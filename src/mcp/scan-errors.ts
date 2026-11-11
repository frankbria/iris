/**
 * What the MCP tool tells an assistant about a scan (#362). A tool result is read by a
 * model and kept in transcripts, so it carries a reason from a fixed vocabulary, never the
 * text an error or a redirect happened to contain: a refused redirect's target, a local
 * path from a failed browser launch, a token in a landing page's query string.
 */

const REDIRECT_BLOCKED = /redirects to .* blocked by navigation policy/;
const BLOCKED = 'blocked by navigation policy';
/** Only where Playwright puts the code, and bounded: the rest of the line names a URL. */
const NETWORK_ERROR = /^(?:[\w.]+: )?(net::ERR_[A-Z0-9_]{1,60})(?![A-Z0-9_])/;
/** Playwright's navigation, the runner's page deadline (#293), axe's own timer. */
const TIMED_OUT = /Timeout \d+ ?ms exceeded|did not finish within|timed out after \d+ ?ms/;
/** Playwright's launch call, or IRIS's own message about it (src/browser.ts). */
const LAUNCH_FAILED = /browserType\.launch|Chromium could not start/;

/**
 * The kind of address the URL policy refused, from its own message (src/url-policy.ts):
 * the text after the guard's last "blocked by navigation policy", since what precedes it
 * is the refused URL, which the page under test chose.
 */
function blockedAddressKind(detail: string): string | null {
  const reason = detail.slice(detail.lastIndexOf(BLOCKED));
  if (reason.includes('link-local/metadata host')) return 'a link-local or metadata address';
  if (reason.includes('private/loopback host')) return 'a private or loopback address';
  return null;
}

/**
 * Why a scan failed, as a clause that follows "Accessibility scan failed for <url>: ".
 * `detail` is the raw error; nothing of it is returned except a `net::ERR_*` code.
 */
export function scanFailureReason(detail: string): string {
  const kind = blockedAddressKind(detail);
  if (REDIRECT_BLOCKED.test(detail)) {
    return kind
      ? `it redirects to ${kind}, which the navigation policy blocks`
      : 'it redirects to a URL the navigation policy blocks';
  }
  if (detail.includes(BLOCKED)) {
    return kind
      ? `it is ${kind}, which the navigation policy blocks`
      : 'the navigation policy blocks it';
  }
  const networkError = NETWORK_ERROR.exec(detail);
  if (networkError) return `the page could not be loaded (${networkError[1]})`;
  if (TIMED_OUT.test(detail)) return 'the page did not finish loading in time';
  // The machine's fault, not the page's: the caller should stop retrying other URLs.
  if (LAUNCH_FAILED.test(detail)) {
    return 'the browser could not be started on the server (details are on the server log)';
  }
  return 'the scan could not be completed (details are on the server log)';
}

/** A landing URL is text the page under test chose; this much of it is shown. */
const MAX_LANDED_URL_LENGTH = 200;
/** A path segment this long is taken for a token (a reset link, a signed URL) and cut. */
const OPAQUE_SEGMENT_LENGTH = 32;

/**
 * Origin and path only: a redirect's query string and fragment are where tokens travel.
 * shortcut: a token under 32 characters in the path is shown, upgrade to origin only if
 * that proves too much.
 */
function landedUrl(scanned: URL): string {
  const path = scanned.pathname
    .split('/')
    .map((segment) => (segment.length >= OPAQUE_SEGMENT_LENGTH ? '…' : segment))
    .join('/');
  const shown = scanned.origin === 'null' ? scanned.protocol : scanned.origin + path;
  return shown.length > MAX_LANDED_URL_LENGTH ? `${shown.slice(0, MAX_LANDED_URL_LENGTH)}…` : shown;
}

function parsed(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The caller's URL as a result may repeat it: without `user:password@`. Parsed, not
 * pattern-matched: a password may hold a space or an `@`, which no pattern over free text
 * can follow. Unchanged when it carries no credentials, so the caller sees its own spelling.
 */
export function withoutCredentials(url: string): string {
  const target = parsed(url);
  if (!target) return 'the requested URL';
  if (!target.username && !target.password) return url;
  target.username = '';
  target.password = '';
  return target.href;
}

/**
 * A URL as the network sees it. The runner reports the response's URL, which never has
 * the request's fragment or credentials: without this, `/#/checkout` read as a redirect.
 */
function asRequested(url: string): string | undefined {
  const target = parsed(url);
  if (!target) return undefined;
  target.hash = '';
  target.username = '';
  target.password = '';
  return target.href;
}

/**
 * The page a scan measured, as reported to the caller. A scan that stayed on the requested
 * URL reports that URL (the caller's own text, without `user:password@`); one that was
 * redirected reports the landing page's origin and path, long segments cut.
 */
export function scannedPage(
  requested: string,
  scanned: string,
): { url: string; redirected: boolean } {
  if (!scanned || asRequested(scanned) === asRequested(requested)) {
    return { url: withoutCredentials(requested), redirected: false };
  }
  const landed = parsed(scanned);
  return { url: landed ? landedUrl(landed) : 'an unreadable URL', redirected: true };
}
