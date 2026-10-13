/**
 * What the agent loop is permitted to do (issue #151).
 *
 * The prompt boundary shipped in #150 tries to stop a page from steering the
 * agent. This is the other half: bounding the blast radius for when it works
 * anyway. A prompt guard lowers the odds an injection lands; it does nothing
 * about what happens next, and the loop otherwise has every action type
 * available on every turn, unattended, against a live authenticated browser.
 *
 * Enforced in the loop rather than the CLI so every caller of `runAgentLoop`
 * gets it, and so a refusal is fed back to the model as a failed action it can
 * see and adapt to.
 */

import type { ElementHandle, Locator, Page } from 'playwright';
import type { Action } from './actions';
import { isWithinPinnedOrigin } from './url-policy';
import { installUrlPolicyGuard } from './url-policy-guard';
import { withPageTimeout } from './page-timeout';

export type ActionType = Action['type'];

export const ALL_ACTION_TYPES: readonly ActionType[] = ['click', 'fill', 'navigate', 'assert'];

/**
 * Words that suggest an action destroys something or is otherwise hard to undo.
 *
 * Deliberately NOT a commerce list. Blocking "checkout" or "purchase" would
 * break the flagship use case this loop exists for ("make sure users can
 * complete checkout"), and buying something is at least a reversible business
 * process with a receipt. This is about data the user cannot get back.
 *
 * Matched as whole words so "undelete" and "removal-policy" do not trip it,
 * though "Remove filter" still will — a false positive costs one flag
 * (`--allow-destructive`) and names what matched, while a false negative costs
 * the user their account.
 */
const DESTRUCTIVE_TERMS = [
  'delete',
  'destroy',
  'erase',
  'purge',
  'wipe',
  'remove',
  'deactivate',
  'terminate',
  'revoke',
  'uninstall',
  'unsubscribe',
  'permanently',
  'reset',
  'drop',
];

const DESTRUCTIVE_PATTERN = new RegExp(`\\b(${DESTRUCTIVE_TERMS.join('|')})\\b`, 'i');

/**
 * Put word boundaries where selector conventions hide them.
 *
 * `\b` sees `#deleteAccount` and `#delete_account` as single words, so a plain
 * word-boundary match would wave through exactly the ids a real app uses — the
 * check would only fire on prose like `has-text("Delete account")`. Splitting
 * camelCase and underscores first makes the same pattern see `delete Account`.
 */
function separateWords(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_+/g, ' ');
}

/**
 * Undo CSS escapes (#353). `#\64 elete-account` and `#de\lete` select `#delete...` but
 * hide the word from the pattern. Hex escapes take up to six digits and one optional
 * trailing space; any other escaped character stands for itself.
 */
function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6}) ?|(.))/g, (_m, hex: string, char: string) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char,
  );
}

/** The destructive term `text` contains, if any. */
function destructiveTerm(text: string): string | null {
  return DESTRUCTIVE_PATTERN.exec(separateWords(text))?.[1] ?? null;
}

export interface AgentPolicy {
  /** Action types the agent may execute. Defaults to all of them. */
  allow?: readonly ActionType[];
  /**
   * Confine the agent to the origin it started on. Defaults to true.
   *
   * Covers two distinct moves: the model proposing a navigation elsewhere, and
   * the page having already drifted (a server redirect, a scripted navigation)
   * before the next turn plans against it. Both end with the agent acting on an
   * origin the user never pointed it at, which is where "already authenticated"
   * turns into a real problem.
   */
  pinOrigin?: boolean;
  /** Permit actions whose target reads as destructive. Defaults to false. */
  allowDestructive?: boolean;
  /** Origins the pinned page may load assets from (#378); see `UrlPolicyOptions.assetOrigins`. */
  assetOrigins?: readonly string[];
}

/** A refusal carries the reason so it can be logged and shown to the model. */
export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
  /**
   * The element the check read, when it read one (#530). Dispatch to it, not to the
   * selector: re-resolving the selector would act on whatever the page put there since,
   * unchecked. Hand it to `executeAction`, which disposes of it.
   */
  target?: ElementHandle;
}

const ALLOWED: PolicyVerdict = { allowed: true };

/** Origin of a URL, or null when it has none (about:blank, data:, malformed). */
export function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The text an action aims at, which is what a destructive-intent check reads. */
function targetText(action: Action): string {
  switch (action.type) {
    // CSS escapes are decoded in selectors only. A typed value, a URL or page text has no
    // escape syntax, and decoding it lost words: `delete\q` became `deleteq` (codex).
    case 'click':
      return decodeCssEscapes(action.selector);
    case 'fill':
      return `${decodeCssEscapes(action.selector)} ${action.text}`;
    case 'navigate':
      return action.url;
    case 'assert':
      return action.target;
  }
}

/**
 * Decide whether a model-proposed action may run.
 *
 * @param currentUrl where the page is right now — not where it started, since
 *   the point is to catch drift.
 * @param startOrigin the origin the run was pointed at, or null if unknown — in
 *   which case, with pinning on, every action is refused: there is nothing to
 *   confine to, and skipping the check would fail open (#337).
 */
export function checkAction(
  action: Action,
  policy: AgentPolicy,
  currentUrl: string,
  startOrigin: string | null,
): PolicyVerdict {
  // In order: the first refusal wins.
  const checks = [
    () => typeVerdict(action, policy),
    () => originVerdict(action, policy, currentUrl, startOrigin),
    () => destructiveVerdict(action, policy),
  ];
  for (const check of checks) {
    const verdict = check();
    if (verdict) return verdict;
  }
  return ALLOWED;
}

/** Refused when this run does not permit the action's type. */
function typeVerdict(action: Action, policy: AgentPolicy): PolicyVerdict | null {
  const allow = policy.allow ?? ALL_ACTION_TYPES;
  if (allow.includes(action.type)) return null;
  return {
    allowed: false,
    reason: `action type "${action.type}" is not permitted this run (allowed: ${allow.join(', ')})`,
  };
}

/** Under origin pinning: refused with no origin to pin to, off-origin, or leaving it. */
function originVerdict(
  action: Action,
  policy: AgentPolicy,
  currentUrl: string,
  startOrigin: string | null,
): PolicyVerdict | null {
  if (policy.pinOrigin === false) return null;
  if (!startOrigin) {
    return {
      allowed: false,
      reason:
        'no starting origin to pin to (about:blank, data:) — pass --allow-cross-origin to run unpinned',
    };
  }
  return driftVerdict(action, currentUrl, startOrigin) ?? leavingVerdict(action, startOrigin);
}

/**
 * Drift first: if the page already moved, nothing proposed against it should run, whatever
 * the action is. An opaque current URL (about:blank, data:, blob:) is NOT same-origin with
 * anything: treating "no origin" as "no problem" would let a page that navigated itself
 * somewhere opaque keep taking actions. Same predicate the request-layer guard uses, so the
 * two layers cannot disagree (they did once, and an http→https upgrade would load fine and
 * then have every action on it refused). A navigation into the pinned origin is let through
 * from anywhere: it is how a fresh page (about:blank) reaches the start origin, and it cannot
 * leak (codex, #354).
 */
function driftVerdict(
  action: Action,
  currentUrl: string,
  startOrigin: string,
): PolicyVerdict | null {
  const intoPinned = action.type === 'navigate' && isWithinPinnedOrigin(action.url, startOrigin);
  if (intoPinned || isWithinPinnedOrigin(currentUrl, startOrigin)) return null;
  return {
    allowed: false,
    reason: `page is on ${originOf(currentUrl) ?? 'an opaque origin'}, not the starting origin ${startOrigin} — refusing to act off-origin`,
  };
}

/** A navigation to an absolute URL elsewhere; a relative URL has no origin and stays put. */
function leavingVerdict(action: Action, startOrigin: string): PolicyVerdict | null {
  if (action.type !== 'navigate') return null;
  const target = originOf(action.url);
  if (!target || isWithinPinnedOrigin(action.url, startOrigin)) return null;
  return {
    allowed: false,
    reason: `navigation to ${target} leaves the starting origin ${startOrigin}`,
  };
}

/**
 * A destructive-looking target, unless allowed. Asserts are read-only by construction, so
 * they are exempt: checking them would refuse to *verify* that a delete button exists.
 */
function destructiveVerdict(action: Action, policy: AgentPolicy): PolicyVerdict | null {
  if (policy.allowDestructive || action.type === 'assert') return null;
  const term = destructiveTerm(targetText(action));
  if (!term) return null;
  return {
    allowed: false,
    reason: `target looks destructive ("${term}") — pass --allow-destructive to permit it`,
  };
}

/** Reading an attached element's attributes and text is quick; this only bounds a hung page. */
const READ_TIMEOUT_MS = 1000;

/** Attributes that name an element to its user, read with its text content. */
const NAMING_ATTRIBUTES = ['aria-label', 'title', 'id', 'name', 'value', 'placeholder', 'alt'];

/**
 * Check the element a click or fill would hit, on the live page (#353). The selector text
 * can hide its target: `form button:nth-of-type(2)` or `[id^="del"]` aim at "Delete
 * account" without naming it, and {@link checkAction} only reads the selector.
 *
 * A heuristic like the selector check, and the page controls what it reads: a hostile page
 * can still label a destructive control blandly. An element that never appears is refused
 * (see resolvedVerdict).
 */
export async function checkResolvedTarget(
  action: Action,
  policy: AgentPolicy,
  page: Page,
): Promise<PolicyVerdict> {
  // Only click and fill aim at an element; asserts are read-only (see checkAction).
  if (policy.allowDestructive || !('selector' in action)) return ALLOWED;
  return resolvedVerdict(page, action.selector);
}

/**
 * Fails closed (codex review, #353): an element the check cannot read is not acted on. The
 * check waits as long as the click would (the page's action timeout), so a control that
 * renders late is read, not skipped; one that never appears would have timed out in the
 * executor anyway.
 */
async function resolvedVerdict(page: Page, selector: string): Promise<PolicyVerdict> {
  const read = await elementWords(page.locator(selector).first());
  if (read === null) {
    return {
      allowed: false,
      reason: `target ${selector} was not found on the page, or could not be read`,
    };
  }
  const term = destructiveTerm(read.words);
  if (!term) return { allowed: true, target: read.handle };
  await read.handle.dispose().catch(() => undefined);
  return {
    allowed: false,
    reason: `target resolves to an element that looks destructive ("${term}") — pass --allow-destructive to permit it`,
  };
}

/** A read that failed, told apart from an attribute that is simply absent (null). */
const UNREAD = Symbol('unread');
const unread = () => UNREAD;

/**
 * What a user reads on `target`: its naming attributes and text content. Null when it is
 * not on the page within the page's action timeout, or when any read fails (it detached, a
 * read timed out): an element the check could not read is treated as one it did not find
 * (codex review, #353). Playwright's own reads, not a page function: under
 * `jest --coverage` a function sent to the page carries instrumentation the page does not
 * have.
 */
async function elementWords(
  target: Locator,
): Promise<{ words: string; handle: ElementHandle } | null> {
  let handle: ElementHandle | null;
  try {
    await target.waitFor({ state: 'attached' });
    // Read through one handle, the one the action is then dispatched to (#530): a
    // locator re-resolves on every call, so its reads could each see another element.
    handle = await target.elementHandle({ timeout: READ_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!handle) return null;
  // Bounded (codex review, #530): a handle's reads take no timeout, unlike a locator's,
  // so a hung renderer would stall the check. A read that times out is unread: refused.
  const bounded = (read: Promise<string | null>) =>
    withPageTimeout(read.catch(unread), UNREAD, READ_TIMEOUT_MS);
  const reads = await Promise.all([
    ...NAMING_ATTRIBUTES.map((name) => bounded(handle.getAttribute(name))),
    bounded(handle.textContent()),
  ]);
  if (reads.includes(UNREAD)) {
    await handle.dispose().catch(() => undefined);
    return null;
  }
  // Matched whole, not capped: a cap let a long benign title push "Delete account" out of
  // reach (codex review). The pattern is linear, run once per action.
  return { words: reads.filter(Boolean).join(' '), handle };
}

/** The flags a caller sets on a run: `--allow`, `--allow-cross-origin`, `--allow-destructive`. */
export interface PolicyFlags {
  allow?: readonly ActionType[];
  allowCrossOrigin?: boolean;
  allowDestructive?: boolean;
  allowAssetOrigins?: readonly string[];
}

/**
 * The policy a plan runs under (#354). A plan a model proposed (the agent loop, an AI
 * translation in one-shot `iris run` or the RPC) gets the agent's defaults (origin pinned,
 * destructive refused) and the flags relax them. A plan the caller wrote itself (a
 * pattern-translated instruction, explicit RPC `actions`) is the caller's own intent: only
 * a requested `--allow` restriction applies, and none at all without one (null).
 */
export function planPolicy(modelProposed: boolean, flags: PolicyFlags = {}): AgentPolicy | null {
  if (modelProposed) {
    return {
      allow: flags.allow,
      pinOrigin: !flags.allowCrossOrigin,
      allowDestructive: flags.allowDestructive,
      assetOrigins: flags.allowAssetOrigins,
    };
  }
  return flags.allow ? { allow: flags.allow, pinOrigin: false, allowDestructive: true } : null;
}

/**
 * The origin a run is confined to: the URL the caller asked for, else where the page is,
 * else the plan's first navigation (a one-shot plan that starts by navigating), else none.
 */
export function startOriginOf(
  requestedUrl: string | undefined,
  currentUrl: string,
  actions: readonly Action[],
): string | null {
  const firstNavigate = actions.find((a) => a.type === 'navigate');
  return (
    originOf(requestedUrl ?? '') ??
    originOf(currentUrl) ??
    (firstNavigate?.type === 'navigate' ? originOf(firstNavigate.url) : null)
  );
}

/**
 * Confine `page` to `startOrigin` at the request layer when the policy pins (#337): the
 * per-action check refuses only the next action, after a same-origin click that navigated
 * away has already made its request. False when pinning is on and there is no origin.
 */
export async function pinPage(
  page: Page,
  policy: AgentPolicy,
  startOrigin: string | null,
): Promise<boolean> {
  if (policy.pinOrigin === false) return true;
  if (!startOrigin) return false;
  await installUrlPolicyGuard(page, {
    pinnedOrigin: startOrigin,
    ...(policy.assetOrigins?.length && { assetOrigins: policy.assetOrigins }),
  });
  return true;
}

/** Every check a planned action passes before it runs (#354): one path for every caller. */
export async function checkPlannedAction(
  action: Action,
  policy: AgentPolicy,
  page: Page,
  startOrigin: string | null,
): Promise<PolicyVerdict> {
  const verdict = checkAction(action, policy, page.url(), startOrigin);
  return verdict.allowed ? checkResolvedTarget(action, policy, page) : verdict;
}
