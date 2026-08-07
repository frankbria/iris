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

  test('failed page creation is retryable (in-flight promise cleared on rejection)', async () => {
    const ws = await createPersistentConnection();
    try {
      await sendRequestViaConnection(ws, {
        jsonrpc: '2.0',
        id: 20,
        method: 'launchBrowser',
        params: {},
      });
      const executor = mockInstances[0];
      executor.createPage.mockRejectedValueOnce(new Error('boom'));

      const actionReq = (id: number) => ({
        jsonrpc: '2.0',
        id,
        method: 'executeBrowserAction',
        params: { actions: [{ type: 'click', selector: '#button' }] },
      });

      const failed = await sendRequestViaConnection(ws, actionReq(21));
      expect(failed.result?.success).toBe(false);
      expect(failed.result?.error).toBe('boom');

      // The rejected promise must not stay cached — the next action retries
      // createPage and succeeds.
      const retried = await sendRequestViaConnection(ws, actionReq(22));
      expect(retried.result?.success).toBe(true);
      expect(executor.createPage).toHaveBeenCalledTimes(2);
    } finally {
      ws.close();
    }
  });

  // Issue #128: #69 fixed the sequential re-launch leak, but two *concurrent*
  // interleavings survived. Both handlers suspend at an `await`, so a second
  // message runs in the gap the first left open.
  describe('concurrent session mutation (issue #128)', () => {
    /** Send without awaiting, so both messages are in flight simultaneously. */
    const launchReq = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'launchBrowser',
      params: {},
    });

    test('two pipelined launchBrowser requests leave exactly one live session and orphan nothing', async () => {
      const ws = await createPersistentConnection();
      try {
        // An existing session is what makes this race real: `await
        // cleanupSession(...)` only suspends for a meaningful length of time
        // when there is a browser to close, and closing Chromium is slow.
        await sendRequestViaConnection(ws, launchReq(30));
        mockInstances[0].cleanup.mockImplementation(() => new Promise((r) => setTimeout(r, 50)));

        const [a, b] = await Promise.all([
          sendRequestViaConnection(ws, launchReq(31)),
          sendRequestViaConnection(ws, launchReq(32)),
        ]);
        expect(a.result?.success).toBe(true);
        expect(b.result?.success).toBe(true);

        // Three executors were constructed; exactly one may still be alive.
        // Every other one must have been cleaned up, or its Chromium is
        // orphaned with no map entry and no future cleanup path.
        expect(mockInstances).toHaveLength(3);
        const alive = mockInstances.filter((m) => m.cleanup.mock.calls.length === 0);
        expect(alive).toHaveLength(1);

        // The first session must not be torn down twice either — both handlers
        // reading it before either deletes it is the same interleaving.
        expect(mockInstances[0].cleanup).toHaveBeenCalledTimes(1);

        // The survivor is the one still serving actions.
        const action = await sendRequestViaConnection(ws, {
          jsonrpc: '2.0',
          id: 33,
          method: 'executeBrowserAction',
          params: { actions: [{ type: 'click', selector: '#button' }] },
        });
        expect(action.result?.success).toBe(true);
        expect(alive[0].executeActions).toHaveBeenCalledTimes(1);
      } finally {
        ws.close();
      }
    });

    test('a launchBrowser arriving mid-action waits instead of tearing down under it', async () => {
      const ws = await createPersistentConnection();
      try {
        await sendRequestViaConnection(ws, launchReq(40));
        const executor = mockInstances[0];

        // Order-of-events log. Asserting on invocationCallOrder alone would only
        // prove when cleanup was *called* relative to when the action *started* —
        // the bug is cleanup landing before the action *finishes*.
        const events: string[] = [];
        executor.executeActions.mockImplementation(async () => {
          events.push('action:start');
          await new Promise((r) => setTimeout(r, 60));
          events.push('action:end');
          return [
            {
              success: true,
              action: { type: 'click', selector: '#button' },
              duration: 1,
              context: { url: 'http://example.com', timestamp: Date.now() },
            },
          ];
        });
        executor.cleanup.mockImplementation(async () => {
          events.push('cleanup');
        });

        const actionPromise = sendRequestViaConnection(ws, {
          jsonrpc: '2.0',
          id: 41,
          method: 'executeBrowserAction',
          params: { actions: [{ type: 'click', selector: '#button' }] },
        });
        // Let the action get past createPage and into executeActions, then
        // launch while it is genuinely in flight.
        await new Promise((r) => setTimeout(r, 40));
        const launchPromise = sendRequestViaConnection(ws, launchReq(42));

        const [actionRes, launchRes] = await Promise.all([actionPromise, launchPromise]);

        expect(actionRes.result?.success).toBe(true);
        expect(launchRes.result?.success).toBe(true);
        expect(events).toEqual(['action:start', 'action:end', 'cleanup']);
      } finally {
        ws.close();
      }
    });

    test('pipelined executeBrowserAction requests still run concurrently', async () => {
      // Guard against over-serialising: the fix must not turn actions into a
      // queue. Two actions overlapping is deliberate and tested for above; this
      // pins it against the new gate.
      const ws = await createPersistentConnection();
      try {
        await sendRequestViaConnection(ws, launchReq(50));
        const executor = mockInstances[0];

        let inFlight = 0;
        let maxConcurrent = 0;
        executor.executeActions.mockImplementation(async () => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((r) => setTimeout(r, 40));
          inFlight -= 1;
          return [
            {
              success: true,
              action: { type: 'click', selector: '#button' },
              duration: 1,
              context: { url: 'http://example.com', timestamp: Date.now() },
            },
          ];
        });

        const actionReq = (id: number) => ({
          jsonrpc: '2.0',
          id,
          method: 'executeBrowserAction',
          params: { actions: [{ type: 'click', selector: '#button' }] },
        });
        await Promise.all([
          sendRequestViaConnection(ws, actionReq(51)),
          sendRequestViaConnection(ws, actionReq(52)),
        ]);

        expect(maxConcurrent).toBe(2);
      } finally {
        ws.close();
      }
    });
  });
});
