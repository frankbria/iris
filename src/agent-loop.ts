/**
 * Bounded observe → act loop.
 *
 * Translation is otherwise one-shot and blind: the model plans against a page it
 * has never seen. `AITranslationRequest.context.currentPage` / `previousActions`
 * existed and were rendered into every prompt, but no caller ever populated
 * them — this module is what finally does.
 *
 * Library only. CLI wiring lives in a follow-up (#122).
 */

import type { Page } from 'playwright';
import type { Action } from './actions';
import type { ActionExecutor, ExecutionResult } from './executor';
import { loadConfig } from './config';
import { createAIClient } from './ai-client';
import { checkAction, originOf } from './agent-policy';
import type { AgentPolicy } from './agent-policy';
import { installUrlPolicyGuard } from './url-policy-guard';

/** Cap on the serialized page digest. Keeps the prompt affordable on big pages. */
export const MAX_DIGEST_CHARS = 4000;

/** How many recent failures are shown back to the model, so the prompt stays bounded. */
const MAX_REPORTED_FAILURES = 5;

/** Caps on the header fields, which are attacker/page controlled and unbounded. */
export const MAX_URL_CHARS = 300;
const MAX_TITLE_CHARS = 200;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[+${value.length - max}]` : value;
}

/** Why the loop stopped. Reported so a caller never has to infer it. */
export type TerminationReason =
  'goal_met' | 'max_turns' | 'no_actions' | 'consecutive_failures' | 'error';

export interface AgentRunResult {
  /** true/false once assertions ran; null when the model never asserted anything. */
  goalMet: boolean | null;
  turns: number;
  results: ExecutionResult[];
  terminationReason: TerminationReason;
}

export interface AgentLoopOptions {
  instruction: string;
  executor: ActionExecutor;
  page: Page;
  /** Upper bound on observe→act cycles. */
  maxTurns?: number;
  /**
   * The URL the run was pointed at, used to pin the origin.
   *
   * Supply it whenever the caller navigated before handing over the page. The
   * fallback — reading the page's current URL — is what the page ended up on,
   * which after a cross-origin redirect is the wrong thing to trust: the guard
   * would pin to wherever the redirect landed and then happily act there.
   */
  startUrl?: string;
  /** Progress sink. Defaults to silence so the library never writes to stdout. */
  log?: (message: string) => void;
  /**
   * Bounds on what the agent may do. Defaults are the safe ones: every action
   * type allowed, but confined to the starting origin and refusing targets that
   * read as destructive. See `./agent-policy` for why.
   */
  policy?: AgentPolicy;
}

/**
 * Serialize the page into a compact digest the model can plan against.
 *
 * Uses the ARIA snapshot rather than raw HTML because it is already semantic —
 * roles and names are what an instruction like "click the sign in button"
 * actually refers to — and it is dramatically smaller than the DOM.
 *
 * Note: `page.accessibility.snapshot()` (what plan 014 specified) no longer
 * exists in Playwright 1.62; `locator.ariaSnapshot()` is its replacement and
 * emits the same role/name information in a flatter YAML-ish form.
 */
export async function observePage(page: Page): Promise<string> {
  // The URL is capped too. A data: URL carries the whole encoded document and a
  // real one can carry a huge query string, either of which would blow the
  // digest budget through the header alone and defeat the body cap entirely.
  const header = `URL: ${truncate(page.url(), MAX_URL_CHARS)}\nTITLE: ${truncate(
    await safeTitle(page),
    MAX_TITLE_CHARS,
  )}`;

  let body: string;
  try {
    body = await page.locator('body').ariaSnapshot();
  } catch {
    // A page mid-navigation can refuse the snapshot. The URL/title header is
    // still useful context, so degrade rather than fail the turn.
    return `${header}\nPAGE: <accessibility snapshot unavailable>`;
  }

  if (!body.trim()) {
    return `${header}\nPAGE: <empty>`;
  }

  const capped =
    body.length > MAX_DIGEST_CHARS
      ? `${body.slice(0, MAX_DIGEST_CHARS)}\n… [truncated ${body.length - MAX_DIGEST_CHARS} chars]`
      : body;

  return `${header}\nPAGE:\n${capped}`;
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '<unknown>';
  }
}

/**
 * Drive an instruction to completion, re-observing between turns.
 *
 * Every exit is bounded. An agent that cannot tell it is stuck will happily burn
 * an API budget forever, so the loop stops on any of: the goal being met, two
 * consecutive empty plans, three consecutive action failures, or `maxTurns`.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const {
    instruction,
    executor,
    page,
    maxTurns = 8,
    log = () => {},
    policy = {},
    startUrl,
  } = options;

  // The origin the run is pinned to: what the caller ASKED for, falling back to
  // where the page is now. Read once, before any turn can move it — and
  // preferring the requested URL matters, because the caller has usually
  // navigated already and a cross-origin redirect would otherwise pin the guard
  // to the redirect's destination, which is exactly backwards.
  const startOrigin = originOf(startUrl ?? page.url());

  // The per-action check refuses on the NEXT turn, by which point a same-origin
  // click that navigated away has already made the request. Confinement has to
  // be enforced before the request, so the loop installs it itself rather than
  // trusting the caller to have done it — the default is advertised as safe, and
  // a library caller gets the same guarantee the CLI does. Installing is
  // idempotent: it merges into whatever policy the executor already set.
  if (policy.pinOrigin !== false && startOrigin) {
    await installUrlPolicyGuard(page, { pinnedOrigin: startOrigin });
  }

  const results: ExecutionResult[] = [];
  const executedActions: Action[] = [];
  /** Failure reasons shown back to the model, newest last. Bounded so a long run does not grow the prompt without limit. */
  const recentFailures: string[] = [];
  let turns = 0;
  let emptyPlans = 0;
  let consecutiveFailures = 0;
  let goalMet: boolean | null = null;

  let client;
  try {
    client = createAIClient(loadConfig());
  } catch (error) {
    // An unsupported provider or unreadable config is a reportable outcome, not
    // a rejected promise — every other failure mode here returns a result.
    log(`client setup failed — ${error instanceof Error ? error.message : error}`);
    return { goalMet: null, turns: 0, results: [], terminationReason: 'error' };
  }

  while (turns < maxTurns) {
    turns++;

    const digest = await observePage(page);
    log(`turn ${turns}: observing (${digest.length} chars)`);

    let plan;
    try {
      plan = await client.translateInstruction({
        instruction,
        // The scaffolding that existed but was never filled in.
        context: {
          // Capped for the same reason the digest header is: every provider
          // interpolates this verbatim into the prompt, so an uncapped value
          // here reintroduces the whole encoded data: URL by another route.
          url: truncate(page.url(), MAX_URL_CHARS),
          currentPage: digest,
          // Snapshot, not the live array: passing the reference lets later turns
          // mutate a request the client may still be holding, so what a provider
          // serialises could differ from what the turn actually knew.
          previousActions: [...executedActions],
          // Without this the model sees what it tried but never how it went, so
          // a refused or failed action just gets proposed again next turn.
          recentFailures: recentFailures.slice(-MAX_REPORTED_FAILURES),
        },
      });
    } catch (error) {
      log(`turn ${turns}: translation failed — ${error instanceof Error ? error.message : error}`);
      return { goalMet, turns, results, terminationReason: 'error' };
    }

    if (plan.actions.length === 0) {
      emptyPlans++;
      log(`turn ${turns}: model proposed no actions (${emptyPlans}/2)`);
      // Once can mean "thinking"; twice means it is stuck and re-asking will not help.
      if (emptyPlans >= 2) {
        return { goalMet, turns, results, terminationReason: 'no_actions' };
      }
      continue;
    }
    emptyPlans = 0;

    const turnAsserts: boolean[] = [];

    for (const action of plan.actions) {
      // Policy is checked per action, immediately before it runs, because an
      // earlier action in the same turn may have moved the page.
      const verdict = checkAction(action, policy, page.url(), startOrigin);

      // A refusal is recorded as a failed result rather than skipped silently:
      // it goes into `previousActions`, so the next turn's prompt shows the
      // model that the action was refused and why, and it counts toward the
      // consecutive-failure cutoff so an agent that keeps retrying a forbidden
      // action stops instead of burning the turn budget.
      const result: ExecutionResult = verdict.allowed
        ? await executor.executeAction(action, page)
        : {
            success: false,
            action,
            error: `Refused by agent policy: ${verdict.reason}`,
            duration: 0,
          };

      results.push(result);
      executedActions.push(action);
      if (!result.success) {
        recentFailures.push(`${action.type} ${JSON.stringify(action)}: ${result.error}`);
      }
      log(`turn ${turns}: ${action.type} → ${result.success ? 'ok' : `failed (${result.error})`}`);

      if (action.type === 'assert') {
        turnAsserts.push(result.success);
      }

      if (result.success) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          log(`turn ${turns}: three consecutive failures, stopping`);
          // Fold in this turn's verdict before bailing. This return jumps out
          // from inside the action loop, so without it an assertion that ran
          // earlier in the same turn would go unreported and goalMet could stay
          // null — which the field's contract reserves for "never asserted".
          if (turnAsserts.length > 0) {
            goalMet = turnAsserts.every(Boolean);
          }
          return { goalMet, turns, results, terminationReason: 'consecutive_failures' };
        }
      }
    }

    // The verdict is the LATEST turn's assertions, not every assertion ever run.
    // A loop exists precisely so a failed check can be acted on and re-checked;
    // carrying the first failure forward forever would make recovery impossible
    // and could report terminationReason 'goal_met' alongside goalMet false.
    if (turnAsserts.length > 0) {
      goalMet = turnAsserts.every(Boolean);
    }

    // Completion signal: the model spent this turn confirming rather than
    // acting, and everything it confirmed held. An assert alongside further
    // actions means it is still working.
    const onlyAsserted = plan.actions.every((a) => a.type === 'assert');
    if (goalMet === true && onlyAsserted) {
      log(`turn ${turns}: goal confirmed`);
      return { goalMet, turns, results, terminationReason: 'goal_met' };
    }
  }

  return { goalMet, turns, results, terminationReason: 'max_turns' };
}
