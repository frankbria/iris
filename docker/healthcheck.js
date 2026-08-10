#!/usr/bin/env node
/**
 * Container health probe for `iris connect` (issue #192).
 *
 * Completes an authenticated JSON-RPC round trip: the socket is up, the bearer
 * token is accepted, and the RPC layer answers. Cheap enough to run every 30s.
 *
 * What it deliberately does NOT prove is that Chromium works. `getStatus`
 * reports `status: 'ready'` without touching the browser (src/protocol.ts:234),
 * so a container with a missing or broken browser stays "healthy" here until
 * something asks it to navigate.
 *
 * An earlier version of this file took a `--with-browser` flag that called the
 * `launchBrowser` RPC for that. It was removed because it could not fail:
 * `createBrowserSession` (protocol.ts:346) only constructs an ActionExecutor and
 * returns `page: null` — no browser is started, yet the RPC answers "Browser
 * launched successfully". Verified by deleting /ms-playwright and watching the
 * probe still pass. The deploy checks the browser directly instead, with a
 * `playwright.chromium.launch()` that genuinely fails when it is broken.
 *
 * Kept as a file rather than inlined into docker-compose.yml: compose treats
 * `${...}` as its own interpolation syntax, so an inline script would have to
 * escape every `$`.
 *
 * Exit 0 = pass. Any other exit, with a reason on stderr, = fail.
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
  // Without the token the probe cannot authenticate and would report every
  // healthy container as failing. That is a misconfiguration, not ill health,
  // so name which one it is.
  fail('IRIS_CONNECT_TOKEN is not set in the container environment');
}

// Always loopback: this runs *inside* the container, where the server is bound
// to 0.0.0.0. It deliberately does not use IRIS_CONNECT_HOST — probing the
// external bind address would test routing rather than the service.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});

const timer = setTimeout(() => fail(`no response within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

ws.on('open', () =>
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getStatus', params: {} })),
);

ws.on('message', (raw) => {
  let response;
  try {
    response = JSON.parse(raw.toString());
  } catch {
    return fail('response was not JSON');
  }
  if (response.error) {
    return fail(`rpc error: ${JSON.stringify(response.error)}`);
  }
  clearTimeout(timer);
  ws.close();
  process.exit(0);
});

// An auth failure arrives as a 1008 close rather than an error, because the
// server accepts the upgrade and then rejects the connection.
ws.on('close', (code, reason) => {
  clearTimeout(timer);
  fail(`connection closed before completing (code ${code}${reason ? `: ${reason}` : ''})`);
});

ws.on('error', (err) => {
  clearTimeout(timer);
  fail(`socket error: ${err.message}`);
});
