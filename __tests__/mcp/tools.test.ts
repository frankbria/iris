/**
 * In-process tests for the IRIS MCP tool layer (plan 012).
 *
 * Complements `server.test.ts`, which drives the built server as a subprocess to
 * prove the stdio wire format. That subprocess is invisible to Istanbul, so the
 * branchy parts of `tools.ts` — the navigation-policy gate, WCAG level mapping,
 * violation mapping, and the failure paths — are exercised here instead, over the
 * SDK's in-memory transport pair. Same real McpServer and real Client, no mocks;
 * only the transport differs.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { registerTools, RUN_ACCESSIBILITY_TEST } from '../../src/mcp/tools';

/** No lang, no title, img with no alt — three unambiguous wcag2a violations. */
const FAILING_HTML = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
  </body>
</html>`;

/** Clean markup, but it pulls an image from the cloud-metadata address. */
const SUBRESOURCE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Subresource fixture</title></head>
  <body>
    <h1>Subresource fixture</h1>
    <img alt="off-host" src="http://169.254.169.254/latest/meta-data/" />
  </body>
</html>`;

/** The same page with every one of those defects fixed. */
const CLEAN_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Clean fixture</title></head>
  <body>
    <h1>Clean fixture</h1>
    <img
      alt="a single transparent pixel"
      src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
    />
  </body>
</html>`;

interface A11yStructuredContent {
  url: string;
  passed: boolean;
  violationCount: number;
  violations: Array<{
    id: string;
    impact: string;
    description: string;
    helpUrl: string;
    nodes: number;
  }>;
}

interface CallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: A11yStructuredContent;
}

describe('run_accessibility_test tool', () => {
  let fixtureServer: Server;
  let fixtureURL: string;
  let cleanURL: string;
  let subresourceURL: string;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    fixtureServer = createServer((req, res) => {
      if (req.url === '/subresource') {
        // Passes the pre-flight check (plain localhost), then asks the browser
        // to fetch from a link-local host the policy is meant to block.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUBRESOURCE_HTML);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(req.url === '/clean' ? CLEAN_HTML : FAILING_HTML);
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, resolve));
    const origin = `http://localhost:${(fixtureServer.address() as AddressInfo).port}`;
    fixtureURL = `${origin}/`;
    cleanURL = `${origin}/clean`;
    subresourceURL = `${origin}/subresource`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      fixtureServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(async () => {
    server = new McpServer({ name: 'iris', version: '0.0.0-test' });
    registerTools(server);
    client = new Client({ name: 'tools-test', version: '0.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  async function callTool(args: Record<string, unknown>): Promise<CallResult> {
    return (await client.callTool({
      name: RUN_ACCESSIBILITY_TEST,
      arguments: args,
    })) as unknown as CallResult;
  }

  describe('advertised contract', () => {
    it('declares both an input and an output schema', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === RUN_ACCESSIBILITY_TEST);

      expect(tool).toBeDefined();
      expect(tool!.inputSchema).toMatchObject({ required: ['url'] });
      // An output schema is what lets a client rely on structuredContent rather
      // than re-parsing the human summary text.
      expect(tool!.outputSchema).toMatchObject({
        properties: {
          passed: expect.anything(),
          violationCount: expect.anything(),
          violations: expect.anything(),
        },
      });
      expect(tool!.annotations).toMatchObject({ readOnlyHint: true });
    });

    it('reports a validation error, not a crash, when url is missing', async () => {
      // The SDK validates against inputSchema and hands back a structured error
      // result rather than rejecting — so a malformed call never reaches our code.
      const result = await callTool({});

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/validation error/i);
    });
  });

  describe('navigation policy gate', () => {
    // These must fail without ever launching a browser: the point of the gate is
    // that a model-supplied URL never reaches page.goto().
    it.each([
      ['file:///etc/passwd', /file:\/\/ scheme is not allowed/i],
      ['ftp://example.com/', /scheme "ftp:" is not allowed/i],
      ['http://169.254.169.254/latest/meta-data/', /link-local\/metadata/i],
      ['not-a-url', /malformed URL/i],
    ])('blocks %s', async (url, expected) => {
      const result = await callTool({ url });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(expected);
      expect(result.structuredContent).toBeUndefined();
    });

    it('aborts a sub-resource request to a metadata host', async () => {
      // The pre-flight check passes here — the page's own origin is plain
      // localhost — so only the per-request route guard can stop the image
      // fetch. The observable is completion: an aborted request settles
      // immediately and the scan returns, whereas an *unguarded* request to a
      // link-local address hangs until `waitUntil: 'networkidle'` times out and
      // the tool reports a failure instead. Asserting success is therefore what
      // discriminates guard-on from guard-off here.
      const result = await callTool({ url: subresourceURL });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ passed: true, violationCount: 0 });
    }, 120_000);
  });

  describe('scan results', () => {
    it('maps axe violations into the structured payload', async () => {
      const result = await callTool({ url: fixtureURL });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent!;
      expect(structured.passed).toBe(false);
      expect(structured.violationCount).toBe(structured.violations.length);

      const imageAlt = structured.violations.find((v) => v.id === 'image-alt');
      expect(imageAlt).toBeDefined();
      // `nodes` is a count, not the offending markup — the tool summarises rather
      // than dumping page HTML back at the assistant.
      expect(imageAlt!.nodes).toBeGreaterThan(0);
      expect(imageAlt!.helpUrl).toMatch(/^https?:\/\//);
      expect(['minor', 'moderate', 'serious', 'critical']).toContain(imageAlt!.impact);
    }, 120_000);

    it('includes a human-readable summary alongside the structured content', async () => {
      const result = await callTool({ url: fixtureURL });

      const text = result.content?.[0]?.text ?? '';
      expect(text).toContain(fixtureURL);
      expect(text).toMatch(/violation\(s\)/);
      expect(text).toContain('image-alt');
    }, 120_000);

    it('accepts wcagLevel AAA', async () => {
      const result = await callTool({ url: fixtureURL, wcagLevel: 'AAA' });

      expect(result.isError).toBeFalsy();
      // AAA is additive over AA, so the AA failures must still be reported.
      expect(result.structuredContent!.violations.map((v) => v.id)).toContain('image-alt');
      expect(result.content?.[0]?.text).toContain('WCAG AAA');
    }, 120_000);

    it('reports a validation error for an unknown wcagLevel', async () => {
      const result = await callTool({ url: fixtureURL, wcagLevel: 'AAAA' });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/expected one of "AA"\|"AAA"/);
    });

    it('reports a clean page as passed with no violations', async () => {
      const result = await callTool({ url: cleanURL });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        url: cleanURL,
        passed: true,
        violationCount: 0,
        violations: [],
      });
      expect(result.content?.[0]?.text).toMatch(/No WCAG AA violations found/);
    }, 120_000);
  });

  describe('failure handling', () => {
    it('returns a tool error, not a throw, when the page is unreachable', async () => {
      // Port 1 is reserved and never listening: connection refused, not a timeout.
      const result = await callTool({ url: 'http://localhost:1/' });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('Accessibility scan failed');
    }, 120_000);
  });
});
