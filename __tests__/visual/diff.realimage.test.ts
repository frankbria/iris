import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import { VisualDiffEngine, MAX_DECODED_PIXELS } from '../../src/visual/diff';
import { DiffOptions } from '../../src/visual/types';

// Regression guard for the P0.2 threshold-inversion bug (issue #55).
// The mocked diff.test.ts suite stubbed out sharp + pixelmatch, so it could not
// catch that `passed` compared similarity the wrong way. These tests run the
// REAL pixel pipeline on generated PNGs, so a re-inverted comparison fails here.

/** Build a solid-color RGBA PNG, optionally painting the top `diffRows` rows black. */
async function makePng(width: number, height: number, diffRows: number): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const paintBlack = y < diffRows;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = paintBlack ? 0 : 255;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

const baseOptions: Omit<DiffOptions, 'threshold'> = {
  includeAA: false,
  alpha: 0.1,
  diffMask: false,
  diffColor: [255, 0, 0],
};

describe('VisualDiffEngine real-image threshold semantics', () => {
  const engine = new VisualDiffEngine();
  const size = 100; // 10_000 px total, below the large-image sampling path

  it('fails a 15% regression at the default 0.1 threshold', async () => {
    const baseline = await makePng(size, size, 0);
    const current = await makePng(size, size, 15); // 15 of 100 rows differ = 15%

    const result = await engine.compare(baseline, current, { ...baseOptions, threshold: 0.1 });

    expect(result.success).toBe(true);
    expect(result.pixelDifference).toBe(15 * size); // 1500 differing pixels
    expect(result.passed).toBe(false); // 15% differ > 10% allowed
  });

  it('passes a small 5% change at the default 0.1 threshold', async () => {
    const baseline = await makePng(size, size, 0);
    const current = await makePng(size, size, 5); // 5% differ

    const result = await engine.compare(baseline, current, { ...baseOptions, threshold: 0.1 });

    expect(result.success).toBe(true);
    expect(result.pixelDifference).toBe(5 * size);
    expect(result.passed).toBe(true); // 5% differ <= 10% allowed
  });
});

// Issue #77: SSIM was implemented, tested in isolation, and never reached the
// pipeline. The mocked suite pins the wiring; this one proves the real vendored
// SSIM produces a sane score through compare() on real PNGs.
describe('VisualDiffEngine real-image SSIM integration', () => {
  const engine = new VisualDiffEngine();
  const size = 100;

  it('reports a real structural score on a failed comparison', async () => {
    const baseline = await makePng(size, size, 0);
    const current = await makePng(size, size, 15); // fails the 0.1 threshold

    const result = await engine.compare(baseline, current, { ...baseOptions, threshold: 0.1 });

    expect(result.passed).toBe(false);
    // A real number from the vendored implementation, not a stub.
    expect(typeof result.ssim).toBe('number');
    expect(result.ssim).toBeGreaterThan(0);
    expect(result.ssim).toBeLessThan(1); // the images genuinely differ
    expect(typeof result.mcs).toBe('number');
  });

  it('scores a bigger structural change lower than a smaller one', async () => {
    // The property that makes SSIM worth surfacing at all: it must move in the
    // right direction. A constant would satisfy the test above but not this one.
    const baseline = await makePng(size, size, 0);
    const small = await engine.compare(baseline, await makePng(size, size, 15), {
      ...baseOptions,
      threshold: 0.1,
    });
    const large = await engine.compare(baseline, await makePng(size, size, 60), {
      ...baseOptions,
      threshold: 0.1,
    });

    expect(large.ssim).toBeLessThan(small.ssim!);
  });

  it('omits the score when the comparison passes', async () => {
    const baseline = await makePng(size, size, 0);
    const current = await makePng(size, size, 5); // under threshold

    const result = await engine.compare(baseline, current, { ...baseOptions, threshold: 0.1 });

    expect(result.passed).toBe(true);
    expect(result.ssim).toBeUndefined();
  });
});

// Issue #282: a full-page capture whose height changed used to be refused as a
// "dimension mismatch", so a page that grew was never diffed (breaking, similarity 0,
// no diff image). It is now diffed over a canvas of the larger size.
describe('VisualDiffEngine real-image page size changes (#282)', () => {
  const engine = new VisualDiffEngine();

  it('diffs a page that grew, counting the new rows as changed', async () => {
    const baseline = await makePng(100, 100, 0);
    const current = await makePng(100, 120, 0); // same top 100 rows, 20 new ones

    const result = await engine.compare(baseline, current, { ...baseOptions, threshold: 0.1 });

    expect(result.success).toBe(true);
    expect(result.passed).toBe(false); // a layout change is never a pass
    expect(result.layoutChange).toEqual({
      baseline: { width: 100, height: 100 },
      current: { width: 100, height: 120 },
    });
    expect(result.pixelDifference).toBe(20 * 100);
    expect(result.similarity).toBeCloseTo(1 - 2000 / 12000);
    const diff = await sharp(result.diffBuffer!).metadata();
    expect([diff.width, diff.height]).toEqual([100, 120]);
  });

  it('also counts changes inside the overlap, and works when the page shrank', async () => {
    const baseline = await makePng(100, 120, 0);
    const current = await makePng(100, 100, 10); // 10 changed rows, 20 rows gone

    const result = await engine.compare(baseline, current, { ...baseOptions, threshold: 0.1 });

    expect(result.success).toBe(true);
    expect(result.pixelDifference).toBe(10 * 100 + 20 * 100);
    expect(result.layoutChange?.current).toEqual({ width: 100, height: 100 });
  });

  it('handles different widths too, with the diff mask the runner uses', async () => {
    // Baseline wider, current taller: the overlap is 100x100, the canvas 120x120.
    // A row-stride slip in the crop or the canvas copy shows up as a wrong count.
    const baseline = await makePng(120, 100, 0);
    const current = await makePng(100, 120, 10); // 10 changed rows inside the overlap

    const result = await engine.compare(baseline, current, {
      ...baseOptions,
      diffMask: true,
      threshold: 0.1,
    });

    expect(result.pixelDifference).toBe(10 * 100 + (120 * 120 - 100 * 100));
    const { data, info } = await sharp(result.diffBuffer!)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([120, 120]);
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(50, 50)).toBe(0); // unchanged overlap: transparent under diffMask
    expect(alphaAt(50, 5)).toBe(255); // changed overlap row
    expect(alphaAt(110, 50)).toBe(255); // outside the overlap: counted as changed
  });

  it('refuses a pair whose shared canvas is too large, before decoding either', async () => {
    // Each fits (30M and 6M pixels), but a canvas holding both is 6000x6000 = 36M.
    const solid = (width: number, height: number) =>
      sharp({ create: { width, height, channels: 4, background: '#ffffff' } })
        .png()
        .toBuffer();
    const [wide, tall] = await Promise.all([solid(6000, 5000), solid(1000, 6000)]);
    const decode = jest.spyOn(sharp.prototype, 'raw');
    try {
      const result = await engine.compare(wide, tall, { ...baseOptions, threshold: 0.1 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/6000x6000/);
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it('refuses an image over the decode limit before decoding it, with a clear error', async () => {
    // 6000 x 6000 = 36M pixels, over the limit (1920 x 16384). Solid colour, so the
    // PNG itself is small: the bound is on decoded pixels, not on file size.
    const huge = await sharp({
      create: { width: 6000, height: 6000, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    expect(6000 * 6000).toBeGreaterThan(MAX_DECODED_PIXELS);
    const small = await makePng(100, 100, 0);
    const decode = jest.spyOn(sharp.prototype, 'raw');
    try {
      const result = await engine.compare(small, huge, { ...baseOptions, threshold: 0.1 });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/6000x6000.*36000000 pixels.*limit is 31457280/);
      // Refused from the headers: neither image is decoded.
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });
});

// Issue #283: pixelmatch's per-pixel `threshold` was fed `alpha` (the diff image's opacity
// for unchanged pixels). The engine's count must be pixelmatch's own for the same options.
describe('VisualDiffEngine pixelmatch option mapping (#283)', () => {
  const engine = new VisualDiffEngine();

  /** 50x50, every pixel the given grey. */
  const grey = (v: number) =>
    sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: v, g: v, b: v, alpha: 1 } },
    })
      .png()
      .toBuffer();
  const rgba = async (png: Buffer) => sharp(png).raw().ensureAlpha().toBuffer();

  it('uses pixelThreshold as the per-pixel threshold, independent of alpha', async () => {
    const [a, b] = await Promise.all([grey(255), grey(250)]); // a faint change everywhere
    const direct = (threshold: number) =>
      Promise.all([rgba(a), rgba(b)]).then(([x, y]) =>
        pixelmatch(x, y, undefined, 50, 50, { threshold, includeAA: false }),
      );
    expect(await direct(0)).toBe(2500); // pixelmatch itself: at 0 every faint change counts
    expect(await direct(0.1)).toBe(0); // and at its default 0.1 none does

    for (const alpha of [0.1, 0.9]) {
      const strict = await engine.compare(a, b, {
        ...baseOptions,
        alpha,
        pixelThreshold: 0,
        threshold: 0.5,
      });
      expect(strict.pixelDifference).toBe(await direct(0));
      const lenient = await engine.compare(a, b, { ...baseOptions, alpha, threshold: 0.5 });
      expect(lenient.pixelDifference).toBe(await direct(0.1)); // default per-pixel threshold
    }
  });
});
