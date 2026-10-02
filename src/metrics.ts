import { createServer, type Server } from 'http';
import { isIP } from 'net';

/**
 * Prometheus metrics (#275): counters, gauges and histograms rendered in the text
 * exposition format (version 0.0.4), with no dependency. One process-wide registry,
 * `metrics`, like prom-client's default one: `iris connect` and `iris worker` are
 * separate processes, each serving its own on a loopback port (`serveMetrics`).
 *
 * Labels must have bounded values: method, outcome, kind, provider. Never an org id,
 * a URL or anything a client chooses freely; each distinct label set is a series kept
 * for the life of the process.
 */

export type Labels = Record<string, string>;

const escapeLabel = (v: string) =>
  v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const escapeHelp = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

function formatValue(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? '+Inf' : '-Inf';
  return String(n);
}

/** One series per distinct label set, keyed independently of the caller's key order. */
const seriesKey = (labels: Labels) => JSON.stringify(Object.entries(labels).sort());

export class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>();
  /** Adds `by` (default 1). A negative or non-finite amount is ignored: counters only go up. */
  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) return;
    const key = seriesKey(labels);
    const s = this.series.get(key) ?? { labels, value: 0 };
    s.value += by;
    this.series.set(key, s);
  }
  /** The current value of one series (0 if it has none). */
  get(labels: Labels = {}): number {
    return this.series.get(seriesKey(labels))?.value ?? 0;
  }
  lines(name: string): string[] {
    return [...this.series.values()].map(
      (s) => `${name}${formatLabels(s.labels)} ${formatValue(s.value)}`,
    );
  }
}

export class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(private readonly buckets: number[]) {}
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(labels);
    const s = this.series.get(key) ?? {
      labels,
      counts: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    this.buckets.forEach((le, i) => {
      if (value <= le) s.counts[i]++;
    });
    s.sum += value;
    s.count++;
    this.series.set(key, s);
  }
  lines(name: string): string[] {
    const out: string[] = [];
    for (const s of this.series.values()) {
      // Each bucket counts every observation <= its bound, so they are cumulative.
      this.buckets.forEach((le, i) =>
        out.push(
          `${name}_bucket${formatLabels({ ...s.labels, le: formatValue(le) })} ${s.counts[i]}`,
        ),
      );
      out.push(`${name}_bucket${formatLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
      out.push(`${name}_sum${formatLabels(s.labels)} ${formatValue(s.sum)}`);
      out.push(`${name}_count${formatLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

/** A gauge is read when scraped: one value, or one per label set. */
export type GaugeCollect = () => number | Array<[Labels, number]>;

interface Family {
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  lines(name: string): string[];
}

export class Registry {
  private readonly families = new Map<string, Family & { metric?: unknown }>();

  /** The counter `name`, created on first use. */
  counter(name: string, help: string): Counter {
    const existing = this.families.get(name);
    if (existing) return existing.metric as Counter;
    const c = new Counter();
    this.families.set(name, { help, type: 'counter', lines: (n) => c.lines(n), metric: c });
    return c;
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    const existing = this.families.get(name);
    if (existing) return existing.metric as Histogram;
    const h = new Histogram([...buckets].sort((a, b) => a - b));
    this.families.set(name, { help, type: 'histogram', lines: (n) => h.lines(n), metric: h });
    return h;
  }

  /** Registers (or replaces) a gauge read at scrape time. A collector that throws is skipped. */
  gauge(name: string, help: string, collect: GaugeCollect): void {
    this.families.set(name, {
      help,
      type: 'gauge',
      lines: (n) => {
        const v = collect();
        const series: Array<[Labels, number]> = typeof v === 'number' ? [[{}, v]] : v;
        return series.map(([labels, value]) => `${n}${formatLabels(labels)} ${formatValue(value)}`);
      },
    });
  }

  /** The text exposition format: `# HELP`, `# TYPE`, then the samples, per family. */
  render(): string {
    const out: string[] = [];
    for (const [name, family] of this.families) {
      let lines: string[];
      try {
        lines = family.lines(name);
      } catch {
        continue;
      }
      out.push(`# HELP ${name} ${escapeHelp(family.help)}`, `# TYPE ${name} ${family.type}`);
      out.push(...lines);
    }
    return out.join('\n') + '\n';
  }
}

export const metrics = new Registry();

/** Latency buckets (seconds) for requests: 5 ms to 2 minutes. */
export const REQUEST_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];

/** Whether `host` is a loopback address (or `localhost`). */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

/**
 * Serves `GET /metrics` on its own listener, loopback only (#275). Metrics are never
 * public: a non-loopback host is refused, and nginx never routes to this port. In a
 * container that loopback is the container's own, so the watchdog scrapes through
 * `docker exec` (deploy/watchdog.sh) and no port is published.
 *
 * Also registers `iris_up` and `iris_start_time_seconds`.
 * @throws when `host` is not loopback; rejects when the port cannot be bound
 */
export async function serveMetrics(
  port: number,
  host = '127.0.0.1',
  registry: Registry = metrics,
): Promise<Server> {
  if (!isLoopbackHost(host)) {
    throw new Error(`The metrics listener binds loopback only, not ${host}`);
  }
  registry.gauge('iris_up', 'Whether the process is serving (always 1 when scraped)', () => 1);
  const started = Date.now() / 1000 - process.uptime();
  registry.gauge('iris_start_time_seconds', 'Process start time, Unix seconds', () => started);
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
      return;
    }
    const body = registry.render();
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Scrapes must not keep a stopping process alive.
  server.unref();
  return server;
}
