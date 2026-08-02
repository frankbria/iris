import { IrisConfig } from '../config';
import { Action } from '../translator';

/**
 * Format an unknown error for logging without dumping the full object.
 *
 * SDK errors (e.g. APIError) can carry response headers, request ids, and other
 * sensitive context. Log only the message plus status/code when present.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    const extra = [
      status !== undefined ? `status=${String(status)}` : '',
      code !== undefined ? `code=${String(code)}` : '',
    ].filter(Boolean);
    return extra.length ? `${error.message} (${extra.join(', ')})` : error.message;
  }
  return String(error);
}

/**
 * Strip anything that could forge the untrusted-page-data fence.
 *
 * The fence is what tells the model where scraped page content starts and stops.
 * A page that simply prints the closing marker in its own copy would appear to
 * end the untrusted region early, and everything after it would read as
 * instructions from us — the standard way these boundaries get walked out of.
 * Applied to every field interpolated inside the fence, not just the digest.
 */
export function redactFenceMarkers(value: string): string {
  // The phrase is what persuades a model, so redact it however it is decorated:
  // requiring the dashes let a bare "END UNTRUSTED PAGE DATA" — or an em-dashed
  // one — through, which is a gap between what this claims to do and what it did.
  // Over-redacting a page that genuinely contains this wording is the safe
  // direction, and it costs that page nothing but four characters of digest.
  return value.replace(/[-–—]*\s*(?:BEGIN|END)\s+UNTRUSTED\s+PAGE\s+DATA\s*[-–—]*/gi, '[redacted]');
}

/**
 * Parse a model's JSON reply, tolerating the wrappers models add anyway.
 *
 * Every prompt here asks for bare JSON and models routinely ignore it —
 * markdown-fencing the object, or prefacing it with a line of commentary. A
 * bare `JSON.parse` turns that into a hard failure, which in the agent loop
 * means an empty plan every turn and a run that terminates having done nothing.
 * Observed with Ollama + gemma3, which fences on essentially every call.
 *
 * Candidates are tried strictest-first, so a clean response is never reshaped
 * by the salvage paths.
 *
 * @throws if no candidate parses into an object.
 */
export function parseModelJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const candidates = [trimmed];

  // ```json … ``` or a bare ``` … ``` fence.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());

  // Last resort: the widest brace-delimited span, which survives leading prose
  // ("Here is the JSON you asked for:") and a trailing sign-off.
  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(trimmed.slice(open, close + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      // Arrays and primitives are valid JSON but never a valid response here,
      // so keep looking rather than handing the caller something unusable.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Model did not return a JSON object (got ${trimmed.slice(0, 80)}…)`);
}

/**
 * Request for translating natural language instructions to browser actions
 */
export interface AITranslationRequest {
  instruction: string;
  context?: {
    url?: string;
    currentPage?: string;
    previousActions?: Action[];
  };
}

/**
 * Response from AI translation containing actions and metadata
 */
export interface AITranslationResponse {
  actions: Action[];
  confidence: number;
  reasoning?: string;
}

/**
 * Request for AI vision analysis of visual changes
 */
export interface AIVisionRequest {
  baseline: Buffer;
  current: Buffer;
  context?: {
    url?: string;
    selector?: string;
    previousClassifications?: VisionClassification[];
  };
}

/**
 * Classification result from AI vision analysis
 */
export interface VisionClassification {
  severity: 'none' | 'minor' | 'moderate' | 'breaking';
  confidence: number;
  reasoning: string;
  categories: Array<'layout' | 'text' | 'color' | 'spacing' | 'content'>;
}

/**
 * Normalized token usage reported by a provider, when available.
 *
 * Providers that don't return usage (e.g. Ollama, or SDK error paths) leave
 * this undefined, and the cost tracker falls back to flat per-image pricing.
 */
export interface AITokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

/**
 * Response from AI vision analysis
 */
export interface AIVisionResponse extends VisionClassification {
  suggestions?: string[];

  /**
   * Token usage for this call, when the provider reports it. Used by the cost
   * tracker to compute real per-token cost instead of a flat per-image estimate.
   */
  usage?: AITokenUsage;
}

/**
 * Base interface for all AI clients (text and vision)
 */
export interface AIClient {
  /**
   * Translate natural language instruction to browser actions
   */
  translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse>;

  /**
   * Check if the client is available and configured
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Extended interface for AI clients that support vision capabilities
 */
export interface AIVisionClient extends AIClient {
  /**
   * Analyze visual differences between two images
   */
  analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse>;

  /**
   * Check if vision capabilities are available
   */
  supportsVision(): boolean;
}

/**
 * Abstract base class for AI clients providing common functionality
 */
export abstract class BaseAIClient implements AIClient {
  protected config: IrisConfig['ai'];

  constructor(config: IrisConfig['ai']) {
    this.config = config;
  }

  /**
   * Translate natural language instruction to browser actions
   * Must be implemented by concrete clients
   */
  abstract translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse>;

  /**
   * Check if the client is available
   * Must be implemented by concrete clients
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Helper method to handle errors consistently
   */
  protected handleError(error: unknown, operation: string): AITranslationResponse {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${operation} error:`, formatError(error));
    return {
      actions: [],
      confidence: 0,
      reasoning: `Failed to ${operation}: ${message}`,
    };
  }

  /**
   * Helper method to validate configuration
   */
  protected validateConfig(requiredFields: string[]): void {
    for (const field of requiredFields) {
      if (!(field in this.config) || !this.config[field as keyof typeof this.config]) {
        throw new Error(`${field} not configured for AI provider`);
      }
    }
  }
}

/**
 * Abstract base class for AI clients with vision support
 */
export abstract class BaseAIVisionClient extends BaseAIClient implements AIVisionClient {
  /**
   * Analyze visual differences between two images
   * Must be implemented by concrete vision clients
   */
  abstract analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse>;

  /**
   * Check if vision capabilities are supported
   * Default implementation returns true for vision clients
   */
  supportsVision(): boolean {
    return true;
  }

  /**
   * Handle a vision analysis failure.
   *
   * Always throws — a failed analysis must NOT masquerade as a clean
   * `severity: 'none'` result (issue #29). Re-throwing lets the
   * SmartAIVisionClient fallback chain engage and surfaces a genuine error
   * when every provider fails. The `never` return type lets call sites keep
   * `return this.handleVisionError(...)` while the value never materializes.
   */
  protected handleVisionError(error: unknown, operation: string): never {
    console.error(`${operation} error:`, formatError(error));
    throw error instanceof Error ? error : new Error(`Failed to ${operation}: ${String(error)}`);
  }
}
