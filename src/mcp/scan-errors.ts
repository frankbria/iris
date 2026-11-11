/**
 * What the MCP tool tells an assistant about a scan (#362). A tool result is read by a
 * model and kept in transcripts, so it carries a reason from a fixed vocabulary, never the
 * text an error or a redirect happened to contain: a refused redirect's target, a local
 * path from a failed browser launch, a token in a landing page's query string.
 */

import { stripUserinfo } from '../report-encoding';

const REDIRECT_BLOCKED = /redirects to .* blocked by navigation policy/;
const BLOCKED = /blocked by navigation policy/;
const NETWORK_ERROR = /net::ERR_[A-Z0-9_]+/;
const TIMED_OUT = /Timeout \d+ ?ms exceeded|did not finish within/;

/** The kind of address the URL policy refused, from its own message (src/url-policy.ts). */
function blockedAddressKind(detail: string): string | null {
  if (detail.includes('link-local/metadata host')) return 'a link-local or metadata address';
  if (detail.includes('private/loopback host')) return 'a private or loopback address';
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
  if (BLOCKED.test(detail)) {
    return kind
      ? `it is ${kind}, which the navigation policy blocks`
      : 'the navigation policy blocks it';
  }
  const networkError = NETWORK_ERROR.exec(detail);
  if (networkError) return `the page could not be loaded (${networkError[0]})`;
  if (TIMED_OUT.test(detail)) return 'the page did not finish loading in time';
  return 'the scan could not be completed (details are on the server log)';
}

/** A landing URL is text the page under test chose; this much of it is shown. */
const MAX_LANDED_URL_LENGTH = 200;

/** Origin and path only: a redirect's query string and fragment are where tokens travel. */
function landedUrl(scanned: URL): string {
  const shown = scanned.origin === 'null' ? scanned.protocol : scanned.origin + scanned.pathname;
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
 * The page a scan measured, as reported to the caller. A scan that stayed on the requested
 * URL reports that URL (the caller's own text, without `user:password@`); one that was
 * redirected reports the landing page's origin and path.
 */
export function scannedPage(
  requested: string,
  scanned: string,
): { url: string; redirected: boolean } {
  if (!scanned || parsed(scanned)?.href === parsed(requested)?.href) {
    return { url: stripUserinfo(requested), redirected: false };
  }
  const landed = parsed(scanned);
  return { url: landed ? landedUrl(landed) : 'an unreadable URL', redirected: true };
}
