#!/usr/bin/env node
/**
 * Container healthcheck for `iris connect` (issue #192).
 *
 * A TCP open proves nothing here: the socket is listening long before the
 * browser layer is usable, and a wedged Chromium leaves a perfectly healthy
 * looking port behind. This completes a real authenticated JSON-RPC round trip
 * instead, so an unhealthy report means the service genuinely cannot serve.
 *
 * Kept as a file rather than inlined into docker-compose.yml: compose treats
 * `${...}` as its own interpolation syntax, so an inline script has to escape
 * every `$`, which is both unreadable and easy to get subtly wrong.
 *
 * Exit 0 = healthy. Any other exit, and the reason on stderr, = unhealthy.
 */

const WebSocket = require('ws');

const PORT = process.env.IRIS_CONNECT_PORT || '4000';
const TOKEN = process.env.IRIS_CONNECT_TOKEN;
const TIMEOUT_MS = Number(process.env.IRIS_HEALTHCHECK_TIMEOUT_MS || 10000);

function fail(reason) {
  console.error(`healthcheck: ${reason}`);
  process.exit(1);
}

if (!TOKEN) {
  // Without the token the probe cannot authenticate, and would report every
  // healthy container as failing. That is a misconfiguration, not ill health,
  // so say which one it is.
  fail('IRIS_CONNECT_TOKEN is not set in the container environment');
}

// Always loopback: this runs *inside* the container, where the server is bound
// to 0.0.0.0. It deliberately does not use IRIS_CONNECT_HOST — probing the
// external bind address would test routing rather than the service.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});

const timer = setTimeout(() => fail(`no response within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

ws.on('open', () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getStatus', params: {} }));
});

ws.on('message', (raw) => {
  clearTimeout(timer);
  let response;
  try {
    response = JSON.parse(raw.toString());
  } catch {
    return fail('response was not JSON');
  }
  if (response.error) {
    return fail(`rpc error: ${JSON.stringify(response.error)}`);
  }
  ws.close();
  process.exit(0);
});

// An auth failure arrives as a 1008 close rather than an error, because the
// server accepts the upgrade and then rejects the connection.
ws.on('close', (code, reason) => {
  clearTimeout(timer);
  fail(`connection closed before responding (code ${code}${reason ? `: ${reason}` : ''})`);
});

ws.on('error', (err) => {
  clearTimeout(timer);
  fail(`socket error: ${err.message}`);
});
