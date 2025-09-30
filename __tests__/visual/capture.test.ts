import { Page } from 'playwright';
import { VisualCaptureEngine } from '../../src/visual/capture';
import { CaptureConfig, CaptureResult } from '../../src/visual/types';
import * as fs from 'fs';
import * as path from 'path';

// Mock dependencies
jest.mock('sharp');
jest.mock('fs');
jest.mock('path');

describe('VisualCaptureEngine', () => {
  let captureEngine: VisualCaptureEngine;
  let mockPage: jest.Mocked<Page>;

  beforeEach(() => {
    // Create mock page with screenshot capabilities
    mockPage = {
      screenshot: jest.fn(),
      title: jest.fn(),
      url: jest.fn(),
      evaluate: jest.fn(),
      waitForLoadState: jest.fn(),
      waitForTimeout: jest.fn(),
      addStyleTag: jest.fn(),
      locator: jest.fn(),
      getByRole: jest.fn(),
      waitForFunction: jest.fn(),
    } as any;

    captureEngine = new VisualCaptureEngine();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('capture()', () => {
    it('should capture a basic screenshot with default config', async () => {
      // Arrange
      const mockBuffer = Buffer.from('fake-image-data');
      mockPage.screenshot.mockResolvedValue(mockBuffer);
      mockPage.url.mockReturnValue('https://example.com');
      mockPage.title.mockResolvedValue('Example Page');
      mockPage.evaluate.mockResolvedValue({ width: 1920, height: 1080 });

      const config: CaptureConfig = {
        selector: undefined,
        fullPage: false,
        maskSelectors: [],
        stabilizeMs: 0,
        disableAnimations: false,
      };

      // Act
      const result = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result).toMatchObject({
        success: true,
        buffer: mockBuffer,
        metadata: {
          url: 'https://example.com',
          title: 'Example Page',
          fullPage: false,
          viewport: expect.any(Object),
          hash: expect.any(String),
          timestamp: expect.any(Number),
        },
      });

      expect(mockPage.screenshot).toHaveBeenCalledWith({
        fullPage: false,
        animations: 'allow',
      });
    });

    it('should capture full page screenshot when configured', async () => {
      // Arrange
      const mockBuffer = Buffer.from('fake-full-page-data');
      mockPage.screenshot.mockResolvedValue(mockBuffer);
      mockPage.url.mockReturnValue('https://example.com/page');
      mockPage.title.mockResolvedValue('Page Title');
      mockPage.evaluate.mockResolvedValue({ width: 1920, height: 1080 });

      const config: CaptureConfig = {
        fullPage: true,
        maskSelectors: [],
        stabilizeMs: 0,
        disableAnimations: false,
      };

      // Act
      const result = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result.success).toBe(true);
      expect(result.metadata.fullPage).toBe(true);
      expect(mockPage.screenshot).toHaveBeenCalledWith({
        fullPage: true,
        animations: 'allow',
      });
    });

    it('should capture element screenshot when selector provided', async () => {
      // Arrange
      const mockBuffer = Buffer.from('fake-element-data');
      const mockLocator = {
        screenshot: jest.fn().mockResolvedValue(mockBuffer),
        waitFor: jest.fn(),
      };
      mockPage.locator.mockReturnValue(mockLocator as any);
      mockPage.url.mockReturnValue('https://example.com');
      mockPage.title.mockResolvedValue('Example');
      mockPage.evaluate.mockResolvedValue({ width: 1920, height: 1080 });

      const config: CaptureConfig = {
        selector: '#main-content',
        fullPage: false,
        maskSelectors: [],
        stabilizeMs: 0,
        disableAnimations: false,
      };

      // Act
      const result = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result.success).toBe(true);
      expect(result.buffer).toBe(mockBuffer);
      expect(mockPage.locator).toHaveBeenCalledWith('#main-content');
      expect(mockLocator.waitFor).toHaveBeenCalledWith({ state: 'visible' });
      expect(mockLocator.screenshot).toHaveBeenCalled();
    });

    it('should stabilize page when stabilizeMs > 0', async () => {
      // Arrange
      const mockBuffer = Buffer.from('fake-stabilized-data');
      mockPage.screenshot.mockResolvedValue(mockBuffer);
      mockPage.url.mockReturnValue('https://example.com');
      mockPage.waitForLoadState.mockResolvedValue();
      mockPage.waitForTimeout.mockResolvedValue();
      mockPage.waitForFunction.mockResolvedValue(true);

      const config: CaptureConfig = {
        fullPage: false,
        maskSelectors: [],
        stabilizeMs: 500,
        disableAnimations: false,
      };

      // Act
      const result = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result.success).toBe(true);
      expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle');
      expect(mockPage.waitForFunction).toHaveBeenCalled(); // Font loading check
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(500);
    });

    it('should disable animations when configured', async () => {
      // Arrange
      const mockBuffer = Buffer.from('fake-no-animation-data');
      mockPage.screenshot.mockResolvedValue(mockBuffer);
      mockPage.url.mockReturnValue('https://example.com');
      mockPage.addStyleTag.mockResolvedValue({} as any);

      const config: CaptureConfig = {
        fullPage: false,
        maskSelectors: [],
        stabilizeMs: 0,
        disableAnimations: true,
      };

      // Act
      const result = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result.success).toBe(true);
      expect(mockPage.addStyleTag).toHaveBeenCalledWith({
        content: expect.stringContaining('animation-duration: 0s'),
      });
      expect(mockPage.screenshot).toHaveBeenCalledWith({
        fullPage: false,
        animations: 'disabled',
      });
    });

    it('should mask elements when maskSelectors provided', async () => {
      // Arrange
      const mockBuffer = Buffer.from('fake-masked-data');
      mockPage.screenshot.mockResolvedValue(mockBuffer);
      mockPage.url.mockReturnValue('https://example.com');
      mockPage.addStyleTag.mockResolvedValue({} as any);

      const config: CaptureConfig = {
        fullPage: false,
        maskSelectors: ['.dynamic-content', '[data-timestamp]'],
        stabilizeMs: 0,
        disableAnimations: false,
      };

      // Act
      const result = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result.success).toBe(true);
      expect(mockPage.addStyleTag).toHaveBeenCalledWith({
        content: expect.stringContaining('.dynamic-content, [data-timestamp]'),
      });
    });

    it('should handle screenshot failures gracefully', async () => {
      // Arrange
      mockPage.screenshot.mockRejectedValue(new Error('Screenshot failed'));
      mockPage.url.mockReturnValue('https://example.com');

      const config: CaptureConfig = {
        fullPage: false,
        maskSelectors: [],
        stabilizeMs: 0,
        disableAnimations: false,
      };

      // Act
      const result = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Screenshot failed');
      expect(result.buffer).toBeUndefined();
    });

    it('should generate unique hash for each screenshot', async () => {
      // Arrange
      const mockBuffer1 = Buffer.from('fake-image-1');
      const mockBuffer2 = Buffer.from('fake-image-2');
      mockPage.url.mockReturnValue('https://example.com');

      const config: CaptureConfig = {
        fullPage: false,
        maskSelectors: [],
        stabilizeMs: 0,
        disableAnimations: false,
      };

      // Act
      mockPage.screenshot.mockResolvedValueOnce(mockBuffer1);
      const result1 = await captureEngine.capture(mockPage, config);

      mockPage.screenshot.mockResolvedValueOnce(mockBuffer2);
      const result2 = await captureEngine.capture(mockPage, config);

      // Assert
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.metadata.hash).not.toBe(result2.metadata.hash);
    });
  });

  describe('captureMultiple()', () => {
    it('should capture multiple screenshots with different configs', async () => {
      // Arrange
      const mockBuffer1 = Buffer.from('fake-image-1');
      const mockBuffer2 = Buffer.from('fake-image-2');
      mockPage.screenshot.mockResolvedValueOnce(mockBuffer1);
      mockPage.screenshot.mockResolvedValueOnce(mockBuffer2);
      mockPage.url.mockReturnValue('https://example.com');

      const configs: CaptureConfig[] = [
        { fullPage: false, maskSelectors: [], stabilizeMs: 0, disableAnimations: false },
        { fullPage: true, maskSelectors: [], stabilizeMs: 0, disableAnimations: false },
      ];

      // Act
      const results = await captureEngine.captureMultiple(mockPage, configs);

      // Assert
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[0].buffer).toBe(mockBuffer1);
      expect(results[1].buffer).toBe(mockBuffer2);
    });

    it('should handle partial failures in multiple captures', async () => {
      // Arrange
      const mockBuffer = Buffer.from('fake-image');
      mockPage.screenshot
        .mockResolvedValueOnce(mockBuffer)
        .mockRejectedValueOnce(new Error('Second capture failed'));
      mockPage.url.mockReturnValue('https://example.com');

      const configs: CaptureConfig[] = [
        { fullPage: false, maskSelectors: [], stabilizeMs: 0, disableAnimations: false },
        { fullPage: true, maskSelectors: [], stabilizeMs: 0, disableAnimations: false },
      ];

      // Act
      const results = await captureEngine.captureMultiple(mockPage, configs);

      // Assert
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('Second capture failed');
    });
  });

  describe('generateMetadata()', () => {
    it('should generate complete metadata for a capture', async () => {
      // Arrange
      const mockBuffer = Buffer.from('test-image-data');
      mockPage.url.mockReturnValue('https://example.com/test');
      mockPage.title.mockResolvedValue('Test Page');
      mockPage.evaluate.mockResolvedValue({ width: 1920, height: 1080 });

      // Act
      const metadata = await captureEngine.generateMetadata(mockPage, mockBuffer, {
        fullPage: true,
        maskSelectors: ['.dynamic'],
        stabilizeMs: 500,
        disableAnimations: true,
      });

      // Assert
      expect(metadata).toMatchObject({
        url: 'https://example.com/test',
        title: 'Test Page',
        fullPage: true,
        viewport: { width: 1920, height: 1080 },
        hash: expect.any(String),
        timestamp: expect.any(Number),
        maskSelectors: ['.dynamic'],
        stabilizeMs: 500,
        disableAnimations: true,
      });
    });
  });

  describe('generateHash()', () => {
    it('should generate consistent hash for same buffer', () => {
      // Arrange
      const buffer = Buffer.from('test-data');

      // Act
      const hash1 = captureEngine.generateHash(buffer);
      const hash2 = captureEngine.generateHash(buffer);

      // Assert
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex format
    });

    it('should generate different hashes for different buffers', () => {
      // Arrange
      const buffer1 = Buffer.from('test-data-1');
      const buffer2 = Buffer.from('test-data-2');

      // Act
      const hash1 = captureEngine.generateHash(buffer1);
      const hash2 = captureEngine.generateHash(buffer2);

      // Assert
      expect(hash1).not.toBe(hash2);
    });
  });
});