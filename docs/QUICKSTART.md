# IRIS Quick Start Guide

Get started with IRIS in 5 minutes.

## Installation

```bash
# Clone the repository
git clone https://github.com/frankbria/iris.git
cd iris

# Install dependencies
npm install

# Build the project
npm run build
```

## Phase 1: Natural Language Commands

### Basic Usage

```bash
# Simple navigation
npm start run "navigate to https://example.com"

# Click elements
npm start run "click #submit-button"
npm start run "click .login-link"

# Fill forms
npm start run "fill #email with user@example.com"
npm start run "fill #password with secretpass123"

# Take screenshots
npm start run "navigate to https://example.com and take screenshot"
```

### With AI Translation (OpenAI/Claude)

```bash
# Set up API key
export OPENAI_API_KEY=sk-your-key-here
# or
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Natural language commands
npm start run "find the blue button next to the search box and click it"
npm start run "fill out the contact form with test data"
npm start run "scroll to the bottom of the page"
```

### File Watching

```bash
# Watch files and auto-execute on changes
npm start watch src/ --instruction "reload page"

# With browser execution
npm start watch "**/*.ts" --execute --instruction "click .refresh"
```

### JSON-RPC Server

```bash
# Start WebSocket server (default port 4000)
npm start connect

# Custom port
npm start connect 8080
```

## Phase 2: Visual Regression Testing (CLI)

### Run Visual Tests

```bash
# Test homepage
npm start visual-diff --pages /

# Multiple pages
npm start visual-diff --pages "/,/products,/about"

# With AI semantic analysis
npm start visual-diff --pages / --semantic

# Update baselines
npm start visual-diff --pages / --update-baseline

# Custom threshold
npm start visual-diff --pages / --threshold 0.05

# Multiple devices
npm start visual-diff --pages / --devices "desktop,mobile,tablet"

# Generate HTML report
npm start visual-diff --pages / --format html --output ./reports/visual.html
```

### Visual Test Options

```bash
--pages <patterns>        # Pages to test (comma-separated)
--baseline <reference>    # Git branch/commit for baselines (default: main)
--semantic               # Enable AI analysis
--threshold <value>      # Similarity threshold 0-1 (default: 0.1)
--devices <list>         # Device types (default: desktop)
--format <type>          # Report format: html, json, junit
--output <path>          # Output file path
--fail-on <severity>     # Fail threshold: minor, moderate, breaking
--update-baseline        # Update baselines with current screenshots
--mask <selectors>       # CSS selectors to mask (comma-separated)
--concurrency <number>   # Max parallel comparisons (default: 3)
```

## Phase 2: Accessibility Testing (CLI)

### Run Accessibility Tests

```bash
# Test homepage for WCAG 2.0 AA
npm start a11y --pages /

# Multiple pages
npm start a11y --pages "/,/products,/about"

# WCAG 2.1 AA compliance
npm start a11y --pages / --tags "wcag2a,wcag2aa,wcag21aa"

# Include keyboard navigation tests
npm start a11y --pages / --include-keyboard

# Include screen reader simulation
npm start a11y --pages / --include-screenreader

# Fail only on critical/serious
npm start a11y --pages / --fail-on "critical,serious"

# Generate HTML report
npm start a11y --pages / --format html --output ./reports/a11y.html
```

### Accessibility Test Options

```bash
--pages <patterns>        # Pages to test (comma-separated)
--rules <rules>           # Specific axe rules (comma-separated)
--tags <tags>             # Rule tags: wcag2a, wcag2aa, wcag21aa
--fail-on <impacts>       # Impact levels to fail on
--format <type>           # Report format: html, json, junit
--output <path>           # Output file path
--include-keyboard        # Test keyboard navigation (default: true)
--include-screenreader    # Test screen reader simulation
```

## Configuration

### Environment Variables

```bash
# AI Providers
export OPENAI_API_KEY=sk-your-key
export ANTHROPIC_API_KEY=sk-ant-your-key
export OLLAMA_ENDPOINT=http://localhost:11434
export OLLAMA_MODEL=llama2

# Database
export IRIS_DB_PATH=~/.iris/iris.db
```

### Config File (~/.iris/config.json)

```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "visual": {
    "baseline": {
      "strategy": "branch",
      "reference": "main"
    },
    "threshold": 0.1,
    "semanticAnalysis": false
  },
  "a11y": {
    "tags": ["wcag2a", "wcag2aa"],
    "failOn": ["critical", "serious"]
  }
}
```

## Examples

### Complete Visual Regression Workflow

```bash
# 1. Set baseline (run on main branch)
git checkout main
npm start visual-diff --pages "/" --update-baseline

# 2. Make changes (on feature branch)
git checkout feature/redesign

# 3. Test for regressions
npm start visual-diff --pages "/" --semantic

# 4. Review report
open ./reports/visual-regression-report.html

# 5. Update baseline if changes are intentional
npm start visual-diff --pages "/" --update-baseline
```

### Complete Accessibility Workflow

```bash
# 1. Run comprehensive accessibility audit
npm start a11y --pages "/,/products,/about" \
  --tags "wcag2a,wcag2aa,wcag21aa" \
  --include-keyboard \
  --include-screenreader \
  --format html \
  --output ./reports/a11y-report.html

# 2. Review violations
open ./reports/a11y-report.html

# 3. Fix issues and re-test
npm start a11y --pages "/" --fail-on "critical,serious"

# 4. Generate JUnit report for CI
npm start a11y --pages "/" --format junit --output ./test-results/a11y-junit.xml
```

## Next Steps

- **API Documentation**: See [docs/api/visual-testing.md](./api/visual-testing.md) and [docs/api/accessibility-testing.md](./api/accessibility-testing.md)
- **Comprehensive Guides**: See [docs/guides/](./guides/)
- **CI/CD Integration**: See [docs/guides/ci-cd-integration.md](./guides/ci-cd-integration.md)
- **Development Guide**: See [docs/DEVELOPMENT_INSTRUCTIONS.md](./DEVELOPMENT_INSTRUCTIONS.md)

## Common Issues

### Browser Not Found

```bash
# Install Playwright browsers
npx playwright install chromium
```

### API Key Not Set

```bash
# Set OpenAI key
export OPENAI_API_KEY=sk-your-key

# Verify
echo $OPENAI_API_KEY
```

### Permission Errors

```bash
# Ensure .iris directory exists
mkdir -p ~/.iris
chmod 755 ~/.iris
```

### Module Not Found

```bash
# Rebuild the project
npm run build
```

## Support

- **Documentation**: [docs/](./docs/)
- **Issues**: [github.com/frankbria/iris/issues](https://github.com/frankbria/iris/issues)
- **Twitter**: [@FrankBria18044](https://twitter.com/FrankBria18044)
