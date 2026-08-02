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
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installUrlPolicyGuard, guardedGoto, MAX_REDIRECT_HOPS } from '../src/url-policy-guard';

const METADATA = 'http://169.254.169.254/latest/meta-data/';

const page = (title: string, body = '') =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

describe('URL policy guard', () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let requestLog: string[];

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
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  let context: Awaited<ReturnType<Browser['newContext']>>;
  let p: Page;

  beforeEach(async () => {
    requestLog = [];
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

      await expect(guardedGoto(p, `${origin}/loop`)).rejects.toThrow(/exceeded \d+ redirects/);
      // Bounded: one request per hop, plus the initial one.
      expect(requestLog.filter((u) => u === '/loop').length).toBeLessThanOrEqual(
        MAX_REDIRECT_HOPS + 2,
      );
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
