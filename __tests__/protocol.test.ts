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

  test('unknown method returns method not found error', async () => {
    const req = { jsonrpc: '2.0', id: 4, method: 'unknownMethod' };
    const res = await sendRequest(req);
    expect(res.id).toBe(4);
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32601);
  });
});
