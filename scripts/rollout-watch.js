// Watches a deploy from the client's side (issue #316). deploy-staging runs it on the box,
// in a container of the iris image on the host's network, while deploy.sh runs:
//
//   node rollout-watch.js <iris port> <portal port> <upstreams file> [hold ms] [max ms]
//
// Every second it sends GET /health/ready to iris-api over one held keep-alive connection
// (a session open across the deploy), and over fresh connections GET /health/ready and the
// portal's GET /api/health. It stops `hold` ms (default 15 s) after the upstreams file
// changes (the proxy switch), or after `max` ms (default 15 min), closes the held
// connection, and prints one JSON line: what each kind of request saw, how many sockets
// the held session used (1: it was never dropped) and whether it spanned the switch.
const http = require('http');
const fs = require('fs');

const [irisPort, portalPort, upstreams] = process.argv.slice(2, 5);
const holdMs = Number(process.argv[5] || 15_000);
const maxMs = Number(process.argv[6] || 900_000);
const intervalMs = Number(process.argv[7] || 1000);
if (!irisPort || !portalPort || !upstreams) {
  console.error(
    'usage: rollout-watch.js <iris port> <portal port> <upstreams file> [hold ms] [max ms]',
  );
  process.exit(2);
}

const read = () => {
  try {
    return fs.readFileSync(upstreams, 'utf8');
  } catch {
    return '';
  }
};
const initial = read();
const started = Date.now();
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const sockets = new Set();
const result = {
  held: { requests: 0, failed: 0, sockets: 0, spannedSwitch: false },
  fresh: { requests: 0, failed: 0 },
  failures: [],
  switchedAfterMs: null,
};

function get(port, path, opts) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 5000, ...opts }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 200, what: String(res.statusCode) }));
      if (opts.agent) sockets.add(res.socket);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, what: err.code || err.message }));
  });
}

function count(kind, label, outcome) {
  result[kind].requests++;
  if (outcome.ok) return;
  result[kind].failed++;
  if (result.failures.length < 10) {
    result.failures.push(`${Date.now() - started}ms ${label}: ${outcome.what}`);
  }
}

(async () => {
  let switchedAt = null;
  while (Date.now() - started < maxMs) {
    if (switchedAt === null && read() !== initial) {
      switchedAt = Date.now();
      result.switchedAfterMs = switchedAt - started;
      result.held.spannedSwitch = result.held.requests > 0;
    }
    if (switchedAt !== null && Date.now() - switchedAt >= holdMs) break;
    const [held, iris, portal] = await Promise.all([
      get(irisPort, '/health/ready', { agent }),
      get(irisPort, '/health/ready', { agent: false }),
      get(portalPort, '/api/health', { agent: false }),
    ]);
    count('held', 'held iris', held);
    count('fresh', 'fresh iris', iris);
    count('fresh', 'fresh portal', portal);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  agent.destroy();
  result.held.sockets = sockets.size;
  console.log(JSON.stringify(result));
})();
