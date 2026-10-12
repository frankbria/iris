/**
 * JSON-RPC 2.0 compliance of `iris connect` (issue #357), over a real WebSocket.
 *
 * Before: a parse error got no reply at all, a request without `method` got -32601, an
 * object id was echoed back, a notification (no `id`) was answered, and a handler's own
 * exception reached the client with its message and, for a Node error, a string code.
 */

import WebSocket from 'ws';
import { once } from 'events';
import type { AddressInfo } from 'net';
import type { WebSocketServer } from 'ws';
import { startServer, serializeResponse, toRpcError } from '../src/protocol';

const TOKEN = 'jsonrpc-test-token';
let wss: WebSocketServer;
let url = '';

beforeAll(async () => {
  wss = startServer(0, { authToken: TOKEN });
  await once(wss, 'listening');
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => wss.close(resolve));
});

async function open(): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await once(ws, 'open');
  return ws;
}

/** Send frames in order and collect the replies that arrive for them. */
async function exchange(
  frames: string[],
  expected: number,
): Promise<Array<Record<string, unknown>>> {
  const ws = await open();
  try {
    const replies: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        replies.push(JSON.parse(String(data)));
        if (replies.length === expected) resolve();
      });
    });
    for (const frame of frames) ws.send(frame);
    await done;
    return replies;
  } finally {
    ws.close();
  }
}

const STATUS = (id: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method: 'getStatus' });

describe('JSON-RPC 2.0 compliance (#357)', () => {
  it('answers a parse error with -32700 and a null id, and keeps serving', async () => {
    const [parse, status] = await exchange(['{"jsonrpc": "2.0", "method"', STATUS(1)], 2);
    expect(parse).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    expect(status).toMatchObject({ id: 1, result: { status: 'ready' } });
  });

  it.each([
    ['no jsonrpc member', { id: 1, method: 'getStatus' }, 1],
    ['a jsonrpc member other than "2.0"', { jsonrpc: '1.0', id: 2, method: 'getStatus' }, 2],
    ['no method', { jsonrpc: '2.0', id: 3 }, 3],
    ['a method that is not a string', { jsonrpc: '2.0', id: 4, method: 5 }, 4],
    ['an id that is an object', { jsonrpc: '2.0', id: { a: 1 }, method: 'getStatus' }, null],
    ['an id that is a boolean', { jsonrpc: '2.0', id: true, method: 'getStatus' }, null],
  ])('answers %s with -32600 Invalid Request', async (_what, request, id) => {
    const [reply] = await exchange([JSON.stringify(request)], 1);
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid Request' },
    });
  });

  // #528: batches are not supported (decision in docs/integration-surfaces.md). A batch is
  // one -32600 that says so; none of its elements runs or is answered.
  it('answers a batch with one -32600 that says batches are not supported', async () => {
    const [batch, after] = await exchange([`[${STATUS(1)},${STATUS(2)}]`, STATUS(3)], 2);
    expect(batch).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request', data: 'Batch requests are not supported' },
    });
    expect(after).toMatchObject({ id: 3, result: { status: 'ready' } });
  });

  it('accepts string, number and null ids and echoes them', async () => {
    const replies = await exchange([STATUS('a'), STATUS(7), STATUS(null)], 3);
    expect(replies.map((r) => r.id)).toEqual(['a', 7, null]);
    expect(replies.every((r) => 'result' in r && !('error' in r))).toBe(true);
  });

  it('does not answer a notification (no id), not even one for an unknown method', async () => {
    const replies = await exchange(
      [
        JSON.stringify({ jsonrpc: '2.0', method: 'getStatus' }),
        JSON.stringify({ jsonrpc: '2.0', method: 'noSuchMethod' }),
        STATUS(9),
      ],
      1,
    );
    // The only reply is the request's: the notifications sent before it got none.
    expect(replies).toEqual([expect.objectContaining({ id: 9, result: expect.anything() })]);
  });

  it('still answers -32601 for an unknown method on a request', async () => {
    const [reply] = await exchange([JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'nope' })], 1);
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32601, message: 'Method not found' },
    });
  });
});

describe('toRpcError (#357)', () => {
  it('keeps an error the server threw on purpose', () => {
    expect(toRpcError({ code: -32000, message: 'No active browser session' })).toEqual({
      code: -32000,
      message: 'No active browser session',
    });
    expect(
      toRpcError({ code: -32029, message: 'Rate limit exceeded', data: { retryAfterMs: 5 } }),
    ).toEqual({ code: -32029, message: 'Rate limit exceeded', data: { retryAfterMs: 5 } });
  });

  it.each([
    [
      'a Node error with a string code',
      Object.assign(new Error('connect ECONNREFUSED /var/run/x.sock'), { code: 'ECONNREFUSED' }),
    ],
    ['a plain Error', new Error('Cannot read properties of undefined (reading "page")')],
    ['a thrown string', 'boom'],
    ['null', null],
    ['a non-integer code', { code: 1.5, message: 'x' }],
  ])('turns %s into -32603 Internal error, with no detail', (_what, thrown) => {
    expect(toRpcError(thrown)).toEqual({ code: -32603, message: 'Internal error' });
  });
});

describe('serializeResponse (#357)', () => {
  it('serializes an ordinary response', () => {
    const res = { jsonrpc: '2.0' as const, id: 1, result: { ok: true } };
    expect(JSON.parse(serializeResponse(res))).toEqual(res);
  });

  it('falls back to -32603 when the result cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(JSON.parse(serializeResponse({ jsonrpc: '2.0', id: 3, result: cyclic }))).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32603, message: 'Internal error' },
    });
  });
});
