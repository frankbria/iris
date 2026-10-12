/**
 * Credential references for fill values (issue #352).
 *
 * The executor and agent-loop cases run real Chromium: the two leaks this closes
 * (a failed fill's error quotes the value; the ARIA digest shows typed values,
 * password fields included) are Playwright behaviour a mocked page cannot show.
 */

import { chromium, Browser, Page } from 'playwright';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import {
  CredentialReferenceError,
  envSecrets,
  mapSecrets,
  resolveFillText,
  scrubValues,
} from '../src/credential-refs';
import { ActionExecutor } from '../src/executor';
import { observePage, runAgentLoop, MAX_DIGEST_CHARS } from '../src/agent-loop';
import * as aiClient from '../src/ai-client';
import type { Action } from '../src/actions';

const SECRET = 'hunter2-Zq9';

describe('credential references', () => {
  describe('resolveFillText', () => {
    const source = mapSecrets({ LOGIN_PW: SECRET });

    it('resolves a whole-value reference', () => {
      expect(resolveFillText('{{secret:LOGIN_PW}}', source)).toEqual({
        value: SECRET,
        fromReference: true,
      });
    });

    it('leaves a literal value alone', () => {
      expect(resolveFillText('alice', source)).toEqual({ value: 'alice', fromReference: false });
    });

    it('refuses an unknown name, naming the reference and not any value', () => {
      expect(() => resolveFillText('{{secret:NOPE}}', source)).toThrow(CredentialReferenceError);
      expect(() => resolveFillText('{{secret:NOPE}}', source)).toThrow(/NOPE/);
    });

    // Typed literally, a half-written reference would be a silent wrong run.
    it.each(['pw: {{secret:LOGIN_PW}}', '{{secret:LOGIN_PW}}!', '{{secret:}}', '{{secret:1X}}'])(
      'refuses a reference that is not the whole value: %s',
      (text) => {
        expect(() => resolveFillText(text, source)).toThrow(CredentialReferenceError);
      },
    );

    // #513: a credential can be bound to the origin it belongs to.
    it('resolves a bound reference on its own origin only, naming it when refused', () => {
      const bound = mapSecrets({
        LOGIN_PW: { value: SECRET, origin: 'https://shop.example/login' },
      });
      expect(resolveFillText('{{secret:LOGIN_PW}}', bound, 'https://shop.example')).toEqual({
        value: SECRET,
        fromReference: true,
      });
      for (const origin of ['https://evil.example', 'http://shop.example', 'null', undefined]) {
        expect(() => resolveFillText('{{secret:LOGIN_PW}}', bound, origin)).toThrow(
          /\{\{secret:LOGIN_PW\}\} is bound to https:\/\/shop\.example/,
        );
      }
    });

    // #513: a value this short cannot be kept out of results without cutting every match.
    it('refuses a value shorter than 4 characters, naming the reference only', () => {
      const short = mapSecrets({ PIN: '123' });
      expect(() => resolveFillText('{{secret:PIN}}', short)).toThrow(
        /\{\{secret:PIN\}\}.*at least 4/,
      );
      expect(() => resolveFillText('{{secret:PIN}}', short)).not.toThrow(/123/);
    });

    it('does not resolve inherited object keys', () => {
      expect(() => resolveFillText('{{secret:constructor}}', mapSecrets({}))).toThrow(
        CredentialReferenceError,
      );
    });
  });

  it('envSecrets reads IRIS_SECRET_<NAME> only', () => {
    const source = envSecrets({ IRIS_SECRET_PW: 'a', PW: 'b' });
    expect(source('PW')).toBe('a');
    expect(source('OTHER')).toBeUndefined();
  });

  it('envSecrets binds a value to IRIS_SECRET_ORIGIN_<NAME>, as an origin (#513)', () => {
    const source = envSecrets({
      IRIS_SECRET_PW: SECRET,
      IRIS_SECRET_ORIGIN_PW: 'https://shop.example/any/path',
      IRIS_SECRET_BAD: SECRET,
      IRIS_SECRET_ORIGIN_BAD: 'not a url',
    });
    expect(source('PW')).toEqual({ value: SECRET, origin: 'https://shop.example' });
    expect(() => resolveFillText('{{secret:BAD}}', source, 'https://shop.example')).toThrow(
      /IRIS_SECRET_ORIGIN_BAD is not an http\(s\) origin/,
    );
  });

  // An ARIA snapshot collapses whitespace; Playwright's call log splits lines with ANSI codes.
  it('scrubValues also cuts the collapsed and per-line forms of a value', () => {
    expect(scrubValues('textbox: aq7 bz9', ['  aq7\n bz9 '])).toBe('textbox: <redacted>');
    expect(scrubValues('fill("aa1\u001b[22m\n\u001b[2mbb2")', ['aa1\nbb2'])).toBe(
      'fill("<redacted>\u001b[22m\n\u001b[2m<redacted>")',
    );
  });

  it('scrubValues cuts the URL-encoded forms of a value', () => {
    expect(scrubValues('/?pw=p%26w+d&x=1', ['p&w d'])).toBe('/?pw=<redacted>&x=1');
    // A form escapes !'()~, which encodeURIComponent leaves bare.
    expect(scrubValues('/?pw=hunter2%21%28x%29', ['hunter2!(x)'])).toBe('/?pw=<redacted>');
  });

  // Legal JSON on the RPC, and encodeURIComponent throws on it.
  it('scrubValues survives a value with a lone surrogate', () => {
    const lone = String.fromCharCode(0xd800) + 'b';
    expect(scrubValues(`a ${lone} c`, [lone])).toBe('a <redacted> c');
  });

  it('refuses a reference whatever its case', () => {
    expect(() => resolveFillText('{{SECRET:X}}', mapSecrets({ X: 'v' }))).toThrow(
      CredentialReferenceError,
    );
  });

  it('scrubValues cuts every occurrence and ignores empty values', () => {
    expect(scrubValues(`x ${SECRET} y ${SECRET}`, [SECRET, ''])).toBe('x <redacted> y <redacted>');
  });

  describe('with a page', () => {
    let browser: Browser;
    let page: Page;
    let server: Server;
    let origin = '';

    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><title>Login</title><body>
          <label>User <input id="user"></label>
          <label>Password <input id="pw" type="password"></label>
          <input id="ro" readonly>
          <input id="mirror" oninput="this.setAttribute('value', this.value)">
          <div id="cover" style="position:fixed;inset:0;display:none"></div>
          <textarea id="notes" readonly></textarea>
          <label>Code <input id="short" maxlength="6"></label>
          <label>Renamed <input id="renames" maxlength="6" oninput="this.id = 'renamed'"></label>
          <p id="done" hidden>Signed in</p>
        </body>`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      browser = await chromium.launch();
    }, 60000);

    afterAll(async () => {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(async () => {
      page = await browser.newPage();
      page.setDefaultTimeout(1000);
      await page.goto(origin);
    });

    afterEach(async () => {
      await page?.close();
      delete process.env.IRIS_SECRET_LOGIN_PW;
      jest.restoreAllMocks();
    });

    const executor = () => new ActionExecutor({ timeout: 1000, retryAttempts: 2, retryDelay: 0 });

    it('types the resolved value; the result keeps the reference', async () => {
      const action: Action = { type: 'fill', selector: '#pw', text: '{{secret:LOGIN_PW}}' };
      const result = await executor().executeAction(action, page, mapSecrets({ LOGIN_PW: SECRET }));

      expect(result.success).toBe(true);
      expect(await page.inputValue('#pw')).toBe(SECRET);
      expect(result.action).toEqual(action);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('reads IRIS_SECRET_<NAME> by default in local mode', async () => {
      process.env.IRIS_SECRET_LOGIN_PW = SECRET;
      const result = await executor().executeAction(
        { type: 'fill', selector: '#pw', text: '{{secret:LOGIN_PW}}' },
        page,
      );
      expect(result.success).toBe(true);
      expect(await page.inputValue('#pw')).toBe(SECRET);
    });

    // Playwright previews the element it resolved, attributes included, and a page
    // (React, for one) may reflect a typed value into the value attribute.
    it('cuts a resolved value from any later action error', async () => {
      const ex = executor();
      const secrets = mapSecrets({ LOGIN_PW: SECRET });
      await ex.executeAction(
        { type: 'fill', selector: '#mirror', text: '{{secret:LOGIN_PW}}' },
        page,
        secrets,
      );
      await page.evaluate("document.getElementById('cover').style.display = 'block'");
      const result = await ex.executeAction({ type: 'click', selector: '#mirror' }, page, secrets);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/value="<redacted>"/); // positive control: it was quoted
      expect(result.error).not.toContain(SECRET);
    });

    it('cuts a resolved value from the context URL', async () => {
      const ex = new ActionExecutor({ timeout: 1000, retryAttempts: 0, trackContext: true });
      const secrets = mapSecrets({ LOGIN_PW: SECRET });
      await ex.executeAction(
        { type: 'fill', selector: '#pw', text: '{{secret:LOGIN_PW}}' },
        page,
        secrets,
      );
      await page.goto(`${origin}/?pw=${encodeURIComponent(SECRET)}`);
      await page.evaluate(`document.title = ${JSON.stringify(`${SECRET} - Search`)}`);
      const result = await ex.executeAction({ type: 'click', selector: '#user' }, page, secrets);
      expect(result.context?.url).toBe(`${origin}/?pw=<redacted>`);
      expect(result.context?.title).toBe('<redacted> - Search');
    });

    it('cuts a multi-line value from a failed fill error', async () => {
      const value = 'line-one-Q7\nline-two-K4';
      const result = await executor().executeAction(
        { type: 'fill', selector: '#notes', text: '{{secret:NOTE}}' },
        page,
        mapSecrets({ NOTE: value }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/fill\("<redacted>/); // positive control: it was quoted
      expect(result.error).not.toMatch(/line-one-Q7|line-two-K4/);
    });

    it('observePage redacts before it caps the digest', async () => {
      await page.setContent(`<p>${'x'.repeat(MAX_DIGEST_CHARS * 2)}</p>`);
      const redact = jest.fn((text: string) => text);
      await observePage(page, redact);
      const longest = Math.max(...redact.mock.calls.map(([text]) => text.length));
      expect(longest).toBeGreaterThan(MAX_DIGEST_CHARS);
    });

    it('fails an unknown reference at once, without typing', async () => {
      const ex = executor();
      const perform = jest.spyOn(ex as never, 'performAction' as never);
      const result = await ex.executeAction(
        { type: 'fill', selector: '#pw', text: '{{secret:MISSING}}' },
        page,
        mapSecrets({}),
      );
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/MISSING/) });
      expect(perform).toHaveBeenCalledTimes(1); // not retried
      expect(await page.inputValue('#pw')).toBe('');
    });

    // Playwright's call log quotes the value: `- fill("…")`.
    it.each([
      ['a referenced value', '{{secret:LOGIN_PW}}'],
      ['a literal value', SECRET],
    ])('cuts %s from a failed fill error', async (_label, text) => {
      const result = await executor().executeAction(
        { type: 'fill', selector: '#ro', text },
        page,
        mapSecrets({ LOGIN_PW: SECRET }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/<redacted>/);
      expect(result.error).not.toContain(SECRET);
    });

    it('under IRIS_HOSTED the process environment is never a source', async () => {
      process.env.IRIS_SECRET_LOGIN_PW = SECRET;
      const prev = process.env.IRIS_HOSTED;
      process.env.IRIS_HOSTED = '1';
      try {
        let hosted!: typeof import('../src/executor');
        jest.isolateModules(() => {
          hosted = require('../src/executor');
        });
        const result = await new hosted.ActionExecutor({
          timeout: 1000,
          retryAttempts: 0,
        }).executeAction({ type: 'fill', selector: '#pw', text: '{{secret:LOGIN_PW}}' }, page);
        expect(result).toMatchObject({ success: false, error: expect.stringMatching(/LOGIN_PW/) });
        expect(await page.inputValue('#pw')).toBe('');
      } finally {
        if (prev === undefined) delete process.env.IRIS_HOSTED;
        else process.env.IRIS_HOSTED = prev;
      }
    });

    // The digest is an ARIA snapshot, and it shows what a field holds.
    it('refuses a fill bound to another origin, typing nothing (#513)', async () => {
      const r = await executor().executeAction(
        { type: 'fill', selector: '#pw', text: '{{secret:LOGIN_PW}}' },
        page,
        mapSecrets({ LOGIN_PW: { value: SECRET, origin: 'https://elsewhere.example' } }),
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/\{\{secret:LOGIN_PW\}\} is bound to https:\/\/elsewhere\.example/);
      expect(await page.inputValue('#pw')).toBe('');
      // Positive control: bound to this page's origin, it is typed.
      const ok = await executor().executeAction(
        { type: 'fill', selector: '#pw', text: '{{secret:LOGIN_PW}}' },
        page,
        mapSecrets({ LOGIN_PW: { value: SECRET, origin } }),
      );
      expect(ok.success).toBe(true);
      expect(await page.inputValue('#pw')).toBe(SECRET);
    });

    // Codex review: the binding is checked against the frame the field is in, also when the
    // selector enters a cross-origin iframe and no policy handle is given.
    it("checks the binding against the iframe a selector enters, not the page's origin", async () => {
      const inner = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Pay</title><body><input id="card"></body>');
      });
      await new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve));
      // localhost, not 127.0.0.1: another origin on the same machine.
      const innerOrigin = `http://localhost:${(inner.address() as AddressInfo).port}`;
      try {
        await page.setContent(`<iframe src="${innerOrigin}/"></iframe>`);
        await page.frameLocator('iframe').locator('#card').waitFor();
        const fill = (origin: string) =>
          executor().executeAction(
            {
              type: 'fill',
              selector: 'iframe >> internal:control=enter-frame >> #card',
              text: '{{secret:LOGIN_PW}}',
            },
            page,
            mapSecrets({ LOGIN_PW: { value: SECRET, origin } }),
          );
        const refused = await fill(origin); // bound to the parent page's origin
        expect(refused.success).toBe(false);
        expect(refused.error).toMatch(/is bound to/);
        const typed = await fill(innerOrigin);
        expect(typed.success).toBe(true);
        expect(await page.frameLocator('iframe').locator('#card').inputValue()).toBe(SECRET);
      } finally {
        await new Promise((resolve) => inner.close(resolve));
      }
    }, 30_000);

    // Codex review: the reader keeps the filled element itself; replaying the selector
    // misses a field whose id an input handler changed.
    it('redacts what a field holds even after its selector stops matching', async () => {
      const ex = executor();
      const r = await ex.executeAction(
        { type: 'fill', selector: '#renames', text: '{{secret:LOGIN_PW}}' },
        page,
        mapSecrets({ LOGIN_PW: SECRET }),
      );
      expect(r.success).toBe(true);
      expect(await page.locator('#renames').count()).toBe(0); // positive control: renamed
      await ex.refreshFieldValues();
      expect(ex.redactSecrets(`Renamed: ${SECRET.slice(0, 6)}`)).toBe('Renamed: <redacted>');
    });

    // #513: a field that keeps only a prefix (maxlength) shows a value the scrub never saw.
    it('the agent loop never shows what a filled field holds, even a prefix', async () => {
      process.env.IRIS_SECRET_LOGIN_PW = SECRET;
      const translateInstruction = jest
        .fn()
        .mockResolvedValueOnce({
          actions: [{ type: 'fill', selector: '#short', text: '{{secret:LOGIN_PW}}' }],
          confidence: 0.9,
        })
        .mockResolvedValue({ actions: [], confidence: 0 });
      jest
        .spyOn(aiClient, 'createResolvedAIClient')
        .mockResolvedValue({ translateInstruction, isAvailable: async () => true } as never);

      await runAgentLoop({
        instruction: 'enter the code',
        executor: executor(),
        page,
        maxTurns: 2,
      });

      const prefix = SECRET.slice(0, 6);
      expect(await page.inputValue('#short')).toBe(prefix); // positive control: truncated
      expect(JSON.stringify(translateInstruction.mock.calls)).not.toContain(prefix);
    });

    it('the agent loop never shows the model a resolved value', async () => {
      process.env.IRIS_SECRET_LOGIN_PW = SECRET;
      const translateInstruction = jest
        .fn()
        .mockResolvedValueOnce({
          actions: [
            { type: 'fill', selector: '#user', text: 'alice' },
            { type: 'fill', selector: '#pw', text: '{{secret:LOGIN_PW}}' },
          ],
          confidence: 0.9,
        })
        .mockResolvedValue({ actions: [], confidence: 0 });
      jest
        .spyOn(aiClient, 'createResolvedAIClient')
        .mockResolvedValue({ translateInstruction, isAvailable: async () => true } as never);

      await runAgentLoop({
        instruction: 'sign in as alice with password {{secret:LOGIN_PW}}',
        executor: executor(),
        page,
        maxTurns: 2,
      });

      expect(await page.inputValue('#pw')).toBe(SECRET);
      const second = translateInstruction.mock.calls[1][0];
      // Positive control: the digest does carry typed values (the literal one).
      expect(second.context.currentPage).toContain('alice');
      expect(JSON.stringify(translateInstruction.mock.calls)).not.toContain(SECRET);
    });
  });
});
