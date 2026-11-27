#!/usr/bin/env node
/**
 * The public status page's uptime check (#317): the two probes of the runbook's "Uptime
 * from outside", run from GitHub Actions (`.github/workflows/status.yml`), and the static
 * page they feed (GitHub Pages).
 *
 *   STATUS_PROBE_URL=https://<portal host> STATUS_OUT=_site \
 *     [STATUS_PREVIOUS_URL=https://<pages site>/status.json] node scripts/status-probe.js
 *
 * - Portal: `GET /` answers 200, or redirects to `/login` on the same origin.
 * - API: `GET /v1/jobs/x` without a key answers 401 (iris-api behind the ingress).
 *
 * The history is the previous run's `status.json`, read back from the published site, so
 * nothing is committed. The probe URL is never printed or published: Actions logs and the
 * page are public, and the repo names no operator host (#329). Plain CommonJS with no
 * dependencies, like scripts/check-pack.js.
 */
const fs = require('fs');
const path = require('path');

/** Checks kept on the page: a day at the five-minute schedule. */
const MAX_CHECKS = 288;
const TIMEOUT_MS = 10_000;
/** A failed probe is tried once more after this long: one dropped packet is not an outage. */
const RETRY_DELAY_MS = 5_000;

const COMPONENTS = [
  ['portal', 'Portal'],
  ['api', 'API'],
];

/** The portal is up on a 200, or on a redirect to `/login` on its own origin. */
function judgePortal(status, location, base) {
  if (status === 200) return true;
  if (status < 300 || status > 399 || !location) return false;
  const target = URL.parse(location, base);
  return target !== null && target.origin === new URL(base).origin && target.pathname === '/login';
}

/** iris-api is up when it refuses a request without a key: 401, not a 502 from the ingress. */
const judgeApi = (status) => status === 401;

/** One request: its status and `Location`, or what went wrong (never the URL). */
async function request(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    return { status: res.status, location: res.headers.get('location') };
  } catch (error) {
    return { status: 0, problem: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

/** Both probes against `base`, each retried once on failure. `{ portal, api }`, booleans. */
async function probe(base, { retryDelayMs = RETRY_DELAY_MS } = {}) {
  const once = async () => {
    const [portal, api] = await Promise.all([
      request(new URL('/', base)),
      request(new URL('/v1/jobs/x', base)),
    ]);
    return {
      portal: judgePortal(portal.status, portal.location, base),
      api: judgeApi(api.status),
      detail: {
        portal: portal.problem ?? String(portal.status),
        api: api.problem ?? String(api.status),
      },
    };
  };
  const first = await once();
  if (first.portal && first.api) return first;
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return once();
}

/**
 * The checks to publish: the previous ones that are well formed, then this one, at most
 * `MAX_CHECKS`. The previous file comes back from a public URL, so nothing in it is
 * trusted: an entry with anything but an ISO time and two booleans is dropped.
 */
function nextChecks(previous, check, max = MAX_CHECKS) {
  const kept = (Array.isArray(previous?.checks) ? previous.checks : []).filter(
    (c) =>
      c !== null &&
      typeof c === 'object' &&
      typeof c.time === 'string' &&
      !Number.isNaN(Date.parse(c.time)) &&
      new Date(c.time).toISOString() === c.time &&
      typeof c.portal === 'boolean' &&
      typeof c.api === 'boolean',
  );
  return [...kept.map(({ time, portal, api }) => ({ time, portal, api })), check].slice(-max);
}

/** Per component: up now, since when, and the share of the kept checks it was up. */
function summarize(checks) {
  return COMPONENTS.map(([key, name]) => {
    const up = checks[checks.length - 1][key];
    let since = checks.length - 1;
    while (since > 0 && checks[since - 1][key] === up) since--;
    const upCount = checks.filter((c) => c[key]).length;
    return {
      key,
      name,
      up,
      since: checks[since].time,
      uptime: Math.floor((upCount / checks.length) * 1000) / 10,
    };
  });
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** The static page. Every value is our own (times, numbers), escaped anyway. */
function renderPage(checks) {
  const rows = summarize(checks);
  const allUp = rows.every((r) => r.up);
  const last = checks[checks.length - 1].time;
  const headline = allUp
    ? 'All systems operational'
    : rows.every((r) => !r.up)
      ? 'Service unavailable'
      : 'Partial outage';
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row">${escapeHtml(r.name)}</th>` +
        `<td class="${r.up ? 'up' : 'down'}">${r.up ? 'Operational' : 'Down'}</td>` +
        `<td><time datetime="${escapeHtml(r.since)}">${escapeHtml(r.since)}</time></td>` +
        `<td>${escapeHtml(r.uptime.toFixed(1))}%</td></tr>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IRIS status</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111827}
h1{font-size:1.4rem}.banner{padding:.75rem 1rem;border-radius:.5rem;font-weight:600}
.ok{background:#dcfce7;color:#14532d}.bad{background:#fee2e2;color:#7f1d1d}
table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.4rem;border-bottom:1px solid #e5e7eb}
.up{color:#15803d}.down{color:#b91c1c;font-weight:600}p{color:#4b5563;font-size:.9rem}
</style>
</head>
<body>
<h1>IRIS status</h1>
<p class="banner ${allUp ? 'ok' : 'bad'}" role="status">${headline}</p>
<table>
<thead><tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Since (UTC)</th><th scope="col">Up, last ${checks.length} check(s)</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
<p>Last checked <time datetime="${escapeHtml(last)}">${escapeHtml(last)}</time> UTC. Checks run from outside our servers, about every five minutes (GitHub Actions; a run can be late). The record covers the last ${checks.length} check(s), since <time datetime="${escapeHtml(checks[0].time)}">${escapeHtml(checks[0].time)}</time>.</p>
</body>
</html>
`;
}

/** The previously published `status.json`, or `null` (first run, not published, unreadable). */
async function readPrevious(url) {
  if (!url) return null;
  try {
    // Pages serves status.json with `Cache-Control: max-age=600`, and runs are five minutes
    // apart: without a cache-buster a run reads a copy missing the last checks and
    // republishes the history without them (glm review).
    const fresh = new URL(url);
    fresh.searchParams.set('t', String(Date.now()));
    const res = await fetch(fresh, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function main(env = process.env, { retryDelayMs } = {}) {
  const base = env.STATUS_PROBE_URL?.trim();
  const target = base ? URL.parse(base) : null;
  if (!target || !/^https?:$/.test(target.protocol)) {
    console.error('STATUS_PROBE_URL must be the http(s) URL of the portal');
    return 2;
  }
  const out = env.STATUS_OUT || '_site';
  const result = await probe(target.origin, { retryDelayMs });
  const checks = nextChecks(await readPrevious(env.STATUS_PREVIOUS_URL), {
    time: new Date().toISOString(),
    portal: result.portal,
    api: result.api,
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'status.json'), `${JSON.stringify({ checks })}\n`);
  fs.writeFileSync(path.join(out, 'index.html'), renderPage(checks));
  const healthy = result.portal && result.api;
  // Status codes only, never the URL: the Actions log is public.
  console.log(
    `portal ${result.portal ? 'up' : 'DOWN'} (${result.detail.portal}), ` +
      `api ${result.api ? 'up' : 'DOWN'} (${result.detail.api}); ${checks.length} check(s) kept`,
  );
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `healthy=${healthy}\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => (process.exitCode = code));
}

module.exports = {
  judgePortal,
  judgeApi,
  probe,
  nextChecks,
  summarize,
  renderPage,
  main,
  MAX_CHECKS,
};
