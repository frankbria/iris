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

import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { assertNavigationAllowed } from './url-policy';
import type { UrlPolicyOptions } from './url-policy';

/**
 * Live popups a guarded context may hold at once (#337).
 *
 * Each popup is a renderer and a guard session of its own, and a page can open
 * them in a loop. Past this many, every request a new one makes is refused and
 * it is closed. A checkout's payment window or an OAuth popup is one or two.
 */
export const MAX_POPUPS_PER_CONTEXT = 5;

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
 * Carries *every* live guard in the context, not just the newest, so the one
 * request that cannot be attributed to a page can be judged against all of them
 * — see {@link installContextNet} and issue #158.
 */
const guardedContexts = new WeakMap<BrowserContext, ContextEntry>();

interface ContextEntry {
  /** Every guard currently installed in this context. Pruned when a page closes. */
  guards: Set<GuardState>;
}

/**
 * What the guard decided about one request, and on what basis.
 *
 * Exists because the behaviour it describes is otherwise untestable. The
 * fail-safe treatment of unattributable requests was written once before and
 * reverted, because no test could tell it apart from its own absence: whether
 * such a request is checked against all policies, the newest one, or none, the
 * popup-blocking tests pass identically (issue #158). Whether a request reached
 * a server cannot distinguish *which* policy refused it.
 *
 * Reporting the decision makes that observable, so security behaviour can be
 * asserted directly rather than inferred.
 */
export interface GuardDecision {
  url: string;
  resourceType: string;
  /**
   * `page` — the request named its own frame and was judged by that page's policy.
   * `context-net` — unattributable (a popup's opening request); judged against
   * every guard in the context.
   * `opener` — a popup's request judged against the policy of the page that
   * opened it, before the popup has a guard of its own: its documents (opening
   * request, redirect hops) by the browser net, anything else by the context net.
   */
  attribution: 'page' | 'context-net' | 'opener';
  /** Every policy consulted, in the order consulted. */
  policies: UrlPolicyOptions[];
  allowed: boolean;
  /** Why it was refused, or null when allowed. */
  reason: string | null;
}

let decisionObserver: ((decision: GuardDecision) => void) | undefined;

/**
 * Observe guard decisions. Diagnostic/test seam; pass nothing to stop.
 *
 * Deliberately module-level rather than an option threaded through
 * {@link installUrlPolicyGuard}: the context net is installed once per context
 * from whichever page arrives first, so a per-page observer could not see the
 * decisions this exists to expose.
 */
export function observeGuardDecisions(observer?: (decision: GuardDecision) => void): void {
  decisionObserver = observer;
}

function reportDecision(decision: GuardDecision): void {
  // Never let a misbehaving observer change what the guard does.
  try {
    decisionObserver?.(decision);
  } catch {
    // ignored
  }
}

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

/** ws/wss onto http/https, so a page's own socket is not mistaken for an escape. */
function toHttpScheme(wsUrl: string): string {
  return wsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

/**
 * Refuse WebSocket connections the policy refuses: one that leaves the pinned
 * origin, or one to a host the request guard would block (metadata always;
 * private hosts under `blockPrivateHosts` or IRIS_HOSTED, #334).
 *
 * Separate from the request guard because CDP's Fetch domain does not cover the
 * WebSocket handshake, so a direct, readable, bidirectional channel would
 * otherwise be exempt by accident. Page-level only: a worker's socket is not
 * routed here. In hosted mode the egress proxy (src/egress-proxy.ts, #336) sees
 * it; in local mode nothing does.
 */
async function installWebSocketGuard(page: Page, state: GuardState): Promise<void> {
  // Match only the sockets to be refused, so an allowed one is never
  // intercepted and needs no proxying to keep working. The policy is read from
  // the live state, not a captured parameter: a later install can tighten or
  // replace it, and a closed-over value would keep enforcing the first one.
  await page.routeWebSocket(
    (url) => blockReason(toHttpScheme(url.toString()), state.policy) !== null,
    (ws) => ws.close({ code: 1008, reason: 'blocked by navigation policy' }),
  );
}

/**
 * Attach the Fetch handler that vets every request before it is sent.
 *
 * @returns the page's CDP session, reused to find its target id for the browser net.
 */
async function installFetchGuard(page: Page, state: GuardState): Promise<CDPSession> {
  const cdp: CDPSession = await page.context().newCDPSession(page);

  // Request stage only. It is sufficient *because* CDP re-pauses the target of
  // a redirect as a fresh request — which `page.route` does not — so a 30x is
  // caught by checking the target's own URL, before it is sent.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  cdp.on('Fetch.requestPaused', async (event) => {
    const url = event.request.url;
    const reason = blockReason(url, state.policy);

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

  return cdp;
}

/** One guarded target as the browser net sees it. */
interface NetTarget {
  state: GuardState;
  /** A popup still running on its opener's guard, not yet on one of its own. */
  inherited: boolean;
}

interface BrowserNet {
  /** Guarded pages and the popups opened from them, by CDP target id. */
  targets: Map<string, NetTarget>;
  /** Live popups of guarded pages, per browser context id, for the cap. */
  popups: Map<string, Set<string>>;
  /** Popups over the cap: every request they make is refused until they are closed. */
  overCap: Set<string>;
}

const browserNets = new WeakMap<Browser, Promise<BrowserNet>>();

/**
 * Vet every popup document — its opening request and each redirect hop — before
 * it is sent (#337).
 *
 * Neither page-scoped layer can. The context route sees a popup's opening
 * request, but Playwright continues the hops of a redirect itself, so a
 * same-origin link that 302s elsewhere was never checked. The popup's own CDP
 * session attaches too late — its first request has gone by the time the 'page'
 * event fires, and holding that request until then deadlocks, because the event
 * waits for it.
 *
 * A browser-level session has neither problem: it pauses the documents of every
 * target, and `Target.targetCreated` names the opener before the popup's first
 * request arrives. So a popup is judged by exactly the policy of the page that
 * opened it — no guessing among the context's guards — until its own guard
 * attaches. Documents only: sub-resources of a popup are the job of that guard.
 */
async function startBrowserNet(browser: Browser): Promise<BrowserNet> {
  const cdp = await browser.newBrowserCDPSession();
  const net: BrowserNet = { targets: new Map(), popups: new Map(), overCap: new Set() };

  cdp.on('Target.targetCreated', ({ targetInfo }) => {
    const opener = targetInfo.openerId ? net.targets.get(targetInfo.openerId) : undefined;
    if (!opener || targetInfo.type !== 'page') return;

    // Registered even when over the cap: its WindowProxy is live as soon as
    // window.open returns, and a popup opened through it must still find a
    // guarded opener — and so the cap — rather than fall through unjudged.
    net.targets.set(targetInfo.targetId, { state: opener.state, inherited: true });

    const contextId = targetInfo.browserContextId ?? '';
    const live = net.popups.get(contextId) ?? new Set<string>();
    net.popups.set(contextId, live);
    if (live.size >= MAX_POPUPS_PER_CONTEXT) {
      // Refused here, closed once its own guard install sees it (joinBrowserNet).
      // Not Target.closeTarget now: closing a target Playwright is still
      // attaching to stalls the click that opened it — measured, 2 runs in 3.
      net.overCap.add(targetInfo.targetId);
      return;
    }
    live.add(targetInfo.targetId);
  });

  cdp.on('Target.targetDestroyed', ({ targetId }) => {
    net.targets.delete(targetId);
    net.overCap.delete(targetId);
    for (const live of net.popups.values()) live.delete(targetId);
  });

  cdp.on('Fetch.requestPaused', async (event) => {
    const url = event.request.url;
    // A top-level frame's id is its target id, so this matches the main
    // document of a guarded page or popup. Subframes are the page guard's job.
    const target = net.targets.get(event.frameId);
    let reason: string | null = null;
    if (net.overCap.has(event.frameId)) {
      reason = `popup limit reached (${MAX_POPUPS_PER_CONTEXT} per context)`;
    } else if (target) {
      reason = blockReason(url, target.state.policy);
      if (target.inherited) {
        reportDecision({
          url,
          resourceType: event.resourceType,
          attribution: 'opener',
          policies: [target.state.policy],
          allowed: reason === null,
          reason,
        });
      } else if (reason) {
        // Whichever layer answers first wins; record it so guardedGoto can
        // still say why. Never for a popup — that would overwrite its opener's.
        target.state.refusal = { url, detail: reason };
      }
    }

    try {
      await (reason
        ? cdp.send('Fetch.failRequest', {
            requestId: event.requestId,
            errorReason: 'BlockedByClient',
          })
        : cdp.send('Fetch.continueRequest', { requestId: event.requestId }));
      // Also closed here, not only from its guard install: a popup opened
      // through an over-cap popup has no live opener by then, so Playwright
      // reports none and no guard is ever installed on it.
      if (net.overCap.has(event.frameId)) {
        await cdp.send('Target.closeTarget', { targetId: event.frameId });
      }
    } catch {
      // Target or request already gone.
    }
  });

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });
  return net;
}

/**
 * Register a guarded page with its browser's net, starting the net on first use.
 *
 * @returns false for a popup over the cap, which the caller closes instead of guarding.
 */
async function joinBrowserNet(page: Page, state: GuardState, cdp: CDPSession): Promise<boolean> {
  const browser = page.context().browser();
  if (!browser) return true; // a persistent context; IRIS never launches one (#331)

  let net = browserNets.get(browser);
  if (!net) {
    net = startBrowserNet(browser);
    browserNets.set(browser, net);
    // A failed start must not poison every later install on this browser.
    net.catch(() => browserNets.delete(browser));
  }
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  const joined = await net;
  if (joined.overCap.has(targetInfo.targetId)) return false;
  joined.targets.set(targetInfo.targetId, { state, inherited: false });
  return true;
}

/**
 * Catch requests from pages the per-page CDP guard is not on — a click that
 * opens a new tab (issue #155).
 *
 * Needed because both hooks are page-scoped and a popup is a different Page.
 * Installing a CDP session from `context.on('page')` loses the race: measured,
 * the popup's first request has already gone by the time that fires. A
 * context-level Playwright route does see it, so it covers the opening request
 * and the popup's CDP session covers what the popup requests once attached. The
 * opening request's redirect hops fall between the two — the route never sees
 * them and the session is not there yet — which is what the browser net
 * ({@link startBrowserNet}) exists for (#337).
 *
 * Only ever continues or aborts. Fulfilling is what broke WebSockets (#154) and
 * has no part here.
 */
async function installContextNet(context: BrowserContext, entry: ContextEntry): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();

    // `frame()` throws for the opening request of a page that does not exist
    // yet — "issued before the frame is created" — which is exactly the popup
    // case this net is here for. Playwright offers nothing else to attribute
    // that one request to, so it is vetted against every guard in the context
    // (below). Every other request names its own page and is judged by that
    // page's policy.
    let owner: Page | undefined;
    let attributable = true;
    try {
      owner = request.frame()?.page();
    } catch {
      attributable = false;
    }

    let policy = attributable ? guards.get(owner as Page)?.policy : undefined;
    // A popup of a guarded page whose own guard is still attaching: judged by
    // its opener's policy meanwhile, so assets its first document requests
    // cannot go out in that window (#337).
    let viaOpener = false;
    if (owner && !policy) {
      const opener = await owner.opener().catch(() => null);
      policy = opener ? guards.get(opener)?.policy : undefined;
      viaOpener = policy !== undefined;
    }

    // An attributable page with no guard (and no guarded opener) never opted
    // in. Leaving it alone is the documented contract; policing it with another
    // page's pin would refuse requests it never agreed to.
    if (attributable && !policy) {
      await route.continue().catch(() => {});
      return;
    }

    const url = request.url();
    const resourceType = request.resourceType();

    // Attributable: judged by its own page's policy, as before.
    //
    // Unattributable (a popup's opening request): judged against EVERY guard in
    // the context, refusing if any refuses. Playwright cannot name the opener
    // for a request issued before its frame exists, so there is no way to pick
    // the right policy — and picking the newest, as this did, would let an
    // off-origin URL through whenever it happened to match a newer sibling's
    // pin. Consulting all of them cannot be too permissive; it can only be too
    // strict, and in the single-policy contexts IRIS actually creates the two
    // are identical (issue #158).
    const consulted = policy ? [policy] : [...entry.guards].map((g) => g.policy);
    let reason: string | null = null;
    for (const candidate of consulted) {
      reason = blockReason(url, candidate);
      if (reason) break; // one refusal is enough
    }

    reportDecision({
      url,
      resourceType,
      attribution: viaOpener ? 'opener' : policy ? 'page' : 'context-net',
      policies: consulted,
      allowed: reason === null,
      reason,
    });

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
    // The WebSocket route reads the live policy, so it follows the merge.
    existing.policy = { ...existing.policy, ...policy };
    return;
  }

  const state: GuardState = { refusal: {}, policy };
  guards.set(page, state);

  const context = page.context();
  let contextEntry = guardedContexts.get(context);
  if (!contextEntry) {
    contextEntry = { guards: new Set() };
    guardedContexts.set(context, contextEntry);
    await installContextNet(context, contextEntry);
  }
  // Every live guard, so an unattributable request can be judged against all of
  // them. Pruned on close: a policy from a page that is gone must not keep
  // refusing requests for the pages still open.
  contextEntry.guards.add(state);
  const entryRef = contextEntry;
  page.once('close', () => entryRef.guards.delete(state));

  const cdp = await installFetchGuard(page, state);
  if (!(await joinBrowserNet(page, state, cdp))) {
    await page.close();
    return;
  }
  await installWebSocketGuard(page, state);
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
