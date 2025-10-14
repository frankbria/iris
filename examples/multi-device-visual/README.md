# Multi-Device Visual Regression Testing Example

This example demonstrates IRIS visual testing across multiple device types (desktop, tablet, mobile) to ensure responsive design works correctly.

## What This Example Tests

- Responsive design across device viewports
- Parallel multi-device screenshot capture
- Device-specific baseline management
- Cross-device visual consistency
- Adaptive layout regression detection

## Files

- `responsive-page.html` - Responsive web page with breakpoints
- `test-multidevice.sh` - Script to run multi-device tests
- `.irisrc` - IRIS configuration with device settings
- `RESULTS.md` - Expected test results guide

## Quick Start

### 1. Run the Example

```bash
# From this directory
cd examples/multi-device-visual

# Start HTTP server
npx http-server -p 8080 &
SERVER_PID=$!

# Create baselines for all devices
node ../../dist/cli.js visual-diff \
  --pages "http://localhost:8080/responsive-page.html" \
  --devices "desktop,tablet,mobile" \
  --update-baseline

# Run comparison across devices
node ../../dist/cli.js visual-diff \
  --pages "http://localhost:8080/responsive-page.html" \
  --devices "desktop,tablet,mobile" \
  --format html \
  --output multi-device-report.html

# Stop server
kill $SERVER_PID
```

Or use the provided script:

```bash
chmod +x test-multidevice.sh
./test-multidevice.sh
```

## Device Configurations

IRIS tests these device viewports by default:

| Device Type | Width | Height | Use Case |
|-------------|-------|--------|----------|
| Desktop | 1920px | 1080px | Standard desktop monitors |
| Laptop | 1366px | 768px | Smaller laptops |
| Tablet | 768px | 1024px | iPad and similar tablets |
| Mobile | 375px | 667px | iPhone and similar phones |

## Configuration

The `.irisrc` file configures multi-device testing:

```json
{
  "visual": {
    "devices": ["desktop", "tablet", "mobile"],
    "diff": {
      "maxConcurrency": 3
    }
  }
}
```

### Concurrency Control

The `maxConcurrency` setting controls how many devices are tested in parallel:

- **Low (1-2)**: Conservative, good for limited resources
- **Medium (3-4)**: Balanced performance and resource usage
- **High (5+)**: Maximum speed, requires powerful hardware

## Understanding Multi-Device Results

### All Devices Pass
```bash
✅ All visual tests passed!
   Total comparisons: 3
   Passed: 3 (desktop: 1, tablet: 1, mobile: 1)
   Failed: 0
```

### Device-Specific Failure
```bash
❌ Visual regression detected!
   Total comparisons: 3
   Passed: 2 (desktop: 1, tablet: 1)
   Failed: 1 (mobile: 1)

   Mobile regression:
   - Similarity: 87%
   - Severity: moderate
   - Pixel diff: 8.5%
```

## Output Structure

```
.iris/
├── baselines/
│   ├── responsive-page_html_desktop.png
│   ├── responsive-page_html_tablet.png
│   └── responsive-page_html_mobile.png
├── screenshots/
│   ├── current/
│   │   ├── responsive-page_html_desktop/
│   │   ├── responsive-page_html_tablet/
│   │   └── responsive-page_html_mobile/
│   └── diff/
│       └── responsive-page_html_mobile/  (only if differences)
└── multi-device-report.html
```

## Common Responsive Issues to Test

### Layout Shifts
```css
/* Desktop: 3 columns */
.grid { display: grid; grid-template-columns: repeat(3, 1fr); }

/* Tablet: 2 columns */
@media (max-width: 768px) {
  .grid { grid-template-columns: repeat(2, 1fr); }
}

/* Mobile: 1 column */
@media (max-width: 480px) {
  .grid { grid-template-columns: 1fr; }
}
```

### Text Overflow
```css
/* Ensure text doesn't break layout on mobile */
.card-title {
  font-size: 1.5rem;
  overflow-wrap: break-word;
}

@media (max-width: 480px) {
  .card-title { font-size: 1.2rem; }
}
```

### Navigation Changes
```css
/* Desktop: horizontal nav */
.nav { display: flex; flex-direction: row; }

/* Mobile: hamburger menu */
@media (max-width: 768px) {
  .nav { flex-direction: column; display: none; }
  .nav.open { display: flex; }
}
```

## Experiment Ideas

Try making these device-specific changes to test visual regression:

### Desktop-Only Changes
- Modify desktop grid layout
- Change large viewport font sizes
- Adjust wide-screen spacing

### Tablet-Specific Issues
- Break two-column layout
- Incorrect image sizing
- Navigation button positioning

### Mobile Regressions
- Text overflow from containers
- Hidden important buttons
- Broken hamburger menu
- Touch target sizes too small

## Testing Strategies

### Progressive Enhancement
Test that mobile-first designs scale up correctly:
```bash
# Test mobile baseline first
iris visual-diff --devices mobile --update-baseline

# Then test tablet and desktop
iris visual-diff --devices tablet,desktop
```

### Graceful Degradation
Test that desktop designs adapt down correctly:
```bash
# Test desktop baseline first
iris visual-diff --devices desktop --update-baseline

# Then test smaller devices
iris visual-diff --devices tablet,mobile
```

### Breakpoint Validation
Test at specific breakpoint widths:
```bash
iris visual-diff \
  --pages "http://localhost:8080/responsive-page.html" \
  --devices "desktop" \
  --viewport-width 1024  # Test at breakpoint
```

## Performance Considerations

### Parallel Execution
Multi-device tests run in parallel by default:
- 3 devices × 1 page = 3 parallel tests
- 3 devices × 5 pages = 15 tests (limited by concurrency setting)

### Resource Usage
Each device test requires:
- Browser context: ~50-100MB RAM
- Screenshot: 1-5MB disk space
- Processing: 1-3 seconds per page

## CI/CD Integration

For GitHub Actions, run multi-device tests efficiently:
```yaml
- name: Visual Regression Tests
  run: |
    npm run build
    npx http-server dist -p 8080 &

    iris visual-diff \
      --devices desktop,tablet,mobile \
      --fail-on moderate \
      --format junit \
      --output test-results.xml
```

## Troubleshooting

### Different Results Locally vs CI
**Cause**: Font rendering differences between environments
**Solution**: Use `waitForFonts: true` in stabilization config

### Flaky Mobile Tests
**Cause**: Dynamic content or animations not disabled
**Solution**: Increase `stabilization.delay` or add mask selectors

### High Memory Usage
**Cause**: Too many parallel device contexts
**Solution**: Reduce `maxConcurrency` to 1-2

## Next Steps

- Try [accessibility-audit](../accessibility-audit) for mobile a11y testing
- Check [ci-cd-integration](../ci-cd-integration) for automated workflows
- See [basic-visual-test](../basic-visual-test) for fundamentals

## Learn More

- [Responsive Design Testing Patterns](../../docs/phase2_technical_architecture.md#responsive-testing)
- [Device Configuration Guide](../../docs/phase2_technical_architecture.md#device-viewports)
- [Performance Optimization](../../docs/phase2_technical_architecture.md#performance)
