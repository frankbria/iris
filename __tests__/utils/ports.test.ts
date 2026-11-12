/**
 * The port helpers the spawning suites share (#666). Real sockets throughout: the point of
 * `onFreePorts` is what happens when a port really is taken.
 */

import { execFileSync } from 'child_process';
import { once } from 'events';
import * as net from 'net';
import * as path from 'path';
import { closedPort, connectPort, onFreePorts, PortTaken } from './ports';

/** Listens on `port`, or throws `PortTaken` when something else holds it. */
async function listenOrTaken(port: number): Promise<net.Server> {
  const server = net.createServer().listen(port, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortTaken(String(err));
    throw err;
  }
  return server;
}

const close = (server: net.Server) => new Promise((resolve) => server.close(resolve));

describe('connectPort', () => {
  it('reads the port iris connect printed, among other output', () => {
    const output = '{"level":"info"}\nJSON-RPC server listening on ws://127.0.0.1:41865\nmore\n';
    expect(connectPort(output)).toBe(41865);
  });

  it('is undefined until the line is there', () => {
    expect(connectPort('')).toBeUndefined();
    expect(connectPort('Cannot listen on 127.0.0.1:41865: address already in use')).toBeUndefined();
  });
});

describe('onFreePorts', () => {
  it('hands over distinct ports that can be bound, and returns what start returned', async () => {
    const servers = await onFreePorts(3, '127.0.0.1', (ports) =>
      Promise.all(ports.map(listenOrTaken)),
    );
    try {
      const bound = servers.map((s) => (s.address() as net.AddressInfo).port);
      expect(new Set(bound).size).toBe(3);
    } finally {
      await Promise.all(servers.map(close));
    }
  });

  it('tries fresh ports when the first was taken before start could bind it', async () => {
    const offered: number[] = [];
    const opened: net.Server[] = [];
    try {
      const server = await onFreePorts(1, '127.0.0.1', async ([port]) => {
        offered.push(port);
        // The race itself: something else binds the probed port first, once.
        if (offered.length === 1) opened.push(await listenOrTaken(port));
        const bound = await listenOrTaken(port);
        opened.push(bound);
        return bound;
      });
      expect(offered).toHaveLength(2);
      expect((server.address() as net.AddressInfo).port).toBe(offered[1]);
      expect(offered[1]).not.toBe(offered[0]);
    } finally {
      await Promise.all(opened.map(close));
    }
  });

  it('gives up after five taken ports, with the last report', async () => {
    let attempts = 0;
    const result = onFreePorts(1, '127.0.0.1', async ([port]) => {
      attempts++;
      throw new PortTaken(`attempt ${attempts} on ${port}`);
    });
    await expect(result).rejects.toThrow(/^attempt 5 on \d+$/);
    expect(attempts).toBe(5);
  });

  it('does not retry any other failure', async () => {
    let attempts = 0;
    const result = onFreePorts(1, '127.0.0.1', async () => {
      attempts++;
      throw new Error('the process crashed');
    });
    await expect(result).rejects.toThrow('the process crashed');
    expect(attempts).toBe(1);
  });
});

describe('closedPort', () => {
  it('names a port that refuses a connection', async () => {
    const socket = net.connect(await closedPort('::1'), '::1');
    const [err] = (await once(socket, 'error')) as [NodeJS.ErrnoException];
    expect(err.code).toBe('ECONNREFUSED');
  });
});

describe('no suite probes a port for a process of its own (#666)', () => {
  it('the only free-port probe under __tests__ is in utils/ports.ts', () => {
    const root = path.resolve(__dirname, '..');
    // A probe is a listen on port 0 that is closed again for its number; the name is how
    // the four copies this replaced were found.
    const hits = execFileSync(
      'git',
      ['grep', '--untracked', '-lE', '(function|const|let) +free[A-Za-z]*Port', '--', '*.ts'],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(hits).toEqual(['utils/ports.ts']);
  });
});
