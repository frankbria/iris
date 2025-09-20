import { loadConfig, validateConfig } from './config';
import { createAIClient, AITranslationRequest } from './ai-client';

export type Action =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'navigate'; url: string };

export interface TranslationResult {
  actions: Action[];
  method: 'pattern' | 'ai';
  confidence: number;
  reasoning?: string;
}

/**
 * Translate a natural language instruction into Playwright actions.
 * First tries pattern matching, then falls back to AI if configured.
 */
export async function translate(instruction: string, context?: { url?: string }): Promise<TranslationResult> {
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
  return translateWithPatterns(instruction).actions;
}

function translateWithPatterns(instruction: string): TranslationResult {
  const trimmed = instruction.trim();

  // Enhanced click patterns
  const clickPatterns = [
    /^click (.+)$/i,
    /^click on (.+)$/i,
    /^press (.+)$/i,
    /^tap (.+)$/i,
  ];

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
  const fillPatterns = [
    /^fill (.+) with (.+)$/i,
  ];

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

  // Enhanced navigation patterns
  const navPatterns = [
    /^navigate to (.+)$/i,
    /^go to (.+)$/i,
    /^visit (.+)$/i,
    /^open (.+)$/i,
  ];

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

async function translateWithAI(instruction: string, context?: { url?: string }): Promise<TranslationResult> {
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
