// The deploy's egress probe (issue #376), run inside a running app container:
//
//   node docker/egress-probe.js [host] [port]     (default 169.254.169.254 80)
//
// Exits 0 only when the connection is refused at once, which is what the egress
// firewall's TCP reset looks like. A connection means the address is reachable; a
// timeout means nothing answered, which a host without a metadata service shows with no
// firewall at all, so neither proves the rules are in place.
const net = require('net');

const host = process.argv[2] || '169.254.169.254';
const port = Number(process.argv[3] || 80);
const target = `${host}:${port}`;

const socket = net.connect({ host, port, timeout: 5000 });
socket.on('connect', () => {
  console.error(`egress probe: ${target} accepted a connection`);
  process.exit(1);
});
socket.on('timeout', () => {
  console.error(`egress probe: ${target} timed out (no firewall reset)`);
  process.exit(1);
});
socket.on('error', (err) => {
  if (err.code === 'ECONNREFUSED') {
    console.log(`egress probe: ${target} refused, as the egress firewall does`);
    process.exit(0);
  }
  console.error(`egress probe: ${target} failed with ${err.code}, not a firewall reset`);
  process.exit(1);
});
