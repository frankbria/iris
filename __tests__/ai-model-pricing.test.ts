/**
 * The default price table against the vendors' pricing pages as checked on 2026-11-11
 * (#523). Every figure here was read off the page that day, USD per 1M tokens:
 * https://developers.openai.com/api/docs/pricing and
 * https://platform.claude.com/docs/en/about-claude/pricing.
 */
import { CostTracker, DEFAULT_PRICING } from '../src/ai-client/cost-tracker';
import { DEFAULT_MODELS, isVisionModel } from '../src/ai-client/models';

const M = 1_000_000;
/** A call under every long-context threshold. */
const usage = { inputTokens: 1000, outputTokens: 1000 };

describe('default price table (#523)', () => {
  let tracker: CostTracker;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    tracker = new CostTracker(':memory:', { dailyLimit: 1e9, monthlyLimit: 1e9 });
    warn = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    tracker.close();
    warn.mockRestore();
  });

  const cost = (provider: string, model: string, tokens = usage) =>
    tracker.trackOperation(provider, model, false, tokens);

  it.each([
    // Current OpenAI families, short-context standard rates.
    ['openai', 'gpt-6-astra', 10, 50],
    ['openai', 'gpt-6.1-sol', 2, 10],
    ['openai', 'gpt-6.1-terra', 1, 5],
    ['openai', 'gpt-6-sol', 2, 10],
    ['openai', 'gpt-6-luna', 0.1, 0.5],
    ['openai', 'gpt-5.6-terra', 2, 12],
    ['openai', 'gpt-5.6-luna', 0.2, 1.2],
    ['openai', 'gpt-5.5', 5, 30],
    ['openai', 'gpt-5.4', 2.5, 15],
    ['openai', 'gpt-5.4-mini', 0.75, 4.5],
    ['openai', 'gpt-5.2', 1.75, 14],
    // Deprecated, still served and billed.
    ['openai', 'gpt-5.1', 1.25, 10],
    ['openai', 'gpt-5.4-nano', 0.2, 1.25],
    ['openai', 'gpt-4o', 2.5, 10],
    ['openai', 'gpt-4o-mini', 0.15, 0.6],
    ['openai', 'gpt-4.1', 2, 8],
    ['openai', 'gpt-4.1-mini', 0.4, 1.6],
    ['openai', 'gpt-5', 1.25, 10],
    ['openai', 'gpt-5-mini', 0.25, 2],
    ['openai', 'gpt-5-nano', 0.05, 0.4],
    ['openai', 'o3', 2, 8],
    ['anthropic', 'claude-fable-5-2', 8, 40],
    ['anthropic', 'claude-fable-5-1', 10, 50],
    ['anthropic', 'claude-fable-5', 10, 50],
    ['anthropic', 'claude-opus-5-5', 4, 20],
    ['anthropic', 'claude-opus-5', 5, 25],
    ['anthropic', 'claude-opus-4-8', 5, 25],
    ['anthropic', 'claude-opus-4-7', 5, 25],
    ['anthropic', 'claude-opus-4-6', 5, 25],
    ['anthropic', 'claude-opus-4-5', 5, 25],
    ['anthropic', 'claude-sonnet-5-5', 2, 10],
    ['anthropic', 'claude-sonnet-4-6', 3, 15],
    ['anthropic', 'claude-sonnet-4-5', 3, 15],
    ['anthropic', 'claude-haiku-5-5', 0.1, 0.5],
    ['anthropic', 'claude-haiku-4-5', 1, 5],
  ])('%s %s is $%d in and $%d out per 1M tokens', (provider, model, input, output) => {
    expect(cost(provider, model)).toBeCloseTo((1000 * input + 1000 * output) / M, 12);
    expect(tracker.priceIsEstimated(provider, model)).toBe(false);
  });

  it('prices Claude Sonnet 5 at $2/$10, its standard price since the rise was cancelled', () => {
    expect(cost('anthropic', 'claude-sonnet-5')).toBeCloseTo(0.012, 12);
  });

  it('prices GPT-5.6 Sol at the $5/$30 it returns to, not its promotion to 2026-11-30', () => {
    expect(cost('openai', 'gpt-5.6-sol')).toBeCloseTo(0.035, 12);
  });

  it('prices a dated snapshot of a new family like the family', () => {
    expect(cost('openai', 'gpt-5.5-2026-04-23')).toBeCloseTo(0.035, 12);
    expect(cost('openai', 'gpt-5.4-mini-2026-03-17')).toBeCloseTo(0.00525, 12);
    expect(cost('anthropic', 'claude-haiku-5-5-20261007')).toBeCloseTo(0.0006, 12);
  });

  it('prices every built-in default model from its own row', () => {
    for (const kind of ['text', 'vision'] as const) {
      for (const provider of ['openai', 'anthropic'] as const) {
        expect(tracker.priceIsEstimated(provider, DEFAULT_MODELS[kind][provider])).toBe(false);
      }
    }
  });

  it('defaults OpenAI to models it has not deprecated, and the vision one sees', () => {
    expect(DEFAULT_MODELS.text.openai).toBe('gpt-6-luna');
    expect(DEFAULT_MODELS.vision.openai).toBe('gpt-6.1-terra');
    expect(isVisionModel('openai', DEFAULT_MODELS.vision.openai)).toBe(true);
  });

  // Rows for models the vendors have stopped serving would price calls that cannot be made.
  it.each([
    ['openai', 'gpt-4o-2024-05-13'],
    ['openai', 'gpt-4-turbo'],
    ['openai', 'o1'],
    ['openai', 'o4-mini'],
    ['openai', 'gpt-4.1-nano'],
    ['anthropic', 'claude-opus-4-1'],
    ['anthropic', 'claude-sonnet-4'],
  ])('has no row for the shut-down %s %s', (provider, model) => {
    expect(DEFAULT_PRICING.some((p) => p.provider === provider && p.model === model)).toBe(false);
  });

  // #388: a row dearer than the rest becomes every unpriced model's estimate.
  it('keeps the Responses-only -pro models out of the table', () => {
    expect(DEFAULT_PRICING.filter((p) => p.model.includes('-pro'))).toEqual([]);
    const dearest = Math.max(...DEFAULT_PRICING.map((p) => p.costPerInputToken ?? 0));
    expect(dearest).toBeCloseTo(10 / M, 15);
  });

  it('has one row per provider and model', () => {
    const keys = DEFAULT_PRICING.map((p) => `${p.provider}:${p.model}`);
    expect(keys).toEqual([...new Set(keys)]);
  });

  describe('long-context tier', () => {
    it('charges an OpenAI request over 272K input tokens the long rate for all of it', () => {
      // gpt-6.1-terra: $1/$5 up to 272K input tokens, $2/$7.50 for the whole request above.
      const atThreshold = { inputTokens: 272_000, outputTokens: 1000 };
      const over = { inputTokens: 272_001, outputTokens: 1000 };
      expect(cost('openai', 'gpt-6.1-terra', atThreshold)).toBeCloseTo(0.272 + 0.005, 12);
      expect(cost('openai', 'gpt-6.1-terra', over)).toBeCloseTo((272_001 * 2 + 1000 * 7.5) / M, 12);
    });

    it.each([
      ['gpt-6-astra', 20, 75],
      ['gpt-6.1-sol', 4, 15],
      ['gpt-6-sol', 4, 15],
      ['gpt-6-luna', 0.2, 0.75],
      ['gpt-5.6-sol', 10, 45],
      ['gpt-5.6-terra', 4, 18],
      ['gpt-5.6-luna', 0.4, 1.8],
      ['gpt-5.5', 10, 45],
      ['gpt-5.4', 5, 22.5],
    ])('%s over 272K is $%d in and $%d out per 1M tokens', (model, input, output) => {
      const over = { inputTokens: 300_000, outputTokens: 1000 };
      expect(cost('openai', model, over)).toBeCloseTo((300_000 * input + 1000 * output) / M, 10);
    });

    it('leaves the models OpenAI prices flat at one rate however long the prompt', () => {
      const over = { inputTokens: 300_000, outputTokens: 1000 };
      expect(cost('openai', 'gpt-5.4-mini', over)).toBeCloseTo((300_000 * 0.75 + 4500) / M, 10);
      expect(cost('openai', 'gpt-5.2', over)).toBeCloseTo((300_000 * 1.75 + 14_000) / M, 10);
    });

    it('charges Claude Haiku 5.5 five times as much over 100,000 prompt tokens', () => {
      const atThreshold = { inputTokens: 100_000, outputTokens: 1000 };
      const over = { inputTokens: 100_001, outputTokens: 1000 };
      expect(cost('anthropic', 'claude-haiku-5-5', atThreshold)).toBeCloseTo(0.01 + 0.0005, 12);
      expect(cost('anthropic', 'claude-haiku-5-5', over)).toBeCloseTo(
        (100_001 * 0.5 + 1000 * 2.5) / M,
        12,
      );
    });

    it('gives a dated snapshot its family tier too', () => {
      const over = { inputTokens: 300_000, outputTokens: 0 };
      expect(cost('openai', 'gpt-5.5-2026-04-23', over)).toBeCloseTo(3, 10);
    });

    it('holds a reservation at the long rate when the call may cross the threshold', () => {
      tracker.reserve('openai', 'gpt-6.1-terra', 'text', {
        inputTokens: 300_000,
        outputTokens: 1000,
      });
      expect(tracker.getDailyCost()).toBeCloseTo((300_000 * 2 + 1000 * 7.5) / M, 6);
    });

    it('applies a tier registered through setPricing, and drops it with the token rates', () => {
      const long = { aboveInputTokens: 10, costPerInputToken: 3e-6, costPerOutputToken: 4e-6 };
      tracker.setPricing('custom', 'tiered', 0.001, 1e-6, 2e-6, long);
      expect(cost('custom', 'tiered', { inputTokens: 10, outputTokens: 10 })).toBeCloseTo(3e-5, 12);
      expect(cost('custom', 'tiered', { inputTokens: 11, outputTokens: 10 })).toBeCloseTo(
        7.3e-5,
        12,
      );
      tracker.setPricing('custom', 'tiered', 0.001);
      expect(cost('custom', 'tiered', { inputTokens: 11, outputTokens: 10 })).toBe(0.001);
    });

    it('does not charge an unpriced model a long-context tier', () => {
      // The estimate is the dearest short-context rate per field: $10 in, $50 out.
      const over = { inputTokens: 300_000, outputTokens: 1000 };
      expect(cost('openai', 'gpt-9-unknown', over)).toBeCloseTo(3 + 0.05, 10);
    });
  });

  it('charges a call recorded without usage 800 input tokens for a row with no flat rate given', () => {
    expect(tracker.getPricing('openai', 'gpt-6.1-terra')).toBeCloseTo(0.0008, 12);
    expect(tracker.getPricing('anthropic', 'claude-fable-5-2')).toBeCloseTo(0.0064, 12);
  });
});
