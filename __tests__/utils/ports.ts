/**
 * Ports for suites that start a real process (#666).
 *
 * A port probed free and then handed to a child can be bound by another Jest worker before
 * the child listens ("address already in use"; several suites listen on port 0 at once).
 * So: `iris connect` is started on port 0 and its port read back with `connectPort`, and a
 * process that cannot say which port it chose (nginx, Next, `--metrics-port`) is started
 * through `onFreePorts`, which starts it again on fresh ports when it found one taken.
 */

import { spawn, spawnSync } from 'child_process';
import { once } from 'events';
import * as net from 'net';

const LISTENING = /listening on ws:\/\/\S+:(\d+)/;

/** The port `iris connect 0` bound, from its output so far; undefined until it listens. */
export function connectPort(output: string): number | undefined {
  const match = LISTENING.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** Thrown by an `onFreePorts` start whose process found a port it was given taken. */
export class PortTaken extends Error {}

const PORT_ATTEMPTS = 5;

/** Ports free on `host` a moment ago; probed together, so they differ from each other. */
async function freePorts(count: number, host: string): Promise<number[]> {
  const probes = Array.from({ length: count }, () => net.createServer().listen(0, host));
  await Promise.all(probes.map((probe) => once(probe, 'listening')));
  const ports = probes.map((probe) => (probe.address() as net.AddressInfo).port);
  await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  return ports;
}

/**
 * Runs `start` with `count` ports nothing listened on a moment ago. `start` throws
 * `PortTaken` when its process reports one was taken in the meantime; it is then run again
 * with fresh ports, five times at most, so it must be able to start over (remove the
 * exited container of the attempt before).
 */
export async function onFreePorts<T>(
  count: number,
  host: string,
  start: (ports: number[]) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start(await freePorts(count, host));
    } catch (err) {
      if (!(err instanceof PortTaken) || attempt === PORT_ATTEMPTS) throw err;
    }
  }
}

/**
 * A port on `host` nothing listens on. For a test of a refused connection, or a port a
 * process is expected not to reach: never one a process must come up on (`onFreePorts`).
 */
export async function closedPort(host: string): Promise<number> {
  return (await freePorts(1, host))[0];
}

/**
 * Watches a container a readiness poll is waiting on. Whoever took its port may accept a
 * connection and never answer, so a poll that only looks at the container after a failed
 * request can wait for good: pass `signal` to the request, and it is cut when the
 * container exits. `output()` is everything it printed (nginx and Node report a bind
 * failure on stderr); `stop()` ends the watch.
 */
export function containerExit(name: string): {
  signal: AbortSignal;
  output: () => string;
  stop: () => void;
} {
  const exited = new AbortController();
  const waiter = spawn('docker', ['wait', name], { stdio: 'ignore' });
  waiter.on('exit', () => exited.abort());
  return {
    signal: exited.signal,
    output: () => {
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
      return logs.stdout + logs.stderr;
    },
    stop: () => void waiter.kill(),
  };
}
