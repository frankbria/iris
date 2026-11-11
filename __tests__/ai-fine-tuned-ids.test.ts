/**
 * Fine-tuned OpenAI ids (`ft:<base model>:<org>:<suffix>:<id>`) in the vision table and the
 * price table (#664). Every figure was read off OpenAI's pages on 2026-11-11, USD per 1M
 * tokens: https://developers.openai.com/api/docs/pricing ("Fine-tuning", standard) and
 * https://developers.openai.com/api/docs/deprecations.
 */
import { CostTracker, DEFAULT_PRICING } from '../src/ai-client/cost-tracker';
import { ModelNotForImagesError, fineTunedBase, isVisionModel } from '../src/ai-client/models';

const M = 1_000_000;
const usage = { inputTokens: 1000, outputTokens: 1000 };

describe('fine-tuned OpenAI ids (#664)', () => {
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

  const cost = (provider: string, model: string) =>
    tracker.trackOperation(provider, model, false, usage);

  describe('fineTunedBase', () => {
    it.each([
      ['ft:gpt-4o-2024-08-06:acme:checkout:AbC123', 'gpt-4o-2024-08-06'],
      ['ft:gpt-4.1-mini-2025-04-14:acme::AbC123', 'gpt-4.1-mini-2025-04-14'],
      ['ft:gpt-4o-mini-2024-07-18:acme::AbC123:ckpt-step-90', 'gpt-4o-mini-2024-07-18'],
    ])('%s is a fine-tune of %s', (model, base) => {
      expect(fineTunedBase(model)).toBe(base);
    });

    it.each(['gpt-4o', 'gpt-6-luna', 'draft:gpt-4o', 'ft:', 'llava:13b'])(
      '%s is not a fine-tuned id',
      (model) => {
        expect(fineTunedBase(model)).toBeUndefined();
      },
    );
  });

  describe('price table', () => {
    it.each([
      ['ft:gpt-4.1-2025-04-14:acme::AbC123', 3, 12],
      ['ft:gpt-4.1-mini-2025-04-14:acme:checkout:AbC123', 0.8, 3.2],
      ['ft:gpt-4o-2024-08-06:acme::AbC123', 3.75, 15],
      ['ft:gpt-4o-mini-2024-07-18:acme::AbC123', 0.3, 1.2],
      // A checkpoint of a job is billed like the job's model.
      ['ft:gpt-4o-mini-2024-07-18:acme::AbC123:ckpt-step-90', 0.3, 1.2],
    ])('%s is $%d in and $%d out per 1M tokens', (model, input, output) => {
      expect(cost('openai', model)).toBeCloseTo((1000 * input + 1000 * output) / M, 12);
      expect(tracker.priceIsEstimated('openai', model)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('charges a fine-tune more than its base model, as the page does', () => {
      expect(cost('openai', 'ft:gpt-4o-2024-08-06:acme::AbC123')).toBeGreaterThan(
        cost('openai', 'gpt-4o-2024-08-06'),
      );
    });

    // No fine-tuning rate on the page: the base's own rate would under-report.
    it.each([
      'ft:gpt-4.1-nano-2025-04-14:acme::AbC123',
      'ft:gpt-3.5-turbo-0125:acme::AbC123',
      'ft:gpt-4o-2024-05-13:acme::AbC123',
      'ft:gpt-4o:acme::AbC123',
      'ft:gpt-6.1-terra:acme::AbC123',
    ])('%s has no row and stays an estimate at the dearest rate', (model) => {
      expect(cost('openai', model)).toBeCloseTo((1000 * 10 + 1000 * 50) / M, 12);
      expect(tracker.priceIsEstimated('openai', model)).toBe(true);
    });

    it('prefers a price registered for the whole fine-tuned id', () => {
      const model = 'ft:gpt-4o-2024-08-06:acme::AbC123';
      tracker.setPricing('openai', model, 0.5);
      expect(tracker.trackOperation('openai', model, false)).toBe(0.5);
    });

    it('reads an ft: prefix as a fine-tune for OpenAI only', () => {
      expect(tracker.priceIsEstimated('anthropic', 'ft:gpt-4o-2024-08-06:acme::AbC123')).toBe(true);
    });

    it('does not make a fine-tuned row the price of its base model', () => {
      // gpt-4o-2024-08-06 keeps gpt-4o's $2.50/$10.
      expect(cost('openai', 'gpt-4o-2024-08-06')).toBeCloseTo(0.0125, 12);
      expect(cost('openai', 'gpt-4.1-mini')).toBeCloseTo(0.002, 12);
    });

    it("leaves the dearest rate, every unpriced model's estimate, where it was", () => {
      expect(Math.max(...DEFAULT_PRICING.map((p) => p.costPerInputToken ?? 0))).toBeCloseTo(
        10 / M,
        15,
      );
      expect(Math.max(...DEFAULT_PRICING.map((p) => p.costPerOutputToken ?? 0))).toBeCloseTo(
        50 / M,
        15,
      );
    });
  });

  describe('vision table', () => {
    // The bases OpenAI lets be fine-tuned are ones IRIS stopped offering for images (#523);
    // the models in the vision table cannot be fine-tuned, so these ids name nothing.
    it.each([
      'ft:gpt-4o-2024-08-06:acme::AbC123',
      'ft:gpt-4.1-2025-04-14:acme::AbC123',
      'ft:gpt-6.1-terra:acme::AbC123',
      'ft:gpt-5.4-mini:acme::AbC123',
    ])('%s is not a model IRIS uses for images', (model) => {
      expect(isVisionModel('openai', model)).toBe(false);
    });

    it('says a fine-tuned id is refused because it is fine-tuned', () => {
      const { message } = new ModelNotForImagesError('openai', 'ft:gpt-4o-2024-08-06:acme::AbC123');
      expect(message).toContain('"ft:gpt-4o-2024-08-06:acme::AbC123"');
      expect(message).toContain('is not one IRIS uses for images');
      expect(message).toContain('fine-tuned');
      expect(message).toContain('choose another with --ai-model');
      expect(message).not.toContain('text-only');
    });

    it('keeps the wording for an id without the ft: prefix', () => {
      expect(new ModelNotForImagesError('openai', 'gpt-4o').message).toBe(
        'openai model "gpt-4o" is not one IRIS uses for images ' +
          '(text-only, deprecated or unknown); choose another with --ai-model',
      );
      expect(new ModelNotForImagesError('ollama', 'ft:custom').message).toContain('text-only');
    });
  });
});
