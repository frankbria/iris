import { randomUUID } from 'crypto';
import * as path from 'path';
import { IrisConfig, resolveBudget } from '../config';
import { resolveDataDir } from '../data-dir';
import { AIClient, AIVisionClient, AITranslationRequest, AITranslationResponse } from './base';
import { CostOperation, CostTracker, RESERVATION_CEILING } from './cost-tracker';
import { OpenAITextClient, AnthropicTextClient, OllamaTextClient } from './text';
import { OpenAIVisionClient, AnthropicVisionClient, OllamaVisionClient } from './vision';
import { resolveModel } from './models';
import { hostedLog } from '../log';

/**
 * Client type - text for instruction translation, vision for visual analysis
 */
export type ClientType = 'text' | 'vision';

/**
 * Factory for creating AI clients based on provider and capability
 */
export class AIClientFactory {
  /**
   * Create an AI client for the specified provider and type
   */
  static create(config: IrisConfig, type: ClientType = 'text'): AIClient {
    if (type === 'text') {
      return this.createTextClient(config);
    } else {
      return this.createVisionClient(config);
    }
  }

  /**
   * Create a text-only AI client
   */
  private static createTextClient(config: IrisConfig): AIClient {
    switch (config.ai.provider) {
      case 'openai':
        return new OpenAITextClient(config.ai);
      case 'anthropic':
        return new AnthropicTextClient(config.ai);
      case 'ollama':
        return new OllamaTextClient(config.ai);
      default:
        throw new Error(`Unsupported AI provider: ${config.ai.provider}`);
    }
  }

  /**
   * Create a vision-capable AI client
   */
  private static createVisionClient(config: IrisConfig): AIVisionClient {
    switch (config.ai.provider) {
      case 'openai':
        return new OpenAIVisionClient(config.ai);
      case 'anthropic':
        return new AnthropicVisionClient(config.ai);
      case 'ollama':
        return new OllamaVisionClient(config.ai);
      default:
        throw new Error(`Unsupported AI provider for vision: ${config.ai.provider}`);
    }
  }

  /**
   * Check if the specified provider supports vision capabilities
   */
  static supportsVision(config: IrisConfig): boolean {
    try {
      const client = this.createVisionClient(config);
      return client.supportsVision();
    } catch {
      return false;
    }
  }
}

/**
 * Legacy factory function for backward compatibility with Phase 1
 * @deprecated Use AIClientFactory.create() instead
 */
export function createAIClient(config: IrisConfig): AIClient {
  return AIClientFactory.create(config, 'text');
}

/**
 * A text client whose every call is budget-gated and recorded (issue #242).
 *
 * Before this only vision calls reached the ledger, so `iris run`, the RPC
 * `instruction` method, the watcher and every agent-loop turn spent tokens
 * that no budget saw. It writes to the same ledger as the vision client, so one
 * budget covers all AI spend.
 *
 * The tracker is opened per call and closed after it: the RPC server lives for
 * days, and a handle kept per client would leak one per translation.
 */
class MeteredTextClient implements AIClient {
  constructor(
    private readonly inner: AIClient,
    private readonly provider: string,
    private readonly model: string,
    private readonly operation: CostOperation,
    /** The tenant charged for the call, whose budget gates it (#255). */
    private readonly orgId?: string,
    /** Told about every call the provider billed, for the usage ledger (#263). */
    private readonly onUsage?: (call: SettledAICall) => void | Promise<void>,
  ) {}

  async translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse> {
    const tracker = new CostTracker(
      path.join(resolveDataDir(), 'cache', 'cost-tracking.db'),
      resolveBudget(),
      { orgId: this.orgId },
    );
    try {
      // Refused before the provider is contacted, counting calls already in
      // flight (#244): a check that ran before the await let N concurrent
      // calls all pass it.
      //
      // The instruction is uncapped short of the RPC payload limit, so it is
      // reserved at up to one token per character on top of the fixed ceiling.
      // Over-holding one call never refuses it; it only holds back the next.
      const reservation = tracker.reserve(this.provider, this.model, this.operation, {
        ...RESERVATION_CEILING,
        inputTokens: RESERVATION_CEILING.inputTokens + JSON.stringify(request).length,
      });
      let response: AITranslationResponse;
      try {
        response = await this.inner.translateInstruction(request);
      } catch (error) {
        tracker.release(reservation);
        throw error;
      }
      // No usage means the request failed before the provider answered, so
      // there is nothing billed to record.
      if (response.usage) {
        const costUsd = tracker.settle(reservation, response.usage);
        await this.report({
          callId: randomUUID(),
          operation: this.operation,
          provider: this.provider,
          model: this.model,
          costUsd,
          estimated: tracker.priceIsEstimated(this.provider, this.model),
        });
      } else {
        tracker.release(reservation);
      }
      return response;
    } finally {
      tracker.close();
    }
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  /**
   * A failed report is logged, never thrown: the call was made and paid for, and its
   * cost is already on the budget ledger.
   *
   * ponytail: the usage row is lost in that case; a retry queue is #264's if invoices
   * must be exact.
   */
  private async report(call: SettledAICall): Promise<void> {
    try {
      await this.onUsage?.(call);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hostedLog('error', 'failed to record AI usage', { err: message }, () =>
        console.error('[iris] failed to record AI usage:', message),
      );
    }
  }
}

/** A provider call that was billed, as the usage ledger needs it (#263). */
export interface SettledAICall {
  /** One per provider call: the usage row's idempotency key is built from it. */
  callId: string;
  operation: CostOperation;
  provider: string;
  model: string;
  costUsd: number;
  /** Priced from an estimate: no price row for the model (#243). */
  estimated: boolean;
}

/**
 * Create a text client whose model has been checked against the provider's live
 * model list (#184), metered against the AI budget (#242).
 *
 * The synchronous {@link createAIClient} trusts `config.ai.model` verbatim,
 * which is how a pin the vendor retired reaches the wire and comes back as an
 * opaque 404. This variant resolves first — one memoized probe per provider per
 * process — replacing a rotted built-in pin and rejecting a user-named model
 * that does not exist. `loadConfig()` stays synchronous; only the two async
 * call sites that build a client pay for the check.
 *
 * Each call on a paid provider throws `BudgetExceededError` once spend plus
 * calls already in flight reaches the budget (#244); local Ollama always proceeds.
 *
 * @throws {ModelUnavailableError} when the configured model is not served.
 */
export async function createResolvedAIClient(
  config: IrisConfig,
  {
    operation = 'text',
    orgId,
    onUsage,
  }: {
    operation?: Extract<CostOperation, 'text' | 'agent_turn'>;
    /** Hosted: the org the call is charged to and budgeted against (#255). */
    orgId?: string;
    /** Hosted: told about each billed call, for the usage ledger (#263). */
    onUsage?: (call: SettledAICall) => void | Promise<void>;
  } = {},
): Promise<AIClient> {
  const model = await resolveModel({
    provider: config.ai.provider,
    kind: 'text',
    model: config.ai.model,
    creds: { apiKey: config.ai.apiKey, endpoint: config.ai.endpoint },
  });

  const client = AIClientFactory.create({ ...config, ai: { ...config.ai, model } }, 'text');
  return new MeteredTextClient(client, config.ai.provider, model, operation, orgId, onUsage);
}
