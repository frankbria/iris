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
 * @param startOrigin the origin the run was pointed at, or null if unknown (in
 *   which case origin pinning cannot be enforced and is skipped).
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
    const match = DESTRUCTIVE_PATTERN.exec(separateWords(targetText(action)));
    if (match) {
      return {
        allowed: false,
        reason: `target looks destructive ("${match[1]}") — pass --allow-destructive to permit it`,
      };
    }
  }

  return ALLOWED;
}
