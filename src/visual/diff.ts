import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import * as crypto from 'crypto';
import * as imageSsim from '../vendor/image-ssim';
import { DiffOptions, DiffResult, DiffAnalysis, PreparedImage, SSIMResult } from './types';

/**
 * Most pixels `compare()` will decode from one image (#282). Decoding is RGBA, 4 bytes a
 * pixel, and a full-page capture has no height ceiling of its own: this is the hosted
 * `MAX_PAGE_HEIGHT` (16384) at desktop width, about 126 MB per decoded image.
 */
export const MAX_DECODED_PIXELS = 1920 * 16_384;

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
  async compare(
    baselineBuffer: Buffer,
    currentBuffer: Buffer,
    options: DiffOptions,
  ): Promise<DiffResult> {
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

      // Sizes from the headers first: the canvas a size change needs is checked before
      // either image is decoded, and it is at least as large as each image (#282).
      const [b, c] = await Promise.all([headerSize(baselineBuffer), headerSize(currentBuffer)]);
      assertDecodable(Math.max(b.width, c.width), Math.max(b.height, c.height));

      // Prepare images for comparison
      const baseline = await this.prepareImage(baselineBuffer);
      const current = await this.prepareImage(currentBuffer);

      // A full-page capture whose page grew or shrank (#282): diff what both show.
      if (baseline.width !== current.width || baseline.height !== current.height) {
        return await this.compareResized(baseline, current, options);
      }

      // Create diff buffer
      const diffBuffer = Buffer.alloc(baseline.width * baseline.height * 4);

      const totalPixels = baseline.width * baseline.height;

      // Perform pixel comparison
      const pixelDifference = pixelmatch(
        baseline.buffer,
        current.buffer,
        diffBuffer,
        baseline.width,
        baseline.height,
        {
          threshold: options.pixelThreshold ?? 0.1,
          includeAA: options.includeAA,
          alpha: options.alpha,
          aaColor: options.diffColor,
          diffColor: options.diffColor,
          diffMask: options.diffMask,
        },
      );

      // Calculate similarity
      const similarity = (totalPixels - pixelDifference) / totalPixels;
      // threshold is the maximum allowed fraction of differing pixels
      // (default 0.1 = up to 10% of pixels may differ before failing)
      const passed = pixelDifference / totalPixels <= options.threshold;

      // Generate diff image
      const diffImageBuffer = await this.generateDiffImage(
        diffBuffer,
        baseline.width,
        baseline.height,
      );

      const result: DiffResult = {
        success: true,
        passed,
        similarity,
        pixelDifference,
        threshold: options.threshold,
        diffBuffer: diffImageBuffer,
        // Only on failures: a structural score is what tells a reviewer whether
        // the regression is a layout shift or a recolour, and it is worth
        // nothing on a comparison that already passed. Both images are already
        // decoded to RGBA above, so this reuses them rather than paying sharp a
        // second time (issue #77).
        ...(passed ? {} : this.structuralScore(baseline, current)),
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
   * SSIM over images `compare()` has already decoded.
   *
   * Returns an empty object rather than throwing: the structural score is
   * supplementary, so losing it must never downgrade a real pixel verdict into
   * an error result.
   */
  private structuralScore(
    baseline: PreparedImage,
    current: PreparedImage,
  ): { ssim?: number; mcs?: number } {
    try {
      const toImage = (image: PreparedImage) => ({
        data: image.buffer,
        width: image.width,
        height: image.height,
        channels: image.channels,
      });
      const { ssim, mcs } = imageSsim.compare(toImage(baseline), toImage(current));
      return { ssim, mcs };
    } catch {
      return {};
    }
  }

  /**
   * Compare two images using SSIM (Structural Similarity Index)
   */
  async ssimCompare(baselineBuffer: Buffer, currentBuffer: Buffer): Promise<SSIMResult> {
    try {
      // image-ssim.compare() is synchronous and needs decoded RGBA pixel data,
      // not raw PNG buffers — decode both images to {data,width,height,channels} first.
      const toImage = async (buffer: Buffer) => {
        const image = sharp(buffer).raw().ensureAlpha();
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height) {
          throw new Error('Invalid image: missing dimensions in metadata');
        }
        const data = await image.toBuffer();
        return { data, width: metadata.width, height: metadata.height, channels: 4 };
      };

      const baseline = await toImage(baselineBuffer);
      const current = await toImage(currentBuffer);
      const result = imageSsim.compare(baseline, current);

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
    height: number,
  ): Promise<Array<{ x: number; y: number; width: number; height: number; significance: number }>> {
    const regions: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      significance: number;
    }> = [];
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
  classifyChange(
    analysis: DiffAnalysis,
  ): 'layout' | 'content' | 'styling' | 'animation' | 'unknown' {
    const { similarity, regions } = analysis;

    // Layout changes: large regions spanning significant width/height
    const hasLargeRegions = regions.some(
      (r) => (r.width > 500 || r.height > 500) && r.significance > 0.5,
    );

    if (similarity < 0.9 && hasLargeRegions) {
      return 'layout';
    }

    // Content changes: medium-sized focused regions
    const hasContentRegions = regions.some(
      (r) =>
        r.width > 100 && r.width < 800 && r.height > 50 && r.height < 600 && r.significance > 0.4,
    );

    if (similarity < 0.95 && hasContentRegions) {
      return 'content';
    }

    // Styling changes: small distributed regions
    const hasSmallRegions =
      regions.length > 1 && regions.every((r) => r.width < 200 && r.height < 200);

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
   * Compare images of different sizes (#282): pixelmatch over the overlap, and every
   * pixel of the larger canvas outside it counted as changed and painted `diffColor`.
   *
   * Not by padding and letting pixelmatch judge: it blends alpha against white, so a
   * transparent pad beside a white page would read as unchanged. A size change never
   * passes; no SSIM (it needs equal sizes) and no sampled early exit.
   */
  private async compareResized(
    baseline: PreparedImage,
    current: PreparedImage,
    options: DiffOptions,
  ): Promise<DiffResult> {
    const width = Math.max(baseline.width, current.width);
    const height = Math.max(baseline.height, current.height);
    assertDecodable(width, height);
    const overlapW = Math.min(baseline.width, current.width);
    const overlapH = Math.min(baseline.height, current.height);

    const crop = (image: PreparedImage): Buffer => {
      const out = Buffer.alloc(overlapW * overlapH * 4);
      for (let y = 0; y < overlapH; y++) {
        image.buffer.copy(
          out,
          y * overlapW * 4,
          y * image.width * 4,
          (y * image.width + overlapW) * 4,
        );
      }
      return out;
    };
    const overlapDiff = Buffer.alloc(overlapW * overlapH * 4);
    const changedInOverlap = pixelmatch(
      crop(baseline),
      crop(current),
      overlapDiff,
      overlapW,
      overlapH,
      {
        threshold: options.pixelThreshold ?? 0.1,
        includeAA: options.includeAA,
        alpha: options.alpha,
        aaColor: options.diffColor,
        diffColor: options.diffColor,
        diffMask: options.diffMask,
      },
    );

    // The canvas starts as all changed (opaque diffColor); the overlap's own diff goes on top.
    const [r, g, b] = options.diffColor ?? [255, 0, 0];
    const canvas = Buffer.alloc(width * height * 4, Buffer.from([r, g, b, 255]));
    for (let y = 0; y < overlapH; y++) {
      overlapDiff.copy(canvas, y * width * 4, y * overlapW * 4, (y + 1) * overlapW * 4);
    }

    const totalPixels = width * height;
    const pixelDifference = changedInOverlap + (totalPixels - overlapW * overlapH);
    return {
      success: true,
      passed: false,
      similarity: (totalPixels - pixelDifference) / totalPixels,
      pixelDifference,
      threshold: options.threshold,
      diffBuffer: await this.generateDiffImage(canvas, width, height),
      layoutChange: {
        baseline: { width: baseline.width, height: baseline.height },
        current: { width: current.width, height: current.height },
      },
    };
  }

  /**
   * Prepare image buffer for comparison by normalizing format
   */
  async prepareImage(buffer: Buffer): Promise<PreparedImage> {
    // The header gives the size without decoding: refuse before allocating the pixels,
    // with a message naming the size. `limitInputPixels` on the decode is the backstop for
    // a header that lies (#282); sharp applies it to `metadata()` too, hence two instances.
    const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
    assertDecodable(metadata.width ?? 0, metadata.height ?? 0);
    const image = sharp(buffer, { limitInputPixels: MAX_DECODED_PIXELS });

    const processedBuffer = await image.raw().ensureAlpha().toBuffer();

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
    visited: Set<number>,
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
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
    }

    return { pixels };
  }

  /**
   * Calculate bounding box for a region
   */
  private calculateRegionBounds(
    pixels: number[],
    width: number,
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
  private generateCacheKey(
    baselineBuffer: Buffer,
    currentBuffer: Buffer,
    options: DiffOptions,
  ): string {
    const baselineHash = crypto
      .createHash('sha256')
      .update(baselineBuffer)
      .digest('hex')
      .substring(0, 16);
    const currentHash = crypto
      .createHash('sha256')
      .update(currentBuffer)
      .digest('hex')
      .substring(0, 16);
    const optionsHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(options))
      .digest('hex')
      .substring(0, 8);
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

/** An image's size from its header alone: nothing is decoded. */
async function headerSize(buffer: Buffer): Promise<{ width: number; height: number }> {
  const { width = 0, height = 0 } = await sharp(buffer, { limitInputPixels: false }).metadata();
  return { width, height };
}

/** Refuse an image (or canvas) too large to decode safely, naming its size (#282). */
function assertDecodable(width: number, height: number): void {
  const pixels = width * height;
  if (pixels > MAX_DECODED_PIXELS) {
    throw new Error(
      `Image ${width}x${height} is ${pixels} pixels; the limit is ${MAX_DECODED_PIXELS} (a full page this tall cannot be compared)`,
    );
  }
}
