import * as fs from 'fs';
import * as path from 'path';
import { StorageManager } from '../../src/visual/storage';
import sharp from 'sharp';

describe('StorageManager', () => {
  let storage: StorageManager;
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for tests
    tempDir = path.join(__dirname, '../../.test-storage');
    storage = new StorageManager(tempDir);

    // Clean up any existing test data
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Directory Management', () => {
    it('should create baseline directory for a branch', async () => {
      await storage.createBaselineDirectory('main');

      const branchDir = storage.getBaselineDirectory('main');
      expect(fs.existsSync(branchDir)).toBe(true);
    });

    it('should sanitize branch names for safe file system usage', async () => {
      await storage.createBaselineDirectory('feature/my-branch');

      const branchDir = storage.getBaselineDirectory('feature/my-branch');
      expect(branchDir).toContain('feature-my-branch');
      expect(fs.existsSync(branchDir)).toBe(true);
    });

    it('should get baseline directory path', () => {
      const dir = storage.getBaselineDirectory('main');
      expect(dir).toContain('main');
      expect(path.isAbsolute(dir)).toBe(true);
    });

    it('should get test directory path within a branch', () => {
      const testDir = storage.getTestDirectory('main', 'homepage-test');
      expect(testDir).toContain('main');
      expect(testDir).toContain('homepage-test');
    });

    it('should ensure test directory exists and create if missing', async () => {
      const testDir = await storage.ensureTestDirectory('main', 'homepage-test');

      expect(fs.existsSync(testDir)).toBe(true);
      expect(testDir).toContain('homepage-test');
    });

    it('should handle special characters in test names', async () => {
      const testDir = await storage.ensureTestDirectory('main', 'test:with/special*chars');

      expect(fs.existsSync(testDir)).toBe(true);
      // Check the sanitized test name portion (not the full path which contains /)
      const testNamePart = path.basename(testDir);
      expect(testNamePart).not.toContain(':');
      expect(testNamePart).not.toContain('/');
      expect(testNamePart).not.toContain('*');
    });

    it('should get base directory', () => {
      const baseDir = storage.getBaseDirectory();
      expect(baseDir).toBe(tempDir);
    });
  });

  describe('Metadata Operations', () => {
    it('should save metadata.json for a test', async () => {
      const metadata = {
        testName: 'homepage-test',
        url: 'https://example.com',
        branch: 'main',
      };

      const metadataPath = await storage.saveMetadata('main', 'homepage-test', metadata);

      expect(fs.existsSync(metadataPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      expect(content.testName).toBe('homepage-test');
      expect(content.url).toBe('https://example.com');
      expect(content.createdAt).toBeDefined();
      expect(content.updatedAt).toBeDefined();
    });

    it('should load metadata.json for a test', async () => {
      const metadata = {
        testName: 'homepage-test',
        url: 'https://example.com',
      };

      await storage.saveMetadata('main', 'homepage-test', metadata);
      const loaded = await storage.loadMetadata('main', 'homepage-test');

      expect(loaded).not.toBeNull();
      expect(loaded?.testName).toBe('homepage-test');
      expect(loaded?.url).toBe('https://example.com');
    });

    it('should return null for non-existent metadata', async () => {
      const metadata = await storage.loadMetadata('main', 'nonexistent-test');
      expect(metadata).toBeNull();
    });

    it('should update updatedAt timestamp on save', async () => {
      const metadata = { testName: 'test' };

      await storage.saveMetadata('main', 'test', metadata);
      const first = await storage.loadMetadata('main', 'test');

      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      await storage.saveMetadata('main', 'test', { ...metadata, updated: true });
      const second = await storage.loadMetadata('main', 'test');

      expect(second?.updatedAt).toBeGreaterThan(first?.updatedAt || 0);
    });
  });

  describe('Image File Operations', () => {
    // Create a simple test image buffer
    const createTestImage = async (width: number = 100, height: number = 100): Promise<Buffer> => {
      return sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 255, g: 0, b: 0 }
        }
      })
        .png()
        .toBuffer();
    };

    it('should save image file with compression', async () => {
      const imageBuffer = await createTestImage();

      const result = await storage.saveImage('main', 'test', imageBuffer);

      expect(result.path).toBeDefined();
      expect(result.hash).toBeDefined();
      expect(result.size).toBeGreaterThan(0);
      expect(result.format).toBe('png');
      expect(fs.existsSync(result.path)).toBe(true);
    });

    it('should save image as PNG format', async () => {
      const imageBuffer = await createTestImage();

      const result = await storage.saveImage('main', 'test', imageBuffer, {
        format: 'png',
        compression: 9
      });

      expect(result.format).toBe('png');
      expect(result.path).toContain('.png');
    });

    it('should save image as JPEG format with quality', async () => {
      const imageBuffer = await createTestImage();

      const result = await storage.saveImage('main', 'test', imageBuffer, {
        format: 'jpeg',
        quality: 80
      });

      expect(result.format).toBe('jpeg');
      expect(result.path).toContain('.jpeg');
    });

    it('should save image as WebP format', async () => {
      const imageBuffer = await createTestImage();

      const result = await storage.saveImage('main', 'test', imageBuffer, {
        format: 'webp',
        quality: 85
      });

      expect(result.format).toBe('webp');
      expect(result.path).toContain('.webp');
    });

    it('should generate consistent hash for same image', async () => {
      const imageBuffer = await createTestImage();

      const result1 = await storage.saveImage('main', 'test1', imageBuffer);
      const result2 = await storage.saveImage('main', 'test2', imageBuffer);

      expect(result1.hash).toBe(result2.hash);
    });

    it('should generate different hash for different images', async () => {
      const image1 = await createTestImage(100, 100);
      const image2 = await createTestImage(200, 200);

      const result1 = await storage.saveImage('main', 'test1', image1);
      const result2 = await storage.saveImage('main', 'test2', image2);

      expect(result1.hash).not.toBe(result2.hash);
    });

    it('should load image file and return buffer', async () => {
      const originalBuffer = await createTestImage();
      const saveResult = await storage.saveImage('main', 'test', originalBuffer);

      const loadedBuffer = await storage.loadImage(saveResult.path);

      expect(loadedBuffer).not.toBeNull();
      expect(Buffer.isBuffer(loadedBuffer)).toBe(true);
    });

    it('should return null for non-existent image', async () => {
      const buffer = await storage.loadImage('/nonexistent/path/image.png');
      expect(buffer).toBeNull();
    });

    it('should validate valid image format', async () => {
      const imageBuffer = await createTestImage();

      const validation = await storage.validateImage(imageBuffer);

      expect(validation.valid).toBe(true);
      expect(validation.format).toBe('png');
      expect(validation.width).toBe(100);
      expect(validation.height).toBe(100);
    });

    it('should reject invalid image buffer', async () => {
      const invalidBuffer = Buffer.from('not an image');

      const validation = await storage.validateImage(invalidBuffer);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBeDefined();
    });

    it('should generate SHA-256 hash for image', async () => {
      const imageBuffer = await createTestImage();

      const hash = storage.generateImageHash(imageBuffer);

      expect(hash).toHaveLength(64); // SHA-256 hex string length
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should get proper image file name', () => {
      const hash = 'abcdef1234567890';
      const filename = storage.getImageFileName(hash, 'baseline', 'png');

      expect(filename).toBe('baseline-abcdef12.png');
    });

    it('should get diff image file name', () => {
      const hash = '1234567890abcdef';
      const filename = storage.getImageFileName(hash, 'diff', 'jpeg');

      expect(filename).toBe('diff-12345678.jpeg');
    });

    it('should convert image format from PNG to JPEG', async () => {
      const pngBuffer = await createTestImage();

      const jpegBuffer = await storage.convertImageFormat(pngBuffer, 'jpeg', 90);

      const metadata = await sharp(jpegBuffer).metadata();
      expect(metadata.format).toBe('jpeg');
    });

    it('should convert image format from PNG to WebP', async () => {
      const pngBuffer = await createTestImage();

      const webpBuffer = await storage.convertImageFormat(pngBuffer, 'webp', 85);

      const metadata = await sharp(webpBuffer).metadata();
      expect(metadata.format).toBe('webp');
    });
  });

  describe('Baseline Listing and Existence', () => {
    it('should list all baselines for a branch', async () => {
      await storage.ensureTestDirectory('main', 'test1');
      await storage.ensureTestDirectory('main', 'test2');
      await storage.ensureTestDirectory('main', 'test3');

      const baselines = await storage.listBaselines('main');

      expect(baselines).toHaveLength(3);
      expect(baselines).toContain('test1');
      expect(baselines).toContain('test2');
      expect(baselines).toContain('test3');
    });

    it('should return empty array for non-existent branch', async () => {
      const baselines = await storage.listBaselines('nonexistent');
      expect(baselines).toEqual([]);
    });

    it('should check if baseline exists', async () => {
      await storage.saveMetadata('main', 'test', { name: 'test' });

      const exists = await storage.baselineExists('main', 'test');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent baseline', async () => {
      const exists = await storage.baselineExists('main', 'nonexistent');
      expect(exists).toBe(false);
    });
  });

  describe('Baseline Deletion', () => {
    it('should delete a specific baseline', async () => {
      await storage.saveMetadata('main', 'test', { name: 'test' });

      const existsBefore = await storage.baselineExists('main', 'test');
      expect(existsBefore).toBe(true);

      await storage.deleteBaseline('main', 'test');

      const existsAfter = await storage.baselineExists('main', 'test');
      expect(existsAfter).toBe(false);
    });

    it('should handle deletion of non-existent baseline gracefully', async () => {
      await expect(storage.deleteBaseline('main', 'nonexistent')).resolves.not.toThrow();
    });
  });

  describe('Baseline Cleanup', () => {
    it('should cleanup old baselines based on age', async () => {
      // Create old baseline with explicitly set old updatedAt
      const oldTimestamp = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago
      const testDir = await storage.ensureTestDirectory('main', 'old-test');
      const metadataPath = path.join(testDir, 'metadata.json');

      const oldMetadata = {
        name: 'old-test',
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp
      };

      fs.writeFileSync(metadataPath, JSON.stringify(oldMetadata, null, 2));

      // Create recent baseline
      await storage.saveMetadata('main', 'recent-test', { name: 'recent-test' });

      const result = await storage.cleanupOldBaselines(30); // 30 days

      expect(result.deleted).toBe(1);
      expect(result.errors).toHaveLength(0);

      const oldExists = await storage.baselineExists('main', 'old-test');
      const recentExists = await storage.baselineExists('main', 'recent-test');

      expect(oldExists).toBe(false);
      expect(recentExists).toBe(true);
    });

    it('should not delete baselines newer than cutoff', async () => {
      await storage.saveMetadata('main', 'test1', { name: 'test1' });
      await storage.saveMetadata('main', 'test2', { name: 'test2' });

      const result = await storage.cleanupOldBaselines(30);

      expect(result.deleted).toBe(0);
      expect(await storage.baselineExists('main', 'test1')).toBe(true);
      expect(await storage.baselineExists('main', 'test2')).toBe(true);
    });

    it('should handle cleanup when base directory does not exist', async () => {
      const newStorage = new StorageManager('/nonexistent/path');
      const result = await newStorage.cleanupOldBaselines(30);

      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Storage Statistics', () => {
    it('should get storage statistics', async () => {
      const image = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } }
      }).png().toBuffer();

      await storage.saveImage('main', 'test1', image);
      await storage.saveImage('main', 'test2', image);
      await storage.saveImage('feature', 'test3', image);

      const stats = await storage.getStorageStats();

      expect(stats.totalBaselines).toBe(3);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.branches.main).toBeDefined();
      expect(stats.branches.main.tests).toBe(2);
      expect(stats.branches.feature).toBeDefined();
      expect(stats.branches.feature.tests).toBe(1);
    });

    it('should return empty stats when base directory does not exist', async () => {
      const stats = await storage.getStorageStats();

      expect(stats.totalBaselines).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(Object.keys(stats.branches)).toHaveLength(0);
    });
  });

  describe('Permissions Setup', () => {
    it('should setup file system permissions', async () => {
      await storage.setupPermissions();

      const baseDir = storage.getBaseDirectory();
      expect(fs.existsSync(baseDir)).toBe(true);

      const stats = fs.statSync(baseDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should create base directory if it does not exist', async () => {
      const baseDir = storage.getBaseDirectory();

      if (fs.existsSync(baseDir)) {
        fs.rmSync(baseDir, { recursive: true });
      }

      await storage.setupPermissions();

      expect(fs.existsSync(baseDir)).toBe(true);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle concurrent directory creation', async () => {
      const promises = [
        storage.ensureTestDirectory('main', 'test'),
        storage.ensureTestDirectory('main', 'test'),
        storage.ensureTestDirectory('main', 'test')
      ];

      await expect(Promise.all(promises)).resolves.not.toThrow();
    });

    it('should handle very long test names', async () => {
      const longName = 'a'.repeat(200);
      const testDir = await storage.ensureTestDirectory('main', longName);

      expect(fs.existsSync(testDir)).toBe(true);
    });

    it('should handle Unicode characters in test names', async () => {
      const unicodeName = '测试-тест-test-🎨';
      const testDir = await storage.ensureTestDirectory('main', unicodeName);

      expect(fs.existsSync(testDir)).toBe(true);
    });

    it('should reject path traversal attempts', async () => {
      const maliciousPath = path.join(tempDir, '../../../etc/passwd');
      const imageBuffer = Buffer.from('fake');

      // loadImage should reject paths outside base directory
      await expect(storage.loadImage(maliciousPath)).resolves.toBeNull();
    });
  });
});
