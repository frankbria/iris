/**
 * Navigation URL policy — the single security gate applied before any
 * `page.goto()`. Blocks non-web schemes and SSRF/local-file targets reachable
 * from the unauthenticated RPC and from AI-translated (prompt-injectable)
 * instructions. Enforced at the `performAction` navigate boundary.
 */

import { BlockList, isIP } from 'net';
import { isHostedMode } from './hosted';

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
  /** Allow `file://` navigation (e.g. the watcher rendering local files). Default: false. Ignored under IRIS_HOSTED. */
  allowFile?: boolean;
  /**
   * Allow a `data:` document (e.g. the a11y CLI scanning inline HTML). Default: false.
   * Ignored under IRIS_HOSTED. Its sub-resources are still network requests, and still vetted.
   */
  allowData?: boolean;
  /** Also block loopback, private and reserved hosts (see PRIVATE_RANGES). Default: false (localhost dev-server testing stays allowed); always on under IRIS_HOSTED. */
  blockPrivateHosts?: boolean;
}

/** Strip IPv6 brackets, DNS-equivalent trailing dots, and lowercase for comparison. */
function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

/**
 * The IPv6 prefixes that carry an IPv4 address in their low 32 bits: mapped
 * (`::ffff:a.b.c.d`), the deprecated compatible form (`::a.b.c.d`), and NAT64 —
 * the well-known `64:ff9b::/96` and the local-use `64:ff9b:1::/96` layout. Each
 * IPv4 range is registered under all of them, so a blocked IPv4 target cannot be
 * reached by spelling it as one of these IPv6 forms — while NAT64 to a public
 * address, which IPv6-only networks depend on, stays reachable.
 */
const IPV4_IN_IPV6_PREFIXES = ['::ffff:', '::', '64:ff9b::', '64:ff9b:1::'];

function rangeList(v4: Array<[string, number]>, v6: Array<[string, number]>): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of v4) {
    list.addSubnet(net, prefix, 'ipv4');
    for (const p of IPV4_IN_IPV6_PREFIXES) list.addSubnet(p + net, 96 + prefix, 'ipv6');
  }
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

// ponytail: host matching is on the URL's hostname only. WHATWG parsing (the
// standard Chromium follows too; Node's is stricter, which fails closed here)
// canonicalises integer/hex/octal IPv4 and every IPv6 spelling first, so those
// are covered. Local-use NAT64 embedding at /48-/64 is not decoded, only its
// /96 layout; the whole prefix is private. A DNS name that *resolves* to
// a blocked address (incl. DNS rebinding) is not. That needs a resolve-at-connect
// control (the hosted egress layer), not string matching.

/** Cloud-metadata / link-local — always blocked, never a legitimate navigation target. */
const METADATA_HOSTS = new Set(['metadata.google.internal']);
const METADATA_RANGES = rangeList(
  [
    ['169.254.0.0', 16], // link-local, incl. AWS/GCP/Azure 169.254.169.254
    ['100.100.100.200', 32], // Alibaba Cloud metadata
  ],
  [
    ['fe80::', 10], // IPv6 link-local
    ['fd00:ec2::254', 128], // AWS IMDS over IPv6
  ],
);

/** Loopback / private / reserved — blocked only when blockPrivateHosts is set. */
const PRIVATE_RANGES = rangeList(
  [
    ['0.0.0.0', 8], // "this network" — Linux routes 0.0.0.0 to loopback
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // CGNAT, incl. Tailscale
    ['127.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.168.0.0', 16],
    ['198.18.0.0', 15], // benchmarking; carriers number internal gear from it
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
  ],
  [
    ['::', 128], // unspecified
    ['::1', 128],
    ['fc00::', 7], // ULA
    ['fec0::', 10], // deprecated site-local, still routed on legacy networks
    ['ff00::', 8], // multicast
    ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215): never globally reachable
  ],
);

/** Match a normalised host (brackets stripped) against a range list. */
function inRanges(host: string, list: BlockList): boolean {
  const family = isIP(host);
  return family !== 0 && list.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

function isLinkLocalOrMetadata(host: string): boolean {
  return METADATA_HOSTS.has(host) || inRanges(host, METADATA_RANGES);
}

function isPrivateHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || inRanges(host, PRIVATE_RANGES);
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
  // Hosted mode is applied here, last, rather than by each caller: every
  // navigation path (the navigate action, the per-request guard, the MCP
  // pre-flight) ends up in this function, and no caller's policy can relax it.
  if (isHostedMode()) {
    options = { ...options, blockPrivateHosts: true, allowFile: false, allowData: false };
  }

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

  if (scheme === 'data:' && options.allowData) return; // no host to range-check

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
