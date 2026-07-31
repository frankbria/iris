import { loadConfig, validateConfig } from './config';
import { createAIClient, AITranslationRequest } from './ai-client';

// The action vocabulary lives in its own leaf module so the AI client can share
// the schema without creating an import cycle (translator -> ai-client -> here).
// Re-exported so existing `from './translator'` imports keep working.
import type { Action, AssertKind } from './actions';
export type { Action, AssertKind } from './actions';
export { ActionSchema, parseActions, describeAction } from './actions';

export interface TranslationResult {
  actions: Action[];
  method: 'pattern' | 'ai';
  confidence: number;
  reasoning?: string;
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
): Promise<TranslationResult> {
  assertInstructionLength(instruction);

  // Try pattern matching first
  const patternResult = translateWithPatterns(instruction);
  if (patternResult.actions.length > 0) {
    return patternResult;
  }

  // Fall back to AI translation
  return await translateWithAI(instruction, context);
}

/**
 * Legacy synchronous translation for backward compatibility.
 * Only uses pattern matching.
 */
export function translateSync(instruction: string): Action[] {
  assertInstructionLength(instruction);
  return translateWithPatterns(instruction).actions;
}

function translateWithPatterns(instruction: string): TranslationResult {
  const trimmed = instruction.trim();

  // Enhanced click patterns
  const clickPatterns = [/^click (.+)$/i, /^click on (.+)$/i, /^press (.+)$/i, /^tap (.+)$/i];

  for (const pattern of clickPatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
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
    if (match) {
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
    if (match) {
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
    if (match) {
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
    if (match) {
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

async function translateWithAI(
  instruction: string,
  context?: { url?: string },
): Promise<TranslationResult> {
  try {
    const config = loadConfig();
    const configErrors = validateConfig(config);

    if (configErrors.length > 0) {
      return {
        actions: [],
        method: 'ai',
        confidence: 0,
        reasoning: `AI translation failed: ${configErrors.join(', ')}`,
      };
    }

    const aiClient = createAIClient(config);
    const isAvailable = await aiClient.isAvailable();

    if (!isAvailable) {
      return {
        actions: [],
        method: 'ai',
        confidence: 0,
        reasoning: 'AI client not available',
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
    };
  } catch (error) {
    return {
      actions: [],
      method: 'ai',
      confidence: 0,
      reasoning: `AI translation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
