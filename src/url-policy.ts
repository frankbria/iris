/**
 * Navigation URL policy — the single security gate applied before any
 * `page.goto()`. Blocks non-web schemes and SSRF/local-file targets reachable
 * from the unauthenticated RPC and from AI-translated (prompt-injectable)
 * instructions. Enforced at the `performAction` navigate boundary.
 */

export interface UrlPolicyOptions {
  /**
   * When set, refuse any *navigation* that leaves this origin.
   *
   * Distinct from the SSRF checks below, which ask "is this host dangerous?".
   * This asks "is this where the caller pointed me?", and exists because the
   * agent loop can be talked into leaving a site while still carrying its
   * session (issue #151). Checking it here rather than only before an action
   * means a same-origin click that navigates away, or a same-origin URL that
   * 302s elsewhere, is stopped before the request goes out — a pre-action check
   * alone notices only after the fact.
   *
   * Applies to document requests only; the guard strips it for sub-resources,
   * since a page legitimately loads images and fonts from other origins.
   */
  pinnedOrigin?: string;
  /** Allow `file://` navigation (e.g. the watcher rendering local files). Default: false. */
  allowFile?: boolean;
  /** Also block loopback + RFC1918 + IPv6 ULA hosts. Default: false (localhost dev-server testing stays allowed). */
  blockPrivateHosts?: boolean;
}

/** Strip IPv6 brackets, a DNS-equivalent trailing dot, and lowercase for comparison. */
function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/** Parse dotted-quad IPv4 into octets, or null if not an IPv4 literal. */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/**
 * Octets for a host that carries an IPv4 address, including IPv4-mapped IPv6
 * literals so `::ffff:169.254.169.254` and its hex form `::ffff:a9fe:a9fe`
 * can't smuggle a blocked IPv4 target past the range checks.
 */
function ipv4OctetsFromAny(host: string): number[] | null {
  const direct = ipv4Octets(host);
  if (direct) return direct;

  // IPv4-mapped IPv6, dotted tail: ::ffff:169.254.169.254
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (dotted) return ipv4Octets(dotted[1]);

  // IPv4-mapped IPv6, hex tail: ::ffff:a9fe:a9fe
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  }
  return null;
}

/** An IPv6 literal (post-bracket-strip) always contains a colon; hostnames never do. */
function isIpv6Literal(host: string): boolean {
  return host.includes(':');
}

// ponytail: host matching is literal-only — it covers dotted-quad IPv4, IPv6
// literals, and exact hostnames, NOT integer/hex/octal IP encodings
// (http://2852039166/) nor DNS names that *resolve* to a link-local/metadata IP
// (incl. DNS-rebinding). Chromium normalizes and resolves those at connect time,
// so a determined SSRF could still reach 169.254.169.254 that way. Closing it
// needs a resolve-at-connect network control (or OS/proxy egress blocking), not
// URL-string matching — see Known Limitations. Add a resolver here if it matters.
/** Cloud-metadata / link-local — always blocked, never a legitimate navigation target. */
function isLinkLocalOrMetadata(host: string): boolean {
  if (host === 'metadata.google.internal') return true;
  const v4 = ipv4OctetsFromAny(host);
  if (v4 && v4[0] === 169 && v4[1] === 254) return true; // 169.254.0.0/16
  // IPv6 link-local fe80::/10 (fe80–febf) — only for IPv6 literals, so a hostname
  // like "feature.example.com" is not mistaken for an address.
  if (isIpv6Literal(host) && /^fe[89ab]/.test(host)) return true;
  return false;
}

/** Loopback / private ranges — blocked only when blockPrivateHosts is set. */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  const v4 = ipv4OctetsFromAny(host);
  if (v4) {
    if (v4[0] === 127) return true; // loopback 127.0.0.0/8
    if (v4[0] === 10) return true; // 10.0.0.0/8
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true; // 172.16.0.0/12
    if (v4[0] === 192 && v4[1] === 168) return true; // 192.168.0.0/16
  }
  if (isIpv6Literal(host) && /^f[cd]/.test(host)) return true; // IPv6 ULA fc00::/7
  return false;
}

/**
 * Whether a URL is within the pinned origin, allowing an http→https upgrade.
 *
 * Origins differ by scheme, so a strict comparison refuses a site that upgrades
 * itself — an HSTS redirect, or a dev server that starts on http and moves. That
 * is a security *improvement* being treated as an escape, which teaches users to
 * pass --allow-cross-origin and lose the whole control. A downgrade is refused,
 * since https→http is the direction that actually costs something.
 */
export function satisfiesPinnedOrigin(parsed: URL, pinnedOrigin: string): boolean {
  if (parsed.origin === pinnedOrigin) return true;

  let pinned: URL;
  try {
    pinned = new URL(pinnedOrigin);
  } catch {
    return false;
  }

  const isUpgrade = pinned.protocol === 'http:' && parsed.protocol === 'https:';
  if (!isUpgrade) return false;
  if (normalizeHost(parsed.hostname) !== normalizeHost(pinned.hostname)) return false;

  // Raw port strings, not scheme-normalised numbers. Normalising made
  // `http://host` (implicit 80) equal to `https://host:80` — an explicit
  // non-default HTTPS port, which is a different service, and a gap in the very
  // boundary this function draws. "" (default for its scheme) is its own value:
  // default→default is an upgrade, explicit→same-explicit is an upgrade, and
  // anything mixed is refused.
  return parsed.port === pinned.port;
}

/**
 * String form of {@link satisfiesPinnedOrigin}, for callers holding a URL rather
 * than a parsed one.
 *
 * Exported so the agent's per-action check and this request-layer check share a
 * single definition of "within the pinned origin". They disagreed once — the
 * request layer allowed an http→https upgrade while the action check compared
 * origins strictly, so an upgrading site would load and then refuse every
 * action on it.
 *
 * @returns false for an unparseable URL, which callers treat as "no origin to
 *   compare" rather than a refusal.
 */
export function isWithinPinnedOrigin(url: string, pinnedOrigin: string): boolean {
  try {
    return satisfiesPinnedOrigin(new URL(url), pinnedOrigin);
  } catch {
    return false;
  }
}

/**
 * Throw if `url` is not a permitted navigation target. Returns normally when allowed.
 */
export function assertNavigationAllowed(url: string, options: UrlPolicyOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Navigation blocked: malformed URL "${url}".`);
  }

  const scheme = parsed.protocol;
  if (scheme === 'file:') {
    if (!options.allowFile) {
      throw new Error('Navigation blocked: file:// scheme is not allowed.');
    }
    return; // file paths have no host to range-check
  }

  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(`Navigation blocked: scheme "${scheme}" is not allowed (only http/https).`);
  }

  if (options.pinnedOrigin && !satisfiesPinnedOrigin(parsed, options.pinnedOrigin)) {
    throw new Error(
      `Navigation blocked: ${parsed.origin} leaves the pinned origin ${options.pinnedOrigin}.`,
    );
  }

  const host = normalizeHost(parsed.hostname);

  if (isLinkLocalOrMetadata(host)) {
    throw new Error(`Navigation blocked: link-local/metadata host "${host}" is not allowed.`);
  }

  if (options.blockPrivateHosts && isPrivateHost(host)) {
    throw new Error(`Navigation blocked: private/loopback host "${host}" is not allowed.`);
  }
}

/**
 * Non-throwing predicate form of {@link assertNavigationAllowed}. Used by the
 * per-request route guard to also reject redirect targets and sub-resource
 * requests that bypass the pre-goto check on the initial action URL.
 */
export function isNavigationAllowed(url: string, options: UrlPolicyOptions = {}): boolean {
  try {
    assertNavigationAllowed(url, options);
    return true;
  } catch {
    return false;
  }
}
