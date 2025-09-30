import { Page } from 'playwright';
import { createHash } from 'crypto';
import { CaptureConfig, CaptureResult, CaptureMetadata, Viewport } from './types';

/**
 * VisualCaptureEngine handles screenshot capture with stabilization and masking
 */
export class VisualCaptureEngine {
  /**
   * Capture a screenshot with the specified configuration
   */
  async capture(page: Page, config: CaptureConfig): Promise<CaptureResult> {
    try {
      // Stabilize page if requested
      if (config.stabilizeMs > 0) {
        await this.stabilizePage(page, config.stabilizeMs);
      }

      // Disable animations if requested
      if (config.disableAnimations) {
        await this.disableAnimations(page);
      }

      // Apply element masking if specified
      if (config.maskSelectors && config.maskSelectors.length > 0) {
        await this.maskElements(page, config.maskSelectors);
      }

      let buffer: Buffer;

      // Capture screenshot based on selector
      if (config.selector) {
        const locator = page.locator(config.selector);
        await locator.waitFor({ state: 'visible' });
        buffer = await locator.screenshot({
          quality: config.quality,
          type: config.type,
        });
      } else {
        buffer = await page.screenshot({
          fullPage: config.fullPage,
          animations: config.disableAnimations ? 'disabled' : 'allow',
          quality: config.quality,
          type: config.type,
          clip: config.clip,
        });
      }

      // Generate metadata
      const metadata = await this.generateMetadata(page, buffer, config);

      return {
        success: true,
        buffer,
        metadata,
      };
    } catch (error) {
      return {
        success: false,
        metadata: await this.generateErrorMetadata(page, config),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Capture multiple screenshots with different configurations
   */
  async captureMultiple(page: Page, configs: CaptureConfig[]): Promise<CaptureResult[]> {
    const results: CaptureResult[] = [];

    for (const config of configs) {
      const result = await this.capture(page, config);
      results.push(result);
    }

    return results;
  }

  /**
   * Generate metadata for a successful capture
   */
  async generateMetadata(page: Page, buffer: Buffer, config: CaptureConfig): Promise<CaptureMetadata> {
    const url = page.url();
    const title = await page.title();
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const hash = this.generateHash(buffer);
    const timestamp = Date.now();

    return {
      url,
      title,
      fullPage: config.fullPage,
      viewport,
      hash,
      timestamp,
      selector: config.selector,
      maskSelectors: config.maskSelectors.length > 0 ? config.maskSelectors : undefined,
      stabilizeMs: config.stabilizeMs > 0 ? config.stabilizeMs : undefined,
      disableAnimations: config.disableAnimations ? config.disableAnimations : undefined,
    };
  }

  /**
   * Generate metadata for a failed capture
   */
  private async generateErrorMetadata(page: Page, config: CaptureConfig): Promise<CaptureMetadata> {
    try {
      const url = page.url();
      const title = await page.title().catch(() => 'Unknown');
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })).catch(() => ({ width: 0, height: 0 }));

      return {
        url,
        title,
        fullPage: config.fullPage,
        viewport,
        hash: '',
        timestamp: Date.now(),
        selector: config.selector,
        maskSelectors: config.maskSelectors.length > 0 ? config.maskSelectors : undefined,
        stabilizeMs: config.stabilizeMs > 0 ? config.stabilizeMs : undefined,
        disableAnimations: config.disableAnimations ? config.disableAnimations : undefined,
      };
    } catch {
      return {
        url: 'unknown',
        title: 'unknown',
        fullPage: config.fullPage,
        viewport: { width: 0, height: 0 },
        hash: '',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Generate SHA-256 hash of image buffer
   */
  generateHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Stabilize page by waiting for network idle and fonts to load
   */
  private async stabilizePage(page: Page, stabilizeMs: number): Promise<void> {
    // Wait for network to be idle
    await page.waitForLoadState('networkidle');

    // Wait for fonts to load
    await page.waitForFunction(() => {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready.then(() => true);
      }
      return true;
    });

    // Additional stabilization delay
    await page.waitForTimeout(stabilizeMs);
  }

  /**
   * Disable CSS animations and transitions
   */
  private async disableAnimations(page: Page): Promise<void> {
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          transform: none !important;
        }
      `,
    });
  }

  /**
   * Mask elements by hiding them with CSS
   */
  private async maskElements(page: Page, selectors: string[]): Promise<void> {
    const selectorList = selectors.join(', ');
    await page.addStyleTag({
      content: `
        ${selectorList} {
          visibility: hidden !important;
          opacity: 0 !important;
        }
      `,
    });
  }
}