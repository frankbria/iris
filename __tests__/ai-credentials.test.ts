/**
 * Per-request AI credentials (#258).
 *
 * Test strategy: the OpenAI and Anthropic SDKs are the fakes the rest of the
 * suite uses, and each fake client remembers the key it was constructed with,
 * so a test can see which key reached which vendor. Process-wide keys are set in
 * the environment on purpose: an injected credential must win over them, and a
 * tenant without one must never fall back to them.
 */

import { translate } from '../src/translator';
import { configFromCredentials } from '../src/ai-client/credentials';
import { createSmartClient, SmartAIVisionClient } from '../src/ai-client';
import { AIClientFactory } from '../src/ai-client/factory';
import { ImagePreprocessor } from '../src/ai-client/preprocessor';

const calls: Array<{ vendor: string; apiKey: string }> = [];
const plan = JSON.stringify({
  actions: [{ type: 'click', selector: '#go' }],
  confidence: 0.9,
  reasoning: 'ok',
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(({ apiKey }: { apiKey: string }) => ({
    chat: {
      completions: {
        create: async () => {
          // Held open, so two requests are in flight at once.
          await sleep(20);
          calls.push({ vendor: 'openai', apiKey });
          return {
            choices: [{ message: { content: plan } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  })),
}));

jest.mock('@anthropic-ai/sdk', () => ({
  Anthropic: jest.fn().mockImplementation(({ apiKey }: { apiKey: string }) => ({
    messages: {
      create: async () => {
        await sleep(5);
        calls.push({ vendor: 'anthropic', apiKey });
        return {
          content: [{ type: 'text', text: plan }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  })),
}));

const NEEDS_AI = 'make sure the order total is shown';

beforeEach(() => {
  calls.length = 0;
  // The operator's own keys, which no tenant request may use.
  process.env.OPENAI_API_KEY = 'sk-process';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-process';
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  jest.restoreAllMocks();
});

describe('translate with injected credentials', () => {
  it('runs two concurrent requests, each with its own key', async () => {
    const [a, b] = await Promise.all([
      translate(NEEDS_AI, undefined, {
        orgId: 'org-a',
        credentials: { provider: 'openai', apiKey: 'sk-tenant-a' },
      }),
      translate(NEEDS_AI, undefined, {
        orgId: 'org-b',
        credentials: { provider: 'openai', apiKey: 'sk-tenant-b' },
      }),
    ]);
    expect([a.method, b.method]).toEqual(['ai', 'ai']);
    expect(calls.map((c) => c.apiKey).sort()).toEqual(['sk-tenant-a', 'sk-tenant-b']);
  });

  it('uses the injected vendor and key, never the process configuration', async () => {
    await translate(NEEDS_AI, undefined, {
      credentials: { provider: 'anthropic', apiKey: 'sk-ant-tenant' },
    });
    expect(calls).toEqual([{ vendor: 'anthropic', apiKey: 'sk-ant-tenant' }]);
  });

  it('with credentials: null, calls no model at all, even with process keys set', async () => {
    const result = await translate(NEEDS_AI, undefined, { credentials: null });
    expect(calls).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.reasoning).toMatch(/no AI credentials/i);
    // Pattern translation still works without a model.
    const nav = await translate('navigate to https://example.com', undefined, {
      credentials: null,
    });
    expect(nav.actions).toEqual([{ type: 'navigate', url: 'https://example.com' }]);
  });

  it('without injected credentials (local mode), still uses the process configuration', async () => {
    await translate(NEEDS_AI);
    expect(calls).toEqual([{ vendor: 'openai', apiKey: 'sk-process' }]);
  });
});

describe('configFromCredentials', () => {
  it("carries only the tenant's vendor, with fallback off unless the org opted in", () => {
    const config = configFromCredentials({ provider: 'openai', apiKey: 'sk-t' }, { kind: 'text' });
    expect(config.ai).toMatchObject({ provider: 'openai', apiKey: 'sk-t', fallback: false });
    expect(config.ai.credentials).toBeUndefined();
    expect(config.ai.model).toBeTruthy();
    expect(
      configFromCredentials(
        { provider: 'openai', apiKey: 'sk-t' },
        { kind: 'text', fallback: true },
      ).ai.fallback,
    ).toBe(true);
  });
});

describe('SmartAIVisionClient with injected credentials', () => {
  let visionCalls: string[];

  beforeEach(() => {
    visionCalls = [];
    jest
      .spyOn(
        SmartAIVisionClient.prototype as unknown as { resolveModel(p: string): Promise<string> },
        'resolveModel',
      )
      .mockImplementation(async (p) => `${p}-model`);
    jest
      .spyOn(ImagePreprocessor.prototype, 'preprocess')
      .mockImplementation(
        async (input) => ({ buffer: input as Buffer, hash: String(input) }) as never,
      );
    jest.spyOn(AIClientFactory, 'create').mockImplementation(
      (config) =>
        ({
          isAvailable: async () => Boolean(config.ai.apiKey || config.ai.endpoint),
          analyzeVisualDiff: async () => {
            visionCalls.push(`${config.ai.provider}:${config.ai.apiKey}`);
            throw new Error(`${config.ai.provider} is down`);
          },
        }) as never,
    );
  });

  const request = { baseline: Buffer.from('b'), current: Buffer.from('c') };

  it("calls only the tenant's vendor when it fails, even with fallback on in process config", async () => {
    // What a local user might have configured: fallback on, keys for every vendor.
    process.env.OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
    try {
      const smart = createSmartClient(
        configFromCredentials({ provider: 'openai', apiKey: 'sk-tenant' }, { kind: 'vision' }),
        { enableCache: false, enableCostTracking: false },
      );
      await expect(smart.analyzeVisualDiff(request)).rejects.toThrow(/openai is down/);
      expect(visionCalls).toEqual(['openai:sk-tenant']);
    } finally {
      delete process.env.OLLAMA_ENDPOINT;
    }
  });

  it('with the org opted in to fallback, still never sends the tenant key to another vendor', async () => {
    const smart = createSmartClient(
      configFromCredentials(
        { provider: 'openai', apiKey: 'sk-tenant' },
        { kind: 'vision', fallback: true },
      ),
      { enableCache: false, enableCostTracking: false },
    );
    await expect(smart.analyzeVisualDiff(request)).rejects.toThrow();
    // Other vendors have no credential of their own here, so none is contacted.
    expect(visionCalls).toEqual(['openai:sk-tenant']);
  });
});
