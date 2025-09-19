import WebSocket, { WebSocketServer } from 'ws';
import { translate } from './translator';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/**
 * Start a JSON-RPC 2.0 over WebSocket server on the given port.
 */
export function startServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(data.toString());
      } catch {
        return;
      }
      const res: JsonRpcResponse = { jsonrpc: '2.0', id: req.id };
      try {
        switch (req.method) {
          case 'executeCommand': {
            const { instruction } = req.params;
            res.result = translate(instruction);
            break;
          }
          case 'getStatus': {
            res.result = { status: 'ready' };
            break;
          }
          case 'streamLogs': {
            res.result = ['log1', 'log2'];
            break;
          }
          default:
            throw { code: -32601, message: 'Method not found' };
        }
      } catch (err: any) {
        res.error = { code: err.code || -32000, message: err.message || 'Server error' };
      }
      ws.send(JSON.stringify(res));
    });
  });
  return wss;
}
