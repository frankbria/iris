import { VisualDiffEngine } from '../../src/visual/diff';
import { DiffOptions, DiffResult, DiffAnalysis } from '../../src/visual/types';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

// Mock dependencies
jest.mock('pixelmatch');
jest.mock('sharp');
jest.mock('image-ssim');

const mockPixelmatch = pixelmatch as jest.MockedFunction<typeof pixelmatch>;

describe('VisualDiffEngine', () => {
  let diffEngine: VisualDiffEngine;

  const mockBaselineBuffer = Buffer.from('baseline-image-data');
  const mockCurrentBuffer = Buffer.from('current-image-data');
  const mockDiffBuffer = Buffer.from('diff-image-data');

  beforeEach(() => {
    diffEngine = new VisualDiffEngine();
    jest.clearAllMocks();

    // Create a proper Sharp mock that returns chain-able methods
    const mockSharpInstance = {
      raw: jest.fn().mockReturnThis(),
      ensureAlpha: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-image')),
      metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080, channels: 4 }),
      png: jest.fn().mockReturnThis(),
    };

    // Mock the sharp function to return our instance
    (sharp as jest.MockedFunction<any>).mockReturnValue(mockSharpInstance);

    // Setup image-ssim mock
    const mockImageSsim = require('image-ssim');
    mockImageSsim.mockResolvedValue = jest.fn();
    mockImageSsim.mockRejectedValue = jest.fn();
  });

  describe('compare()', () => {
    it('should perform pixel comparison and return diff result', async () => {
      // Arrange
      mockPixelmatch.mockReturnValue(1500); // 1500 different pixels

      const options: DiffOptions = {
        threshold: 0.1,
        includeAA: false,
        alpha: 0.1,
        diffMask: true,
        diffColor: [255, 0, 0],
      };

      // Act
      const result = await diffEngine.compare(mockBaselineBuffer, mockCurrentBuffer, options);

      // Debug output
      console.log('Test result:', result);

      // Assert
      expect(result.success).toBe(true);
      expect(result.pixelDifference).toBe(1500);
      expect(result.similarity).toBeCloseTo(0.9992, 3); // (1920*1080 - 1500) / (1920*1080)
      expect(result.threshold).toBe(0.1);
      expect(result.passed).toBe(true); // similarity > threshold
      expect(result.diffBuffer).toBeDefined();
      expect(mockPixelmatch).toHaveBeenCalled();
    });

    it('should fail comparison when similarity below threshold', async () => {
      // Arrange
      mockPixelmatch.mockReturnValue(300000); // Many different pixels

      const options: DiffOptions = {
        threshold: 0.9, // Higher than the expected similarity
        includeAA: false,
        alpha: 0.1,
        diffMask: true,
        diffColor: [255, 0, 0],
      };

      // Act
      const result = await diffEngine.compare(mockBaselineBuffer, mockCurrentBuffer, options);

      // Assert
      expect(result.success).toBe(true);
      expect(result.pixelDifference).toBe(300000);
      expect(result.similarity).toBeLessThan(0.9);
      expect(result.passed).toBe(false);
    });

    it('should handle images with different dimensions', async () => {
      // Arrange
      const mockSharp = {
        raw: jest.fn().mockReturnThis(),
        ensureAlpha: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-image')),
        metadata: jest.fn()
          .mockResolvedValueOnce({ width: 1920, height: 1080, channels: 4 })
          .mockResolvedValueOnce({ width: 1024, height: 768, channels: 4 }),
      };
      (sharp as any).mockReturnValue(mockSharp);

      const options: DiffOptions = {
        threshold: 0.1,
        includeAA: false,
        alpha: 0.1,
        diffMask: true,
        diffColor: [255, 0, 0],
      };

      // Act
      const result = await diffEngine.compare(mockBaselineBuffer, mockCurrentBuffer, options);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('dimension mismatch');
    });

    it('should handle comparison errors gracefully', async () => {
      // Arrange
      mockPixelmatch.mockImplementation(() => {
        throw new Error('Pixelmatch failed');
      });

      const options: DiffOptions = {
        threshold: 0.1,
        includeAA: false,
        alpha: 0.1,
        diffMask: true,
        diffColor: [255, 0, 0],
      };

      // Act
      const result = await diffEngine.compare(mockBaselineBuffer, mockCurrentBuffer, options);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Pixelmatch failed');
    });
  });

  describe('ssimCompare()', () => {
    it.skip('should perform SSIM comparison', async () => {
      // TODO: Fix SSIM mock setup
    });

    it.skip('should handle SSIM errors gracefully', async () => {
      // TODO: Fix SSIM mock setup
    });
  });

  describe('analyzeRegions()', () => {
    it('should identify significant change regions', async () => {
      // Arrange
      const diffBuffer = Buffer.alloc(1920 * 1080 * 4); // RGBA buffer
      // Simulate a significant change in the top-left area
      for (let i = 0; i < 100 * 100 * 4; i += 4) {
        diffBuffer[i] = 255; // Red channel indicates change
        diffBuffer[i + 1] = 0;
        diffBuffer[i + 2] = 0;
        diffBuffer[i + 3] = 255;
      }

      // Act
      const regions = await diffEngine.analyzeRegions(diffBuffer, 1920, 1080);

      // Assert
      expect(regions).toHaveLength(1);
      expect(regions[0]).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
        significance: expect.any(Number),
      });
      expect(regions[0].significance).toBeGreaterThan(0);
    });

    it('should return empty array when no significant regions found', async () => {
      // Arrange
      const diffBuffer = Buffer.alloc(1920 * 1080 * 4, 0); // All black = no diff

      // Act
      const regions = await diffEngine.analyzeRegions(diffBuffer, 1920, 1080);

      // Assert
      expect(regions).toHaveLength(0);
    });
  });

  describe('classifyChange()', () => {
    it('should classify layout changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.85,
        pixelDifference: 50000,
        regions: [
          { x: 0, y: 0, width: 200, height: 1080, significance: 0.8 },
        ],
        classification: 'unknown',
      };

      // Act
      const classification = diffEngine.classifyChange(analysis);

      // Assert
      expect(classification).toBe('layout');
    });

    it('should classify content changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.92,
        pixelDifference: 15000,
        regions: [
          { x: 500, y: 300, width: 300, height: 100, significance: 0.6 },
        ],
        classification: 'unknown',
      };

      // Act
      const classification = diffEngine.classifyChange(analysis);

      // Assert
      expect(classification).toBe('content');
    });

    it('should classify styling changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.96,
        pixelDifference: 5000,
        regions: [
          { x: 100, y: 100, width: 50, height: 50, significance: 0.3 },
          { x: 200, y: 200, width: 50, height: 50, significance: 0.3 },
        ],
        classification: 'unknown',
      };

      // Act
      const classification = diffEngine.classifyChange(analysis);

      // Assert
      expect(classification).toBe('styling');
    });

    it('should classify animation changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.98,
        pixelDifference: 2000,
        regions: [
          { x: 400, y: 400, width: 100, height: 100, significance: 0.2 },
        ],
        classification: 'unknown',
      };

      // Act
      const classification = diffEngine.classifyChange(analysis);

      // Assert
      expect(classification).toBe('animation');
    });
  });

  describe('getSeverity()', () => {
    it('should return critical severity for major layout changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.70,
        pixelDifference: 500000,
        regions: [
          { x: 0, y: 0, width: 1920, height: 500, significance: 0.9 },
        ],
        classification: 'layout',
      };

      // Act
      const severity = diffEngine.getSeverity(analysis);

      // Assert
      expect(severity).toBe('critical');
    });

    it('should return high severity for significant content changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.82,
        pixelDifference: 100000,
        regions: [
          { x: 200, y: 200, width: 600, height: 400, significance: 0.7 },
        ],
        classification: 'content',
      };

      // Act
      const severity = diffEngine.getSeverity(analysis);

      // Assert
      expect(severity).toBe('high');
    });

    it('should return medium severity for moderate styling changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.91,
        pixelDifference: 25000,
        regions: [
          { x: 100, y: 100, width: 200, height: 100, significance: 0.5 },
        ],
        classification: 'styling',
      };

      // Act
      const severity = diffEngine.getSeverity(analysis);

      // Assert
      expect(severity).toBe('medium');
    });

    it('should return low severity for minor animation changes', () => {
      // Arrange
      const analysis: DiffAnalysis = {
        similarity: 0.97,
        pixelDifference: 5000,
        regions: [
          { x: 500, y: 500, width: 50, height: 50, significance: 0.2 },
        ],
        classification: 'animation',
      };

      // Act
      const severity = diffEngine.getSeverity(analysis);

      // Assert
      expect(severity).toBe('low');
    });
  });

  describe('prepareImage()', () => {
    it('should prepare image buffer for comparison', async () => {
      // Arrange
      const inputBuffer = Buffer.from('input-image');

      // Act
      const result = await diffEngine.prepareImage(inputBuffer);

      // Assert
      expect(result.buffer).toBeDefined();
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.channels).toBe(4);
    });

    it('should handle image preparation errors', async () => {
      // Arrange
      const mockSharp = {
        raw: jest.fn().mockReturnThis(),
        ensureAlpha: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockRejectedValue(new Error('Sharp processing failed')),
        metadata: jest.fn().mockResolvedValue({ width: 1920, height: 1080, channels: 4 }),
      };
      (sharp as any).mockReturnValue(mockSharp);

      // Act & Assert
      await expect(diffEngine.prepareImage(mockBaselineBuffer)).rejects.toThrow('Sharp processing failed');
    });
  });

  describe('generateDiffImage()', () => {
    it('should generate diff visualization image', async () => {
      // Arrange
      const diffData = Buffer.alloc(1920 * 1080 * 4);
      const mockSharp = {
        raw: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(mockDiffBuffer),
      };
      (sharp as any).mockReturnValue(mockSharp);

      // Act
      const result = await diffEngine.generateDiffImage(diffData, 1920, 1080);

      // Assert
      expect(result).toBe(mockDiffBuffer);
    });
  });
});