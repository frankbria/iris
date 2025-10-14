import { createHash } from 'crypto';
import sharp from 'sharp';

/**
 * Image preprocessing configuration
 */
export interface PreprocessorConfig {
  /**
   * Maximum width in pixels (default: 2048)
   * GPT-4V supports up to 2048x2048 at high detail
   */
  maxWidth?: number;

  /**
   * Maximum height in pixels (default: 2048)
   */
  maxHeight?: number;

  /**
   * JPEG quality (0-100, default: 85)
   * 85% provides good balance between quality and size
   */
  quality?: number;

  /**
   * Whether to maintain aspect ratio when resizing (default: true)
   */
  maintainAspectRatio?: boolean;

  /**
   * Image format for processing (default: 'jpeg')
   * JPEG provides better compression for screenshots
   */
  format?: 'jpeg' | 'png' | 'webp';
}

/**
 * Preprocessed image result
 */
export interface PreprocessedImage {
  /**
   * Image data as Buffer
   */
  buffer: Buffer;

  /**
   * Base64-encoded image data for transmission
   */
  base64: string;

  /**
   * SHA-256 hash for caching and comparison
   */
  hash: string;

  /**
   * Original image size in bytes
   */
  originalSize: number;

  /**
   * Processed image size in bytes
   */
  processedSize: number;

  /**
   * Size reduction percentage (0-100)
   */
  reductionPercent: number;

  /**
   * Final image dimensions
   */
  dimensions: {
    width: number;
    height: number;
  };
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<PreprocessorConfig> = {
  maxWidth: 2048,
  maxHeight: 2048,
  quality: 85,
  maintainAspectRatio: true,
  format: 'jpeg',
};

/**
 * Image preprocessor for AI vision APIs
 *
 * Handles image optimization, resizing, encoding, and caching preparation.
 * Designed to reduce API costs by minimizing image sizes while maintaining
 * visual fidelity for regression detection.
 */
export class ImagePreprocessor {
  private config: Required<PreprocessorConfig>;

  constructor(config: PreprocessorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Preprocess a single image for AI vision analysis
   *
   * @param input - Image as Buffer, base64 string, or file path
   * @returns Preprocessed image with metadata
   */
  async preprocess(input: Buffer | string): Promise<PreprocessedImage> {
    const originalBuffer = await this.loadImage(input);
    const originalSize = originalBuffer.length;

    // Process image with sharp
    let pipeline = sharp(originalBuffer);

    // Get original dimensions
    const metadata = await pipeline.metadata();
    const originalWidth = metadata.width || 0;
    const originalHeight = metadata.height || 0;

    // Resize if needed
    if (
      originalWidth > this.config.maxWidth ||
      originalHeight > this.config.maxHeight
    ) {
      pipeline = pipeline.resize(this.config.maxWidth, this.config.maxHeight, {
        fit: this.config.maintainAspectRatio ? 'inside' : 'fill',
        withoutEnlargement: true,
      });
    }

    // Convert to target format with quality optimization
    let processedBuffer: Buffer;
    if (this.config.format === 'jpeg') {
      processedBuffer = await pipeline
        .jpeg({ quality: this.config.quality })
        .toBuffer();
    } else if (this.config.format === 'png') {
      processedBuffer = await pipeline
        .png({ compressionLevel: 9 })
        .toBuffer();
    } else {
      // webp
      processedBuffer = await pipeline
        .webp({ quality: this.config.quality })
        .toBuffer();
    }

    // Get final dimensions
    const processedMetadata = await sharp(processedBuffer).metadata();
    const finalWidth = processedMetadata.width || originalWidth;
    const finalHeight = processedMetadata.height || originalHeight;

    // Calculate hash for caching
    const hash = this.calculateHash(processedBuffer);

    // Encode to base64
    const base64 = processedBuffer.toString('base64');

    // Calculate size reduction
    const processedSize = processedBuffer.length;
    const reductionPercent =
      originalSize > 0
        ? Math.round(((originalSize - processedSize) / originalSize) * 100)
        : 0;

    return {
      buffer: processedBuffer,
      base64,
      hash,
      originalSize,
      processedSize,
      reductionPercent,
      dimensions: {
        width: finalWidth,
        height: finalHeight,
      },
    };
  }

  /**
   * Preprocess multiple images in batch
   *
   * @param inputs - Array of images as Buffer, base64, or file paths
   * @returns Array of preprocessed images
   */
  async preprocessBatch(
    inputs: Array<Buffer | string>
  ): Promise<PreprocessedImage[]> {
    return Promise.all(inputs.map((input) => this.preprocess(input)));
  }

  /**
   * Calculate SHA-256 hash of image buffer
   *
   * @param buffer - Image buffer
   * @returns Hex-encoded hash string
   */
  private calculateHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Load image from various input formats
   *
   * @param input - Buffer, base64 string, or file path
   * @returns Image as Buffer
   */
  private async loadImage(input: Buffer | string): Promise<Buffer> {
    if (Buffer.isBuffer(input)) {
      return input;
    }

    // Check if base64 string
    if (input.startsWith('data:image/')) {
      // Extract base64 data from data URL
      const base64Data = input.split(',')[1];
      return Buffer.from(base64Data, 'base64');
    } else if (this.isBase64(input)) {
      // Raw base64 string
      return Buffer.from(input, 'base64');
    }

    // Assume file path - load with sharp
    return sharp(input).toBuffer();
  }

  /**
   * Check if string is valid base64
   *
   * @param str - String to check
   * @returns True if valid base64
   */
  private isBase64(str: string): boolean {
    try {
      return Buffer.from(str, 'base64').toString('base64') === str;
    } catch {
      return false;
    }
  }

  /**
   * Update configuration
   *
   * @param config - New configuration values
   */
  updateConfig(config: PreprocessorConfig): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   *
   * @returns Current configuration
   */
  getConfig(): Required<PreprocessorConfig> {
    return { ...this.config };
  }
}

/**
 * Create a preprocessor with default configuration
 */
export function createPreprocessor(
  config?: PreprocessorConfig
): ImagePreprocessor {
  return new ImagePreprocessor(config);
}
