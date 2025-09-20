import WebSocket from 'ws';
import { startServer, JsonRpcResponse } from '../src/protocol';

describe('Protocol Layer (JSON-RPC over WebSocket)', () => {
  let wss: ReturnType<typeof startServer>;
  const port = 5000;

  beforeAll(() => {
    wss = startServer(port);
  });

  afterAll((done) => {
    wss.close(() => done());
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
      const req = { jsonrpc: '2.0', id: 1, method: 'executeCommand', params: { instruction: 'click #a' } };
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
        lastActivity: 0
      });
      expect(res.error).toBeUndefined();
    });

    test('executeBrowserAction fails when no browser session exists', async () => {
      const req = {
        jsonrpc: '2.0',
        id: 11,
        method: 'executeBrowserAction',
        params: { instruction: 'click #button' }
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
          sessionId: expect.any(String)
        });

        // 2. Check browser status
        const statusReq = { jsonrpc: '2.0', id: 21, method: 'getBrowserStatus' };
        const statusRes = await sendRequestViaConnection(ws, statusReq);
        expect(statusRes.id).toBe(21);
        expect(statusRes.result).toEqual({
          isActive: true,
          hasPage: false,
          lastActivity: expect.any(Number)
        });

        // 3. Execute browser action (this will create a page)
        const actionReq = {
          jsonrpc: '2.0',
          id: 22,
          method: 'executeBrowserAction',
          params: { instruction: 'navigate to data:text/html,<html><body><h1>Test Page</h1></body></html>' }
        };
        const actionRes = await sendRequestViaConnection(ws, actionReq);
        expect(actionRes.id).toBe(22);
        expect(actionRes.result).toEqual({
          success: expect.any(Boolean),
          results: expect.any(Array),
          translationResult: expect.any(Object)
        });

        // 4. Check browser status after action
        const statusReq2 = { jsonrpc: '2.0', id: 23, method: 'getBrowserStatus' };
        const statusRes2 = await sendRequestViaConnection(ws, statusReq2);
        expect(statusRes2.id).toBe(23);
        expect(statusRes2.result).toEqual({
          isActive: true,
          hasPage: true,
          lastActivity: expect.any(Number),
          context: expect.any(Object)
        });

        // 5. Close browser
        const closeReq = { jsonrpc: '2.0', id: 24, method: 'closeBrowser' };
        const closeRes = await sendRequestViaConnection(ws, closeReq);
        expect(closeRes.id).toBe(24);
        expect(closeRes.result).toEqual({
          success: true,
          message: 'Browser closed successfully'
        });

        // 6. Verify browser status after close
        const statusReq3 = { jsonrpc: '2.0', id: 25, method: 'getBrowserStatus' };
        const statusRes3 = await sendRequestViaConnection(ws, statusReq3);
        expect(statusRes3.id).toBe(25);
        expect(statusRes3.result).toEqual({
          isActive: false,
          hasPage: false,
          lastActivity: 0
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
              { type: 'navigate', url: 'data:text/html,<html><body><button id="button">Click me</button></body></html>' },
              { type: 'click', selector: '#button' }
            ]
          }
        };
        const actionRes = await sendRequestViaConnection(ws, actionReq);
        expect(actionRes.id).toBe(31);
        expect(actionRes.result).toEqual({
          success: expect.any(Boolean),
          results: expect.arrayContaining([
            expect.objectContaining({
              action: { type: 'navigate', url: expect.stringContaining('data:text/html') },
              success: expect.any(Boolean)
            }),
            expect.objectContaining({
              action: { type: 'click', selector: '#button' },
              success: expect.any(Boolean)
            })
          ]),
          translationResult: null
        });

        // Close browser
        const closeReq = { jsonrpc: '2.0', id: 32, method: 'closeBrowser' };
        await sendRequestViaConnection(ws, closeReq);

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
          params: {}
        };
        const actionRes = await sendRequestViaConnection(ws, actionReq);
        expect(actionRes.id).toBe(41);
        expect(actionRes.result).toEqual({
          success: false,
          results: [],
          error: 'Either instruction or actions must be provided'
        });

        // Close browser
        const closeReq = { jsonrpc: '2.0', id: 42, method: 'closeBrowser' };
        await sendRequestViaConnection(ws, closeReq);

      } finally {
        ws.close();
      }
    }, 30000);
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
        await new Promise(resolve => setTimeout(resolve, 100));

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
