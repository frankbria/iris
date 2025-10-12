import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';

/**
 * StorageManager handles all file system operations for visual testing
 * Manages baseline directory structure, image file operations, and metadata
 */
export class StorageManager {
  private readonly baseDir: string;
  private readonly metadataFileName = 'metadata.json';

  constructor(baseDir: string = '.iris/baselines') {
    this.baseDir = path.resolve(baseDir);
  }

  /**
   * Create baseline directory structure for a specific branch
   * Directory structure: .iris/baselines/{branch}/{testName}/
   */
  async createBaselineDirectory(branch: string): Promise<void> {
    const branchDir = path.join(this.baseDir, this.sanitizeBranchName(branch));

    if (!fs.existsSync(branchDir)) {
      fs.mkdirSync(branchDir, { recursive: true, mode: 0o755 });
    }
  }

  /**
   * Get the baseline directory path for a branch
   */
  getBaselineDirectory(branch: string): string {
    return path.join(this.baseDir, this.sanitizeBranchName(branch));
  }

  /**
   * Get the test directory path within a branch
   */
  getTestDirectory(branch: string, testName: string): string {
    return path.join(
      this.getBaselineDirectory(branch),
      this.sanitizeTestName(testName)
    );
  }

  /**
   * Ensure test directory exists and return the path
   */
  async ensureTestDirectory(branch: string, testName: string): Promise<string> {
    const testDir = this.getTestDirectory(branch, testName);

    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o755 });
    }

    return testDir;
  }

  /**
   * Save metadata.json file for a test baseline
   */
  async saveMetadata(
    branch: string,
    testName: string,
    metadata: Record<string, any>
  ): Promise<string> {
    const testDir = await this.ensureTestDirectory(branch, testName);
    const metadataPath = path.join(testDir, this.metadataFileName);

    const metadataWithTimestamp = {
      ...metadata,
      createdAt: metadata.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    fs.writeFileSync(
      metadataPath,
      JSON.stringify(metadataWithTimestamp, null, 2),
      { encoding: 'utf-8', mode: 0o644 }
    );

    return metadataPath;
  }

  /**
   * Load metadata.json file for a test baseline
   */
  async loadMetadata(
    branch: string,
    testName: string
  ): Promise<Record<string, any> | null> {
    const testDir = this.getTestDirectory(branch, testName);
    const metadataPath = path.join(testDir, this.metadataFileName);

    if (!fs.existsSync(metadataPath)) {
      return null;
    }

    const content = fs.readFileSync(metadataPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Save image file with compression and optimization
   */
  async saveImage(
    branch: string,
    testName: string,
    imageBuffer: Buffer,
    options: {
      quality?: number;
      format?: 'png' | 'jpeg' | 'webp';
      compression?: number;
      autoOptimize?: boolean;
    } = {}
  ): Promise<{
    path: string;
    hash: string;
    size: number;
    format: string;
  }> {
    const testDir = await this.ensureTestDirectory(branch, testName);

    // Auto-optimize format based on image analysis if requested
    let format = options.format;
    let quality = options.quality || 90;

    if (options.autoOptimize && !format) {
      const metadata = await sharp(imageBuffer).metadata();
      const originalSize = imageBuffer.length;

      // Use JPEG for photos (larger images), WebP for graphics
      if (originalSize > 1024 * 1024) { // > 1MB, likely a photo
        format = 'jpeg';
        quality = 85; // More aggressive compression for large images
      } else if (originalSize > 500 * 1024) { // > 500KB
        format = 'webp';
        quality = 88;
      } else {
        format = 'png'; // Small images, keep quality
      }
    } else {
      format = format || 'png';
    }

    // Process image with sharp for compression
    let processedBuffer: Buffer;
    let sharpInstance = sharp(imageBuffer);

    if (format === 'png') {
      sharpInstance = sharpInstance.png({
        compressionLevel: options.compression || 9,
        adaptiveFiltering: true,
        palette: true, // Use palette optimization for smaller size
      });
    } else if (format === 'jpeg') {
      sharpInstance = sharpInstance.jpeg({
        quality,
        mozjpeg: true,
        progressive: true, // Progressive JPEG for faster loading
        optimizeScans: true,
      });
    } else if (format === 'webp') {
      sharpInstance = sharpInstance.webp({
        quality,
        lossless: false,
        nearLossless: true, // Better compression with minimal quality loss
        smartSubsample: true,
      });
    }

    processedBuffer = await sharpInstance.toBuffer();

    // Generate hash for deduplication
    const hash = this.generateImageHash(processedBuffer);

    // Save with hash-based filename
    const filename = `baseline-${hash.substring(0, 8)}.${format}`;
    const imagePath = path.join(testDir, filename);

    fs.writeFileSync(imagePath, processedBuffer, { mode: 0o644 });

    return {
      path: imagePath,
      hash,
      size: processedBuffer.length,
      format,
    };
  }

  /**
   * Load image file and return buffer
   */
  async loadImage(imagePath: string): Promise<Buffer | null> {
    if (!fs.existsSync(imagePath)) {
      return null;
    }

    // Validate it's actually an image
    if (!this.isValidImagePath(imagePath)) {
      throw new Error(`Invalid image path: ${imagePath}`);
    }

    return fs.readFileSync(imagePath);
  }

  /**
   * Validate image format and integrity
   */
  async validateImage(imageBuffer: Buffer): Promise<{
    valid: boolean;
    format?: string;
    width?: number;
    height?: number;
    error?: string;
  }> {
    try {
      const metadata = await sharp(imageBuffer).metadata();

      return {
        valid: true,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Invalid image',
      };
    }
  }

  /**
   * Generate SHA-256 hash of image content for deduplication
   */
  generateImageHash(imageBuffer: Buffer): string {
    return crypto
      .createHash('sha256')
      .update(imageBuffer)
      .digest('hex');
  }

  /**
   * Get image file naming convention
   * Format: baseline-{hash8}.{ext} or diff-{hash8}.{ext}
   */
  getImageFileName(hash: string, type: 'baseline' | 'diff', format: string): string {
    return `${type}-${hash.substring(0, 8)}.${format}`;
  }

  /**
   * List all baselines for a branch
   */
  async listBaselines(branch: string): Promise<string[]> {
    const branchDir = this.getBaselineDirectory(branch);

    if (!fs.existsSync(branchDir)) {
      return [];
    }

    return fs.readdirSync(branchDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  }

  /**
   * Check if a baseline exists
   */
  async baselineExists(branch: string, testName: string): Promise<boolean> {
    const testDir = this.getTestDirectory(branch, testName);
    const metadataPath = path.join(testDir, this.metadataFileName);

    return fs.existsSync(testDir) && fs.existsSync(metadataPath);
  }

  /**
   * Delete a specific baseline
   */
  async deleteBaseline(branch: string, testName: string): Promise<void> {
    const testDir = this.getTestDirectory(branch, testName);

    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  /**
   * Cleanup old baselines based on age
   */
  async cleanupOldBaselines(maxAgeDays: number): Promise<{
    deleted: number;
    errors: string[];
  }> {
    const result = { deleted: 0, errors: [] as string[] };
    const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    if (!fs.existsSync(this.baseDir)) {
      return result;
    }

    // Iterate through all branches
    const branches = fs.readdirSync(this.baseDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const branch of branches) {
      const branchDir = this.getBaselineDirectory(branch);
      const tests = fs.readdirSync(branchDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const testName of tests) {
        try {
          const metadata = await this.loadMetadata(branch, testName);

          if (metadata && metadata.updatedAt < cutoffTime) {
            await this.deleteBaseline(branch, testName);
            result.deleted++;
          }
        } catch (error) {
          result.errors.push(
            `Error cleaning ${branch}/${testName}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }
    }

    return result;
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{
    totalBaselines: number;
    totalSize: number;
    branches: Record<string, { tests: number; size: number }>;
  }> {
    const stats = {
      totalBaselines: 0,
      totalSize: 0,
      branches: {} as Record<string, { tests: number; size: number }>,
    };

    if (!fs.existsSync(this.baseDir)) {
      return stats;
    }

    const branches = fs.readdirSync(this.baseDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const branch of branches) {
      const branchDir = this.getBaselineDirectory(branch);
      const tests = fs.readdirSync(branchDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let branchSize = 0;

      for (const testName of tests) {
        const testDir = this.getTestDirectory(branch, testName);
        branchSize += this.getDirectorySize(testDir);
      }

      stats.branches[branch] = {
        tests: tests.length,
        size: branchSize,
      };

      stats.totalBaselines += tests.length;
      stats.totalSize += branchSize;
    }

    return stats;
  }

  /**
   * Setup file system permissions for baseline directory
   */
  async setupPermissions(): Promise<void> {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o755 });
    }

    // Ensure readable/writable by owner
    fs.chmodSync(this.baseDir, 0o755);
  }

  /**
   * Convert image format
   */
  async convertImageFormat(
    imageBuffer: Buffer,
    targetFormat: 'png' | 'jpeg' | 'webp',
    quality: number = 90
  ): Promise<Buffer> {
    let sharpInstance = sharp(imageBuffer);

    if (targetFormat === 'png') {
      sharpInstance = sharpInstance.png({ compressionLevel: 9 });
    } else if (targetFormat === 'jpeg') {
      sharpInstance = sharpInstance.jpeg({ quality, mozjpeg: true });
    } else if (targetFormat === 'webp') {
      sharpInstance = sharpInstance.webp({ quality });
    }

    return sharpInstance.toBuffer();
  }

  /**
   * Get the root baseline directory
   */
  getBaseDirectory(): string {
    return this.baseDir;
  }

  // Private helper methods

  /**
   * Sanitize branch name for safe file system usage
   */
  private sanitizeBranchName(branch: string): string {
    return branch
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Sanitize test name for safe file system usage
   */
  private sanitizeTestName(testName: string): string {
    return testName
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Validate image path to prevent directory traversal
   */
  private isValidImagePath(imagePath: string): boolean {
    const resolved = path.resolve(imagePath);
    const normalized = path.normalize(resolved);

    // Must be within base directory or test directory
    return normalized.startsWith(this.baseDir) &&
           (normalized.endsWith('.png') ||
            normalized.endsWith('.jpeg') ||
            normalized.endsWith('.jpg') ||
            normalized.endsWith('.webp'));
  }

  /**
   * Get total size of a directory recursively
   */
  private getDirectorySize(dirPath: string): number {
    let size = 0;

    if (!fs.existsSync(dirPath)) {
      return 0;
    }

    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      const itemPath = path.join(dirPath, item.name);

      if (item.isDirectory()) {
        size += this.getDirectorySize(itemPath);
      } else {
        const stats = fs.statSync(itemPath);
        size += stats.size;
      }
    }

    return size;
  }
}
