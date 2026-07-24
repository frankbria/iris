import WebSocket from 'ws';
import { startServer, JsonRpcResponse } from '../src/protocol';

// Mock executor so no real Chromium launches and each ActionExecutor instance
// gets its own spies (needed to tell the first session's cleanup apart from the
// second's). Lives in its own file: jest.mock is file-wide, and protocol.test.ts
// runs real-browser integration tests that must stay unmocked.
const mockInstances: Array<{
  createPage: jest.Mock;
  executeActions: jest.Mock;
  cleanup: jest.Mock;
  getPageContext: jest.Mock;
}> = [];

jest.mock('../src/executor', () => ({
  ActionExecutor: jest.fn().mockImplementation(() => {
    const instance = {
      // Resolve on a later tick to widen the race window between pipelined
      // first actions — without the in-flight-promise guard both would call
      // createPage.
      createPage: jest.fn(
        () => new Promise((resolve) => setTimeout(() => resolve({ page: true }), 25)),
      ),
      executeActions: jest.fn().mockResolvedValue([
        {
          success: true,
          action: { type: 'click', selector: '#button' },
          duration: 1,
          context: { url: 'http://example.com', timestamp: Date.now() },
        },
      ]),
      cleanup: jest.fn().mockResolvedValue(undefined),
      getPageContext: jest.fn().mockResolvedValue({ url: 'http://example.com', title: 'T' }),
    };
    mockInstances.push(instance);
    return instance;
  }),
}));

import { ActionExecutor } from '../src/executor';

describe('Protocol session/page resource leaks (issue #69)', () => {
  let wss: ReturnType<typeof startServer>;
  const port = 5091;

  beforeAll(() => {
    wss = startServer(port);
  });

  afterAll((done) => {
    wss.close(() => done());
  });

  beforeEach(() => {
    mockInstances.length = 0;
    (ActionExecutor as unknown as jest.Mock).mockClear();
  });

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
        const res = JSON.parse(data.toString()) as JsonRpcResponse;
        if (res.id === (req as { id: number }).id) {
          clearTimeout(timeout);
          ws.off('message', messageHandler);
          resolve(res);
        }
      };
      ws.on('message', messageHandler);
      ws.send(JSON.stringify(req));
    });
  }

  test('double launchBrowser cleans up the prior session before replacing it', async () => {
    const ws = await createPersistentConnection();
    try {
      const first = await sendRequestViaConnection(ws, {
        jsonrpc: '2.0',
        id: 1,
        method: 'launchBrowser',
        params: {},
      });
      expect(first.result?.success).toBe(true);

      const second = await sendRequestViaConnection(ws, {
        jsonrpc: '2.0',
        id: 2,
        method: 'launchBrowser',
        params: {},
      });
      expect(second.result?.success).toBe(true);

      expect(mockInstances).toHaveLength(2);
      // First executor's browser was torn down exactly once; the replacement's wasn't.
      expect(mockInstances[0].cleanup).toHaveBeenCalledTimes(1);
      expect(mockInstances[1].cleanup).not.toHaveBeenCalled();
      // Cleanup was invoked before the replacement executor was constructed
      // (and since launchBrowser awaits cleanupSession, invocation order
      // implies completion order here).
      const cleanupOrder = mockInstances[0].cleanup.mock.invocationCallOrder[0];
      const secondCtorOrder = (ActionExecutor as unknown as jest.Mock).mock.invocationCallOrder[1];
      expect(cleanupOrder).toBeLessThan(secondCtorOrder);
    } finally {
      ws.close();
    }
  });

  test('concurrent first executeBrowserAction requests create a single page', async () => {
    const ws = await createPersistentConnection();
    try {
      await sendRequestViaConnection(ws, {
        jsonrpc: '2.0',
        id: 10,
        method: 'launchBrowser',
        params: {},
      });

      const actionReq = (id: number) => ({
        jsonrpc: '2.0',
        id,
        method: 'executeBrowserAction',
        params: { actions: [{ type: 'click', selector: '#button' }] },
      });
      const [resA, resB] = await Promise.all([
        sendRequestViaConnection(ws, actionReq(11)),
        sendRequestViaConnection(ws, actionReq(12)),
      ]);

      expect(resA.result?.success).toBe(true);
      expect(resB.result?.success).toBe(true);
      expect(mockInstances).toHaveLength(1);
      expect(mockInstances[0].createPage).toHaveBeenCalledTimes(1);
      // Both actions executed against the single shared page.
      expect(mockInstances[0].executeActions).toHaveBeenCalledTimes(2);
      const pages = mockInstances[0].executeActions.mock.calls.map((c) => c[1]);
      expect(pages[0]).toBe(pages[1]);
    } finally {
      ws.close();
    }
  });
});
