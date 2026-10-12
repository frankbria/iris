# Basic Visual Regression Testing Example

This example demonstrates IRIS visual regression testing capabilities with a simple web page.

## What This Example Tests

- Screenshot capture and comparison
- Pixel-based difference detection
- SSIM (Structural Similarity Index) analysis
- Baseline management with Git integration
- Basic change detection and severity classification

## Files

- `sample-page.html` - Simple web page to test
- `test-visual.sh` - Script to run visual tests
- `package.json` - Optional npm scripts

## Quick Start

### 1. Install IRIS (if not already installed)

```bash
cd ../..  # Navigate to IRIS root
npm install
npm run build
```

### 2. Run the Example

```bash
# From this directory
cd examples/basic-visual-test

# Start a simple HTTP server
npx http-server -p 8080 &
SERVER_PID=$!

# Capture baseline (first run)
node ../../dist/cli.js visual-diff \
  --pages "http://localhost:8080/sample-page.html" \
  --update-baseline

# Make changes to sample-page.html, then run comparison
node ../../dist/cli.js visual-diff \
  --pages "http://localhost:8080/sample-page.html" \
  --format html \
  --output visual-report.html

# Stop server
kill $SERVER_PID
```

Or use the provided script:

```bash
chmod +x test-visual.sh
./test-visual.sh
```

## Configuration Options

Visual testing is configured with `iris visual-diff` flags (IRIS reads no project
config file):

```bash
iris visual-diff --pages /sample-page.html --base-url http://localhost:8080 \
  --threshold 0.1 --baseline main --baseline-strategy branch
```

### Key Options

- `--threshold` (0-1): Pixel difference tolerance (0.1 = 10% difference allowed)
- `--baseline-strategy`: How to read `--baseline` (`branch`, `commit`, or `tag`)
- `--baseline`: Git reference for baseline comparison
- `--mask`: CSS selectors to mask before comparing (comma-separated)

Screenshots are always full-page PNGs.

## Understanding Results

### Passed Test
```bash
✅ All visual tests passed!
   Total comparisons: 1
   Passed: 1
   Failed: 0
```

### Failed Test with Differences
```bash
❌ Visual regression detected!
   Total comparisons: 1
   Passed: 0
   Failed: 1
   Breaking: 0
   Moderate: 1
   Minor: 0

📋 Report generated: visual-report.html
```

### Severity Levels

- **Breaking**: Major layout changes, missing elements (similarity < 85% or pixel diff > 15%)
- **Moderate**: Noticeable visual changes (similarity < 95% or pixel diff > 5%)
- **Minor**: Small differences (similarity > 95% and pixel diff < 5%)

## Expected Output Structure

```
.iris/
├── baselines/
│   └── sample-page_html_desktop.png
├── screenshots/
│   ├── current/
│   │   └── sample-page_html_desktop.png
│   └── diff/
│       └── sample-page_html_desktop.png  (only if differences detected)
└── visual-report.html
```

## Experiment Ideas

Try making these changes to `sample-page.html` to see different severity levels:

### Minor Changes
- Change text color slightly
- Adjust font size by 1-2px
- Add subtle shadow effects

### Moderate Changes
- Swap layout order of elements
- Change button sizes significantly
- Modify spacing/margins

### Breaking Changes
- Remove entire sections
- Change page layout structure
- Hide important elements

## Common Issues

### Server Not Running
```bash
Error: Failed to navigate to http://localhost:8080/sample-page.html
```
**Solution**: Make sure the HTTP server is running on port 8080.

### No Baseline Found
```bash
⚠️  No baseline found - creating new baseline
```
**Solution**: This is expected on first run. Use `--update-baseline` flag.

### Permission Errors
```bash
Error: EACCES: permission denied
```
**Solution**: Check file permissions or run with appropriate privileges.

## Next Steps

- Try [multi-device-visual](../multi-device-visual) for responsive testing
- Check [accessibility-audit](../accessibility-audit) for WCAG compliance
- See [ci-cd-integration](../ci-cd-integration) for automated testing

## Learn More

- [IRIS Visual Testing Documentation](../../docs/phase2_technical_architecture.md)
- [Visual Capture Engine](../../src/visual/capture.ts)
- [Visual Diff Engine](../../src/visual/diff.ts)
