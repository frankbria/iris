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

/** Cap on the serialized page digest. Keeps the prompt affordable on big pages. */
export const MAX_DIGEST_CHARS = 4000;

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
  /** Progress sink. Defaults to silence so the library never writes to stdout. */
  log?: (message: string) => void;
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
  const { instruction, executor, page, maxTurns = 8, log = () => {} } = options;

  const results: ExecutionResult[] = [];
  const executedActions: Action[] = [];
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
          url: page.url(),
          currentPage: digest,
          // Snapshot, not the live array: passing the reference lets later turns
          // mutate a request the client may still be holding, so what a provider
          // serialises could differ from what the turn actually knew.
          previousActions: [...executedActions],
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
      const result = await executor.executeAction(action, page);
      results.push(result);
      executedActions.push(action);
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
