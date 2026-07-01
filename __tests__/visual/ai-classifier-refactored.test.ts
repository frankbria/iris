/**
 * Tests for the REAL AIVisualClassifier (src/visual/ai-classifier.ts).
 *
 * Previously this file exercised an in-file stub class that never imported
 * production code (issue #62 / P0.9). It now imports the real classifier and
 * mocks only the collaborator boundaries it owns:
 *   - SmartAIVisionClient (provider selection / cache / cost / fallback)
 *   - ImagePreprocessor   (used by prepareImageForAI)
 *   - p-limit             (ESM-only; used by batchAnalyze)
 *
 * Assertions reflect PRODUCTION behavior, notably:
 *   - analyzeChange() passes RAW buffers to the smart client (preprocessing
 *     happens inside the smart client, not here) and NEVER throws — on error it
 *     returns a fallback response.
 *   - severity map: none/minor→low(+intentional), moderate→medium, breaking→critical.
 *   - category map: layout/spacing→layout, text→typography, color→color, content→content.
 *   - classification: none→'no-change', else intentional?'intentional':'regression'.
 *   - constructor validates config (openai/claude require an apiKey).
 */

// Mock collaborator boundaries only — the classifier itself is real.
jest.mock('../../src/ai-client/smart-client');
jest.mock('../../src/ai-client/preprocessor');
// p-limit v5 is ESM-only; the real batchAnalyze dynamically imports it. Replace
// it with a pass-through limiter so batching runs under ts-jest/CommonJS.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (fn: () => unknown) => fn(),
}));

import { AIVisualClassifier, AIAnalysisRequest } from '../../src/visual/ai-classifier';
import { SmartAIVisionClient } from '../../src/ai-client/smart-client';
import { ImagePreprocessor } from '../../src/ai-client/preprocessor';
import { AIVisionResponse } from '../../src/ai-client/base';

const MockSmartAIVisionClient = SmartAIVisionClient as jest.MockedClass<typeof SmartAIVisionClient>;
const MockImagePreprocessor = ImagePreprocessor as jest.MockedClass<typeof ImagePreprocessor>;

describe('AIVisualClassifier (real, backed by Phase 2A infrastructure)', () => {
  const mockBaselineBuffer = Buffer.from('baseline-image-data');
  const mockCurrentBuffer = Buffer.from('current-image-data');
  const mockDiffBuffer = Buffer.from('diff-image-data');

  const mockPreprocessedImage = {
    buffer: Buffer.from('optimized'),
    base64: 'b3B0aW1pemVk',
    hash: 'abc123def456',
    originalSize: 10000,
    processedSize: 5000,
    reductionPercent: 50,
    dimensions: { width: 1024, height: 768 },
  };

  const mockAIVisionResponse: AIVisionResponse = {
    severity: 'moderate',
    confidence: 0.85,
    reasoning: 'Layout shift detected in header section',
    categories: ['layout', 'spacing'],
    suggestions: ['Check CSS flexbox properties', 'Verify container widths'],
  };

  let mockSmartClient: jest.Mocked<SmartAIVisionClient>;
  let mockPreprocessor: jest.Mocked<ImagePreprocessor>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPreprocessor = {
      preprocess: jest.fn().mockResolvedValue(mockPreprocessedImage),
    } as unknown as jest.Mocked<ImagePreprocessor>;
    MockImagePreprocessor.mockImplementation(() => mockPreprocessor);

    mockSmartClient = {
      analyzeVisualDiff: jest.fn().mockResolvedValue(mockAIVisionResponse),
      getCacheStats: jest.fn().mockReturnValue({ hits: 10, misses: 5 }),
      getCostStats: jest.fn().mockReturnValue({ totalCost: 1.5, operationCount: 100 }),
      getBudgetStatus: jest.fn().mockReturnValue({ circuitBreakerTriggered: false }),
      close: jest.fn(),
    } as unknown as jest.Mocked<SmartAIVisionClient>;
    MockSmartAIVisionClient.mockImplementation(() => mockSmartClient);
  });

  const makeClassifier = (): AIVisualClassifier =>
    new AIVisualClassifier({ provider: 'openai', apiKey: 'sk-test-key' });

  // ==========================================================================
  // Constructor & configuration validation
  // ==========================================================================
  describe('Constructor & validation', () => {
    it('constructs the smart client and preprocessor for a valid OpenAI config', () => {
      const classifier = new AIVisualClassifier({ provider: 'openai', apiKey: 'sk-test' });
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
      expect(MockSmartAIVisionClient).toHaveBeenCalledTimes(1);
      expect(MockImagePreprocessor).toHaveBeenCalledTimes(1);
    });

    it('constructs for a valid Anthropic (claude) config', () => {
      const classifier = new AIVisualClassifier({ provider: 'claude', apiKey: 'sk-ant' });
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
    });

    it('constructs for Ollama without an apiKey', () => {
      const classifier = new AIVisualClassifier({
        provider: 'ollama',
        baseURL: 'http://localhost:11434',
      });
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
    });

    it('throws when OpenAI apiKey is missing', () => {
      expect(() => new AIVisualClassifier({ provider: 'openai' })).toThrow(/OpenAI API key/i);
    });

    it('throws when Claude apiKey is missing', () => {
      expect(() => new AIVisualClassifier({ provider: 'claude' })).toThrow(/Anthropic API key/i);
    });

    it('throws on an unsupported provider', () => {
      expect(() => new AIVisualClassifier({ provider: 'bogus' as unknown as 'openai' })).toThrow(
        /Unsupported AI provider/i,
      );
    });
  });

  // ==========================================================================
  // analyzeChange()
  // ==========================================================================
  describe('analyzeChange()', () => {
    let classifier: AIVisualClassifier;
    beforeEach(() => {
      classifier = makeClassifier();
    });

    it('delegates to the smart client with RAW buffers (no local preprocessing)', async () => {
      const request: AIAnalysisRequest = {
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      };

      await classifier.analyzeChange(request);

      expect(mockSmartClient.analyzeVisualDiff).toHaveBeenCalledTimes(1);
      const callArgs = mockSmartClient.analyzeVisualDiff.mock.calls[0][0];
      // Production forwards the ORIGINAL buffers; the smart client preprocesses.
      expect(callArgs.baseline).toBe(mockBaselineBuffer);
      expect(callArgs.current).toBe(mockCurrentBuffer);
      // analyzeChange must not run the preprocessor itself.
      expect(mockPreprocessor.preprocess).not.toHaveBeenCalled();
    });

    it('maps a moderate response to medium/regression', async () => {
      const result = await classifier.analyzeChange({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      expect(result.severity).toBe('medium');
      expect(result.confidence).toBe(0.85);
      expect(result.classification).toBe('regression');
      expect(result.isIntentional).toBe(false);
      expect(result.changeType).toBe('layout');
      expect(result.description).toContain('Layout shift detected');
      expect(result.suggestions).toEqual(mockAIVisionResponse.suggestions);
      expect(result.reasoning).toBe(mockAIVisionResponse.reasoning);
      expect(result.regions).toBeUndefined();
    });

    it.each([
      ['none', 'low', true, 'no-change'],
      ['minor', 'low', true, 'intentional'],
      ['moderate', 'medium', false, 'regression'],
      ['breaking', 'critical', false, 'regression'],
    ] as const)(
      'maps severity %s → %s (intentional=%s, classification=%s)',
      async (severity, expectedSeverity, intentional, classification) => {
        mockSmartClient.analyzeVisualDiff.mockResolvedValue({
          ...mockAIVisionResponse,
          severity,
        });

        const result = await classifier.analyzeChange({
          baselineImage: mockBaselineBuffer,
          currentImage: mockCurrentBuffer,
        });

        expect(result.severity).toBe(expectedSeverity);
        expect(result.isIntentional).toBe(intentional);
        expect(result.classification).toBe(classification);
      },
    );

    it('forwards only the mapped context (url) to the smart client', async () => {
      const request: AIAnalysisRequest = {
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
        diffImage: mockDiffBuffer,
        context: {
          testName: 'Header Test',
          url: 'https://example.com',
          viewport: { width: 1920, height: 1080 },
          gitBranch: 'feature/x',
        },
      };

      await classifier.analyzeChange(request);

      const callArgs = mockSmartClient.analyzeVisualDiff.mock.calls[0][0];
      expect(callArgs.context).toEqual({
        url: 'https://example.com',
        selector: undefined,
        previousClassifications: undefined,
      });
    });

    it('appends test/url/viewport context to the description', async () => {
      const result = await classifier.analyzeChange({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
        context: {
          testName: 'Login Form',
          url: 'https://app.example.com/login',
          viewport: { width: 1280, height: 720 },
        },
      });

      expect(result.description).toContain('Test: Login Form');
      expect(result.description).toContain('URL: https://app.example.com/login');
      expect(result.description).toContain('Viewport: 1280x720');
    });

    it('returns a fallback response (never throws) when the smart client fails', async () => {
      mockSmartClient.analyzeVisualDiff.mockRejectedValue(
        new Error('OpenAI API rate limit exceeded'),
      );

      const result = await classifier.analyzeChange({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      expect(result.classification).toBe('unknown');
      expect(result.severity).toBe('medium');
      expect(result.confidence).toBe(0.5);
      expect(result.isIntentional).toBe(false);
      expect(result.changeType).toBe('unknown');
      expect(result.description).toContain('OpenAI API rate limit exceeded');
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('returns a fallback response when the budget circuit breaker trips', async () => {
      mockSmartClient.analyzeVisualDiff.mockRejectedValue(
        new Error('Budget limit exceeded - circuit breaker activated'),
      );

      const result = await classifier.analyzeChange({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      expect(result.classification).toBe('unknown');
      expect(result.description).toContain('Budget limit exceeded');
    });
  });

  // ==========================================================================
  // Category → changeType mapping
  // ==========================================================================
  describe('category → changeType mapping', () => {
    let classifier: AIVisualClassifier;
    beforeEach(() => {
      classifier = makeClassifier();
    });

    it.each([
      [['layout', 'spacing'], 'layout'],
      [['spacing'], 'layout'],
      [['text'], 'typography'], // production maps text → typography (NOT content)
      [['color'], 'color'],
      [['content'], 'content'],
      [[], 'unknown'],
    ] as const)('maps categories %j → %s', async (categories, expected) => {
      mockSmartClient.analyzeVisualDiff.mockResolvedValue({
        ...mockAIVisionResponse,
        categories: [...categories],
      });

      const result = await classifier.analyzeChange({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      expect(result.changeType).toBe(expected);
    });

    it('defaults suggestions to [] when the response omits them', async () => {
      mockSmartClient.analyzeVisualDiff.mockResolvedValue({
        severity: 'moderate',
        confidence: 0.75,
        reasoning: 'Some changes detected',
        categories: [],
      });

      const result = await classifier.analyzeChange({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      expect(result.suggestions).toEqual([]);
      expect(result.changeType).toBe('unknown');
    });
  });

  // ==========================================================================
  // batchAnalyze()
  // ==========================================================================
  describe('batchAnalyze()', () => {
    let classifier: AIVisualClassifier;
    beforeEach(() => {
      classifier = makeClassifier();
    });

    it('analyzes every request in the batch', async () => {
      const requests: AIAnalysisRequest[] = Array(4).fill({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      const results = await classifier.batchAnalyze(requests);

      expect(results).toHaveLength(4);
      expect(mockSmartClient.analyzeVisualDiff).toHaveBeenCalledTimes(4);
    });

    it('resolves all entries even when some analyses fail (fallback per item)', async () => {
      mockSmartClient.analyzeVisualDiff
        .mockResolvedValueOnce(mockAIVisionResponse)
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce(mockAIVisionResponse);

      const requests: AIAnalysisRequest[] = Array(3).fill({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      const results = await classifier.batchAnalyze(requests);

      expect(results).toHaveLength(3);
      // The failed item becomes a fallback, not a rejection.
      expect(results[1].classification).toBe('unknown');
      expect(results[1].description).toContain('API error');
    });
  });

  // ==========================================================================
  // Backward-compat helpers
  // ==========================================================================
  describe('backward-compat helpers', () => {
    let classifier: AIVisualClassifier;
    beforeEach(() => {
      classifier = makeClassifier();
    });

    it('prepareImageForAI() delegates to the preprocessor', async () => {
      const result = await classifier.prepareImageForAI(mockBaselineBuffer);

      expect(mockPreprocessor.preprocess).toHaveBeenCalledWith(mockBaselineBuffer);
      expect(result.base64).toBe(mockPreprocessedImage.base64);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.width).toBe(mockPreprocessedImage.dimensions.width);
      expect(result.height).toBe(mockPreprocessedImage.dimensions.height);
    });

    it('prepareImageForAI() wraps preprocessing errors', async () => {
      mockPreprocessor.preprocess.mockRejectedValue(new Error('sharp exploded'));

      await expect(classifier.prepareImageForAI(mockBaselineBuffer)).rejects.toThrow(
        /Failed to prepare image for AI: sharp exploded/,
      );
    });

    it('prepareImagesForAI() prepares each image', async () => {
      const results = await classifier.prepareImagesForAI([mockBaselineBuffer, mockCurrentBuffer]);
      expect(results).toHaveLength(2);
      expect(mockPreprocessor.preprocess).toHaveBeenCalledTimes(2);
    });

    it('toVisualAnalysis() projects the response subset', async () => {
      const response = await classifier.analyzeChange({
        baselineImage: mockBaselineBuffer,
        currentImage: mockCurrentBuffer,
      });

      const summary = classifier.toVisualAnalysis(response);

      expect(summary).toEqual({
        classification: response.classification,
        confidence: response.confidence,
        description: response.description,
        severity: response.severity,
        suggestions: response.suggestions,
        regions: response.regions,
      });
    });

    it('exposes cache/cost/budget stats and close() via the smart client', () => {
      expect(classifier.getCacheStats()).toEqual({ hits: 10, misses: 5 });
      expect(classifier.getCostStats()).toEqual({ totalCost: 1.5, operationCount: 100 });
      expect(classifier.getBudgetStatus()).toEqual({ circuitBreakerTriggered: false });

      classifier.close();
      expect(mockSmartClient.close).toHaveBeenCalledTimes(1);
    });
  });
});
