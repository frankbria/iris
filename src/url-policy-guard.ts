/**
 * Enforcement of the navigation URL policy on every request a page makes.
 *
 * `src/url-policy.ts` decides whether a single URL is allowed. This module is
 * what makes that decision stick for the requests a page issues *after* the one
 * the caller asked for — redirect targets and sub-resources — which is where the
 * policy was previously being walked around (issue #148).
 *
 * The load-bearing fact, measured rather than assumed:
 *
 *   Playwright does NOT invoke `page.route` for the target of a 30x. Chromium
 *   follows the redirect internally, so `route.continue()` hands it a URL the
 *   handler never saw. This is true for main-frame navigations AND for
 *   sub-resources — an <img> pointing at a redirect to 169.254.169.254 reaches
 *   it with the handler only ever seeing the original URL.
 *
 * Two further approaches were tried and rejected before settling on this shape:
 *
 *   - `route.fulfill()` with the 30x response does not make the browser re-issue
 *     a routed request; the navigation just hangs to the goto timeout.
 *   - `route.fulfill()` with the *final* response leaves the document on the
 *     pre-redirect URL, so the page's relative assets resolve against the wrong
 *     base. A stylesheet that 404s changes computed styles, which silently
 *     corrupts anything measuring the page.
 *
 * So navigations are refused at the route layer and re-driven by {@link guardedGoto},
 * which walks the chain one vetted hop at a time using real `page.goto` calls.
 * Every hop is checked before the browser is allowed to request it, and because
 * each hop is a genuine navigation the document URL and asset base stay correct.
 */

import type { Page, Route } from 'playwright';
import { isNavigationAllowed } from './url-policy';
import type { UrlPolicyOptions } from './url-policy';

/** Bound on a redirect chain, for both the sub-resource walk and {@link guardedGoto}. */
export const MAX_REDIRECT_HOPS = 10;

/**
 * Cap on a single guarded fetch. Must stay below `page.goto`'s 30s default:
 * whichever fires first owns the error the caller sees, and the guard's reason
 * is the useful one. It also bounds the commonest mistake — pointing a tool at a
 * dev server that is not running — because Playwright's Node-side fetch does not
 * fail fast on a refused connection the way Chromium's own stack does (measured:
 * ~28s to localhost:1).
 */
const GUARDED_FETCH_TIMEOUT_MS = 15_000;

/** Why the guard turned a navigation away, and where it was headed. */
interface NavigationRefusal {
  /** Human-readable cause, replacing the opaque `net::ERR_BLOCKED_BY_CLIENT`. */
  reason?: string;
  /** Set only for a policy-ALLOWED redirect, i.e. one `guardedGoto` may follow. */
  redirectTo?: string;
  /**
   * True while `guardedGoto` is awaiting a main-frame navigation, so it — and
   * not the route handler — will re-drive the next hop. Any other document
   * redirect (a click, a form POST, an iframe) has nobody waiting on it.
   */
  driving?: boolean;
}

/**
 * Per-page refusal state.
 *
 * A WeakMap rather than a parameter threaded through every caller: the route
 * handler and the goto live in different call stacks, and tying the record to
 * the page means it cannot be paired with the wrong one or outlive it.
 */
const refusals = new WeakMap<Page, NavigationRefusal>();

/**
 * Only http(s) can redirect, and only http(s) can be re-issued through
 * `route.fetch` — it is an HTTP client, and handing it a `file://` URL throws,
 * which the guard would then report as a failed request. Other allowed schemes
 * (file:, when a caller opts in) are passed straight through after the policy
 * check: there is no redirect chain to walk.
 */
function isHttpScheme(url: string): boolean {
  return /^https?:/i.test(url);
}

/**
 * Apply the policy to a non-document request, following any redirect chain one
 * hop at a time.
 *
 * Unlike a navigation this follows rather than refuses: a sub-resource has no
 * document base to get wrong, and CDN redirects on images and fonts are ordinary
 * enough that refusing them would degrade the very page being measured.
 */
async function guardSubresource(route: Route, policy: UrlPolicyOptions): Promise<void> {
  let url = route.request().url();

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isNavigationAllowed(url, policy)) {
      await route.abort('blockedbyclient');
      return;
    }

    if (!isHttpScheme(url)) {
      await route.continue();
      return;
    }

    let response;
    try {
      response = await route.fetch({ url, maxRedirects: 0, timeout: GUARDED_FETCH_TIMEOUT_MS });
    } catch {
      await route.abort('failed');
      return;
    }

    const status = response.status();
    const location = response.headers()['location'];
    if (status < 300 || status >= 400 || !location) {
      await route.fulfill({ response });
      return;
    }

    try {
      url = new URL(location, url).toString();
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
  }

  // Chain too long: a redirect loop, or an attempt to outlast the check.
  await route.abort('blockedbyclient');
}

/**
 * Install the policy guard on a page. Call once, before the first navigation, so
 * that no request escapes it.
 *
 * Pages without a guard are unaffected: {@link guardedGoto} falls back to a plain
 * `page.goto`, so a caller that does not want the policy simply does not install it.
 */
export async function installUrlPolicyGuard(page: Page, policy: UrlPolicyOptions): Promise<void> {
  const refusal: NavigationRefusal = {};
  refusals.set(page, refusal);

  await page.route('**/*', async (route) => {
    const request = route.request();

    if (request.resourceType() !== 'document') {
      await guardSubresource(route, policy);
      return;
    }

    const url = request.url();
    if (!isNavigationAllowed(url, policy)) {
      refusal.reason = `blocked by navigation policy: ${url}`;
      refusal.redirectTo = undefined;
      await route.abort('blockedbyclient');
      return;
    }

    if (!isHttpScheme(url)) {
      refusal.reason = undefined;
      refusal.redirectTo = undefined;
      await route.continue();
      return;
    }

    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: GUARDED_FETCH_TIMEOUT_MS });
    } catch (error) {
      refusal.reason = `could not be fetched: ${error instanceof Error ? error.message : String(error)}`;
      refusal.redirectTo = undefined;
      await route.abort('failed');
      return;
    }

    const status = response.status();
    const location = response.headers()['location'];
    if (status < 300 || status >= 400 || !location) {
      refusal.reason = undefined;
      refusal.redirectTo = undefined;
      await route.fulfill({ response });
      return;
    }

    // A redirect. Vet the target, then hand it back for guardedGoto to re-drive
    // as a real navigation rather than following it here — see the module note.
    let target: string;
    try {
      target = new URL(location, url).toString();
    } catch {
      refusal.reason = `redirects to an unparseable location: ${location}`;
      refusal.redirectTo = undefined;
      await route.abort('blockedbyclient');
      return;
    }

    if (isNavigationAllowed(target, policy)) {
      refusal.reason = undefined;
      refusal.redirectTo = target;
      // 'aborted', not 'blockedbyclient': this hop is being *deferred*, not
      // refused. It matters mechanically as well as semantically —
      // blockedbyclient commits a chrome-error:// page, and that navigation
      // then interrupts the very retry about to be issued.
      await route.abort('aborted');

      // Only an explicit guardedGoto on the main frame has a caller waiting to
      // re-drive the hop. Every other redirect — a clicked link, a form POST
      // answered with a 302, an iframe — has nobody, and deferring it would
      // simply strand the navigation on the previous page. Drive it here.
      //
      // Deliberately not awaited: awaiting a navigation from inside a route
      // handler deadlocks, since the navigation's own requests need this
      // handler to return first. Re-entry is fine and bounded — the new
      // request is vetted like any other, and a chain that will not settle
      // still terminates on the hop cap.
      const frame = request.frame();
      const drivenByCaller = refusal.driving && frame === page.mainFrame();
      if (!drivenByCaller) {
        void frame.goto(target).catch(() => {
          // The navigation may be superseded or the frame detached; either way
          // the failure surfaces to whatever is observing the page, not here.
        });
      }
      return;
    }

    refusal.reason = `redirects to ${target}, which is blocked by navigation policy`;
    refusal.redirectTo = undefined;
    await route.abort('blockedbyclient');
  });
}

/**
 * `page.goto` with the policy enforced on every hop and redirect semantics intact.
 *
 * The route guard refuses a redirect rather than following it, so this walks the
 * chain itself: each allowed target is re-issued as a genuine `page.goto`, which
 * keeps the document URL and the asset base correct at every step — the thing
 * fulfilling the final response silently gets wrong.
 *
 * @returns the URL actually landed on, which differs from `url` when redirected.
 * @throws with the guard's reason (not `net::ERR_BLOCKED_BY_CLIENT`) when refused.
 */
export async function guardedGoto(
  page: Page,
  url: string,
  options?: Parameters<Page['goto']>[1],
): Promise<string> {
  const refusal = refusals.get(page);
  if (!refusal) {
    // No guard installed: this page opted out of the policy entirely.
    await page.goto(url, options);
    return url;
  }

  let target = url;

  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      refusal.reason = undefined;
      refusal.redirectTo = undefined;
      // Claim the re-drive, so the route handler defers to this loop instead of
      // navigating the main frame underneath it.
      refusal.driving = true;

      try {
        await page.goto(target, options);
        return target;
      } catch (error) {
        if (refusal.redirectTo) {
          target = refusal.redirectTo;
          continue;
        }
        if (refusal.reason) {
          throw new Error(`${target} ${refusal.reason}`);
        }
        throw error;
      }
    }
  } finally {
    refusal.driving = false;
  }

  throw new Error(`${url} exceeded ${MAX_REDIRECT_HOPS} redirects without settling.`);
}
