import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
const imageSsim = require('image-ssim');
import { DiffOptions, DiffResult, DiffAnalysis, PreparedImage, SSIMResult } from './types';

/**
 * VisualDiffEngine handles pixel-level and semantic comparison of images
 */
export class VisualDiffEngine {
  /**
   * Compare two images using pixel matching
   */
  async compare(baselineBuffer: Buffer, currentBuffer: Buffer, options: DiffOptions): Promise<DiffResult> {
    try {
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
      const totalPixels = baseline.width * baseline.height;
      const similarity = (totalPixels - pixelDifference) / totalPixels;
      const passed = similarity >= options.threshold;

      // Generate diff image
      const diffImageBuffer = await this.generateDiffImage(diffBuffer, baseline.width, baseline.height);

      return {
        success: true,
        passed,
        similarity,
        pixelDifference,
        threshold: options.threshold,
        diffBuffer: diffImageBuffer,
      };
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
}