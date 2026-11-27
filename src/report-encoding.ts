/**
 * Output encoders shared by every report writer (issue #339).
 *
 * Report fields carry text the page under test controls: page names, axe output
 * (axe runs inside the page) and model output quoting the page. Each format gets
 * exactly one encoder here, so the visual and a11y reporters cannot drift apart.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape text for an HTML element body or a quoted attribute value. Coerces its
 * input: axe output is page-controlled, so a "string" field can arrive as anything,
 * and a throw here would lose the whole report.
 */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

// XML 1.0 `Char`: everything outside it (C0 controls other than TAB/LF/CR, lone
// surrogates, U+FFFE, U+FFFF) is a fatal parse error, and no escape exists for it.
const XML_ILLEGAL = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

// A parser turns a raw TAB, LF or CR in an attribute value into a space; the
// character reference survives. In element text the two parse the same.
const XML_WHITESPACE: Record<string, string> = { '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' };

/**
 * Escape text for an XML element body or a quoted attribute value. Characters
 * XML cannot carry become U+FFFD, so the document still parses and the reader can
 * see something was replaced.
 */
export function escapeXml(text: string): string {
  return escapeHtml(String(text).replace(XML_ILLEGAL, '\uFFFD')).replace(
    /[\t\n\r]/g,
    (c) => XML_WHITESPACE[c],
  );
}

/**
 * Escape text for inline Markdown. Every character CommonMark/GFM gives inline
 * meaning is backslash-escaped (links, images, emphasis, code, raw HTML, entities,
 * strikethrough, table cells, heading closers), and line breaks fold to a space so
 * the value cannot start a new block such as a heading or a list item.
 *
 * A value placed right after a list marker still starts a block, so leading
 * whitespace (indented code) is dropped, as is trailing whitespace (two spaces
 * before the template's newline would be a hard break) and a leading `-`, `+` or `1.`/`1)` (a
 * nested list or a thematic break) is escaped.
 *
 * ponytail: bare URLs are left as text, so GFM may still autolink them; the link
 * target is then the visible text, which deceives no one.
 */
export function escapeMarkdown(text: string): string {
  return String(text)
    .replace(/\r\n|\r|\n/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>&!|~#]/g, '\\$&')
    .replace(/^[-+]/, '\\$&')
    .replace(/^(\d+)([.)])/, '$1\\$2');
}

/** The URL if it is safe to put in an href (http or https), otherwise null. */
export function safeHref(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Terminal control sequences (CSI: ESC `[` parameters, intermediates, final byte) cut from
 * error text (#420): Playwright colours its call log, and stored errors are read in the portal
 * and the API, where they show as junk.
 */
export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

/**
 * A URL without its `user:password@`, cut by parsing it (#645): a password may hold an `@`
 * or a space, which a parser follows and a pattern over free text cannot. Unchanged when it
 * carries no credentials, so the caller sees its own spelling; text that does not parse as
 * a URL gets the pattern.
 */
export function urlWithoutUserinfo(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return stripUserinfo(url);
  }
  if (!parsed.username && !parsed.password) return url;
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

/**
 * A whole run of scheme characters, then `://userinfo@` if it follows (#658). The run is
 * taken in one match, so no position inside it is tried again: a pattern that starts at the
 * scheme (`[a-z][a-z0-9+.-]*:\/\/`) scans a long run once from each of its characters, which
 * took 3 s for 40,000 letters.
 */
const SCHEME_RUN_THEN_USERINFO = /([a-z0-9+.-]+)(?::\/\/([^\s/?#]*)@)?/gi;

/**
 * `text` with the userinfo after each `scheme://` replaced by `replacement(userinfo)`, in
 * time linear in the text (#658). A scheme starts at a letter, and what stands before the
 * run's first letter is kept (`1http://u:p@h` is a URL after a `1`), so the matches are those
 * of the pattern that started at the scheme.
 */
export function replaceUserinfo(text: string, replacement: (userinfo: string) => string): string {
  if (!text.includes('://')) return text;
  return text.replace(SCHEME_RUN_THEN_USERINFO, (all: string, run: string, userinfo?: string) =>
    userinfo !== undefined && /[a-z]/i.test(run) ? `${run}://${replacement(userinfo)}` : all,
  );
}

/**
 * Every `scheme://user:password@` in free text, without the userinfo (#254, #287). The cut
 * runs to the last `@` of the authority, as a URL parser reads it (#645): `/`, `?` and `#`
 * end the authority, so an `@` in a path or query is left alone.
 *
 * Whitespace ends a URL in free text, so a password holding a raw space is not followed
 * (`http://u:correct horse@host/` reads as a URL that ends at `correct`). A caller that
 * knows which URL the text quotes passes it as `quotedUrl`: each occurrence is replaced by
 * its parsed form first.
 */
export function stripUserinfo(text: string, quotedUrl?: string): string {
  return withoutPatternUserinfo(withoutQuoted(text, quotedUrl));
}

/** The pattern alone. An empty userinfo (`http://@host`) is left as it was written. */
const withoutPatternUserinfo = (text: string): string =>
  replaceUserinfo(text, (userinfo) => (userinfo ? '' : '@'));

/** `text` with each whole copy of `quotedUrl` replaced by its parsed form. */
const withoutQuoted = (text: string, quotedUrl?: string): string =>
  quotedUrl ? text.split(quotedUrl).join(urlWithoutUserinfo(quotedUrl)) : text;

/** The most error text the stripping patterns are given, in UTF-16 units (#658). */
export const ERROR_TEXT_MAX = 16_384;

/** Knuth-Morris-Pratt: for each prefix of `pattern`, its longest proper prefix that ends it. */
function borders(pattern: string): Int32Array {
  const table = new Int32Array(pattern.length);
  for (let i = 1, matched = 0; i < pattern.length; i++) {
    while (matched > 0 && pattern[i] !== pattern[matched]) matched = table[matched - 1];
    if (pattern[i] === pattern[matched]) matched++;
    table[i] = matched;
  }
  return table;
}

/**
 * `head` without a trailing start of `quotedUrl` that stops short of its end. One pass
 * (Knuth-Morris-Pratt): comparing each suffix with the URL took a second on 16,384 repeated
 * letters (codex review).
 */
function withoutPartialCopy(head: string, quotedUrl: string): string {
  const start = quotedUrl.slice(0, Math.min(quotedUrl.length - 1, head.length));
  if (!start) return head;
  const table = borders(start);
  let matched = 0;
  for (let i = head.length - start.length; i < head.length; i++) {
    while (matched > 0 && (matched === start.length || head[i] !== start[matched])) {
      matched = table[matched - 1];
    }
    if (head[i] === start[matched]) matched++;
  }
  return head.slice(0, head.length - matched);
}

/** The start of a colour code that the cut ended: `ESC`, `ESC [`, or one with no final byte. */
const PARTIAL_ANSI_TAIL = /\x1b(?:\[[0-?]*[ -/]*)?$/;

/** The first `ERROR_TEXT_MAX` units of `text`, never ending on half a surrogate pair. */
function firstUnits(text: string): string {
  if (text.length <= ERROR_TEXT_MAX) return text;
  const lastIsHighSurrogate = (text.charCodeAt(ERROR_TEXT_MAX - 1) & 0xfc00) === 0xd800;
  return text.slice(0, ERROR_TEXT_MAX - (lastIsHighSurrogate ? 1 : 0));
}

/**
 * The start of `text` without colour codes and with whole copies of `quotedUrl` parsed, at
 * most `ERROR_TEXT_MAX` units. A cut can land inside a URL whose `@` is past it, and what is
 * left of the userinfo would no longer be recognised. So a cut text also ends before a
 * partial copy of `quotedUrl` and before an authority that nothing terminates. The order
 * matters (codex review): colour codes go first, since one inside a URL can hold a `?`,
 * which would read as the authority's end; whole copies are replaced before a partial one
 * is looked for, since a URL may end with its own beginning (`http://u:p@host/http`); and
 * the text is cut again after that, since a parsed URL can be longer than it was written.
 */
function headOfErrorText(text: string, quotedUrl: string): string {
  const cut = firstUnits(text);
  const plain = cut === text ? stripAnsi(cut) : stripAnsi(cut).replace(PARTIAL_ANSI_TAIL, '');
  const parsed = withoutQuoted(plain, quotedUrl);
  const head = firstUnits(parsed);
  if (cut === text && head === parsed) return head;
  const whole = withoutPartialCopy(head, quotedUrl);
  const scheme = whole.lastIndexOf('://');
  return scheme !== -1 && !/[\s/?#]/.test(whole.slice(scheme + 3)) ? whole.slice(0, scheme) : whole;
}

/**
 * Error text a page or a client controls, as it may be stored or shown: without terminal
 * colour codes and URL userinfo (`quotedUrl` as for `stripUserinfo`), from at most
 * `ERROR_TEXT_MAX` units of it, cut before any pattern runs (#658): such text has no length
 * of its own. What a cut loses is the end of the text, never a credential's `@`.
 */
export function strippedError(error: string, quotedUrl = ''): string {
  return withoutPatternUserinfo(headOfErrorText(error, quotedUrl));
}
