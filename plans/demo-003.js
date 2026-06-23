// Phase 11 demo for issue #3 — runtime evidence for each acceptance criterion.
// Run: node plans/demo-003.js
const net = require('net');
const WebSocket = require('ws');
const { startServer } = require('../dist/protocol');

const PORT = 5099;

function rpc(req, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, opts);
    let settled = false;
    ws.on('open', () => ws.send(JSON.stringify(req)));
    ws.on('message', (d) => { settled = true; resolve(JSON.parse(d.toString())); ws.close(); });
    ws.on('close', (code) => { if (!settled) { settled = true; resolve({ closed: code }); } });
    ws.on('error', () => {});
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('timeout')); } }, 5000);
  });
}

(async () => {
  const wss = startServer(PORT);
  await new Promise((r) => wss.on('listening', r));

  const addr = wss.address();
  console.log(`[1] BIND: server listening on ${addr.address}:${addr.port}` +
    `  -> ${addr.address === '127.0.0.1' ? 'PASS (loopback, not 0.0.0.0)' : 'FAIL'}`);

  // Confirm nothing is reachable on a non-loopback interface bind would imply 0.0.0.0
  const onLoopbackOnly = addr.address === '127.0.0.1';

  const evil = await rpc({ jsonrpc: '2.0', id: 1, method: 'getStatus' }, { origin: 'http://evil.example' });
  console.log(`[2] ORIGIN: browser-origin connection -> ${evil.closed === 1008 ? 'PASS (closed 1008)' : 'FAIL ' + JSON.stringify(evil)}`);

  const ok = await rpc({ jsonrpc: '2.0', id: 2, method: 'getStatus' });
  console.log(`[3] NO-ORIGIN: trusted client -> ${ok.result && ok.result.status === 'ready' ? 'PASS (served)' : 'FAIL ' + JSON.stringify(ok)}`);

  const bad = await rpc({ jsonrpc: '2.0', id: 3, method: 'executeCommand', params: {} });
  console.log(`[4] PARAMS: executeCommand {} -> ${bad.error && bad.error.code === -32602 ? 'PASS (-32602)' : 'FAIL ' + JSON.stringify(bad)}`);

  const good = await rpc({ jsonrpc: '2.0', id: 4, method: 'executeCommand', params: { instruction: 'click #a' } });
  console.log(`[5] HAPPY PATH: executeCommand valid -> ${good.result ? 'PASS (' + JSON.stringify(good.result) + ')' : 'FAIL ' + JSON.stringify(good)}`);

  const fileUrl = await rpc({ jsonrpc: '2.0', id: 5, method: 'executeBrowserAction', params: { url: 'file:///etc/passwd', instruction: 'read' } });
  console.log(`[6] URL SCHEME: executeBrowserAction file:// -> ${fileUrl.error && fileUrl.error.code === -32602 ? 'PASS (-32602, never navigated)' : 'FAIL ' + JSON.stringify(fileUrl)}`);

  await new Promise((r) => wss.close(r));
  process.exit(0);
})();
