import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import * as crypto from 'crypto';
const imageSsim = require('image-ssim');
import { DiffOptions, DiffResult, DiffAnalysis, PreparedImage, SSIMResult } from './types';

/**
 * VisualDiffEngine handles pixel-level and semantic comparison of images
 */
export class VisualDiffEngine {
  private diffCache: Map<string, DiffResult> = new Map();
  private cacheEnabled: boolean = true;
  private maxCacheSize: number = 100;
  private maxImageSize: number = 10 * 1024 * 1024; // 10MB max per image
  private memoryThreshold: number = 100 * 1024 * 1024; // 100MB total memory threshold
  /**
   * Compare two images using pixel matching
   */
  async compare(baselineBuffer: Buffer, currentBuffer: Buffer, options: DiffOptions): Promise<DiffResult> {
    try {
      // Memory management: check image sizes
      if (baselineBuffer.length > this.maxImageSize || currentBuffer.length > this.maxImageSize) {
        return {
          success: false,
          passed: false,
          similarity: 0,
          pixelDifference: 0,
          threshold: options.threshold,
          error: `Image size exceeds maximum allowed (${this.maxImageSize / (1024 * 1024)}MB)`,
        };
      }

      // Check available memory and clear cache if needed
      const memoryUsage = process.memoryUsage();
      if (memoryUsage.heapUsed > this.memoryThreshold) {
        this.clearCache();
        if (global.gc) {
          global.gc(); // Force garbage collection if available
        }
      }

      // Check cache first
      if (this.cacheEnabled) {
        const cacheKey = this.generateCacheKey(baselineBuffer, currentBuffer, options);
        const cached = this.diffCache.get(cacheKey);
        if (cached) {
          return cached;
        }
      }

      // Prepare images for comparison
      const baseline = await this.prepareImage(baselineBuffer);
      const current = await this.prepareImage(currentBuffer);

      // Check dimensions match
      if (baseline.width !== current.width || baseline.height !== current.height) {
        return {
          success: false,
          passed: false,
          similarity: 0,
          pixelDifference: 0,
          threshold: options.threshold,
          error: `Image dimension mismatch: baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}`,
        };
      }

      // Create diff buffer
      const diffBuffer = Buffer.alloc(baseline.width * baseline.height * 4);

      // Early exit optimization: sample a subset of pixels first for large images
      const totalPixels = baseline.width * baseline.height;
      const isLargeImage = totalPixels > 1920 * 1080; // > Full HD

      if (isLargeImage) {
        // Sample 10% of pixels for quick check
        const sampleSize = Math.floor(totalPixels * 0.1);
        let sampleDiff = 0;

        for (let i = 0; i < sampleSize; i++) {
          const pixelIndex = Math.floor(Math.random() * totalPixels);
          const bufferIndex = pixelIndex * 4;

          // Simple RGB difference check
          const rDiff = Math.abs(baseline.buffer[bufferIndex] - current.buffer[bufferIndex]);
          const gDiff = Math.abs(baseline.buffer[bufferIndex + 1] - current.buffer[bufferIndex + 1]);
          const bDiff = Math.abs(baseline.buffer[bufferIndex + 2] - current.buffer[bufferIndex + 2]);

          if (rDiff > 10 || gDiff > 10 || bDiff > 10) {
            sampleDiff++;
          }
        }

        const sampleSimilarity = (sampleSize - sampleDiff) / sampleSize;

        // If sample shows large difference, exit early
        if (sampleSimilarity < 0.7) {
          return {
            success: true,
            passed: false,
            similarity: sampleSimilarity,
            pixelDifference: Math.floor((1 - sampleSimilarity) * totalPixels),
            threshold: options.threshold,
            diffBuffer: Buffer.alloc(0), // Don't generate diff for obviously different images
            earlyExit: true,
          } as any;
        }
      }

      // Perform pixel comparison
      const pixelDifference = pixelmatch(
        baseline.buffer,
        current.buffer,
        diffBuffer,
        baseline.width,
        baseline.height,
        {
          threshold: options.alpha,
          includeAA: options.includeAA,
          alpha: options.alpha,
          aaColor: options.diffColor,
          diffColor: options.diffColor,
          diffMask: options.diffMask,
        }
      );

      // Calculate similarity
      const similarity = (totalPixels - pixelDifference) / totalPixels;
      const passed = similarity >= options.threshold;

      // Generate diff image
      const diffImageBuffer = await this.generateDiffImage(diffBuffer, baseline.width, baseline.height);

      const result = {
        success: true,
        passed,
        similarity,
        pixelDifference,
        threshold: options.threshold,
        diffBuffer: diffImageBuffer,
      };

      // Store in cache
      if (this.cacheEnabled) {
        const cacheKey = this.generateCacheKey(baselineBuffer, currentBuffer, options);
        this.addToCache(cacheKey, result);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        passed: false,
        similarity: 0,
        pixelDifference: 0,
        threshold: options.threshold,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Compare two images using SSIM (Structural Similarity Index)
   */
  async ssimCompare(baselineBuffer: Buffer, currentBuffer: Buffer): Promise<SSIMResult> {
    try {
      const result = await imageSsim(baselineBuffer, currentBuffer);
      return {
        success: true,
        ssim: result.ssim,
        mcs: result.mcs,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Analyze regions of difference in the diff buffer
   */
  async analyzeRegions(
    diffBuffer: Buffer,
    width: number,
    height: number
  ): Promise<Array<{ x: number; y: number; width: number; height: number; significance: number }>> {
    const regions: Array<{ x: number; y: number; width: number; height: number; significance: number }> = [];
    const visited = new Set<number>();
    const minRegionSize = 100; // Minimum pixels for a significant region

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const pixelIndex = y * width + x;

        // Skip if already visited or pixel is not different (red channel = 0)
        if (visited.has(pixelIndex) || diffBuffer[index] === 0) {
          continue;
        }

        // Flood fill to find connected region
        const region = this.floodFillRegion(diffBuffer, width, height, x, y, visited);

        if (region.pixels.length >= minRegionSize) {
          const bounds = this.calculateRegionBounds(region.pixels, width);
          const significance = Math.min(region.pixels.length / (width * height), 1.0);

          regions.push({
            x: bounds.minX,
            y: bounds.minY,
            width: bounds.maxX - bounds.minX + 1,
            height: bounds.maxY - bounds.minY + 1,
            significance,
          });
        }
      }
    }

    return regions;
  }

  /**
   * Classify the type of visual change based on analysis
   */
  classifyChange(analysis: DiffAnalysis): 'layout' | 'content' | 'styling' | 'animation' | 'unknown' {
    const { similarity, regions } = analysis;

    // Layout changes: large regions spanning significant width/height
    const hasLargeRegions = regions.some(r =>
      (r.width > 500 || r.height > 500) && r.significance > 0.5
    );

    if (similarity < 0.9 && hasLargeRegions) {
      return 'layout';
    }

    // Content changes: medium-sized focused regions
    const hasContentRegions = regions.some(r =>
      r.width > 100 && r.width < 800 &&
      r.height > 50 && r.height < 600 &&
      r.significance > 0.4
    );

    if (similarity < 0.95 && hasContentRegions) {
      return 'content';
    }

    // Styling changes: small distributed regions
    const hasSmallRegions = regions.length > 1 &&
      regions.every(r => r.width < 200 && r.height < 200);

    if (similarity < 0.98 && hasSmallRegions) {
      return 'styling';
    }

    // Animation changes: very small regions with high similarity
    if (similarity > 0.95 && regions.length > 0) {
      return 'animation';
    }

    return 'unknown';
  }

  /**
   * Determine severity level of visual changes
   */
  getSeverity(analysis: DiffAnalysis): 'low' | 'medium' | 'high' | 'critical' {
    const { similarity, pixelDifference, classification } = analysis;

    // Critical: Major layout changes or very low similarity
    if (similarity < 0.8 || (classification === 'layout' && pixelDifference > 300000)) {
      return 'critical';
    }

    // High: Significant content changes
    if (similarity < 0.9 || (classification === 'content' && pixelDifference > 50000)) {
      return 'high';
    }

    // Medium: Moderate styling changes
    if (similarity < 0.95 || (classification === 'styling' && pixelDifference > 10000)) {
      return 'medium';
    }

    // Low: Minor changes or animations
    return 'low';
  }

  /**
   * Prepare image buffer for comparison by normalizing format
   */
  async prepareImage(buffer: Buffer): Promise<PreparedImage> {
    const image = sharp(buffer);
    const metadata = await image.metadata();

    const processedBuffer = await image
      .raw()
      .ensureAlpha()
      .toBuffer();

    return {
      buffer: processedBuffer,
      width: metadata.width!,
      height: metadata.height!,
      channels: 4, // RGBA
    };
  }

  /**
   * Generate PNG image from diff buffer
   */
  async generateDiffImage(diffBuffer: Buffer, width: number, height: number): Promise<Buffer> {
    return sharp(diffBuffer, {
      raw: {
        width,
        height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();
  }

  /**
   * Flood fill algorithm to find connected regions of difference
   */
  private floodFillRegion(
    diffBuffer: Buffer,
    width: number,
    height: number,
    startX: number,
    startY: number,
    visited: Set<number>
  ): { pixels: number[] } {
    const pixels: number[] = [];
    const stack: Array<{ x: number; y: number }> = [{ x: startX, y: startY }];

    while (stack.length > 0) {
      const { x, y } = stack.pop()!;
      const pixelIndex = y * width + x;

      if (x < 0 || x >= width || y < 0 || y >= height || visited.has(pixelIndex)) {
        continue;
      }

      const bufferIndex = (y * width + x) * 4;
      // Check if pixel shows a difference (red channel > 0)
      if (diffBuffer[bufferIndex] === 0) {
        continue;
      }

      visited.add(pixelIndex);
      pixels.push(pixelIndex);

      // Add neighboring pixels
      stack.push(
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 }
      );
    }

    return { pixels };
  }

  /**
   * Calculate bounding box for a region
   */
  private calculateRegionBounds(
    pixels: number[],
    width: number
  ): { minX: number; maxX: number; minY: number; maxY: number } {
    let minX = width;
    let maxX = 0;
    let minY = Infinity;
    let maxY = 0;

    for (const pixelIndex of pixels) {
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    return { minX, maxX, minY, maxY };
  }

  /**
   * Generate cache key from image buffers and options
   */
  private generateCacheKey(baselineBuffer: Buffer, currentBuffer: Buffer, options: DiffOptions): string {
    const baselineHash = crypto.createHash('sha256').update(baselineBuffer).digest('hex').substring(0, 16);
    const currentHash = crypto.createHash('sha256').update(currentBuffer).digest('hex').substring(0, 16);
    const optionsHash = crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex').substring(0, 8);
    return `${baselineHash}-${currentHash}-${optionsHash}`;
  }

  /**
   * Add result to cache with size management
   */
  private addToCache(key: string, result: DiffResult): void {
    // Implement LRU eviction if cache is full
    if (this.diffCache.size >= this.maxCacheSize) {
      // Remove oldest entry (first in Map)
      const firstKey = this.diffCache.keys().next().value;
      if (firstKey) {
        this.diffCache.delete(firstKey);
      }
    }
    this.diffCache.set(key, result);
  }

  /**
   * Clear the diff cache
   */
  clearCache(): void {
    this.diffCache.clear();
  }

  /**
   * Enable or disable caching
   */
  setCacheEnabled(enabled: boolean): void {
    this.cacheEnabled = enabled;
    if (!enabled) {
      this.clearCache();
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; enabled: boolean } {
    return {
      size: this.diffCache.size,
      maxSize: this.maxCacheSize,
      enabled: this.cacheEnabled,
    };
  }

  /**
   * Set memory limits for image processing
   */
  setMemoryLimits(maxImageSize: number, memoryThreshold: number): void {
    this.maxImageSize = maxImageSize;
    this.memoryThreshold = memoryThreshold;
  }

  /**
   * Get current memory usage statistics
   */
  getMemoryStats(): {
    heapUsed: number;
    heapTotal: number;
    external: number;
    threshold: number;
    maxImageSize: number;
  } {
    const memoryUsage = process.memoryUsage();
    return {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      external: memoryUsage.external,
      threshold: this.memoryThreshold,
      maxImageSize: this.maxImageSize,
    };
  }

  /**
   * Force cleanup of resources and garbage collection
   */
  forceCleanup(): void {
    this.clearCache();
    if (global.gc) {
      global.gc();
    }
  }
}