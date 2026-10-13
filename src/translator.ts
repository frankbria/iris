import { loadConfig, validateAiConfig } from './config';
import { configFromCredentials, type AICredentials } from './ai-client/credentials';
import type { SettledAICall } from './ai-client/factory';
import { isHostedMode } from './hosted';

/**
 * A request's AI credentials (#258): injected, `null` for none, or a function asked
 * only when the instruction needs the model.
 */
export type CredentialsSource = AICredentials | null | (() => Promise<AICredentials | null>);
import { createResolvedAIClient, AITranslationRequest } from './ai-client';
import { BudgetExceededError } from './ai-client/cost-tracker';

// The action vocabulary lives in its own leaf module so the AI client can share
// the schema without creating an import cycle (translator -> ai-client -> here).
// Re-exported so existing `from './translator'` imports keep working.
import type { Action, AssertKind } from './actions';
import { hostedLog } from './log';
export type { Action, AssertKind } from './actions';
export { ActionSchema, parseActions, describeAction } from './actions';

export interface TranslationResult {
  actions: Action[];
  method: 'pattern' | 'ai';
  confidence: number;
  reasoning?: string;
  /**
   * Set when the AI provider was asked and failed (unavailable, request failed, reply
   * unreadable): an outage, not a plan with no actions (#293, #294). No AI configured,
   * or no match, leaves it unset.
   */
  error?: string;
}

/** Defense-in-depth cap on instruction size before any pattern/AI processing. */
export const MAX_INSTRUCTION_LENGTH = 10000;

function assertInstructionLength(instruction: string): void {
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new Error(
      `Instruction too long: ${instruction.length} characters (max ${MAX_INSTRUCTION_LENGTH}).`,
    );
  }
}

/**
 * Translate a natural language instruction into Playwright actions.
 * First tries pattern matching, then falls back to AI if configured.
 */
export async function translate(
  instruction: string,
  context?: { url?: string },
  /**
   * Hosted: the org an AI translation is charged to (#255), and the credentials it
   * runs with (#258). Injected credentials replace the process configuration
   * entirely; `null` means this tenant has no AI, and never falls back to the
   * process-wide keys. Omitted (local mode): the process configuration.
   */
  scope: {
    orgId?: string;
    credentials?: CredentialsSource;
    /** Hosted: told about each billed AI call, for the usage ledger (#263). */
    onUsage?: (call: SettledAICall) => void | Promise<void>;
  } = {},
): Promise<TranslationResult> {
  assertInstructionLength(instruction);

  // Try pattern matching first
  const patternResult = translateWithPatterns(instruction);
  if (patternResult.actions.length > 0) {
    return patternResult;
  }

  // Fall back to AI translation
  return await translateWithAI(instruction, context, scope);
}

/**
 * Legacy synchronous translation for backward compatibility.
 * Only uses pattern matching.
 */
export function translateSync(instruction: string): Action[] {
  assertInstructionLength(instruction);
  return translateWithPatterns(instruction).actions;
}

/** A whole target that is a selector as written: `text=Sign in`, `role=button`, `//button`. */
const ENGINE_OR_XPATH = /^(?:[a-z][\w-]*=\S|\(?\/\/)/i;

/**
 * One whitespace-separated CSS token with selector syntax: a combinator, spaced or not
 * (`div>a`, `div >a`; `>>` chains to an
 * engine selector such as `text=Logout`), `#id`, `.class`, `[attr]`, `:pseudo` or `*`.
 */
const SELECTOR_TOKEN =
  /^(?:>>?|\+|~)$|[\w\])"'][>+~]|^[>+~]\S|[#.][a-z_-]|\[|:[a-z-]|\*|^[a-z][\w-]*=\S/i;

/**
 * Whether a pattern's target may go to Playwright as a selector (#297). Prose does not:
 * `click submit` became `page.click("submit")`, a CSS type selector no page has. Accepted:
 * an engine selector or XPath, or CSS with at least one token of selector syntax and only
 * bare identifiers beside it. So `form > button` is a selector, and `the login button` or a
 * bare `submit` (even a tag name) is prose for the AI.
 */
function looksLikeSelector(target: string): boolean {
  if (ENGINE_OR_XPATH.test(target)) return true;
  // Quoted strings and bracket/paren contents may hold anything, spaces included.
  const tokens = target
    .replace(/"[^"]*"|'[^']*'|\[[^\]]*\]|\([^)]*\)/g, (m) => m[0] + m.at(-1))
    // A selector list (`#save, button`) splits at its commas too.
    .split(/[\s,]+/)
    .filter(Boolean);
  return (
    tokens.some((t) => SELECTOR_TOKEN.test(t)) &&
    tokens.every((t) => SELECTOR_TOKEN.test(t) || /^[a-z][\w-]*$/i.test(t))
  );
}

/** A navigate target must be an absolute URL, as the executor requires; else it is prose. */
function looksLikeUrl(target: string): boolean {
  return !/\s/.test(target) && URL.canParse(target);
}

function translateWithPatterns(instruction: string): TranslationResult {
  const trimmed = instruction.trim();

  // Enhanced click patterns
  const clickPatterns = [/^click (.+)$/i, /^click on (.+)$/i, /^press (.+)$/i, /^tap (.+)$/i];

  for (const pattern of clickPatterns) {
    const match = pattern.exec(trimmed);
    if (match && looksLikeSelector(match[1])) {
      return {
        actions: [{ type: 'click', selector: match[1] }],
        method: 'pattern',
        confidence: 0.9,
        reasoning: `Matched click pattern: ${pattern.source}`,
      };
    }
  }

  // Enhanced fill patterns
  const fillPatterns = [/^fill (.+) with (.+)$/i];

  for (const pattern of fillPatterns) {
    const match = pattern.exec(trimmed);
    if (match && looksLikeSelector(match[1])) {
      return {
        actions: [{ type: 'fill', selector: match[1], text: match[2] }],
        method: 'pattern',
        confidence: 0.9,
        reasoning: `Matched fill pattern: ${pattern.source}`,
      };
    }
  }

  // Additional fill patterns with different order
  const fillPatterns2 = [
    /^enter (.+) into (.+)$/i,
    /^type (.+) in (.+)$/i,
    /^input (.+) to (.+)$/i,
  ];

  for (const pattern of fillPatterns2) {
    const match = pattern.exec(trimmed);
    if (match && looksLikeSelector(match[2])) {
      return {
        actions: [{ type: 'fill', selector: match[2], text: match[1] }],
        method: 'pattern',
        confidence: 0.9,
        reasoning: `Matched fill pattern: ${pattern.source}`,
      };
    }
  }

  // Assertion patterns. Only the unambiguous explicit forms are handled here —
  // anything richer ("make sure users can complete checkout") needs the AI path,
  // and a greedy pattern would silently mistranslate it into a single check.
  // Ordered before navigation so "verify ... is visible" isn't eaten by a
  // broader verb pattern.
  const assertPatterns: Array<{ pattern: RegExp; kind: AssertKind }> = [
    { pattern: /^(?:verify|make sure|check|confirm) (.+) is visible$/i, kind: 'text_visible' },
    {
      pattern: /^(?:verify|make sure|check|confirm) (.+) is not visible$/i,
      kind: 'element_absent',
    },
    { pattern: /^(?:verify|make sure|check|confirm) (.+) is hidden$/i, kind: 'element_absent' },
    {
      pattern: /^(?:verify|make sure|check|confirm) (?:the )?url contains (.+)$/i,
      kind: 'url_matches',
    },
  ];

  for (const { pattern, kind } of assertPatterns) {
    const match = pattern.exec(trimmed);
    // An element_absent target is a selector (page.locator); the others are text or a URL part.
    if (match && (kind !== 'element_absent' || looksLikeSelector(match[1]))) {
      return {
        actions: [{ type: 'assert', kind, target: match[1], description: trimmed }],
        method: 'pattern',
        confidence: 0.9,
        reasoning: `Matched assertion pattern: ${pattern.source}`,
      };
    }
  }

  // Enhanced navigation patterns
  const navPatterns = [/^navigate to (.+)$/i, /^go to (.+)$/i, /^visit (.+)$/i, /^open (.+)$/i];

  for (const pattern of navPatterns) {
    const match = pattern.exec(trimmed);
    if (match && looksLikeUrl(match[1])) {
      return {
        actions: [{ type: 'navigate', url: match[1] }],
        method: 'pattern',
        confidence: 0.9,
        reasoning: `Matched navigation pattern: ${pattern.source}`,
      };
    }
  }

  return {
    actions: [],
    method: 'pattern',
    confidence: 0,
    reasoning: 'No patterns matched',
  };
}

/**
 * Ask a lazy credentials source. Anything but credentials is no AI: a lookup that
 * resolves nothing, or fails, must never open the process configuration (#258).
 */
async function askCredentials(
  source: () => Promise<AICredentials | null>,
): Promise<AICredentials | null> {
  try {
    return (await source()) ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    hostedLog(
      'error',
      'AI credentials lookup failed; translating without AI',
      { err: message },
      () => console.error('[iris] AI credentials lookup failed; translating without AI:', message),
    );
    return null;
  }
}

/**
 * The credentials a request's AI calls run with: `undefined` is the process configuration
 * (local mode), `null` is no AI. In hosted mode an omitted source is no AI too, never the
 * operator's keys: a caller that forgets them must not spend the process-wide ones (ADR
 * 0001 §5). A lazy source is asked here, so call this only once the model is needed.
 */
export async function resolveCredentials(
  source: CredentialsSource | undefined,
): Promise<AICredentials | null | undefined> {
  if (typeof source === 'function') return askCredentials(source);
  return source === undefined && isHostedMode() ? null : source;
}

async function translateWithAI(
  instruction: string,
  context: { url?: string } | undefined,
  scope: {
    orgId?: string;
    credentials?: CredentialsSource;
    onUsage?: (call: SettledAICall) => void | Promise<void>;
  },
): Promise<TranslationResult> {
  // Asked for only now, after patterns failed: a lookup can cost a database read.
  const credentials = await resolveCredentials(scope.credentials);
  if (credentials === null) {
    return {
      actions: [],
      method: 'ai',
      confidence: 0,
      reasoning: 'AI translation unavailable: no AI credentials for this organization',
    };
  }
  try {
    const config = credentials
      ? configFromCredentials(credentials, { kind: 'text' })
      : loadConfig();
    const configErrors = validateAiConfig(config);

    if (configErrors.length > 0) {
      return {
        actions: [],
        method: 'ai',
        confidence: 0,
        reasoning:
          `No pattern matched, and AI translation is not configured (${configErrors.join(', ')}). ` +
          'Without AI, name the element or page: click #submit, fill #email with x, ' +
          'navigate to https://example.com',
      };
    }

    // Resolved, not just constructed: a retired pin or a typo'd model is
    // caught here and reported by name instead of returning an opaque 404 (#184).
    const aiClient = await createResolvedAIClient(config, {
      orgId: scope.orgId,
      onUsage: scope.onUsage,
    });
    const isAvailable = await aiClient.isAvailable();

    if (!isAvailable) {
      return {
        actions: [],
        method: 'ai',
        confidence: 0,
        reasoning: 'AI client not available',
        error: 'AI client not available',
      };
    }

    const request: AITranslationRequest = {
      instruction,
      context: context ? { url: context.url } : undefined,
    };

    const response = await aiClient.translateInstruction(request);

    return {
      actions: response.actions,
      method: 'ai',
      confidence: response.confidence,
      reasoning: response.reasoning,
      error: response.error,
    };
  } catch (error) {
    const message = `AI translation error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    // The budget breaker refused before the provider was asked (#510 review): a plain
    // failure, not `error`, which callers read as "the provider failed" (retryable).
    if (error instanceof BudgetExceededError)
      return { actions: [], method: 'ai', confidence: 0, reasoning: message };
    return { actions: [], method: 'ai', confidence: 0, reasoning: message, error: message };
  }
}
