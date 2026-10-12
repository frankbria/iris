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

import type { Locator, Page } from 'playwright';
import type { Action } from './actions';
import { isWithinPinnedOrigin } from './url-policy';

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
  return DESTRUCTIVE_PATTERN.exec(separateWords(decodeCssEscapes(text)))?.[1] ?? null;
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
}

/** A refusal carries the reason so it can be logged and shown to the model. */
export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
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
    case 'click':
      return action.selector;
    case 'fill':
      return `${action.selector} ${action.text}`;
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
  const allow = policy.allow ?? ALL_ACTION_TYPES;
  if (!allow.includes(action.type)) {
    return {
      allowed: false,
      reason: `action type "${action.type}" is not permitted this run (allowed: ${allow.join(', ')})`,
    };
  }

  if (policy.pinOrigin !== false && !startOrigin) {
    return {
      allowed: false,
      reason:
        'no starting origin to pin to (about:blank, data:) — pass --allow-cross-origin to run unpinned',
    };
  }

  if (policy.pinOrigin !== false && startOrigin) {
    // Drift first: if the page already moved, nothing proposed against it should
    // run, whatever the action is.
    // An opaque current URL (about:blank, data:, blob:) is NOT same-origin with
    // anything. Treating "no origin" as "no problem" would let a page that
    // navigated itself somewhere opaque keep taking actions.
    // Same predicate the request-layer guard uses, so the two layers cannot
    // disagree — they did once, and an http→https upgrade would load fine and
    // then have every action on it refused.
    if (!isWithinPinnedOrigin(currentUrl, startOrigin)) {
      return {
        allowed: false,
        reason: `page is on ${originOf(currentUrl) ?? 'an opaque origin'}, not the starting origin ${startOrigin} — refusing to act off-origin`,
      };
    }
    if (action.type === 'navigate') {
      // A relative URL has no origin to compare and stays put, so only an
      // absolute one that resolves elsewhere is refused.
      const target = originOf(action.url);
      if (target && !isWithinPinnedOrigin(action.url, startOrigin)) {
        return {
          allowed: false,
          reason: `navigation to ${target} leaves the starting origin ${startOrigin}`,
        };
      }
    }
  }

  if (!policy.allowDestructive && action.type !== 'assert') {
    // Asserts are read-only by construction, so they are exempt — checking them
    // would refuse to *verify* that a delete button exists, which is a
    // legitimate and harmless thing to ask.
    const term = destructiveTerm(targetText(action));
    if (term) {
      return {
        allowed: false,
        reason: `target looks destructive ("${term}") — pass --allow-destructive to permit it`,
      };
    }
  }

  return ALLOWED;
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
  const words = await elementWords(page.locator(selector).first());
  if (words === null) {
    return { allowed: false, reason: `target ${selector} was not found on the page` };
  }
  const term = destructiveTerm(words);
  return term
    ? {
        allowed: false,
        reason: `target resolves to an element that looks destructive ("${term}") — pass --allow-destructive to permit it`,
      }
    : ALLOWED;
}

const unread = () => null;

/**
 * What a user reads on `target`: its naming attributes and text content, or null when it
 * is not on the page within the page's action timeout. Playwright's own reads, not a page
 * function: under `jest --coverage` a function sent to the page carries instrumentation
 * the page does not have.
 */
async function elementWords(target: Locator): Promise<string | null> {
  try {
    await target.waitFor({ state: 'attached' });
  } catch {
    return null;
  }
  const timeout = { timeout: READ_TIMEOUT_MS };
  const attributes = NAMING_ATTRIBUTES.map((name) =>
    target.getAttribute(name, timeout).catch(unread),
  );
  const text = await target.textContent(timeout).catch(unread);
  return [...(await Promise.all(attributes)), text?.slice(0, 500)].filter(Boolean).join(' ');
}
