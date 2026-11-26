/**
 * The status page's uptime check (#317): the runbook's two probes against a real local
 * server playing the portal and the ingress, the history read back from a "published"
 * status.json, and the page it writes; and the workflow that runs it, which must do
 * nothing while unconfigured.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { closedPort } from './utils/ports';

interface Check {
  time: string;
  portal: boolean;
  api: boolean;
}
const probeScript = require('../scripts/status-probe.js') as {
  judgePortal(status: number, location: string | null, base: string): boolean;
  judgeApi(status: number): boolean;
  probe(base: string, o?: { retryDelayMs?: number }): Promise<{ portal: boolean; api: boolean }>;
  nextChecks(previous: unknown, check: Check, max?: number): Check[];
  summarize(checks: Check[]): Array<{ key: string; up: boolean; since: string; uptime: number }>;
  renderPage(checks: Check[]): string;
  main(env: NodeJS.ProcessEnv, o?: { retryDelayMs?: number }): Promise<number>;
  MAX_CHECKS: number;
};
const { judgePortal, judgeApi, probe, nextChecks, summarize, renderPage, main, MAX_CHECKS } =
  probeScript;

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://portal.example.com';

describe('the probes (runbook "Uptime from outside")', () => {
  it('takes the portal as up on a 200 or a same-origin redirect to /login only', () => {
    expect(judgePortal(200, null, BASE)).toBe(true);
    expect(judgePortal(307, '/login', BASE)).toBe(true);
    expect(judgePortal(302, `${BASE}/login?next=%2F`, BASE)).toBe(true);
    expect(judgePortal(302, 'https://evil.example/login', BASE)).toBe(false);
    expect(judgePortal(302, '/dashboard', BASE)).toBe(false);
    expect(judgePortal(302, null, BASE)).toBe(false);
    for (const status of [0, 204, 404, 500, 502, 503]) {
      expect(judgePortal(status, null, BASE)).toBe(false);
    }
  });

  it('takes the API as up on 401 only: a 502 or 200 means the ingress or the auth is wrong', () => {
    expect(judgeApi(401)).toBe(true);
    for (const status of [0, 200, 403, 404, 426, 502, 503]) expect(judgeApi(status)).toBe(false);
  });
});

describe('probing a server', () => {
  let server: http.Server;
  let base: string;
  let behaviour: { root: number; api: number; hits: number };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      behaviour.hits++;
      if (req.url === '/v1/jobs/x') {
        res.writeHead(behaviour.api).end();
      } else if (req.url === '/') {
        if (behaviour.root === 307) res.writeHead(307, { location: '/login' }).end();
        else res.writeHead(behaviour.root).end('<html></html>');
      } else res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => (behaviour = { root: 307, api: 401, hits: 0 }));
  afterAll(() => new Promise((r) => server.close(r)));

  it('reports both up, without a retry, when the portal redirects and the API refuses', async () => {
    expect(await probe(base, { retryDelayMs: 0 })).toMatchObject({ portal: true, api: true });
    expect(behaviour.hits).toBe(2);
  });

  it('retries once, and reports what is still down', async () => {
    behaviour.api = 502;
    expect(await probe(base, { retryDelayMs: 0 })).toMatchObject({ portal: true, api: false });
    expect(behaviour.hits).toBe(4);
  });

  it('reports an unreachable server as down', async () => {
    // [::1]: a closed 127.0.0.1 port hangs on WSL instead of refusing (#382).
    const port = await closedPort('::1');
    expect(await probe(`http://[::1]:${port}`, { retryDelayMs: 0 })).toMatchObject({
      portal: false,
      api: false,
    });
  });

  it('writes the page and status.json, carries the history forward, and never prints the URL', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-status-'));
    const githubOutput = path.join(out, 'github-output');
    // The previous publication, served like the Pages site would serve it.
    const previous = { checks: [{ time: '2026-11-26T10:00:00.000Z', portal: true, api: false }] };
    const pages = http.createServer((_req, res) => res.end(JSON.stringify(previous)));
    pages.listen(0, '127.0.0.1');
    await once(pages, 'listening');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      behaviour.root = 200;
      const code = await main({
        STATUS_PROBE_URL: `${base}/`,
        STATUS_PREVIOUS_URL: `http://127.0.0.1:${(pages.address() as AddressInfo).port}/status.json`,
        STATUS_OUT: out,
        GITHUB_OUTPUT: githubOutput,
      });
      expect(code).toBe(0);
      const { checks } = JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'));
      expect(checks).toHaveLength(2);
      expect(checks[0]).toEqual(previous.checks[0]);
      expect(checks[1]).toMatchObject({ portal: true, api: true });
      const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
      expect(page).toContain('All systems operational');
      expect(page).not.toContain('127.0.0.1');
      expect(fs.readFileSync(githubOutput, 'utf8')).toBe('healthy=true\n');
      const printed = log.mock.calls.flat().join('\n');
      expect(printed).toMatch(/portal up \(200\), api up \(401\)/);
      expect(printed).not.toContain('127.0.0.1');

      // Down, and no previous file (the first run): a page saying so, healthy=false.
      behaviour.api = 503;
      await main(
        { STATUS_PROBE_URL: base, STATUS_OUT: out, GITHUB_OUTPUT: githubOutput },
        { retryDelayMs: 0 },
      );
      expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('Partial outage');
      expect(fs.readFileSync(githubOutput, 'utf8')).toBe('healthy=true\nhealthy=false\n');
    } finally {
      log.mockRestore();
      pages.close();
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('refuses a missing or non-http target without probing anything', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const url of [undefined, '', 'file:///etc/passwd', 'not a url']) {
        expect(await main({ STATUS_PROBE_URL: url, STATUS_OUT: os.tmpdir() })).toBe(2);
      }
      expect(behaviour.hits).toBe(0);
    } finally {
      error.mockRestore();
    }
  });
});

describe('the history', () => {
  const at = (minute: number, portal = true, api = true): Check => ({
    time: new Date(Date.UTC(2026, 10, 26, 10, minute)).toISOString(),
    portal,
    api,
  });

  it('drops malformed entries from the previous file and keeps at most MAX_CHECKS', () => {
    const now = at(59);
    const junk = [null, 1, { time: 'yesterday', portal: true, api: true }, { time: at(1).time }];
    const hostile = { time: at(2).time, portal: true, api: true, html: '<script>' };
    expect(nextChecks({ checks: [...junk, hostile] }, now)).toEqual([
      { time: at(2).time, portal: true, api: true },
      now,
    ]);
    for (const previous of [null, 'x', { checks: 'x' }, []]) {
      expect(nextChecks(previous, now)).toEqual([now]);
    }
    const many = { checks: Array.from({ length: MAX_CHECKS + 5 }, (_, i) => at(i % 59)) };
    const kept = nextChecks(many, now);
    expect(kept).toHaveLength(MAX_CHECKS);
    expect(kept[kept.length - 1]).toBe(now);
  });

  it('says since when each component is in its state, and its uptime share', () => {
    const checks = [at(0), at(5, true, false), at(10, true, false), at(15)];
    expect(summarize(checks)).toEqual([
      { key: 'portal', name: 'Portal', up: true, since: at(0).time, uptime: 100 },
      { key: 'api', name: 'API', up: true, since: at(15).time, uptime: 50 },
    ]);
    expect(summarize([at(0), at(5, false, false)])[0]).toMatchObject({
      up: false,
      since: at(5).time,
    });
  });

  it('renders the overall state', () => {
    expect(renderPage([at(0)])).toContain('All systems operational');
    expect(renderPage([at(0, false, true)])).toContain('Partial outage');
    const down = renderPage([at(0, false, false)]);
    expect(down).toContain('Service unavailable');
    expect(down).toContain('<td class="down">Down</td>');
  });
});

describe('the workflow (.github/workflows/status.yml)', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/status.yml'), 'utf8');
  const job = (name: string) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
  };

  it('runs on a schedule and by hand, never on push or pull requests', () => {
    expect(workflow).toMatch(/schedule:\n\s+- cron: '\*\/5 \* \* \* \*'/);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s+(push|pull_request\w*):/m);
  });

  // Unconfigured (no secret, Pages not enabled) it must succeed doing nothing: no Pages
  // call, and no reference to the github-pages environment, which would create it.
  it('does nothing until the STATUS_PROBE_URL secret is set', () => {
    const config = job('config');
    expect(config).toContain('STATUS_PROBE_URL: ${{ secrets.STATUS_PROBE_URL }}');
    expect(config).not.toMatch(/environment:|uses:|pages:/);
    const publish = job('publish');
    expect(publish).toMatch(/^ {4}if: needs\.config\.outputs\.enabled == 'true'$/m);
    expect(publish).toContain('name: github-pages');
    const steps = workflow.replace(/^\s*#.*$/gm, '');
    expect(steps.match(/github-pages|configure-pages|deploy-pages/g)).toHaveLength(
      (publish.match(/github-pages|configure-pages|deploy-pages/g) ?? []).length,
    );
  });

  it('pins every action by commit, and grants Pages rights only to the jobs that use them', () => {
    for (const [, ref] of workflow.matchAll(/uses: [\w./-]+@(\S+)/g)) {
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(job('publish')).toMatch(/pages: write/);
    expect(job('publish')).toMatch(/id-token: write/);
  });

  it('fails the run after publishing when a probe is down, so the owner is notified', () => {
    const publish = job('publish');
    const deployAt = publish.indexOf('actions/deploy-pages');
    expect(deployAt).toBeGreaterThan(0);
    expect(deployAt).toBeLessThan(publish.indexOf("if: steps.probe.outputs.healthy != 'true'"));
  });
});
