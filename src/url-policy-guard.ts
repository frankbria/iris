/**
 * Enforcement of the navigation URL policy on every request a page makes.
 *
 * `src/url-policy.ts` decides whether a single URL is allowed. This module makes
 * that decision stick for the requests a page issues *after* the one the caller
 * asked for — redirect targets and sub-resources — which is where the policy was
 * previously being walked around (issue #148).
 *
 * ## Why CDP rather than `page.route`
 *
 * Playwright's `page.route` cannot express this. Measured, in order:
 *
 * 1. `route.continue()` does not re-route the target of a 30x — Chromium
 *    follows it internally — so the handler never sees where it actually went.
 *    That was the original bug (#148).
 * 2. `route.fulfill()` with the redirect response does not make the browser
 *    re-issue a routed request; the navigation hangs to the goto timeout.
 * 3. `route.fetch()` + `route.fulfill()` with the *final* response works for
 *    vetting, but a fulfilled document can never open a WebSocket afterwards —
 *    same-origin included — which broke every app using live reload or a
 *    subscription transport (#154). Unrouting afterwards does not undo it; nor
 *    does fulfilling manually rather than passing the response; nor does
 *    Playwright 1.62.1.
 *
 * CDP's Fetch domain pauses each request at *request* stage, where the URL can
 * be checked before anything is sent, and — unlike `page.route` — it re-pauses
 * the target of a redirect, for documents and sub-resources alike. The request
 * is then continued natively, so the page stays network-backed and WebSockets
 * keep working.
 *
 * Chromium-only, which is what IRIS launches everywhere.
 */

import type { BrowserContext, CDPSession, Page } from 'playwright';
import { assertNavigationAllowed, isWithinPinnedOrigin } from './url-policy';
import type { UrlPolicyOptions } from './url-policy';

/**
 * Resource types exempt from origin pinning (CDP spelling).
 *
 * These are rendered, not executed and not readable: the page cannot pull an
 * arbitrary response body out of an image or a font. Refusing them would break
 * the page the agent is trying to read, for no security gain.
 *
 * Everything NOT listed stays pinned, and the exclusions are deliberate:
 *
 * - `XHR`, `Fetch`, `EventSource`, `Ping` — carry data off-origin and return
 *   readable responses, so a same-origin click that fires one is an
 *   exfiltration channel the agent's per-action check cannot see.
 * - `Script` — code execution with the page's own authority. A cross-origin
 *   script can read the DOM and act as the user, which is precisely the
 *   post-click injection scenario this control exists for. It is NOT passive,
 *   however much it looks like a static asset in a network log. The cost is
 *   real — a site serving its JavaScript from a CDN needs
 *   `--allow-cross-origin` — and taken deliberately.
 *
 * Unknown future types default to pinned rather than exempt.
 */
const PIN_EXEMPT_RESOURCE_TYPES = new Set([
  'stylesheet',
  'image',
  'media',
  'font',
  'texttrack',
  'manifest',
]);

/** Why the guard turned a navigation away. */
interface NavigationRefusal {
  /** The URL that was actually refused — the redirect target, when redirected. */
  url?: string;
  /** The policy's own explanation, e.g. "link-local/metadata host …". */
  detail?: string;
}

/** Everything the CDP handler and `guardedGoto` share for one page. */
interface GuardState {
  refusal: NavigationRefusal;
  /** Live, so a later install can tighten the policy without a second session. */
  policy: UrlPolicyOptions;
}

/**
 * Per-page guard state.
 *
 * A WeakMap rather than a parameter threaded through every caller: the CDP
 * handler and the goto live in different call stacks, and tying the record to
 * the page means it cannot be paired with the wrong one or outlive it.
 */
const guards = new WeakMap<Page, GuardState>();

/**
 * Contexts already carrying the popup net, so it is attached exactly once.
 *
 * Carries the most recently installed guard, for the one request that cannot be
 * attributed to a page — see {@link installContextNet}.
 */
const guardedContexts = new WeakMap<BrowserContext, { latest: GuardState }>();

/**
 * Why the policy refuses this URL, or null when it does not.
 *
 * The boolean form is enough to decide but not to explain, and "blocked by
 * navigation policy" tells a caller nothing about whether it was the scheme, a
 * metadata host, or the pinned origin. Ask for the reason instead.
 */
function blockReason(url: string, policy: UrlPolicyOptions): string | null {
  try {
    assertNavigationAllowed(url, policy);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The policy as it applies to one request, relaxing the pin for passive assets.
 *
 * Case-insensitive because the two interception layers spell resource types
 * differently — CDP says `Stylesheet`, Playwright says `stylesheet` — and a
 * mismatch here would silently un-exempt every passive asset.
 */
function policyFor(policy: UrlPolicyOptions, resourceType: string): UrlPolicyOptions {
  return PIN_EXEMPT_RESOURCE_TYPES.has(resourceType.toLowerCase())
    ? { ...policy, pinnedOrigin: undefined }
    : policy;
}

/** ws/wss onto http/https, so a page's own socket is not mistaken for an escape. */
function toHttpScheme(wsUrl: string): string {
  return wsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

/**
 * Refuse WebSocket connections that leave the pinned origin.
 *
 * Separate from the request guard because CDP's Fetch domain does not cover the
 * WebSocket handshake, so a direct, readable, bidirectional channel off-origin
 * would otherwise be exempt by accident.
 */
async function installWebSocketPin(page: Page, state: GuardState): Promise<void> {
  // Match only the sockets to be refused, so an allowed one is never
  // intercepted and needs no proxying to keep working.
  await page.routeWebSocket(
    (url) => {
      // Read the pin from the live state, not a captured parameter: a later
      // install can tighten or replace it, and a closed-over value would keep
      // enforcing the origin that was pinned first.
      const pinnedOrigin = state.policy.pinnedOrigin;
      if (!pinnedOrigin) return false;
      return !isWithinPinnedOrigin(toHttpScheme(url.toString()), pinnedOrigin);
    },
    (ws) => ws.close({ code: 1008, reason: 'blocked: leaves the pinned origin' }),
  );
}

/** Attach the Fetch handler that vets every request before it is sent. */
async function installFetchGuard(page: Page, state: GuardState): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(page);

  // Request stage only. It is sufficient *because* CDP re-pauses the target of
  // a redirect as a fresh request — which `page.route` does not — so a 30x is
  // caught by checking the target's own URL, before it is sent.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  cdp.on('Fetch.requestPaused', async (event) => {
    const url = event.request.url;
    const reason = blockReason(url, policyFor(state.policy, event.resourceType));

    try {
      if (!reason) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        return;
      }

      // Recorded only for the main document: a blocked image must not overwrite
      // the reason a navigation failed, which is what the caller will be shown.
      if (event.resourceType === 'Document') {
        state.refusal = { url, detail: reason };
      }
      await cdp.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'BlockedByClient',
      });
    } catch {
      // The request can be gone before we answer — a cancelled navigation, a
      // closed page. There is nothing left to continue or fail.
    }
  });
}

/**
 * Catch requests from pages the per-page CDP guard is not on — a click that
 * opens a new tab (issue #155).
 *
 * Needed because both hooks are page-scoped and a popup is a different Page.
 * Installing a CDP session from `context.on('page')` loses the race: measured,
 * the popup's first request has already gone by the time that fires. A
 * context-level Playwright route does see it, so it covers the opening request
 * while the CDP session installed alongside covers everything after — including
 * redirect targets, which a route never sees.
 *
 * Only ever continues or aborts. Fulfilling is what broke WebSockets (#154) and
 * has no part here.
 */
async function installContextNet(
  context: BrowserContext,
  entry: { latest: GuardState },
): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();

    // `frame()` throws for the opening request of a page that does not exist
    // yet — "issued before the frame is created" — which is exactly the popup
    // case this net is here for. Playwright offers nothing else to attribute
    // that one request to, so it is vetted against the context's most recent
    // guard. Every other request names its own page and is judged by that
    // page's policy.
    let owner: Page | undefined;
    let attributable = true;
    try {
      owner = request.frame()?.page();
    } catch {
      attributable = false;
    }

    // An attributable page with no guard never opted in. Leaving it alone is
    // the documented contract; policing it with another page's pin would refuse
    // requests it never agreed to.
    const policy = attributable ? guards.get(owner as Page)?.policy : undefined;
    if (attributable && !policy) {
      await route.continue().catch(() => {});
      return;
    }

    // Unattributable: vetted against the context's most recent guard. Exact
    // whenever every page in the context shares a policy, which is the only
    // shape IRIS creates — one executor, one context, one policy. A context
    // holding pages pinned to *different* origins would judge this one request
    // by the newest of them — tracked as #158, along with why the fail-safe
    // version was reverted: its test could not be told apart from its absence.
    const effective = policy ?? entry.latest.policy;
    const reason = blockReason(request.url(), policyFor(effective, request.resourceType()));
    try {
      await (reason ? route.abort('blockedbyclient') : route.continue());
    } catch {
      // Page or request gone; nothing left to answer.
    }
  });

  // A popup gets its own CDP session, so requests after its first are vetted as
  // thoroughly as on the page that opened it. Deliberately NOT every new page:
  // a caller that creates one itself and installs no guard has opted out, and
  // an opener tells the two apart — `context.newPage()` has none.
  context.on('page', (candidate) => {
    void (async () => {
      const opener = await candidate.opener();
      const inherited = opener ? guards.get(opener)?.policy : undefined;
      if (inherited) {
        await installUrlPolicyGuard(candidate, inherited);
      }
    })().catch(() => {
      // A page that closed before the guard attached needs no guard.
    });
  });
}

/**
 * Install the policy guard on a page. Call once, before the first navigation, so
 * that no request escapes it.
 *
 * Also attaches a context-level net the first time it sees a context, so a page
 * opened from this one — a `target=_blank` click, `window.open` — is covered
 * too (issue #155).
 *
 * Pages without a guard are unaffected: {@link guardedGoto} falls back to a plain
 * `page.goto`, so a caller that does not want the policy simply does not install it.
 */
export async function installUrlPolicyGuard(page: Page, policy: UrlPolicyOptions): Promise<void> {
  // Installing twice must not attach a second handler, which would double-answer
  // every paused request. Merge into the live policy instead, so a later caller
  // (the agent loop pinning an origin) can tighten what an earlier one (the
  // executor) established.
  const existing = guards.get(page);
  if (existing) {
    const hadPin = existing.policy.pinnedOrigin;
    existing.policy = { ...existing.policy, ...policy };
    // A merge that introduces a pin still needs the WebSocket route, which the
    // first install had no reason to add. A merge that *changes* one does not:
    // the predicate reads the live policy, so it follows the new value.
    if (!hadPin && existing.policy.pinnedOrigin) {
      await installWebSocketPin(page, existing);
    }
    return;
  }

  const state: GuardState = { refusal: {}, policy };
  guards.set(page, state);

  const context = page.context();
  const contextEntry = guardedContexts.get(context);
  if (contextEntry) {
    contextEntry.latest = state;
  } else {
    const entry = { latest: state };
    guardedContexts.set(context, entry);
    await installContextNet(context, entry);
  }

  await installFetchGuard(page, state);
  if (policy.pinnedOrigin) {
    await installWebSocketPin(page, state);
  }
}

/**
 * `page.goto` with the policy enforced on every hop.
 *
 * Redirects are followed natively by the browser — each hop is paused and vetted
 * on the way — so the document URL and asset base stay correct without this
 * having to re-drive anything.
 *
 * @returns the URL actually landed on, which differs from `url` when redirected.
 * @throws with the policy's reason rather than `net::ERR_BLOCKED_BY_CLIENT`.
 */
export async function guardedGoto(
  page: Page,
  url: string,
  options?: Parameters<Page['goto']>[1],
): Promise<string> {
  const state = guards.get(page);
  if (!state) {
    // No guard installed: this page opted out of the policy entirely. Report
    // where it landed, since the browser still follows redirects natively — the
    // return value has to mean the same thing on both paths.
    const response = await page.goto(url, options);
    return response?.url() ?? url;
  }

  // Checked here as well as in the handler, because CDP's Fetch domain only
  // covers network requests: a `file://` URL is never paused, so the policy
  // would otherwise not apply to it at all.
  const blocked = blockReason(url, state.policy);
  if (blocked) {
    throw new Error(`${url} blocked by navigation policy: ${blocked}`);
  }

  state.refusal = {};
  try {
    const response = await page.goto(url, options);
    return response?.url() ?? url;
  } catch (error) {
    const { url: refusedUrl, detail } = state.refusal;
    if (detail) {
      // Name the hop that was actually refused. When it is not the URL asked
      // for, say so — "blocked" on a URL the caller can see is fine tells them
      // nothing about which redirect went wrong.
      throw refusedUrl && refusedUrl !== url
        ? new Error(
            `${url} redirects to ${refusedUrl}, which is blocked by navigation policy: ${detail}`,
          )
        : new Error(`${url} blocked by navigation policy: ${detail}`);
    }
    throw error;
  }
}
