/**
 * Protocol-level tests for the IRIS MCP stdio server (plan 012).
 *
 * Test strategy: these drive the *built* server as a real subprocess over real
 * stdio, speaking newline-delimited JSON-RPC 2.0 by hand rather than through the
 * SDK client. That is deliberate — the failure mode this spike most needs to
 * exclude is a stray `console.log` (or any non-JSON byte) landing on stdout and
 * corrupting the transport. A hand-rolled reader that JSON.parses every line
 * surfaces that immediately; an SDK client would hide the framing.
 *
 * The axe run is real (no axe-core mock): the fixture page is served over
 * localhost HTTP and contains known WCAG 2 A violations.
 */

import { spawn, ChildProcessWithoutNullStreams, execFileSync } from 'child_process';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'dist/mcp/server.js');

/** A page with three unambiguous wcag2a violations: no lang, no title, img with no alt. */
const FIXTURE_HTML = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
  </body>
</html>`;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Minimal newline-delimited JSON-RPC client over a child process' stdio.
 * Any stdout line that is not parseable JSON is surfaced as an error rather
 * than skipped — that is the stdout-pollution assertion.
 */
class McpStdioClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private nextId = 1;
  /** Diagnostics are expected on stderr; kept for failure messages. */
  stderr = '';

  constructor() {
    this.proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.proc.on('exit', (code) => this.failAll(new Error(`server exited early (code ${code})`)));
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(new Error(`non-JSON byte(s) on stdout — transport corrupted: ${line}`));
        return;
      }
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private write(payload: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** initialize + the initialized notification, i.e. a completed MCP handshake. */
  async handshake(): Promise<JsonRpcResponse> {
    const res = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'iris-protocol-test', version: '0.0.0' },
    });
    this.notify('notifications/initialized');
    return res;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      this.proc.on('exit', () => resolve());
      setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 3000).unref();
    });
  }
}

interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: {
    url: string;
    passed: boolean;
    violationCount: number;
    violations: Array<{ id: string; impact: string; description: string; nodes: number }>;
  };
}

describe('MCP stdio server', () => {
  let fixtureServer: Server;
  let fixtureURL: string;
  let client: McpStdioClient;

  beforeAll(() => {
    // Assert against the artifact the `iris-mcp` bin actually runs, and rebuild
    // so a stale dist/ can never turn a broken server into a passing test.
    execFileSync('npx', ['tsc'], { cwd: REPO_ROOT, stdio: 'pipe' });
  }, 120_000);

  beforeAll(async () => {
    fixtureServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, resolve));
    fixtureURL = `http://localhost:${(fixtureServer.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      fixtureServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    client = new McpStdioClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it('completes an MCP handshake and identifies itself as iris', async () => {
    const res = await client.handshake();

    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      serverInfo: { name: 'iris' },
      capabilities: { tools: expect.anything() },
    });
    // The version is read from package.json, not hardcoded — assert it is a real
    // semver rather than pinning a value this test would have to chase.
    expect((res.result as { serverInfo: { version: string } }).serverInfo.version).toMatch(
      /^\d+\.\d+\.\d+/,
    );
  }, 30_000);

  it('lists run_accessibility_test with a url input', async () => {
    await client.handshake();
    const res = await client.request('tools/list');

    const tools = (res.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'run_accessibility_test');

    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: { url: expect.anything(), wcagLevel: expect.anything() },
      required: ['url'],
    });
  }, 30_000);

  it('runs a real axe scan and reports the fixture page violations', async () => {
    await client.handshake();
    const res = await client.request('tools/call', {
      name: 'run_accessibility_test',
      arguments: { url: fixtureURL },
    });

    const result = res.result as unknown as ToolCallResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();

    const structured = result.structuredContent!;
    expect(structured.url).toBe(fixtureURL);
    expect(structured.violationCount).toBeGreaterThan(0);
    expect(structured.passed).toBe(false);
    expect(structured.violations.length).toBe(structured.violationCount);
    // image-alt is the fixture's most unambiguous wcag2a failure.
    expect(structured.violations.map((v) => v.id)).toContain('image-alt');
    for (const violation of structured.violations) {
      expect(typeof violation.nodes).toBe('number');
    }
  }, 120_000);

  it('reports only axe violations — never keyboard or screen-reader results', async () => {
    // #72/#73: keyboard and screen-reader sub-checks hardcode success, so the
    // tool must not surface them. Guard the honest scoping against regression.
    await client.handshake();
    const res = await client.request('tools/call', {
      name: 'run_accessibility_test',
      arguments: { url: fixtureURL },
    });

    const result = res.result as unknown as ToolCallResult;
    // Assert the exact key set rather than grepping the payload for "keyboard":
    // axe rule descriptions are Deque's prose and could legitimately mention a
    // screen reader, which would make a substring scan false-fail on a reword.
    expect(Object.keys(result.structuredContent!).sort()).toEqual([
      'passed',
      'url',
      'violationCount',
      'violations',
    ]);
    expect(Object.keys(result.structuredContent!.violations[0]).sort()).toEqual([
      'description',
      'helpUrl',
      'id',
      'impact',
      'nodes',
    ]);
  }, 120_000);

  it('returns a tool error for a URL the navigation policy blocks', async () => {
    await client.handshake();
    const res = await client.request('tools/call', {
      name: 'run_accessibility_test',
      arguments: { url: 'file:///etc/passwd' },
    });

    const result = res.result as unknown as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/blocked/i);
  }, 30_000);

  it('returns a tool error instead of crashing when the page is unreachable', async () => {
    await client.handshake();
    // Port 1 is reserved and never listening: connection refused, not a timeout.
    const res = await client.request('tools/call', {
      name: 'run_accessibility_test',
      arguments: { url: 'http://localhost:1/' },
    });

    const result = res.result as unknown as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBeTruthy();

    // The server must survive a failed tool call and still serve the next request.
    const followUp = await client.request('tools/list');
    expect(followUp.error).toBeUndefined();
  }, 120_000);
});
