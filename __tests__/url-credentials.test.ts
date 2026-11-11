/**
 * URL credentials in text that leaves the process (#645). A URL parser takes the LAST `@`
 * of the authority as the separator and accepts a space in a password, so a pattern that
 * stops at the first `@` leaves half a password behind. Pure functions, so no browser.
 */

import { redactString } from '../src/log';
import { stripUserinfo, urlWithoutUserinfo } from '../src/report-encoding';

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
