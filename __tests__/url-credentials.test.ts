/**
 * URL credentials in text that leaves the process (#645). A URL parser takes the LAST `@`
 * of the authority as the separator and accepts a space in a password, so a pattern that
 * stops at the first `@` leaves half a password behind. Pure functions, so no browser.
 */

import { redactString } from '../src/log';
import {
  ERROR_TEXT_MAX,
  strippedError,
  stripUserinfo,
  urlWithoutUserinfo,
} from '../src/report-encoding';

// Assembled so no credential-shaped literal sits in the source.
const PART_ONE = 'part1';
const PART_TWO = 'part2';
const AT_PASSWORD = `admin:${PART_ONE}@${PART_TWO}`;
const SPACE_PASSWORD = 'admin:correct horse';

describe('stripUserinfo', () => {
  it('cuts up to the last @ of the authority', () => {
    expect(stripUserinfo(`Navigation to http://${AT_PASSWORD}@host/x refused`)).toBe(
      'Navigation to http://host/x refused',
    );
  });

  it.each([
    'http://host/path?email=a@b.example',
    'http://host?email=a@b.example',
    'http://host#a@b.example',
    'http://host/@handle',
    'see http://host and write to a@b.example',
  ])('leaves %s alone: the @ is not in the authority', (text) => {
    expect(stripUserinfo(text)).toBe(text);
  });

  it('cuts the credentials and keeps an @ in the query', () => {
    expect(stripUserinfo(`ftp://${AT_PASSWORD}@host/p?to=a@b.example`)).toBe(
      'ftp://host/p?to=a@b.example',
    );
  });

  it('cuts every URL in the text', () => {
    expect(stripUserinfo(`http://${AT_PASSWORD}@one/ then https://u:p@two/`)).toBe(
      'http://one/ then https://two/',
    );
  });

  it('cannot follow a space in a password in free text', () => {
    // Documented limit: whitespace ends a URL in prose, so the pattern stops there.
    const text = `Navigation to http://${SPACE_PASSWORD}@host/ refused`;
    expect(stripUserinfo(text)).toBe(text);
  });

  it('cuts a password with a space when told which URL the text quotes', () => {
    const url = `http://${SPACE_PASSWORD}@host/a?b=1`;
    const text = `Navigation to ${url} refused; ${url} is blocked, see ftp://u:p@other/`;
    expect(stripUserinfo(text, url)).toBe(
      'Navigation to http://host/a?b=1 refused; http://host/a?b=1 is blocked, see ftp://other/',
    );
  });

  it('falls back to the pattern when the quoted URL has no credentials or does not parse', () => {
    expect(stripUserinfo('http://u:p@host/ failed', 'http://host/')).toBe('http://host/ failed');
    expect(stripUserinfo('http://u:p@host/ failed', 'not a url')).toBe('http://host/ failed');
    expect(stripUserinfo('http://u:p@host/ failed', '')).toBe('http://host/ failed');
  });
});

describe('urlWithoutUserinfo', () => {
  it('returns a URL without credentials as it was written', () => {
    expect(urlWithoutUserinfo('http://LOCALHOST:3000')).toBe('http://LOCALHOST:3000');
  });

  it.each([
    `http://${AT_PASSWORD}@localhost:3000/a?b=1#c`,
    `http://${SPACE_PASSWORD}@localhost:3000/a?b=1#c`,
    'http://admin@localhost:3000/a?b=1#c',
  ])('cuts the credentials from %s by parsing it', (url) => {
    expect(urlWithoutUserinfo(url)).toBe('http://localhost:3000/a?b=1#c');
  });

  it('uses the pattern on text that does not parse as a URL', () => {
    expect(urlWithoutUserinfo(`http://${AT_PASSWORD}@bad host/`)).toBe('http://bad host/');
  });
});

describe('redactString', () => {
  it('cuts up to the last @ of the authority', () => {
    const out = redactString(`could not reach postgres://${AT_PASSWORD}@db:5432/iris`);
    expect(out).toBe('could not reach postgres://[redacted]@db:5432/iris');
  });

  it.each(['http://host/path?email=a@b.example', 'http://host?email=a@b.example'])(
    'leaves %s alone',
    (text) => {
      expect(redactString(text)).toBe(text);
    },
  );
});

// #658: the patterns used to begin with an unanchored scheme, so a long run of scheme
// characters was scanned again from each of its positions.
describe('match set of the linear patterns (#658)', () => {
  it.each([
    ['...http://u:p@h', '...http://h', '...http://[redacted]@h'],
    ['1http://u:p@h', '1http://h', '1http://[redacted]@h'],
    ['a-b+c.d://u:p@h', 'a-b+c.d://h', 'a-b+c.d://[redacted]@h'],
    ['HTTP://U:P@H', 'HTTP://H', 'HTTP://[redacted]@H'],
    ['123://u:p@h', '123://u:p@h', '123://u:p@h'],
    ['http://@h', 'http://@h', 'http://[redacted]@h'],
    ['x://a/http://u:p@h', 'x://a/http://h', 'x://a/http://[redacted]@h'],
  ])('%s', (text, stripped, redacted) => {
    expect(stripUserinfo(text)).toBe(stripped);
    expect(redactString(text)).toBe(redacted);
  });

  it.each([
    ['??token=abc', '??token=[redacted]'],
    ['?a?token=abc&b=1', '?a?token=[redacted]&b=1'],
    ['?a?b&token=abc', '?a?b&token=[redacted]'],
    ['?token', '?token'],
    ['?=abc', '?=abc'],
  ])('query parameter %s', (text, redacted) => {
    expect(redactString(text)).toBe(redacted);
  });

  // The patterns as they were on main before #658, kept as the reference.
  const oldStrip = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, '$1');
  const oldRedact = (text: string) =>
    text
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1[redacted]@')
      .replace(/([?&;#]([^=&;#\s]*)=)([^&;#\s]*)/g, (all, head: string, name: string) =>
        /token|key|passw(?:or)?d|secret|sig|auth|session|credential/i.test(name)
          ? `${head}[redacted]`
          : all,
      );

  it('agrees with the old patterns on 60,000 generated strings', () => {
    // A small alphabet makes schemes, authorities and parameters collide often.
    const alphabet = ['a', 'Z', '1', '.', '-', ':', '/', '/', '@', ' ', '?', '#', '=', '&', 'key'];
    let seed = 658;
    const next = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * below);
    };
    const differing: string[] = [];
    for (let i = 0; i < 60_000; i++) {
      let text = next(4) === 0 ? 'a://' : '';
      for (let length = next(20); length > 0; length--) text += alphabet[next(alphabet.length)];
      if (stripUserinfo(text) !== oldStrip(text) || redactString(text) !== oldRedact(text)) {
        differing.push(text);
      }
    }
    expect(differing).toEqual([]);
  });
});

describe('time on adversarial input (#658)', () => {
  // Fastest of five runs on a monotonic clock, compared as a ratio: a clock that steps back
  // (#190) or a busy machine (#142) cannot make a linear scan look quadratic that way.
  const fastest = (run: () => unknown) => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const shapes: Array<[string, (length: number) => string]> = [
    ['letters', (n) => 'a'.repeat(n)],
    ['a1a1…', (n) => 'a1'.repeat(n / 2)],
    ['a.a.…', (n) => 'a.'.repeat(n / 2)],
    [
      'a long scheme before an authority with no @',
      (n) => `${'a'.repeat(n / 2)}://${'b'.repeat(n / 2)}`,
    ],
    ['a://a://…', (n) => 'a://'.repeat(n / 4)],
    ['question marks', (n) => '?'.repeat(n)],
    ['?a?a…', (n) => '?a'.repeat(n / 2)],
    ['a key that never ends', (n) => `iris_${'a'.repeat(n)}_`],
    ['Bearer and spaces', (n) => `Bearer${' '.repeat(n)}`],
    ['an escape sequence that never ends', (n) => `\x1b[${'0'.repeat(n)}`],
  ];

  it.each(shapes)('%s: ten times the input takes about ten times as long', (_name, shape) => {
    // Also behind a `://`: text without one never reaches the userinfo pattern.
    const inputs = [shape, (length: number) => `:// ${shape(length)}`];
    for (const helper of [stripUserinfo, redactString, strippedError]) {
      for (const input of inputs) {
        let previous = fastest(() => helper(input(1_000)));
        for (const length of [10_000, 100_000, 1_000_000]) {
          const text = input(length);
          const time = fastest(() => helper(text));
          // Quadratic time is a hundredfold per step, and the old patterns fail the first
          // one within a second. Under a millisecond the clock is too coarse to divide by.
          expect(time).toBeLessThan(40 * Math.max(previous, 1));
          previous = time;
        }
      }
    }
  });
});

describe('strippedError (#658)', () => {
  it('strips colour codes and credentials from a short error', () => {
    expect(strippedError('\x1b[2mgoto http://u:p@host/\x1b[22m failed')).toBe(
      'goto http://host/ failed',
    );
  });

  it('follows a space in the password of the URL it is told the error quotes', () => {
    const url = `http://${SPACE_PASSWORD}@host/a`;
    expect(strippedError(`Navigation to ${url} refused`, url)).toBe(
      'Navigation to http://host/a refused',
    );
  });

  it('gives the patterns at most ERROR_TEXT_MAX characters', () => {
    const out = strippedError(`${'word '.repeat(ERROR_TEXT_MAX)}http://u:p@host/`);
    expect(out).toBe('word '.repeat(ERROR_TEXT_MAX).slice(0, ERROR_TEXT_MAX));
  });

  it('leaves a text of exactly ERROR_TEXT_MAX characters whole', () => {
    const text = `${'x'.repeat(ERROR_TEXT_MAX - 14)} http://u:pass`;
    expect(text).toHaveLength(ERROR_TEXT_MAX);
    expect(strippedError(text)).toBe(text);
  });

  // A cut inside a URL separates its userinfo from the `@` the pattern needs.
  it('drops a URL the cut lands in before its @', () => {
    const lead = 'x'.repeat(ERROR_TEXT_MAX - 13);
    const out = strippedError(`${lead} http://u:pass@host/ and more`);
    expect(out).toBe(`${lead} http`);
  });

  it('keeps a URL whose authority ended before the cut', () => {
    const lead = 'x'.repeat(ERROR_TEXT_MAX - 20);
    const out = strippedError(`${lead} http://u:p@host/path/that/goes/on`);
    expect(out).toBe(`${lead} http://host/pat`);
  });

  it('drops a partial copy of the quoted URL at the cut, whatever its password holds', () => {
    const url = `http://${SPACE_PASSWORD}@host/next=http://other/x`;
    const whole = `Navigation to ${url} refused. `;
    const lead = 'x'.repeat(ERROR_TEXT_MAX - whole.length - url.length + 8);
    const out = strippedError(`${lead}${whole}${url} and more`, url);
    expect(out).toBe(`${lead}Navigation to http://host/next=http://other/x refused. `);
  });

  // codex review: a colour code holds `?` or `;`, which read as the end of an authority,
  // so the URL the cut landed in was kept, and removing the code then exposed its password.
  it.each([
    ['a whole colour code', '\x1b[?25l'],
    ['a colour code the cut ends', '\x1b[?2'],
  ])('drops a URL the cut lands in when its userinfo holds %s', (_what, code) => {
    const whole = code.length === 6;
    const start = `${'\x1b[2m'.repeat(4088)}http://u:${PART_ONE}${whole ? code : ''}`;
    const fill = 's'.repeat(ERROR_TEXT_MAX - start.length - (whole ? 0 : code.length));
    const error = `${start}${fill}${whole ? '' : code}5l@host/ rest`;
    expect(stripUserinfo(error.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))).toBe('http://host/ rest');
    expect(strippedError(error)).toBe('http');
  });

  it('does not end on half a surrogate pair', () => {
    const out = strippedError(`${'x'.repeat(ERROR_TEXT_MAX - 1)}😀 tail`);
    expect(out).toBe('x'.repeat(ERROR_TEXT_MAX - 1));
  });
});
