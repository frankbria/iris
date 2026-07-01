import WebSocket from 'ws';
import http from 'http';
import { startServer, JsonRpcResponse } from '../src/protocol';

describe('Protocol Layer (JSON-RPC over WebSocket)', () => {
  let wss: ReturnType<typeof startServer>;
  const port = 5000;

  // Ephemeral localhost page server. data:/file: navigation is now blocked by the
  // URL policy, so integration tests navigate to a real http://127.0.0.1 page
  // (loopback is allowed by default) instead of a data: URL.
  let pageServer: http.Server;
  let pageUrl: string;

  beforeAll(async () => {
    wss = startServer(port);
    pageServer = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Test Page</h1><button id="button">Click me</button></body></html>');
    });
    await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = pageServer.address();
    pageUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
  });

  afterAll((done) => {
    pageServer.close(() => wss.close(() => done()));
  });

  function sendRequest(req: object): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => ws.send(JSON.stringify(req)));
      ws.on('message', (data: WebSocket.Data) => {
        try {
          const res = JSON.parse(data.toString()) as JsonRpcResponse;
          resolve(res);
        } catch (err) {
          reject(err);
        } finally {
          ws.close();
        }
      });
      ws.on('error', reject);
    });
  }

  function createPersistentConnection(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function sendRequestViaConnection(ws: WebSocket, req: object): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Request timeout')), 10000);

      const messageHandler = (data: WebSocket.Data) => {
        try {
          const res = JSON.parse(data.toString()) as JsonRpcResponse;
          if (res.id === (req as any).id) {
            clearTimeout(timeout);
            ws.off('message', messageHandler);
            resolve(res);
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      };

      ws.on('message', messageHandler);
      ws.send(JSON.stringify(req));
    });
  }

  describe('Legacy Translation Methods', () => {
    test('executeCommand returns translated actions', async () => {
      const req = {
        jsonrpc: '2.0',
        id: 1,
        method: 'executeCommand',
        params: { instruction: 'click #a' },
      };
      const res = await sendRequest(req);
      expect(res.id).toBe(1);
      expect(res.result).toEqual([{ type: 'click', selector: '#a' }]);
      expect(res.error).toBeUndefined();
    });

    test('getStatus returns ready status', async () => {
      const req = { jsonrpc: '2.0', id: 2, method: 'getStatus' };
      const res = await sendRequest(req);
      expect(res.id).toBe(2);
      expect(res.result).toEqual({ status: 'ready' });
    });

    test('streamLogs returns an array of logs', async () => {
      const req = { jsonrpc: '2.0', id: 3, method: 'streamLogs' };
      const res = await sendRequest(req);
      expect(res.id).toBe(3);
      expect(res.result).toEqual(['log1', 'log2']);
    });
  });

  describe('Browser Automation Methods', () => {
    test('getBrowserStatus returns inactive status when no session exists', async () => {
      const req = { jsonrpc: '2.0', id: 10, method: 'getBrowserStatus' };
      const res = await sendRequest(req);
      expect(res.id).toBe(10);
      expect(res.result).toEqual({
        isActive: false,
        hasPage: false,
        lastActivity: 0,
      });
      expect(res.error).toBeUndefined();
    });

    test('executeBrowserAction fails when no browser session exists', async () => {
      const req = {
        jsonrpc: '2.0',
        id: 11,
        method: 'executeBrowserAction',
        params: { instruction: 'click #button' },
      };
      const res = await sendRequest(req);
      expect(res.id).toBe(11);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32000);
      expect(res.error!.message).toBe('No active browser session. Call launchBrowser first.');
    });

    test('closeBrowser fails when no browser session exists', async () => {
      const req = { jsonrpc: '2.0', id: 12, method: 'closeBrowser' };
      const res = await sendRequest(req);
      expect(res.id).toBe(12);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32000);
      expect(res.error!.message).toBe('No active browser session');
    });

    test('full browser automation workflow', async () => {
      const ws = await createPersistentConnection();

      try {
        // 1. Launch browser
        const launchReq = { jsonrpc: '2.0', id: 20, method: 'launchBrowser' };
        const launchRes = await sendRequestViaConnection(ws, launchReq);
        expect(launchRes.id).toBe(20);
        expect(launchRes.result).toEqual({
          success: true,
          message: 'Browser launched successfully',
          sessionId: expect.any(String),
        });

        // 2. Check browser status
        const statusReq = { jsonrpc: '2.0', id: 21, method: 'getBrowserStatus' };
        const statusRes = await sendRequestViaConnection(ws, statusReq);
        expect(statusRes.id).toBe(21);
        expect(statusRes.result).toEqual({
          isActive: true,
          hasPage: false,
          lastActivity: expect.any(Number),
        });

        // 3. Execute browser action (this will create a page)
        const actionReq = {
          jsonrpc: '2.0',
          id: 22,
          method: 'executeBrowserAction',
          params: {
            instruction: `navigate to ${pageUrl}`,
          },
        };
        const actionRes = await sendRequestViaConnection(ws, actionReq);
        expect(actionRes.id).toBe(22);
        expect(actionRes.result).toEqual({
          success: expect.any(Boolean),
          results: expect.any(Array),
          translationResult: expect.any(Object),
        });

        // 4. Check browser status after action
        const statusReq2 = { jsonrpc: '2.0', id: 23, method: 'getBrowserStatus' };
        const statusRes2 = await sendRequestViaConnection(ws, statusReq2);
        expect(statusRes2.id).toBe(23);
        expect(statusRes2.result).toEqual({
          isActive: true,
          hasPage: true,
          lastActivity: expect.any(Number),
          context: expect.any(Object),
        });

        // 5. Close browser
        const closeReq = { jsonrpc: '2.0', id: 24, method: 'closeBrowser' };
        const closeRes = await sendRequestViaConnection(ws, closeReq);
        expect(closeRes.id).toBe(24);
        expect(closeRes.result).toEqual({
          success: true,
          message: 'Browser closed successfully',
        });

        // 6. Verify browser status after close
        const statusReq3 = { jsonrpc: '2.0', id: 25, method: 'getBrowserStatus' };
        const statusRes3 = await sendRequestViaConnection(ws, statusReq3);
        expect(statusRes3.id).toBe(25);
        expect(statusRes3.result).toEqual({
          isActive: false,
          hasPage: false,
          lastActivity: 0,
        });
      } finally {
        ws.close();
      }
    }, 30000); // 30 second timeout for this test

    test('executeBrowserAction with direct actions parameter', async () => {
      const ws = await createPersistentConnection();

      try {
        // Launch browser
        const launchReq = { jsonrpc: '2.0', id: 30, method: 'launchBrowser' };
        await sendRequestViaConnection(ws, launchReq);

        // Execute with direct actions (use data: URL for faster test)
        const actionReq = {
          jsonrpc: '2.0',
          id: 31,
          method: 'executeBrowserAction',
          params: {
            actions: [
              { type: 'navigate', url: pageUrl },
              { type: 'click', selector: '#button' },
            ],
          },
        };
        const actionRes = await sendRequestViaConnection(ws, actionReq);
        expect(actionRes.id).toBe(31);
        expect(actionRes.result).toEqual({
          success: expect.any(Boolean),
          results: expect.arrayContaining([
            expect.objectContaining({
              action: { type: 'navigate', url: expect.stringContaining('127.0.0.1') },
              success: expect.any(Boolean),
            }),
            expect.objectContaining({
              action: { type: 'click', selector: '#button' },
              success: expect.any(Boolean),
            }),
          ]),
          translationResult: null,
        });

        // Close browser
        const closeReq = { jsonrpc: '2.0', id: 32, method: 'closeBrowser' };
        await sendRequestViaConnection(ws, closeReq);
      } finally {
        ws.close();
      }
    }, 30000);

    // Note: the redirect-SSRF guard (a 30x to a metadata host is aborted by the
    // per-request route) is covered deterministically in executor.test.ts — whether
    // page.goto rejects after an aborted redirect is browser/env-dependent, so it is
    // not asserted here.

    test('launchBrowser ignores a client-supplied urlPolicy (cannot re-enable file://)', async () => {
      const ws = await createPersistentConnection();

      try {
        // Malicious client tries to opt out of the local-file block.
        await sendRequestViaConnection(ws, {
          jsonrpc: '2.0',
          id: 55,
          method: 'launchBrowser',
          params: { options: { timeout: 4000, retryAttempts: 0, urlPolicy: { allowFile: true } } },
        });

        const actionRes = await sendRequestViaConnection(ws, {
          jsonrpc: '2.0',
          id: 56,
          method: 'executeBrowserAction',
          params: { actions: [{ type: 'navigate', url: 'file:///etc/passwd' }] },
        });

        expect(actionRes.id).toBe(56);
        // urlPolicy is stripped from wire options, so the default block still applies.
        expect(actionRes.result.success).toBe(false);
        expect(actionRes.result.results[0].success).toBe(false);
        expect(actionRes.result.results[0].error).toMatch(/blocked/i);

        await sendRequestViaConnection(ws, { jsonrpc: '2.0', id: 57, method: 'closeBrowser' });
      } finally {
        ws.close();
      }
    }, 30000);

    test('executeBrowserAction fails with neither instruction nor actions', async () => {
      const ws = await createPersistentConnection();

      try {
        // Launch browser
        const launchReq = { jsonrpc: '2.0', id: 40, method: 'launchBrowser' };
        await sendRequestViaConnection(ws, launchReq);

        // Execute with no instruction or actions
        const actionReq = {
          jsonrpc: '2.0',
          id: 41,
          method: 'executeBrowserAction',
          params: {},
        };
        const actionRes = await sendRequestViaConnection(ws, actionReq);
        expect(actionRes.id).toBe(41);
        expect(actionRes.result).toEqual({
          success: false,
          results: [],
          error: 'Either instruction or actions must be provided',
        });

        // Close browser
        const closeReq = { jsonrpc: '2.0', id: 42, method: 'closeBrowser' };
        await sendRequestViaConnection(ws, closeReq);
      } finally {
        ws.close();
      }
    }, 30000);
  });

  describe('Security Hardening', () => {
    test('rejects cross-origin connection with code 1008', async () => {
      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`, {
          origin: 'http://evil.example',
        });
        ws.on('close', (code) => resolve(code));
        ws.on('error', reject);
      });
      expect(closeCode).toBe(1008);
    });

    test('accepts a connection whose Origin is in the allowlist', async () => {
      const allowPort = 5001;
      const allowWss = startServer(allowPort, { allowedOrigins: ['http://trusted.example'] });
      try {
        await new Promise<void>((resolve) => allowWss.once('listening', resolve));
        const res = await new Promise<JsonRpcResponse>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${allowPort}`, {
            origin: 'http://trusted.example',
          });
          ws.on('open', () =>
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 70, method: 'getStatus' })),
          );
          ws.on('message', (d) => {
            resolve(JSON.parse(d.toString()));
            ws.close();
          });
          ws.on('error', reject);
        });
        expect(res.result).toEqual({ status: 'ready' });
        expect(res.error).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => allowWss.close(() => resolve()));
      }
    });

    test('executeCommand with missing instruction returns invalid params (-32602)', async () => {
      const req = { jsonrpc: '2.0', id: 60, method: 'executeCommand', params: {} };
      const res = await sendRequest(req);
      expect(res.id).toBe(60);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
    });

    // Param validation runs before the session check, so no browser launch is
    // needed to prove a file: URL is rejected.
    test('executeBrowserAction with file: URL scheme is rejected (-32602)', async () => {
      const res = await sendRequest({
        jsonrpc: '2.0',
        id: 62,
        method: 'executeBrowserAction',
        params: { url: 'file:///etc/passwd', instruction: 'read it' },
      });
      expect(res.id).toBe(62);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
    });

    // A valid http(s) URL passes the schema — it reaches the session check
    // (-32000 "no session") rather than being rejected as -32602.
    test('executeBrowserAction with a valid https URL passes param validation', async () => {
      const res = await sendRequest({
        jsonrpc: '2.0',
        id: 64,
        method: 'executeBrowserAction',
        params: { url: 'https://example.com', instruction: 'click #a' },
      });
      expect(res.id).toBe(64);
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32000); // got past validation, failed only on missing session
    });

    // The discriminated-union Action schema replaces the former z.array(z.any()),
    // so malformed actions are rejected at the dispatch boundary (-32602) rather
    // than reaching the executor.
    test('executeBrowserAction rejects an unknown action type (-32602)', async () => {
      const res = await sendRequest({
        jsonrpc: '2.0',
        id: 66,
        method: 'executeBrowserAction',
        params: { actions: [{ type: 'evil', payload: 'rm -rf' }] },
      });
      expect(res.id).toBe(66);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
    });

    test('executeBrowserAction rejects a navigate action with a non-URL (-32602)', async () => {
      const res = await sendRequest({
        jsonrpc: '2.0',
        id: 67,
        method: 'executeBrowserAction',
        params: { actions: [{ type: 'navigate', url: 'not a url' }] },
      });
      expect(res.id).toBe(67);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
    });

    test('executeBrowserAction rejects a click action missing its selector (-32602)', async () => {
      const res = await sendRequest({
        jsonrpc: '2.0',
        id: 68,
        method: 'executeBrowserAction',
        params: { actions: [{ type: 'click' }] },
      });
      expect(res.id).toBe(68);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
    });

    // A well-formed action array passes the schema and reaches the session check.
    test('executeBrowserAction with a well-formed navigate action passes validation', async () => {
      const res = await sendRequest({
        jsonrpc: '2.0',
        id: 69,
        method: 'executeBrowserAction',
        params: { actions: [{ type: 'navigate', url: 'https://example.com' }] },
      });
      expect(res.id).toBe(69);
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32000); // past validation, failed only on missing session
    });
  });

  describe('Error Handling', () => {
    test('unknown method returns method not found error', async () => {
      const req = { jsonrpc: '2.0', id: 50, method: 'unknownMethod' };
      const res = await sendRequest(req);
      expect(res.id).toBe(50);
      expect(res.result).toBeUndefined();
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32601);
      expect(res.error!.message).toBe('Method not found');
    });

    test('invalid JSON request is ignored', async () => {
      const ws = await createPersistentConnection();

      try {
        // Send invalid JSON
        ws.send('invalid json');

        // Wait a bit to ensure no response
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Send valid request to verify connection still works
        const validReq = { jsonrpc: '2.0', id: 51, method: 'getStatus' };
        const res = await sendRequestViaConnection(ws, validReq);
        expect(res.id).toBe(51);
        expect(res.result).toEqual({ status: 'ready' });
      } finally {
        ws.close();
      }
    });
  });
});
