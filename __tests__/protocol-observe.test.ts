/**
 * The RPC `observe` method (#312): what the session's page shows, as an ARIA snapshot and
 * a screenshot, metered per call.
 *
 * Test strategy: a real server and a real Chromium. The tenant seam (`authenticate`) gives
 * the connection a principal, so usage is recorded through `startServer({ usage })` into
 * an in-test list; the Postgres side of the `observation` kind is in usage-ledger.test.ts.
 * A fill types a credential from a reference into a plain text field, whose value a
 * screenshot would otherwise show (#352's comment on this issue).
 */

import { once } from 'events';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import sharp from 'sharp';
import WebSocket, { type WebSocketServer } from 'ws';
import type { UsageEvent } from '../src/billing/usage';
import { startServer } from '../src/protocol';

const SECRET = 'correct-horse-battery-staple';
const PAGE = `<!doctype html><html lang="en"><head><title>Sign in</title>
<style>body { margin: 0; background: #fff } #user { position: absolute; left: 0; top: 0;
width: 400px; height: 60px; font-size: 24px; border: 0; background: #fff; color: #000 }</style>
</head><body><label>User <input id="user" type="text"></label><h1 style="margin-top: 120px">Welcome</h1></body></html>`;

/** A contenteditable target, which a fill also types into (codex review). */
const EDITABLE = `<!doctype html><html lang="en"><head><title>Note</title>
<style>body { margin: 0; background: #fff } #note { position: absolute; left: 0; top: 0;
width: 400px; height: 60px; font-size: 24px; color: #000 }</style>
</head><body><div id="note" contenteditable="true" aria-label="Note"></div></body></html>`;

let site: Server;
let siteUrl = '';
let wss: WebSocketServer;
let url = '';
const usage: Array<{ orgId: string; events: UsageEvent[] }> = [];

beforeAll(async () => {
  site = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/note' ? EDITABLE : PAGE);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  wss = startServer(0, {
    authenticate: {
      verify: async () => ({ orgId: 'org-a', keyId: 'key-a' }),
      recheck: async () => true,
    },
    usage: {
      record: async (orgId, events) => {
        usage.push({ orgId, events });
      },
    },
  });
  await once(wss, 'listening');
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => site.close(resolve));
});

async function session() {
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer iris_test' } });
  await once(ws, 'open');
  let id = 0;
  const call = (method: string, params?: object): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      const mine = ++id;
      const on = (data: WebSocket.Data) => {
        const reply = JSON.parse(String(data));
        if (reply.id !== mine) return;
        ws.off('message', on);
        resolve(reply);
      };
      ws.on('message', on);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }));
    });
  return { ws, call };
}

it('refuses before there is a page, and refuses unknown params', async () => {
  const { ws, call } = await session();
  try {
    await call('launchBrowser');
    expect((await call('observe')).error).toMatchObject({ code: -32000 });
    expect((await call('observe', { fullPage: true })).error).toMatchObject({ code: -32602 });
  } finally {
    ws.close();
  }
});

it('returns the snapshot and a masked screenshot, without the typed credential, metered', async () => {
  const { ws, call } = await session();
  try {
    await call('launchBrowser');
    const acted = await call('executeBrowserAction', {
      actions: [
        { type: 'navigate', url: siteUrl },
        { type: 'fill', selector: '#user', text: '{{secret:PW}}' },
      ],
      secrets: { PW: SECRET },
    });
    expect(acted.result).toMatchObject({ success: true });
    usage.length = 0;

    const { result } = await call('observe');
    expect(result.snapshot).toContain('TITLE: Sign in');
    expect(result.snapshot).toContain('Welcome');
    expect(result.snapshot).not.toContain(SECRET);

    const shot = Buffer.from(result.screenshot, 'base64');
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    // Playwright paints a masked element magenta (#FF00FF); the field sits at the top left.
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const [r, g, b] = at(200, 30);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeGreaterThan(200);
    // Elsewhere the page is white: the mask covers the field, not the page.
    expect(at(200, 300).every((c) => c > 200)).toBe(true);

    const text = await call('observe', { screenshot: false });
    expect(text.result.screenshot).toBeUndefined();
    expect(usage.map((u) => [u.orgId, u.events[0].kind])).toEqual([
      ['org-a', 'observation'],
      ['org-a', 'observation'],
    ]);
  } finally {
    ws.close();
  }
}, 60_000);

it('masks a credential typed into a contenteditable element too', async () => {
  const { ws, call } = await session();
  try {
    await call('launchBrowser');
    const acted = await call('executeBrowserAction', {
      actions: [
        { type: 'navigate', url: `${siteUrl}note` },
        { type: 'fill', selector: '#note', text: '{{secret:PW}}' },
      ],
      secrets: { PW: SECRET },
    });
    expect(acted.result).toMatchObject({ success: true });
    const { result } = await call('observe');
    expect(result.snapshot).not.toContain(SECRET);
    const { data, info } = await sharp(Buffer.from(result.screenshot, 'base64'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const i = (30 * info.width + 200) * info.channels;
    expect([data[i] > 200, data[i + 1] < 60, data[i + 2] > 200]).toEqual([true, true, true]);
  } finally {
    ws.close();
  }
}, 60_000);

describe('executor.secretFields', () => {
  const { ActionExecutor } = require('../src/executor') as typeof import('../src/executor');
  const { mapSecrets } =
    require('../src/credential-refs') as typeof import('../src/credential-refs');
  const executor = new ActionExecutor({ retryAttempts: 0, timeout: 5_000, trackContext: false });
  afterAll(() => executor.cleanup());

  it('masks every field past the first 100, unread (PR bot review)', async () => {
    const page = await executor.createPage();
    try {
      const inputs = Array.from({ length: 105 }, (_, i) => `<input id="i${i}" aria-label="f${i}">`);
      await page.setContent(`<!doctype html><title>Many</title>${inputs.join('')}`);
      const filled = await executor.executeAction(
        { type: 'fill', selector: '#i103', text: '{{secret:PW}}' },
        page,
        mapSecrets({ PW: SECRET }),
      );
      expect(filled.success).toBe(true);
      const ids = await Promise.all(
        (await executor.secretFields(page))!.map((f) => f.getAttribute('id')),
      );
      expect(ids).toEqual(['i100', 'i101', 'i102', 'i103', 'i104']);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('masks a credential typed into a field inside an iframe (PR bot review)', async () => {
    const page = await executor.createPage();
    try {
      await page.setContent(
        '<!doctype html><title>Frame</title><iframe name="app" srcdoc="<input id=token aria-label=token>"></iframe>',
      );
      await page.frameLocator('iframe[name=app]').locator('#token').waitFor();
      const filled = await executor.executeAction(
        {
          type: 'fill',
          // The selector frameLocator() compiles to: a fill can reach a field inside an iframe.
          selector: 'iframe[name=app] >> internal:control=enter-frame >> #token',
          text: '{{secret:PW}}',
        },
        page,
        mapSecrets({ PW: SECRET }),
      );
      expect(filled.success).toBe(true);
      const masked = (await executor.secretFields(page))!;
      expect(await Promise.all(masked.map((f) => f.getAttribute('id')))).toEqual(['token']);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('answers null for a page that does not answer, so no unmasked screenshot is taken', async () => {
    const page = await executor.createPage();
    try {
      await page.setContent('<!doctype html><title>Hung</title><input id="a" aria-label="a">');
      await executor.executeAction(
        { type: 'fill', selector: '#a', text: '{{secret:PW}}' },
        page,
        mapSecrets({ PW: SECRET }),
      );
      await page.evaluate('setTimeout(() => { for (;;) {} }, 0)');
      expect(await executor.secretFields(page)).toBeNull();
    } finally {
      await page.close().catch(() => undefined);
    }
  }, 60_000);
});
