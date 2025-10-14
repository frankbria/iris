# Accessibility Audit Example

This example demonstrates IRIS accessibility testing with WCAG 2.1 AA compliance validation, keyboard navigation testing, and screen reader simulation.

## What This Example Tests

- WCAG 2.1 Level A and AA compliance (axe-core integration)
- Keyboard navigation and focus order
- Focus trap detection
- Arrow key navigation patterns
- Escape key handling
- Screen reader compatibility (ARIA labels, landmarks, headings)
- Color contrast validation
- Image alt text verification

## Files

- `accessible-page.html` - Sample page with accessibility features
- `inaccessible-page.html` - Sample page with common a11y issues
- `test-a11y.sh` - Script to run accessibility tests
- `.irisrc` - IRIS configuration for accessibility testing
- `WCAG_GUIDE.md` - WCAG compliance quick reference

## Quick Start

### 1. Run the Example

```bash
# From this directory
cd examples/accessibility-audit

# Start HTTP server
npx http-server -p 8080 &
SERVER_PID=$!

# Test accessible page (should pass)
node ../../dist/cli.js a11y \
  --pages "http://localhost:8080/accessible-page.html" \
  --tags "wcag2a,wcag2aa" \
  --fail-on "critical,serious" \
  --include-keyboard

# Test inaccessible page (should fail with violations)
node ../../dist/cli.js a11y \
  --pages "http://localhost:8080/inaccessible-page.html" \
  --tags "wcag2a,wcag2aa" \
  --fail-on "critical,serious" \
  --format html \
  --output a11y-report.html

# Stop server
kill $SERVER_PID
```

Or use the provided script:

```bash
chmod +x test-a11y.sh
./test-a11y.sh
```

## Configuration

The `.irisrc` file configures accessibility testing:

```json
{
  "accessibility": {
    "tags": ["wcag2a", "wcag2aa", "wcag21aa"],
    "failOn": ["critical", "serious"],
    "keyboard": {
      "testFocusOrder": true,
      "testTrapDetection": true
    },
    "screenReader": {
      "testAriaLabels": true,
      "testLandmarkNavigation": true
    }
  }
}
```

### WCAG Tags

- `wcag2a` - Level A compliance (basic)
- `wcag2aa` - Level AA compliance (recommended)
- `wcag2aaa` - Level AAA compliance (enhanced)
- `wcag21a`, `wcag21aa` - WCAG 2.1 specific rules
- `best-practice` - Additional accessibility best practices

### Impact Levels

Violations are classified by impact:

- **Critical**: Severe accessibility barriers (missing lang, empty buttons)
- **Serious**: Significant barriers (color contrast, missing labels)
- **Moderate**: Notable issues (link text, heading order)
- **Minor**: Best practice violations (duplicate IDs)

## Understanding Results

### All Tests Pass
```bash
✅ All accessibility tests passed!
   Total violations: 0
   Accessibility score: 100/100
   Keyboard tests: 5/5 passed
```

### Tests Fail with Violations
```bash
❌ Accessibility violations found!
   Total violations: 8
   Accessibility score: 67/100

   Critical: 2
   - [html-has-lang] <html> element must have a lang attribute
   - [button-name] Buttons must have discernible text

   Serious: 4
   - [color-contrast] Elements must have sufficient color contrast
   - [label] Form elements must have labels

   Moderate: 2
   - [link-name] Links must have discernible text
   - [heading-order] Heading levels should increase by one

📋 Report generated: a11y-report.html
```

### Keyboard Test Results
```bash
Keyboard Navigation:
   ✓ Focus order follows DOM order
   ✓ No focus traps detected
   ✓ Arrow key navigation works
   ✓ Escape key closes modals
   ✗ Submit button not keyboard accessible
```

## Common Accessibility Issues

### 1. Missing Alt Text
```html
<!-- ❌ Inaccessible -->
<img src="logo.png">

<!-- ✅ Accessible -->
<img src="logo.png" alt="Company logo">
```

### 2. Poor Color Contrast
```css
/* ❌ Inaccessible (2.5:1 ratio) */
.text { color: #999; background: #fff; }

/* ✅ Accessible (4.5:1 ratio for normal text) */
.text { color: #595959; background: #fff; }
```

### 3. Missing Form Labels
```html
<!-- ❌ Inaccessible -->
<input type="email" placeholder="Email">

<!-- ✅ Accessible -->
<label for="email">Email</label>
<input type="email" id="email" name="email">
```

### 4. Non-semantic HTML
```html
<!-- ❌ Inaccessible -->
<div onclick="submit()">Submit</div>

<!-- ✅ Accessible -->
<button type="submit">Submit</button>
```

### 5. Missing ARIA Labels
```html
<!-- ❌ Inaccessible -->
<button><svg>...</svg></button>

<!-- ✅ Accessible -->
<button aria-label="Close dialog">
  <svg aria-hidden="true">...</svg>
</button>
```

## Keyboard Navigation Testing

IRIS automatically tests these keyboard patterns:

### Tab Navigation
```
Tab     → Move to next focusable element
Shift+Tab → Move to previous focusable element
```

Expected behavior:
- Focus order follows visual order
- All interactive elements are reachable
- Focus is clearly visible
- No keyboard traps

### Arrow Key Navigation
```
Arrow Up/Down   → Navigate lists/menus
Arrow Left/Right → Navigate tabs/sliders
```

Expected behavior:
- Arrow keys work in appropriate widgets
- Focus moves correctly within components
- Wrapping behavior is predictable

### Escape Key
```
Escape → Close modal/dialog/dropdown
```

Expected behavior:
- Closes overlay components
- Returns focus to trigger element
- Does not break page functionality

## Screen Reader Compatibility

IRIS tests screen reader compatibility by checking:

### ARIA Landmarks
```html
<header role="banner">
<nav role="navigation" aria-label="Main">
<main role="main">
<aside role="complementary">
<footer role="contentinfo">
```

### Heading Structure
```html
<h1>Page Title</h1>
  <h2>Section 1</h2>
    <h3>Subsection 1.1</h3>
    <h3>Subsection 1.2</h3>
  <h2>Section 2</h2>
```

No skipped levels (h1 → h3 without h2)

### Image Alt Text
```html
<!-- Informative images -->
<img src="chart.png" alt="Sales increased 40% in Q3">

<!-- Decorative images -->
<img src="decoration.png" alt="" role="presentation">
```

## Experiment Ideas

Try fixing these issues in `inaccessible-page.html`:

### Critical Fixes
1. Add `lang` attribute to `<html>`
2. Add text content to empty buttons
3. Fix form inputs without labels
4. Add alt text to images

### Serious Fixes
1. Improve color contrast ratios
2. Add ARIA labels to icon buttons
3. Fix heading level hierarchy
4. Add keyboard navigation to custom widgets

### Moderate Fixes
1. Add descriptive link text
2. Use semantic HTML elements
3. Add skip navigation link
4. Improve focus indicators

## Testing Strategies

### Progressive Testing
Start with basic compliance, then enhance:
```bash
# Level A only (basic)
iris a11y --tags wcag2a

# Level A + AA (recommended)
iris a11y --tags wcag2a,wcag2aa

# Level A + AA + AAA + best practices (comprehensive)
iris a11y --tags wcag2a,wcag2aa,wcag2aaa,best-practice
```

### Targeted Testing
Test specific rules or exclude others:
```bash
# Test only color contrast
iris a11y --rules color-contrast

# Exclude known issues
iris a11y --disable-rules duplicate-id,image-alt
```

### Severity-Based Testing
Fail on different impact levels:
```bash
# Fail only on critical issues (production)
iris a11y --fail-on critical

# Fail on critical + serious (staging)
iris a11y --fail-on critical,serious

# Fail on all violations (development)
iris a11y --fail-on critical,serious,moderate,minor
```

## CI/CD Integration

### GitHub Actions Example
```yaml
- name: Accessibility Tests
  run: |
    npm run build
    npx http-server dist -p 8080 &

    iris a11y \
      --pages "/" \
      --tags wcag2a,wcag2aa \
      --fail-on critical,serious \
      --format junit \
      --output test-results.xml

    if [ $? -ne 0 ]; then
      echo "::error::Accessibility violations detected"
      exit 1
    fi
```

## Troubleshooting

### False Positives
**Issue**: axe-core reports violations that aren't real issues
**Solution**: Use `--disable-rules` to exclude specific rules, or add aria attributes to clarify intent

### Keyboard Tests Fail
**Issue**: Keyboard navigation tests report failures
**Solution**: Check that custom widgets implement proper keyboard patterns (arrow keys, Enter, Escape)

### Low Score Despite Fixes
**Issue**: Accessibility score remains low after fixing issues
**Solution**: Score is weighted by severity. Fix critical/serious issues first for maximum impact

## Accessibility Score Calculation

The accessibility score (0-100) is calculated based on violations:

```
Score = 100 - (
  critical_count × 25 +
  serious_count × 10 +
  moderate_count × 5 +
  minor_count × 2
) / pages_tested
```

### Score Ranges
- **90-100**: Excellent accessibility
- **80-89**: Good accessibility with minor issues
- **70-79**: Acceptable with notable issues
- **60-69**: Needs improvement
- **0-59**: Significant barriers present

## Next Steps

- Try [basic-visual-test](../basic-visual-test) for visual regression
- Check [multi-device-visual](../multi-device-visual) for responsive a11y
- See [ci-cd-integration](../ci-cd-integration) for automation

## Learn More

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [axe-core Documentation](https://github.com/dequelabs/axe-core)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [IRIS A11y Module](../../src/a11y/)
