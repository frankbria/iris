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
  const withoutQuoted = quotedUrl
    ? text.split(quotedUrl).join(urlWithoutUserinfo(quotedUrl))
    : text;
  // An empty userinfo (`http://@host`) is left as it was written.
  return replaceUserinfo(withoutQuoted, (userinfo) => (userinfo ? '' : '@'));
}

/** The most error text the stripping patterns are given, in UTF-16 units (#658). */
export const ERROR_TEXT_MAX = 16_384;

/** `head` without a trailing start of `quotedUrl` that stops short of its end. */
function withoutPartialCopy(head: string, quotedUrl: string): string {
  for (let start = Math.max(0, head.length - quotedUrl.length + 1); start < head.length; start++) {
    if (quotedUrl.startsWith(head.slice(start))) return head.slice(0, start);
  }
  return head;
}

/**
 * The first `ERROR_TEXT_MAX` units of `text`, by code point. A cut can land inside a URL
 * whose `@` is past it, and what is left of the userinfo would no longer be recognised. So a
 * cut text also ends before a partial copy of `quotedUrl` and before an authority that
 * nothing terminates.
 */
function headOfErrorText(text: string, quotedUrl: string): string {
  if (text.length <= ERROR_TEXT_MAX) return text;
  const lastIsHighSurrogate = (text.charCodeAt(ERROR_TEXT_MAX - 1) & 0xfc00) === 0xd800;
  const head = withoutPartialCopy(
    text.slice(0, ERROR_TEXT_MAX - (lastIsHighSurrogate ? 1 : 0)),
    quotedUrl,
  );
  const scheme = head.lastIndexOf('://');
  return scheme !== -1 && !/[\s/?#]/.test(head.slice(scheme + 3)) ? head.slice(0, scheme) : head;
}

/**
 * Error text a page or a client controls, as it may be stored or shown: without terminal
 * colour codes and URL userinfo (`quotedUrl` as for `stripUserinfo`). Cut to
 * `ERROR_TEXT_MAX` before any pattern runs (#658): such text has no length of its own.
 */
export function strippedError(error: string, quotedUrl = ''): string {
  return stripUserinfo(stripAnsi(headOfErrorText(error, quotedUrl)), quotedUrl);
}
