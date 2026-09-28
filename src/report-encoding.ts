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

/** Escape text for an HTML element body or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
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
  return escapeHtml(text.replace(XML_ILLEGAL, '\uFFFD')).replace(
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
 * whitespace (indented code) is dropped and a leading `-`, `+` or `1.`/`1)` (a
 * nested list or a thematic break) is escaped.
 *
 * ponytail: bare URLs are left as text, so GFM may still autolink them; the link
 * target is then the visible text, which deceives no one.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ')
    .trimStart()
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
