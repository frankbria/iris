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
import { loadConfig, validateAiConfig } from './config';
import { createResolvedAIClient } from './ai-client';
import { configFromCredentials, type AICredentials } from './ai-client/credentials';
import type { SettledAICall } from './ai-client/factory';
import type { SecretSource } from './credential-refs';
import { isIrisRefusal, resolveCredentials, type CredentialsSource } from './translator';
import { checkPlannedAction, originOf, pinPage, refusedResult } from './agent-policy';
import type { AgentPolicy } from './agent-policy';
import { withPageTimeout } from './page-timeout';

/** Cap on the serialized page digest. Keeps the prompt affordable on big pages. */
export const MAX_DIGEST_CHARS = 4000;

/** How many recent failures are shown back to the model, so the prompt stays bounded. */
const MAX_REPORTED_FAILURES = 5;

/** Caps on the header fields, which are attacker/page controlled and unbounded. */
export const MAX_URL_CHARS = 300;
const MAX_TITLE_CHARS = 200;

/** The snapshot's own timeout: the page's default may be none at all (#293). */
const SNAPSHOT_TIMEOUT_MS = 5_000;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[+${value.length - max}]` : value;
}

/** Why the loop stopped. Reported so a caller never has to infer it. */
export type TerminationReason =
  'goal_met' | 'max_turns' | 'no_actions' | 'consecutive_failures' | 'error';

export interface AgentRunResult {
  /**
   * Whether the checks made after the agent's last action held. null when no
   * assertion ran after it: nothing asserted at all, or the agent acted again
   * after its last check, which then describes a page that is gone (#351).
   */
  goalMet: boolean | null;
  turns: number;
  results: ExecutionResult[];
  terminationReason: TerminationReason;
  /**
   * Why an `error` ending happened (#510): `provider` when the AI could not be built or
   * asked (an outage, a bad model or key), `other` for a refusal before any AI call (an
   * opaque start origin, no credentials for the org). Absent unless `error`.
   */
  errorKind?: 'provider' | 'other';
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
  /**
   * A request's scope (#428), as for `translate()`: the org its turns are charged to (the
   * ledger's budget and rows), its AI credentials (omitted: the process configuration
   * locally, no AI under IRIS_HOSTED), each settled call (usage rows), and the values a
   * fill's `{{secret:NAME}}` resolves from (omitted: the executor's default).
   */
  orgId?: string;
  credentials?: CredentialsSource;
  onUsage?: (call: SettledAICall) => void | Promise<void>;
  secrets?: SecretSource;
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
export async function observePage(
  page: Page,
  redact: (text: string) => string = (text) => text,
): Promise<string> {
  // The URL is capped too. A data: URL carries the whole encoded document and a
  // real one can carry a huge query string, either of which would blow the
  // digest budget through the header alone and defeat the body cap entirely.
  const header = `URL: ${truncate(redact(page.url()), MAX_URL_CHARS)}\nTITLE: ${truncate(
    redact(await safeTitle(page)),
    MAX_TITLE_CHARS,
  )}`;

  let body: string;
  try {
    // Redacted before the cap, or a value cut across it would leave its prefix (#352).
    body = redact(await page.locator('body').ariaSnapshot({ timeout: SNAPSHOT_TIMEOUT_MS }));
  } catch {
    // A page mid-navigation can refuse the snapshot, and a hung one times it out.
    // The URL/title header is still useful context, so degrade rather than fail
    // the turn.
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
    return await withPageTimeout(page.title(), '<unknown>');
  } catch {
    return '<unknown>';
  }
}

/**
 * Drive an instruction to completion, re-observing between turns.
 *
 * Every exit is bounded. An agent that cannot tell it is stuck will happily burn
 * an API budget forever, so the loop stops on any of: the goal being met, a
 * provider failure, two consecutive empty plans, three consecutive action
 * failures, or `maxTurns`.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const {
    instruction,
    executor,
    page,
    maxTurns = 8,
    log = () => {},
    policy = {},
    secrets,
  } = options;
  const pinned = await pinStart(options, policy, log);
  if ('terminationReason' in pinned) return pinned;
  const { startOrigin } = pinned;

  const client = await setupClient(options, log);
  if (!('translateInstruction' in client)) return client;

  const ctx: TurnContext = {
    instruction,
    executor,
    page,
    policy,
    startOrigin,
    secrets,
    log,
    client,
  };
  const state: LoopState = {
    results: [],
    executedActions: [],
    recentFailures: [],
    turns: 0,
    emptyPlans: 0,
    consecutiveFailures: 0,
    goalMet: null,
  };
  while (state.turns < maxTurns) {
    state.turns++;
    const ended = await playTurn(ctx, state);
    if (ended) return ended;
  }
  return endRun(state, 'max_turns');
}

type TextClient = Awaited<ReturnType<typeof createResolvedAIClient>>;

/** What every turn needs and nothing changes (#518: out of one long function). */
interface TurnContext {
  instruction: string;
  executor: ActionExecutor;
  page: Page;
  policy: AgentPolicy;
  startOrigin: string | null;
  secrets: SecretSource | undefined;
  log: (message: string) => void;
  client: TextClient;
}

/** What the run accumulates across turns. */
interface LoopState {
  results: ExecutionResult[];
  executedActions: Action[];
  /** Failure reasons shown back to the model, newest last. Bounded so a long run does not grow the prompt without limit. */
  recentFailures: string[];
  turns: number;
  emptyPlans: number;
  consecutiveFailures: number;
  goalMet: boolean | null;
}

/** This turn's checks made since its last executed action, and whether it acted (#351). */
interface TurnChecks {
  asserts: boolean[];
  acted: boolean;
}

const endRun = (
  state: LoopState,
  terminationReason: TerminationReason,
  errorKind?: 'provider' | 'other',
): AgentRunResult => ({
  goalMet: state.goalMet,
  turns: state.turns,
  results: state.results,
  terminationReason,
  ...(errorKind && { errorKind }),
});

/** An `error` ending before any turn ran (#510): `other` refusals, `provider` failures. */
const endBeforeTurns = (errorKind: 'provider' | 'other'): AgentRunResult => ({
  goalMet: null,
  turns: 0,
  results: [],
  terminationReason: 'error',
  errorKind,
});

/**
 * The origin the run is pinned to: what the caller ASKED for, falling back to where the page
 * is now. Read once, before any turn can move it; preferring the requested URL matters,
 * because the caller has usually navigated already and a cross-origin redirect would
 * otherwise pin the guard to the redirect's destination, which is exactly backwards.
 *
 * The per-action check refuses on the NEXT turn, by which point a same-origin click that
 * navigated away has already made the request. Confinement has to be enforced before the
 * request, so the loop installs it itself rather than trusting the caller to have done it:
 * the default is advertised as safe, and a library caller gets the same guarantee the CLI
 * does. Installing is idempotent: it merges into whatever policy the executor already set. No
 * origin (about:blank, data:) means nothing to confine to; running anyway would silently turn
 * the advertised default into "any origin" (#337).
 */
async function pinStart(
  options: AgentLoopOptions,
  policy: AgentPolicy,
  log: (message: string) => void,
): Promise<{ startOrigin: string | null } | AgentRunResult> {
  const startOrigin = originOf(options.startUrl ?? options.page.url());
  if (await pinPage(options.page, policy, startOrigin)) return { startOrigin };
  log(
    'refusing to start: the starting page has no origin to pin to — opt out of pinning to run anyway',
  );
  return endBeforeTurns('other');
}

/**
 * The metered text client for the run, or the result that ends it first: no credentials for
 * the org, or an AI that is not configured (#510 review: a configuration to fix, as one-shot
 * `translate()` reports it), are `other`; an unsupported provider or a setup that throws is a
 * reportable `provider` outcome, not a rejected promise.
 */
async function setupClient(
  options: AgentLoopOptions,
  log: (message: string) => void,
): Promise<TextClient | AgentRunResult> {
  try {
    const credentials = await resolveCredentials(options.credentials);
    if (credentials === null) {
      log('no AI credentials for this organization');
      return endBeforeTurns('other');
    }
    const config = clientConfig(credentials);
    const configErrors = validateAiConfig(config);
    if (configErrors.length > 0) {
      log(`AI translation is not configured (${configErrors.join(', ')})`);
      return endBeforeTurns('other');
    }
    return await createResolvedAIClient(config, {
      operation: 'agent_turn',
      orgId: options.orgId,
      onUsage: options.onUsage,
    });
  } catch (error) {
    log(`client setup failed — ${error instanceof Error ? error.message : error}`);
    return endBeforeTurns('provider');
  }
}

/** The org's injected credentials, else the process configuration (local mode). */
function clientConfig(credentials: AICredentials | undefined) {
  return credentials ? configFromCredentials(credentials, { kind: 'text' }) : loadConfig();
}

/** One observe → plan → act turn; the result when the run ends here, else null. */
async function playTurn(ctx: TurnContext, state: LoopState): Promise<AgentRunResult | null> {
  // The digest shows what fields hold: a value typed from a credential
  // reference must not reach the model (#352), nor what such a field holds now (#513).
  await ctx.executor.refreshFieldValues();
  const digest = await observePage(ctx.page, (text) => ctx.executor.redactSecrets(text));
  ctx.log(`turn ${state.turns}: observing (${digest.length} chars)`);

  const plan = await askTurn(ctx, state, digest);
  if ('terminationReason' in plan) return plan;
  if (plan.actions.length === 0) return noPlan(ctx, state);
  state.emptyPlans = 0;

  const stopped = await runTurnActions(ctx, state, plan.actions);
  if (stopped) return stopped;

  return goalConfirmed(ctx, state, plan.actions);
}

/**
 * Completion signal: the model spent this turn confirming rather than acting, and everything
 * it confirmed held. An assert alongside further actions means it is still working.
 */
function goalConfirmed(
  ctx: TurnContext,
  state: LoopState,
  actions: Action[],
): AgentRunResult | null {
  if (state.goalMet !== true || !actions.every((a) => a.type === 'assert')) return null;
  ctx.log(`turn ${state.turns}: goal confirmed`);
  return endRun(state, 'goal_met');
}

/** A turn with no actions: once can mean "thinking"; twice means it is stuck. */
function noPlan(ctx: TurnContext, state: LoopState): AgentRunResult | null {
  state.emptyPlans++;
  ctx.log(`turn ${state.turns}: model proposed no actions (${state.emptyPlans}/2)`);
  return state.emptyPlans >= 2 ? endRun(state, 'no_actions') : null;
}

/**
 * The model's plan for this turn, or the `error` ending: a provider failure (#293: asking
 * again is not "letting the model think", and no_actions blamed the model for an outage), or
 * IRIS's own refusal (`other`, #510).
 */
async function askTurn(
  ctx: TurnContext,
  state: LoopState,
  digest: string,
): Promise<{ actions: Action[] } | AgentRunResult> {
  let plan;
  try {
    plan = await ctx.client.translateInstruction({
      instruction: ctx.instruction,
      // The scaffolding that existed but was never filled in.
      context: {
        // Capped for the same reason the digest header is: every provider
        // interpolates this verbatim into the prompt, so an uncapped value
        // here reintroduces the whole encoded data: URL by another route.
        url: truncate(ctx.executor.redactSecrets(ctx.page.url()), MAX_URL_CHARS),
        currentPage: digest,
        // Snapshot, not the live array: passing the reference lets later turns
        // mutate a request the client may still be holding, so what a provider
        // serialises could differ from what the turn actually knew.
        previousActions: [...state.executedActions],
        // Without this the model sees what it tried but never how it went, so
        // a refused or failed action just gets proposed again next turn.
        recentFailures: state.recentFailures.slice(-MAX_REPORTED_FAILURES),
      },
    });
  } catch (error) {
    ctx.log(
      `turn ${state.turns}: translation failed — ${error instanceof Error ? error.message : error}`,
    );
    return endRun(state, 'error', isIrisRefusal(error) ? 'other' : 'provider');
  }
  if (plan.error) {
    ctx.log(`turn ${state.turns}: translation failed — ${plan.error}`);
    return endRun(state, 'error', 'provider');
  }
  return plan;
}

/**
 * Runs a turn's actions; the result when three consecutive failures stop the run. The verdict
 * is the LATEST checks, not every assertion ever run: a loop exists so a failed check can be
 * acted on and re-checked, and carrying the first failure forward would make recovery
 * impossible and could report goal_met alongside goalMet false.
 */
async function runTurnActions(
  ctx: TurnContext,
  state: LoopState,
  actions: Action[],
): Promise<AgentRunResult | null> {
  const checks: TurnChecks = { asserts: [], acted: false };
  for (const action of actions) {
    if (await runOneAction(ctx, state, checks, action)) {
      ctx.log(`turn ${state.turns}: three consecutive failures, stopping`);
      // Fold in this turn's verdict before bailing.
      settleVerdict(state, checks);
      return endRun(state, 'consecutive_failures');
    }
  }
  settleVerdict(state, checks);
  return null;
}

/**
 * A check describes the page as it was when it ran. Once the agent acts again it describes
 * nothing, so the verdict is only the checks made after the last executed action, and with
 * none it is unverified (#351).
 */
function settleVerdict(state: LoopState, checks: TurnChecks): void {
  if (checks.asserts.length > 0) {
    state.goalMet = checks.asserts.every(Boolean);
  } else if (checks.acted) {
    state.goalMet = null;
  }
}

/**
 * One planned action under the policy; true when it makes three consecutive failures. Policy
 * is checked per action, immediately before it runs, because an earlier action in the same
 * turn may have moved the page: the action, then what its selector hits (#353), as on every
 * path (#354).
 */
async function runOneAction(
  ctx: TurnContext,
  state: LoopState,
  checks: TurnChecks,
  action: Action,
): Promise<boolean> {
  const verdict = await checkPlannedAction(action, ctx.policy, ctx.page, ctx.startOrigin);
  const result = await actionResult(ctx, action, verdict);
  recordResult(ctx, state, action, result);
  noteCheck(checks, action, verdict.allowed, result.success);
  state.consecutiveFailures = result.success ? 0 : state.consecutiveFailures + 1;
  return state.consecutiveFailures >= 3;
}

/**
 * The action run, or its refusal as a failed result. A refusal is recorded rather than
 * skipped silently: it goes into `previousActions`, so the next turn's prompt shows the model
 * that the action was refused and why, and it counts toward the consecutive-failure cutoff so
 * an agent that keeps retrying a forbidden action stops instead of burning the turn budget.
 */
async function actionResult(
  ctx: TurnContext,
  action: Action,
  verdict: Awaited<ReturnType<typeof checkPlannedAction>>,
): Promise<ExecutionResult> {
  if (verdict.allowed) {
    return ctx.executor.executeAction(action, ctx.page, ctx.secrets, verdict.target);
  }
  return refusedResult(action, verdict);
}

/**
 * An assert's outcome joins the turn's checks; an executed action clears them. Failed too: a
 * click that threw may still have been dispatched. A refused action never ran, so the page
 * the checks saw is unchanged.
 */
function noteCheck(checks: TurnChecks, action: Action, ran: boolean, success: boolean): void {
  if (action.type === 'assert') {
    checks.asserts.push(success);
  } else if (ran) {
    checks.asserts.length = 0;
    checks.acted = true;
  }
}

function recordResult(
  ctx: TurnContext,
  state: LoopState,
  action: Action,
  result: ExecutionResult,
): void {
  state.results.push(result);
  state.executedActions.push(action);
  if (!result.success) {
    state.recentFailures.push(`${action.type} ${JSON.stringify(action)}: ${result.error}`);
  }
  ctx.log(
    `turn ${state.turns}: ${action.type} → ${result.success ? 'ok' : `failed (${result.error})`}`,
  );
}
