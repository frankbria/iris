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

/**
 * Reaches the metadata address only via a redirect, so the guard must vet the
 * hop rather than trusting the sub-resource's own (allowed) URL.
 */
const SUBRESOURCE_REDIRECT_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Redirected subresource fixture</title></head>
  <body>
    <h1>Redirected subresource fixture</h1>
    <img alt="off-host via redirect" src="/img-redirect" />
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
  let subresourceRedirectURL: string;
  let redirectBlockedURL: string;
  let redirectOkURL: string;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    fixtureServer = createServer((req, res) => {
      if (req.url === '/redirect-to-metadata') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      if (req.url === '/redirect-ok') {
        res.writeHead(302, { Location: '/clean' });
        res.end();
        return;
      }
      if (req.url === '/img-redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/meta.png' });
        res.end();
        return;
      }
      if (req.url === '/subresource-redirect') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUBRESOURCE_REDIRECT_HTML);
        return;
      }
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
    subresourceRedirectURL = `${origin}/subresource-redirect`;
    redirectBlockedURL = `${origin}/redirect-to-metadata`;
    redirectOkURL = `${origin}/redirect-ok`;
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

    it('aborts a sub-resource that only reaches a metadata host via a redirect', async () => {
      // The image's own URL is in-policy; only the 30x target is not. Chromium
      // does not re-route a redirected sub-resource any more than it re-routes a
      // redirected navigation, so `route.continue()` here would let the request
      // through — measured, and the reason the guard follows the chain itself.
      const result = await callTool({ url: subresourceRedirectURL });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ passed: true, violationCount: 0 });
    }, 120_000);

    it('names the blocked host when an allowed URL redirects to one', async () => {
      // The pre-flight check passes — the origin is plain localhost — and
      // Chromium never re-routes a 30x target, so only the guard can catch this.
      const result = await callTool({ url: redirectBlockedURL });

      expect(result.isError).toBe(true);
      // Asserting the *reason* is the whole point. The metadata address is
      // unreachable from CI anyway, so a test that merely asserted "the scan
      // failed" would pass with the guard removed — verified, it does.
      expect(result.content?.[0]?.text).toMatch(
        /redirects to http:\/\/169\.254\.169\.254\/.*blocked by navigation policy/,
      );
    }, 120_000);

    it('follows an in-policy redirect and scans what it lands on', async () => {
      // This used to refuse, because following a redirect by fulfilling the final
      // response left the document on the pre-redirect URL and the page's relative
      // assets resolved against the wrong base. The shared guard (#148) re-drives
      // each vetted hop as a real navigation instead, so the redirect is both
      // followed and accurate, and the caller no longer needs a second call.
      const result = await callTool({ url: redirectOkURL });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ passed: true, violationCount: 0 });
    }, 120_000);

    it('scans the redirect target directly too', async () => {
      const result = await callTool({ url: cleanURL });

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
      // Port 1 is reserved and never listening.
      const result = await callTool({ url: 'http://localhost:1/' });
      const text = result.content?.[0]?.text ?? '';

      expect(result.isError).toBe(true);
      expect(text).toContain('Accessibility scan failed');
      // The guard's reason must win the race against page.goto's own timeout,
      // otherwise the caller is told only "Timeout exceeded" with no URL.
      expect(text).toContain('http://localhost:1/');

      // One line, no ANSI. Playwright appends a coloured multi-line call log to
      // its errors; forwarding that to an assistant is tokens spent on noise.
      expect(text).not.toContain('\n');
      expect(text).not.toMatch(/\[/);
    }, 120_000);
  });
});
