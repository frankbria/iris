import {
  ImagePreprocessor,
  createPreprocessor,
  PreprocessorConfig,
} from '../src/ai-client/preprocessor';
import sharp from 'sharp';

describe('ImagePreprocessor', () => {
  let preprocessor: ImagePreprocessor;

  beforeEach(() => {
    preprocessor = new ImagePreprocessor();
  });

  describe('constructor and configuration', () => {
    it('should create with default configuration', () => {
      const config = preprocessor.getConfig();
      expect(config.maxWidth).toBe(2048);
      expect(config.maxHeight).toBe(2048);
      expect(config.quality).toBe(85);
      expect(config.maintainAspectRatio).toBe(true);
      expect(config.format).toBe('jpeg');
    });

    it('should create with custom configuration', () => {
      const customPreprocessor = new ImagePreprocessor({
        maxWidth: 1024,
        quality: 80,
        format: 'png',
      });
      const config = customPreprocessor.getConfig();
      expect(config.maxWidth).toBe(1024);
      expect(config.maxHeight).toBe(2048); // default
      expect(config.quality).toBe(80);
      expect(config.format).toBe('png');
    });

    it('should update configuration', () => {
      preprocessor.updateConfig({ quality: 90 });
      const config = preprocessor.getConfig();
      expect(config.quality).toBe(90);
      expect(config.maxWidth).toBe(2048); // unchanged
    });

    it('should create with factory function', () => {
      const processor = createPreprocessor({ maxWidth: 512 });
      expect(processor.getConfig().maxWidth).toBe(512);
    });
  });

  describe('image preprocessing', () => {
    it('should preprocess a Buffer image', async () => {
      // Create a test image buffer (100x100 red square)
      const testBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const result = await preprocessor.preprocess(testBuffer);

      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.base64).toBeTruthy();
      expect(result.hash).toHaveLength(64); // SHA-256 hex
      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.processedSize).toBeGreaterThan(0);
      expect(result.dimensions.width).toBe(100);
      expect(result.dimensions.height).toBe(100);
    });

    it('should preprocess a base64 string', async () => {
      // Create a small test image
      const testBuffer = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const base64Input = testBuffer.toString('base64');
      const result = await preprocessor.preprocess(base64Input);

      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.base64).toBeTruthy();
      expect(result.hash).toHaveLength(64);
    });

    it('should preprocess a data URL', async () => {
      // Create a small test image
      const testBuffer = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer();

      const dataUrl = `data:image/png;base64,${testBuffer.toString('base64')}`;
      const result = await preprocessor.preprocess(dataUrl);

      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.base64).toBeTruthy();
      expect(result.hash).toHaveLength(64);
    });

    it('should resize large images', async () => {
      // Create a large test image (3000x2000)
      const largeBuffer = await sharp({
        create: {
          width: 3000,
          height: 2000,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .png()
        .toBuffer();

      const result = await preprocessor.preprocess(largeBuffer);

      // Should be resized to fit within 2048x2048 maintaining aspect ratio
      expect(result.dimensions.width).toBeLessThanOrEqual(2048);
      expect(result.dimensions.height).toBeLessThanOrEqual(2048);

      // Aspect ratio should be maintained (3000:2000 = 1.5:1)
      const aspectRatio =
        result.dimensions.width / result.dimensions.height;
      expect(aspectRatio).toBeCloseTo(1.5, 1);
    });

    it('should not enlarge small images', async () => {
      // Create a small test image (100x100)
      const smallBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();

      const result = await preprocessor.preprocess(smallBuffer);

      // Should remain at original size
      expect(result.dimensions.width).toBe(100);
      expect(result.dimensions.height).toBe(100);
    });

    it('should apply quality optimization', async () => {
      // Create a test image with detail
      const detailBuffer = await sharp({
        create: {
          width: 500,
          height: 500,
          channels: 3,
          background: { r: 200, g: 200, b: 200 },
        },
      })
        .png()
        .toBuffer();

      const highQuality = new ImagePreprocessor({ quality: 95 });
      const lowQuality = new ImagePreprocessor({ quality: 60 });

      const highResult = await highQuality.preprocess(detailBuffer);
      const lowResult = await lowQuality.preprocess(detailBuffer);

      // Lower quality should result in smaller file
      expect(lowResult.processedSize).toBeLessThan(
        highResult.processedSize
      );
    });

    it('should calculate consistent hashes for identical images', async () => {
      const testBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 100, g: 150, b: 200 },
        },
      })
        .png()
        .toBuffer();

      const result1 = await preprocessor.preprocess(testBuffer);
      const result2 = await preprocessor.preprocess(testBuffer);

      expect(result1.hash).toBe(result2.hash);
    });

    it('should calculate different hashes for different images', async () => {
      const buffer1 = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const buffer2 = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const result1 = await preprocessor.preprocess(buffer1);
      const result2 = await preprocessor.preprocess(buffer2);

      expect(result1.hash).not.toBe(result2.hash);
    });

    it('should achieve significant size reduction for typical screenshots', async () => {
      // Create a realistic large screenshot (4000x3000 PNG)
      // This simulates a high-res screenshot that needs resizing and optimization
      const screenshotBuffer = await sharp({
        create: {
          width: 4000,
          height: 3000,
          channels: 4, // RGBA (PNG with alpha)
          background: { r: 240, g: 240, b: 240, alpha: 1 },
        },
      })
        .png({ compressionLevel: 0 }) // No compression to start
        .toBuffer();

      const result = await preprocessor.preprocess(screenshotBuffer);

      // Large PNG → resized + JPEG conversion should achieve significant reduction
      // The >40% target is achievable with large, uncompressed source images
      expect(result.reductionPercent).toBeGreaterThan(40);
      expect(result.dimensions.width).toBeLessThanOrEqual(2048);
      expect(result.dimensions.height).toBeLessThanOrEqual(2048);

      // Verify actual optimization occurred
      expect(result.processedSize).toBeLessThan(result.originalSize);
    });
  });

  describe('format support', () => {
    it('should support JPEG format', async () => {
      const jpegPreprocessor = new ImagePreprocessor({ format: 'jpeg' });
      const testBuffer = await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .png()
        .toBuffer();

      const result = await jpegPreprocessor.preprocess(testBuffer);

      // Verify it's actually JPEG
      const metadata = await sharp(result.buffer).metadata();
      expect(metadata.format).toBe('jpeg');
    });

    it('should support PNG format', async () => {
      const pngPreprocessor = new ImagePreprocessor({ format: 'png' });
      const testBuffer = await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .jpeg()
        .toBuffer();

      const result = await pngPreprocessor.preprocess(testBuffer);

      // Verify it's actually PNG
      const metadata = await sharp(result.buffer).metadata();
      expect(metadata.format).toBe('png');
    });

    it('should support WebP format', async () => {
      const webpPreprocessor = new ImagePreprocessor({ format: 'webp' });
      const testBuffer = await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .png()
        .toBuffer();

      const result = await webpPreprocessor.preprocess(testBuffer);

      // Verify it's actually WebP
      const metadata = await sharp(result.buffer).metadata();
      expect(metadata.format).toBe('webp');
    });
  });

  describe('batch processing', () => {
    it('should preprocess multiple images in batch', async () => {
      const buffers = await Promise.all([
        sharp({
          create: {
            width: 100,
            height: 100,
            channels: 3,
            background: { r: 255, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer(),
        sharp({
          create: {
            width: 200,
            height: 200,
            channels: 3,
            background: { r: 0, g: 255, b: 0 },
          },
        })
          .png()
          .toBuffer(),
        sharp({
          create: {
            width: 300,
            height: 300,
            channels: 3,
            background: { r: 0, g: 0, b: 255 },
          },
        })
          .png()
          .toBuffer(),
      ]);

      const results = await preprocessor.preprocessBatch(buffers);

      expect(results).toHaveLength(3);
      expect(results[0].dimensions.width).toBe(100);
      expect(results[1].dimensions.width).toBe(200);
      expect(results[2].dimensions.width).toBe(300);
      expect(results[0].hash).not.toBe(results[1].hash);
      expect(results[1].hash).not.toBe(results[2].hash);
    });

    it('should handle batch with mixed input types', async () => {
      const buffer1 = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const buffer2 = await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const base64Input = buffer2.toString('base64');

      const results = await preprocessor.preprocessBatch([
        buffer1,
        base64Input,
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].buffer).toBeInstanceOf(Buffer);
      expect(results[1].buffer).toBeInstanceOf(Buffer);
    });
  });

  describe('base64 encoding', () => {
    it('should produce valid base64 output', async () => {
      const testBuffer = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 128, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const result = await preprocessor.preprocess(testBuffer);

      // Should be able to decode back to buffer
      const decoded = Buffer.from(result.base64, 'base64');
      expect(decoded).toEqual(result.buffer);
    });

    it('should handle base64 roundtrip', async () => {
      const originalBuffer = await sharp({
        create: {
          width: 150,
          height: 150,
          channels: 3,
          background: { r: 100, g: 100, b: 100 },
        },
      })
        .png()
        .toBuffer();

      // Preprocess original
      const result1 = await preprocessor.preprocess(originalBuffer);

      // Use the base64 output as input
      const result2 = await preprocessor.preprocess(result1.base64);

      // Hashes should match (same image)
      expect(result2.hash).toBe(result1.hash);
    });
  });

  describe('aspect ratio handling', () => {
    it('should maintain aspect ratio by default', async () => {
      const wideBuffer = await sharp({
        create: {
          width: 3000,
          height: 1000,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .png()
        .toBuffer();

      const result = await preprocessor.preprocess(wideBuffer);

      const aspectRatio =
        result.dimensions.width / result.dimensions.height;
      expect(aspectRatio).toBeCloseTo(3.0, 1); // 3000:1000 = 3:1
    });

    it('should allow aspect ratio distortion when configured', async () => {
      const distortPreprocessor = new ImagePreprocessor({
        maintainAspectRatio: false,
        maxWidth: 1000,
        maxHeight: 500,
      });

      const squareBuffer = await sharp({
        create: {
          width: 2000,
          height: 2000,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .png()
        .toBuffer();

      const result = await distortPreprocessor.preprocess(squareBuffer);

      // Should be stretched to fill max dimensions
      expect(result.dimensions.width).toBe(1000);
      expect(result.dimensions.height).toBe(500);
    });
  });

  describe('edge cases', () => {
    it('should handle very small images', async () => {
      const tinyBuffer = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const result = await preprocessor.preprocess(tinyBuffer);

      expect(result.dimensions.width).toBe(1);
      expect(result.dimensions.height).toBe(1);
      expect(result.hash).toHaveLength(64);
    });

    it('should calculate reduction percent correctly for same size', async () => {
      const smallBuffer = await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .jpeg({ quality: 85 })
        .toBuffer();

      const result = await preprocessor.preprocess(smallBuffer);

      // Reduction should be >=0 even if sizes are similar
      expect(result.reductionPercent).toBeGreaterThanOrEqual(0);
    });
  });
});
