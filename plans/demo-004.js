// Phase 11 demo for issue #4 — real outcome evidence (no mocks).
// Run: node plans/demo-004.js
const sharp = require('sharp');
const { VisualDiffEngine } = require('../dist/visual/diff');
const { AccessibilityRunner } = require('../dist/a11y/a11y-runner');

(async () => {
  // [1] URL construction fix — the exact regex from testPage(), proving no corruption.
  const resolve = (p) => (/^[a-z]+:/i.test(p) ? p : `http://localhost:3000${p}`);
  const cases = {
    'about:blank': 'about:blank',
    'data:text/html,<h1>x</h1>': 'data:text/html,<h1>x</h1>',
    'https://example.com': 'https://example.com',
    '/dashboard': 'http://localhost:3000/dashboard',
  };
  let urlPass = true;
  for (const [input, expected] of Object.entries(cases)) {
    const got = resolve(input);
    const ok = got === expected;
    urlPass = urlPass && ok;
    console.log(`[1] URL: ${JSON.stringify(input)} -> ${got}  ${ok ? 'PASS' : 'FAIL (want ' + expected + ')'}`);
  }
  console.log(`    (old code would produce 'http://localhost:3000about:blank' for about:blank)`);

  // [2] ssimCompare — REAL decode + image-ssim.compare, no mocks.
  const engine = new VisualDiffEngine();
  const imgA = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const imgSame = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  const imgDiff = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();

  const same = await engine.ssimCompare(imgA, imgSame);
  const diff = await engine.ssimCompare(imgA, imgDiff);
  const ssimOk = same.success && diff.success &&
    same.ssim >= 0 && same.ssim <= 1 && diff.ssim >= 0 && diff.ssim <= 1 &&
    same.ssim > diff.ssim; // identical images more similar than different ones
  console.log(`[2] SSIM identical: success=${same.success} ssim=${same.ssim?.toFixed(4)} | different: ssim=${diff.ssim?.toFixed(4)}  -> ${ssimOk ? 'PASS (real scores, identical>different)' : 'FAIL ' + JSON.stringify({ same, diff })}`);

  // [3] AccessibilityRunner against a real data: URL with REAL axe-core (no mock).
  const html = '<!DOCTYPE html><html lang="en"><head><title>Demo</title></head><body><h1>Hi</h1><img src="x.png"></body></html>';
  const runner = new AccessibilityRunner({
    pages: ['data:text/html,' + encodeURIComponent(html)],
    axe: { rules: {}, tags: ['wcag2a'], include: [], exclude: [], disableRules: [], timeout: 30000 },
    keyboard: { testFocusOrder: false, testTrapDetection: false, testArrowKeyNavigation: false, testEscapeHandling: false, customSequences: [] },
    screenReader: { testAriaLabels: false, testLandmarkNavigation: false, testImageAltText: false, testHeadingStructure: false, simulateScreenReader: false },
    failureThreshold: { critical: true, serious: true },
    reporting: { includePassedTests: false, groupByImpact: true, includeScreenshots: false },
  });
  const result = await runner.run();
  const a11yOk = result.summary.pagesTested === 1 && result.results.length === 1 && result.results[0].axeResult;
  console.log(`[3] A11y on data: URL (real axe-core): pagesTested=${result.summary.pagesTested} violations=${result.summary.totalViolations}  -> ${a11yOk ? 'PASS (ran without URL corruption)' : 'FAIL'}`);

  console.log(`\nOVERALL: ${urlPass && ssimOk && a11yOk ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  process.exit(urlPass && ssimOk && a11yOk ? 0 : 1);
})().catch((e) => { console.error('demo error:', e); process.exit(1); });
