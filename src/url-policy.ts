/**
 * Navigation URL policy — the single security gate applied before any
 * `page.goto()`. Blocks non-web schemes and SSRF/local-file targets reachable
 * from the unauthenticated RPC and from AI-translated (prompt-injectable)
 * instructions. Enforced at the `performAction` navigate boundary.
 */

export interface UrlPolicyOptions {
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
