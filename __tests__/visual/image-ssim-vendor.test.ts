import { compare, Channels, IImage } from '../../src/vendor/image-ssim';

// Real (unmocked) checks on the vendored SSIM implementation — the diff engine
// tests mock this module, so this file is what proves the algorithm itself.
describe('vendored image-ssim', () => {
  const rgbaImage = (fill: (i: number) => number, width = 16, height = 16): IImage => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 4 === 3 ? 255 : fill(i);
    }
    return { data, width, height, channels: Channels.RGBAlpha };
  };

  it('returns ssim=1 and mcs=1 for identical images', () => {
    const a = rgbaImage((i) => (i * 7) % 256);
    const b = rgbaImage((i) => (i * 7) % 256);
    const result = compare(a, b);
    expect(result.ssim).toBeCloseTo(1, 5);
    expect(result.mcs).toBeCloseTo(1, 5);
  });

  it('returns ssim<1 for differing images', () => {
    const a = rgbaImage(() => 30);
    const b = rgbaImage((i) => (i * 13) % 256);
    const result = compare(a, b);
    expect(result.ssim).toBeGreaterThanOrEqual(0);
    expect(result.ssim).toBeLessThan(0.9);
  });

  it('matches the upstream implementation on a pinned input (golden value)', () => {
    // Golden values computed with image-ssim@0.2.0 — guards the vendored math
    // (luma coefficients, SSIM formula) against accidental edits.
    const a = rgbaImage((i) => (i * 7) % 256);
    const b = rgbaImage((i) => (i * 13) % 256);
    const result = compare(a, b);
    expect(result.ssim).toBeCloseTo(0.04536884, 6);
    expect(result.mcs).toBeCloseTo(0.045378, 6);
  });

  it('handles Grey and RGB channel layouts', () => {
    const grey = (fill: (i: number) => number): IImage => {
      const data = new Uint8Array(16 * 16);
      for (let i = 0; i < data.length; i++) data[i] = fill(i);
      return { data, width: 16, height: 16, channels: Channels.Grey };
    };
    const rgb = (fill: (i: number) => number): IImage => {
      const data = new Uint8Array(16 * 16 * 3);
      for (let i = 0; i < data.length; i++) data[i] = fill(i);
      return { data, width: 16, height: 16, channels: Channels.RGB };
    };
    expect(compare(grey((i) => (i * 3) % 256), grey((i) => (i * 3) % 256)).ssim).toBeCloseTo(1, 5);
    expect(compare(rgb((i) => (i * 5) % 256), rgb((i) => (i * 5) % 256)).ssim).toBeCloseTo(1, 5);
    expect(compare(rgb(() => 40), rgb((i) => (i * 11) % 256)).ssim).toBeLessThan(0.9);
  });

  it('throws when image sizes differ', () => {
    const a = rgbaImage(() => 0, 16, 16);
    const b = rgbaImage(() => 0, 8, 8);
    expect(() => compare(a, b)).toThrow('Images have different sizes!');
  });
});
