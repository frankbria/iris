import { AIVisualClassifier, AIProviderConfig, AIAnalysisRequest, AIAnalysisResponse } from '../../src/visual/ai-classifier';
import sharp from 'sharp';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// Mock dependencies
jest.mock('sharp');
jest.mock('openai');
jest.mock('@anthropic-ai/sdk');
jest.mock('node-fetch', () => jest.fn());

const mockSharp = sharp as jest.MockedFunction<typeof sharp>;
const mockOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;
const mockAnthropic = Anthropic as jest.MockedClass<typeof Anthropic>;

describe('AIVisualClassifier', () => {
  const mockImageBuffer = Buffer.from('mock-image-data');
  const mockBase64 = 'bW9jay1pbWFnZS1kYXRh'; // base64 of "mock-image-data"

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup sharp mock with chaining
    const mockSharpInstance = {
      metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080, format: 'png' }),
      resize: jest.fn().mockReturnThis(),
      jpeg: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('optimized-image')),
    };
    mockSharp.mockReturnValue(mockSharpInstance as any);
  });

  describe('Constructor and Initialization', () => {
    it('should initialize with OpenAI provider', () => {
      const config: AIProviderConfig = {
        provider: 'openai',
        apiKey: 'test-openai-key',
      };

      const classifier = new AIVisualClassifier(config);
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
      expect(mockOpenAI).toHaveBeenCalledWith({ apiKey: 'test-openai-key' });
    });

    it('should initialize with Claude provider', () => {
      const config: AIProviderConfig = {
        provider: 'claude',
        apiKey: 'test-claude-key',
      };

      const classifier = new AIVisualClassifier(config);
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
      expect(mockAnthropic).toHaveBeenCalledWith({ apiKey: 'test-claude-key' });
    });

    it('should initialize with Ollama provider', () => {
      const config: AIProviderConfig = {
        provider: 'ollama',
        baseURL: 'http://localhost:11434',
      };

      const classifier = new AIVisualClassifier(config);
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
    });

    it('should throw error if OpenAI API key is missing', () => {
      const config: AIProviderConfig = {
        provider: 'openai',
      };

      expect(() => new AIVisualClassifier(config)).toThrow('OpenAI API key is required');
    });

    it('should throw error if Claude API key is missing', () => {
      const config: AIProviderConfig = {
        provider: 'claude',
      };

      expect(() => new AIVisualClassifier(config)).toThrow('Anthropic API key is required');
    });

    it('should throw error for unsupported provider', () => {
      const config: AIProviderConfig = {
        provider: 'unsupported' as any,
      };

      expect(() => new AIVisualClassifier(config)).toThrow('Unsupported AI provider');
    });

    it('should use default models if not specified', () => {
      const openaiConfig: AIProviderConfig = {
        provider: 'openai',
        apiKey: 'test-key',
      };
      new AIVisualClassifier(openaiConfig);
      // Model defaults are set internally, tested through usage

      const claudeConfig: AIProviderConfig = {
        provider: 'claude',
        apiKey: 'test-key',
      };
      new AIVisualClassifier(claudeConfig);
    });

    it('should accept custom model names', () => {
      const config: AIProviderConfig = {
        provider: 'openai',
        apiKey: 'test-key',
        model: 'gpt-4-custom',
      };

      const classifier = new AIVisualClassifier(config);
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
    });

    it('should accept custom temperature and maxTokens', () => {
      const config: AIProviderConfig = {
        provider: 'openai',
        apiKey: 'test-key',
        temperature: 0.5,
        maxTokens: 4096,
      };

      const classifier = new AIVisualClassifier(config);
      expect(classifier).toBeInstanceOf(AIVisualClassifier);
    });
  });

  describe('prepareImageForAI()', () => {
    let classifier: AIVisualClassifier;

    beforeEach(() => {
      classifier = new AIVisualClassifier({
        provider: 'openai',
        apiKey: 'test-key',
      });
    });

    it('should prepare image with optimization', async () => {
      const mockOptimizedBuffer = Buffer.from('optimized-image');
      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(mockOptimizedBuffer),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);

      const result = await classifier.prepareImageForAI(mockImageBuffer);

      expect(result).toEqual({
        base64: expect.any(String),
        mimeType: 'image/jpeg',
        width: expect.any(Number),
        height: expect.any(Number),
      });
      expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({ quality: 85 });
    });

    it('should resize large images to maxWidth', async () => {
      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 2560, height: 1440 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('resized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);

      await classifier.prepareImageForAI(mockImageBuffer, 1024);

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(1024, undefined, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    });

    it('should not resize images smaller than maxWidth', async () => {
      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 800, height: 600 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('not-resized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);

      await classifier.prepareImageForAI(mockImageBuffer, 1024);

      expect(mockSharpInstance.resize).not.toHaveBeenCalled();
    });

    it('should handle image processing errors', async () => {
      mockSharp.mockImplementation(() => {
        throw new Error('Sharp processing failed');
      });

      await expect(classifier.prepareImageForAI(mockImageBuffer)).rejects.toThrow(
        'Failed to prepare image for AI'
      );
    });

    it('should use custom maxWidth parameter', async () => {
      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 3000, height: 2000 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('custom-resize')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);

      await classifier.prepareImageForAI(mockImageBuffer, 512);

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(512, undefined, expect.any(Object));
    });
  });

  describe('prepareImagesForAI()', () => {
    let classifier: AIVisualClassifier;

    beforeEach(() => {
      classifier = new AIVisualClassifier({
        provider: 'openai',
        apiKey: 'test-key',
      });

      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('optimized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);
    });

    it('should prepare multiple images in parallel', async () => {
      const images = [mockImageBuffer, mockImageBuffer, mockImageBuffer];

      const results = await classifier.prepareImagesForAI(images);

      expect(results).toHaveLength(3);
      expect(results[0]).toHaveProperty('base64');
      expect(results[0]).toHaveProperty('mimeType', 'image/jpeg');
    });

    it('should handle empty array', async () => {
      const results = await classifier.prepareImagesForAI([]);
      expect(results).toEqual([]);
    });
  });

  describe('analyzeChange() - OpenAI', () => {
    let classifier: AIVisualClassifier;
    let mockOpenAIInstance: any;

    beforeEach(() => {
      mockOpenAIInstance = {
        chat: {
          completions: {
            create: jest.fn(),
          },
        },
      };
      mockOpenAI.mockImplementation(() => mockOpenAIInstance);

      classifier = new AIVisualClassifier({
        provider: 'openai',
        apiKey: 'test-key',
      });

      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('optimized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);
    });

    it('should analyze visual changes using OpenAI', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                classification: 'regression',
                confidence: 0.95,
                description: 'Layout shift detected',
                severity: 'high',
                suggestions: ['Review CSS changes', 'Check flexbox settings'],
                isIntentional: false,
                changeType: 'layout',
                reasoning: 'Unintended layout shift',
                regions: [],
              }),
            },
          },
        ],
      };

      mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockResponse);

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
        context: {
          testName: 'homepage-test',
          url: 'https://example.com',
        },
      };

      const result = await classifier.analyzeChange(request);

      expect(result.classification).toBe('regression');
      expect(result.confidence).toBe(0.95);
      expect(result.severity).toBe('high');
      expect(result.isIntentional).toBe(false);
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalled();
    });

    it('should include diff image if provided', async () => {
      const mockResponse = {
        choices: [{ message: { content: '{"classification":"unknown","confidence":0.5}' } }],
      };
      mockOpenAIInstance.chat.completions.create.mockResolvedValue(mockResponse);

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
        diffImage: mockImageBuffer,
      };

      await classifier.analyzeChange(request);

      const callArgs = mockOpenAIInstance.chat.completions.create.mock.calls[0][0];
      expect(callArgs.messages[0].content).toHaveLength(4); // text + 3 images
    });

    it('should handle OpenAI API errors', async () => {
      mockOpenAIInstance.chat.completions.create.mockRejectedValue(new Error('API rate limit'));

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      await expect(classifier.analyzeChange(request)).rejects.toThrow('OpenAI analysis failed');
    });

    it('should handle empty response from OpenAI', async () => {
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [{ message: {} }],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      await expect(classifier.analyzeChange(request)).rejects.toThrow('No response from OpenAI');
    });
  });

  describe('analyzeChange() - Claude', () => {
    let classifier: AIVisualClassifier;
    let mockAnthropicInstance: any;

    beforeEach(() => {
      mockAnthropicInstance = {
        messages: {
          create: jest.fn(),
        },
      };
      mockAnthropic.mockImplementation(() => mockAnthropicInstance);

      classifier = new AIVisualClassifier({
        provider: 'claude',
        apiKey: 'test-key',
      });

      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('optimized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);
    });

    it('should analyze visual changes using Claude', async () => {
      const mockResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              classification: 'intentional',
              confidence: 0.88,
              description: 'New feature added',
              severity: 'low',
              suggestions: [],
              isIntentional: true,
              changeType: 'content',
              reasoning: 'Deliberate content addition',
            }),
          },
        ],
      };

      mockAnthropicInstance.messages.create.mockResolvedValue(mockResponse);

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);

      expect(result.classification).toBe('intentional');
      expect(result.confidence).toBe(0.88);
      expect(result.isIntentional).toBe(true);
      expect(mockAnthropicInstance.messages.create).toHaveBeenCalled();
    });

    it('should handle Claude API errors', async () => {
      mockAnthropicInstance.messages.create.mockRejectedValue(new Error('Claude API error'));

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      await expect(classifier.analyzeChange(request)).rejects.toThrow('Claude analysis failed');
    });

    it('should handle missing text block in Claude response', async () => {
      mockAnthropicInstance.messages.create.mockResolvedValue({
        content: [{ type: 'other' }],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      await expect(classifier.analyzeChange(request)).rejects.toThrow('No text response from Claude');
    });
  });

  describe('analyzeChange() - Ollama', () => {
    let classifier: AIVisualClassifier;
    const mockFetch = require('node-fetch');

    beforeEach(() => {
      classifier = new AIVisualClassifier({
        provider: 'ollama',
        baseURL: 'http://localhost:11434',
      });

      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('optimized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);

      mockFetch.mockClear();
    });

    it('should analyze visual changes using Ollama', async () => {
      const mockResponse = {
        ok: true,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue({
          response: JSON.stringify({
            classification: 'regression',
            confidence: 0.75,
            description: 'Color mismatch',
            severity: 'medium',
            suggestions: ['Check color palette'],
            isIntentional: false,
            changeType: 'color',
            reasoning: 'Unexpected color change',
          }),
        }),
      };

      (global as any).fetch = jest.fn().mockResolvedValue(mockResponse);

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);

      expect(result.classification).toBe('regression');
      expect(result.changeType).toBe('color');
      expect((global as any).fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should handle Ollama API errors', async () => {
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: false,
        statusText: 'Service Unavailable',
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      await expect(classifier.analyzeChange(request)).rejects.toThrow('Ollama analysis failed');
    });

    it('should handle network errors', async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      await expect(classifier.analyzeChange(request)).rejects.toThrow('Ollama analysis failed');
    });
  });

  describe('batchAnalyze()', () => {
    let classifier: AIVisualClassifier;
    let mockOpenAIInstance: any;

    beforeEach(() => {
      mockOpenAIInstance = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      classification: 'unknown',
                      confidence: 0.5,
                      description: 'Test',
                      severity: 'low',
                      suggestions: [],
                      isIntentional: false,
                      changeType: 'unknown',
                      reasoning: 'Test',
                    }),
                  },
                },
              ],
            }),
          },
        },
      };
      mockOpenAI.mockImplementation(() => mockOpenAIInstance);

      classifier = new AIVisualClassifier({
        provider: 'openai',
        apiKey: 'test-key',
      });

      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('optimized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);
    });

    it('should process multiple requests in batches', async () => {
      const requests: AIAnalysisRequest[] = [
        { baselineImage: mockImageBuffer, currentImage: mockImageBuffer },
        { baselineImage: mockImageBuffer, currentImage: mockImageBuffer },
        { baselineImage: mockImageBuffer, currentImage: mockImageBuffer },
        { baselineImage: mockImageBuffer, currentImage: mockImageBuffer },
      ];

      const results = await classifier.batchAnalyze(requests);

      expect(results).toHaveLength(4);
      expect(mockOpenAIInstance.chat.completions.create).toHaveBeenCalledTimes(4);
    });

    it('should handle empty request array', async () => {
      const results = await classifier.batchAnalyze([]);
      expect(results).toEqual([]);
    });
  });

  describe('Response Parsing and Validation', () => {
    let classifier: AIVisualClassifier;
    let mockOpenAIInstance: any;

    beforeEach(() => {
      mockOpenAIInstance = {
        chat: {
          completions: {
            create: jest.fn(),
          },
        },
      };
      mockOpenAI.mockImplementation(() => mockOpenAIInstance);

      classifier = new AIVisualClassifier({
        provider: 'openai',
        apiKey: 'test-key',
      });

      const mockSharpInstance = {
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080 }),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('optimized')),
      };
      mockSharp.mockReturnValue(mockSharpInstance as any);
    });

    it('should extract JSON from response with extra text', async () => {
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Here is the analysis:\n{"classification":"regression","confidence":0.9,"severity":"high","isIntentional":false,"changeType":"layout","reasoning":"Test"}',
            },
          },
        ],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);
      expect(result.classification).toBe('regression');
    });

    it('should normalize confidence scores outside 0-1 range', async () => {
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: '{"classification":"regression","confidence":1.5,"severity":"high","isIntentional":false,"changeType":"layout","reasoning":"Test"}',
            },
          },
        ],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);
      expect(result.confidence).toBe(1.0); // Clamped to 1.0
    });

    it('should validate and default invalid severity levels', async () => {
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: '{"classification":"unknown","confidence":0.5,"severity":"invalid","isIntentional":false,"changeType":"unknown","reasoning":"Test"}',
            },
          },
        ],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);
      expect(result.severity).toBe('medium'); // Default
    });

    it('should validate and default invalid change types', async () => {
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: '{"classification":"unknown","confidence":0.5,"severity":"low","isIntentional":false,"changeType":"invalid","reasoning":"Test"}',
            },
          },
        ],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);
      expect(result.changeType).toBe('unknown'); // Default
    });

    it('should handle malformed JSON gracefully', async () => {
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: 'This is not JSON at all!' } }],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);
      expect(result.classification).toBe('unknown');
      expect(result.confidence).toBe(0.5);
      expect(result.description).toContain('Failed to parse AI response');
    });

    it('should infer isIntentional from classification', async () => {
      mockOpenAIInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: '{"classification":"intentional","confidence":0.8,"severity":"low","changeType":"content","reasoning":"Test"}',
            },
          },
        ],
      });

      const request: AIAnalysisRequest = {
        baselineImage: mockImageBuffer,
        currentImage: mockImageBuffer,
      };

      const result = await classifier.analyzeChange(request);
      expect(result.isIntentional).toBe(true);
    });
  });

  describe('toVisualAnalysis()', () => {
    let classifier: AIVisualClassifier;

    beforeEach(() => {
      classifier = new AIVisualClassifier({
        provider: 'openai',
        apiKey: 'test-key',
      });
    });

    it('should convert AIAnalysisResponse to AIVisualAnalysis format', () => {
      const response: AIAnalysisResponse = {
        classification: 'regression',
        confidence: 0.95,
        description: 'Test description',
        severity: 'high',
        suggestions: ['Fix layout', 'Check CSS'],
        isIntentional: false,
        changeType: 'layout',
        reasoning: 'Test reasoning',
        regions: [
          {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            type: 'header',
            description: 'Header changed',
          },
        ],
      };

      const visualAnalysis = classifier.toVisualAnalysis(response);

      expect(visualAnalysis).toEqual({
        classification: 'regression',
        confidence: 0.95,
        description: 'Test description',
        severity: 'high',
        suggestions: ['Fix layout', 'Check CSS'],
        regions: response.regions,
      });
    });

    it('should handle undefined regions', () => {
      const response: AIAnalysisResponse = {
        classification: 'unknown',
        confidence: 0.5,
        description: 'Test',
        severity: 'medium',
        suggestions: [],
        isIntentional: false,
        changeType: 'unknown',
        reasoning: 'Test',
      };

      const visualAnalysis = classifier.toVisualAnalysis(response);

      expect(visualAnalysis.regions).toBeUndefined();
    });
  });
});
