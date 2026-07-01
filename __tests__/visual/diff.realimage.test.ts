import sharp from 'sharp';
import { VisualDiffEngine } from '../../src/visual/diff';
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
