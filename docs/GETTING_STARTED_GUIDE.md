# IRIS Getting Started Guide - Development Environment Setup

Complete step-by-step guide for creating a sample repository and testing IRIS visual regression and accessibility testing capabilities.

**Time Required**: 15-20 minutes
**Prerequisites**: Node.js 18+, Git

---

## Table of Contents

1. [Quick Start (5 minutes)](#quick-start-5-minutes)
2. [Full Setup (20 minutes)](#full-setup-20-minutes)
3. [Testing Visual Regression](#testing-visual-regression)
4. [Testing Accessibility](#testing-accessibility)
5. [AI Semantic Analysis](#ai-semantic-analysis)
6. [CI/CD Integration](#cicd-integration)
7. [Troubleshooting](#troubleshooting)

---

## Quick Start (5 minutes)

### Step 1: Install IRIS Globally

```bash
# Clone the IRIS repository
git clone https://github.com/frankbria/iris.git
cd iris

# Install dependencies
npm install

# Build the project
npm run build

# Link globally for system-wide access
npm link

# Verify installation
iris --version
iris --help
```

**Expected Output:**
```
iris 0.0.1
```

### Step 2: Use Pre-Built Examples

```bash
# Navigate to a pre-built example
cd examples/basic-visual-test

# Make test script executable
chmod +x test-visual.sh

# Run visual regression test
./test-visual.sh
```

**What This Does:**
- Starts a local HTTP server
- Captures baseline screenshots
- Runs visual comparison
- Generates HTML report
- Opens report in browser

**Success Indicator:**
- HTML report generated in `.iris/reports/`
- Console shows "✓ All visual tests passed"
- Browser opens showing diff results

---

## Full Setup (20 minutes)

### Step 1: Create Sample Test Repository

```bash
# Create new test project directory
mkdir iris-test-project
cd iris-test-project

# Initialize Git repository
git init
git checkout -b main

# Initialize npm project
npm init -y

# Install IRIS as dependency (if not using global install)
# npm install /path/to/iris

# Create project structure
mkdir -p pages
mkdir -p tests
```

### Step 2: Create Sample HTML Pages

**Create `pages/homepage.html`:**

```bash
cat > pages/homepage.html << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sample Homepage - IRIS Test</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            line-height: 1.6;
            color: #333;
        }

        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            text-align: center;
        }

        nav {
            background: #2d3748;
            padding: 1rem;
        }

        nav ul {
            list-style: none;
            display: flex;
            justify-content: center;
            gap: 2rem;
        }

        nav a {
            color: white;
            text-decoration: none;
            font-weight: 500;
            transition: color 0.3s;
        }

        nav a:hover {
            color: #667eea;
        }

        main {
            max-width: 1200px;
            margin: 2rem auto;
            padding: 0 2rem;
        }

        .hero {
            text-align: center;
            padding: 4rem 2rem;
            background: #f7fafc;
            border-radius: 8px;
            margin-bottom: 2rem;
        }

        .hero h2 {
            font-size: 2.5rem;
            margin-bottom: 1rem;
            color: #2d3748;
        }

        .hero p {
            font-size: 1.25rem;
            color: #4a5568;
            margin-bottom: 2rem;
        }

        .cta-button {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 1rem 2rem;
            border-radius: 6px;
            text-decoration: none;
            font-weight: 600;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            margin-top: 3rem;
        }

        .feature-card {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s;
        }

        .feature-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        }

        .feature-card h3 {
            color: #667eea;
            margin-bottom: 1rem;
        }

        footer {
            background: #2d3748;
            color: white;
            text-align: center;
            padding: 2rem;
            margin-top: 4rem;
        }
    </style>
</head>
<body>
    <header role="banner">
        <h1>Welcome to IRIS Testing</h1>
        <p>Visual Regression & Accessibility Testing Made Simple</p>
    </header>

    <nav role="navigation" aria-label="Main navigation">
        <ul>
            <li><a href="#home">Home</a></li>
            <li><a href="#features">Features</a></li>
            <li><a href="#docs">Documentation</a></li>
            <li><a href="#contact">Contact</a></li>
        </ul>
    </nav>

    <main role="main">
        <section class="hero">
            <h2>Automated Visual Testing</h2>
            <p>Catch visual regressions before they reach production</p>
            <a href="#get-started" class="cta-button" role="button">Get Started</a>
        </section>

        <section class="features" id="features">
            <article class="feature-card">
                <h3>Visual Regression Testing</h3>
                <p>Automatically detect visual changes across your application with pixel-perfect accuracy.</p>
            </article>

            <article class="feature-card">
                <h3>AI-Powered Analysis</h3>
                <p>Semantic understanding of visual changes using GPT-4 Vision, Claude, or Ollama.</p>
            </article>

            <article class="feature-card">
                <h3>WCAG Compliance</h3>
                <p>Ensure accessibility compliance with automated WCAG 2.1 Level AA/AAA testing.</p>
            </article>

            <article class="feature-card">
                <h3>Multi-Device Testing</h3>
                <p>Test responsive designs across desktop, tablet, and mobile viewports.</p>
            </article>

            <article class="feature-card">
                <h3>CI/CD Ready</h3>
                <p>Integrate seamlessly with GitHub Actions, GitLab CI, Jenkins, and CircleCI.</p>
            </article>

            <article class="feature-card">
                <h3>Detailed Reports</h3>
                <p>Interactive HTML reports with side-by-side comparisons and diff visualizations.</p>
            </article>
        </section>
    </main>

    <footer role="contentinfo">
        <p>&copy; 2025 IRIS Testing Suite. Open Source MIT License.</p>
    </footer>
</body>
</html>
EOF
```

**Create `pages/homepage-modified.html` (for testing changes):**

```bash
cat > pages/homepage-modified.html << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sample Homepage - IRIS Test (Modified)</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            line-height: 1.6;
            color: #333;
        }

        header {
            /* CHANGED: Different gradient colors */
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            padding: 2rem;
            text-align: center;
        }

        nav {
            background: #2d3748;
            padding: 1rem;
        }

        nav ul {
            list-style: none;
            display: flex;
            justify-content: center;
            gap: 2rem;
        }

        nav a {
            color: white;
            text-decoration: none;
            font-weight: 500;
            transition: color 0.3s;
        }

        nav a:hover {
            color: #f093fb;
        }

        main {
            max-width: 1200px;
            margin: 2rem auto;
            padding: 0 2rem;
        }

        .hero {
            text-align: center;
            padding: 4rem 2rem;
            background: #f7fafc;
            border-radius: 8px;
            margin-bottom: 2rem;
        }

        .hero h2 {
            font-size: 2.5rem;
            margin-bottom: 1rem;
            color: #2d3748;
            /* CHANGED: Added text transform */
            text-transform: uppercase;
        }

        .hero p {
            font-size: 1.25rem;
            color: #4a5568;
            margin-bottom: 2rem;
        }

        .cta-button {
            display: inline-block;
            /* CHANGED: Different button color */
            background: #f5576c;
            color: white;
            padding: 1rem 2rem;
            border-radius: 6px;
            text-decoration: none;
            font-weight: 600;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(245, 87, 108, 0.4);
        }

        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            margin-top: 3rem;
        }

        .feature-card {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s;
        }

        .feature-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        }

        .feature-card h3 {
            /* CHANGED: Different heading color */
            color: #f5576c;
            margin-bottom: 1rem;
        }

        footer {
            background: #2d3748;
            color: white;
            text-align: center;
            padding: 2rem;
            margin-top: 4rem;
        }
    </style>
</head>
<body>
    <header role="banner">
        <h1>Welcome to IRIS Testing</h1>
        <p>Visual Regression & Accessibility Testing Made Simple</p>
    </header>

    <nav role="navigation" aria-label="Main navigation">
        <ul>
            <li><a href="#home">Home</a></li>
            <li><a href="#features">Features</a></li>
            <li><a href="#docs">Documentation</a></li>
            <li><a href="#contact">Contact</a></li>
        </ul>
    </nav>

    <main role="main">
        <section class="hero">
            <h2>Automated Visual Testing</h2>
            <p>Catch visual regressions before they reach production</p>
            <a href="#get-started" class="cta-button" role="button">Get Started</a>
        </section>

        <section class="features" id="features">
            <article class="feature-card">
                <h3>Visual Regression Testing</h3>
                <p>Automatically detect visual changes across your application with pixel-perfect accuracy.</p>
            </article>

            <article class="feature-card">
                <h3>AI-Powered Analysis</h3>
                <p>Semantic understanding of visual changes using GPT-4 Vision, Claude, or Ollama.</p>
            </article>

            <article class="feature-card">
                <h3>WCAG Compliance</h3>
                <p>Ensure accessibility compliance with automated WCAG 2.1 Level AA/AAA testing.</p>
            </article>

            <article class="feature-card">
                <h3>Multi-Device Testing</h3>
                <p>Test responsive designs across desktop, tablet, and mobile viewports.</p>
            </article>

            <article class="feature-card">
                <h3>CI/CD Ready</h3>
                <p>Integrate seamlessly with GitHub Actions, GitLab CI, Jenkins, and CircleCI.</p>
            </article>

            <article class="feature-card">
                <h3>Detailed Reports</h3>
                <p>Interactive HTML reports with side-by-side comparisons and diff visualizations.</p>
            </article>
        </section>
    </main>

    <footer role="contentinfo">
        <p>&copy; 2025 IRIS Testing Suite. Open Source MIT License.</p>
    </footer>
</body>
</html>
EOF
```

### Step 3: Create Test Scripts

**Create `tests/run-visual-test.sh`:**

```bash
cat > tests/run-visual-test.sh << 'EOF'
#!/bin/bash

# IRIS Visual Regression Test Script
set -e

echo "🎨 IRIS Visual Regression Testing"
echo "=================================="
echo ""

# Start simple HTTP server in background
echo "📡 Starting local server..."
cd ..
python3 -m http.server 8080 --directory pages > /dev/null 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
sleep 2

# Create baseline on main branch
echo "📸 Creating baseline screenshots..."
git checkout -b baseline-branch 2>/dev/null || git checkout baseline-branch
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --baseline main \
  --devices desktop \
  --format html \
  --output .iris/reports/baseline-report.html

echo "✅ Baseline created"
echo ""

# Switch to test branch and make changes
echo "🔄 Switching to test branch..."
git checkout -b feature-branch 2>/dev/null || git checkout feature-branch

# Copy modified version
cp pages/homepage-modified.html pages/homepage.html

echo "🔍 Running visual diff against baseline..."
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --baseline baseline-branch \
  --devices desktop \
  --threshold 0.1 \
  --format html \
  --output .iris/reports/diff-report.html

echo ""
echo "✅ Visual regression test complete!"
echo "📊 Report: .iris/reports/diff-report.html"

# Cleanup
kill $SERVER_PID 2>/dev/null || true

# Restore original file
git checkout baseline-branch
cp pages/homepage.html pages/homepage-original.html
git checkout feature-branch
mv pages/homepage-original.html pages/homepage.html

echo ""
echo "🎉 Test complete! Check the HTML report for results."
EOF

chmod +x tests/run-visual-test.sh
```

**Create `tests/run-a11y-test.sh`:**

```bash
cat > tests/run-a11y-test.sh << 'EOF'
#!/bin/bash

# IRIS Accessibility Test Script
set -e

echo "♿ IRIS Accessibility Testing"
echo "=============================="
echo ""

# Start simple HTTP server in background
echo "📡 Starting local server..."
cd ..
python3 -m http.server 8080 --directory pages > /dev/null 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
sleep 2

echo "🔍 Running WCAG 2.1 AA compliance tests..."
iris a11y \
  --pages "http://localhost:8080/homepage.html" \
  --tags wcag2a,wcag2aa \
  --fail-on critical,serious \
  --format html \
  --output .iris/reports/a11y-report.html \
  --include-keyboard \
  --include-screenreader

echo ""
echo "✅ Accessibility test complete!"
echo "📊 Report: .iris/reports/a11y-report.html"

# Cleanup
kill $SERVER_PID 2>/dev/null || true

echo ""
echo "🎉 Test complete! Check the HTML report for results."
EOF

chmod +x tests/run-a11y-test.sh
```

### Step 4: Create IRIS Configuration

**Create `.irisrc` configuration file:**

```bash
cat > .irisrc << 'EOF'
{
  "visual": {
    "threshold": 0.1,
    "devices": ["desktop", "tablet", "mobile"],
    "baseline": {
      "strategy": "branch",
      "reference": "main"
    },
    "capture": {
      "waitForFonts": true,
      "disableAnimations": true,
      "stabilizationDelay": 500
    },
    "comparison": {
      "ignoreAntialiasing": true,
      "ssimThreshold": 0.95
    }
  },
  "accessibility": {
    "wcagLevel": "AA",
    "includeKeyboard": true,
    "includeScreenReader": true,
    "failureThreshold": {
      "critical": true,
      "serious": true,
      "moderate": false,
      "minor": false
    }
  },
  "reporting": {
    "format": "html",
    "outputDir": ".iris/reports",
    "includePassedTests": false
  }
}
EOF
```

### Step 5: Initial Git Commit

```bash
# Add all files
git add .

# Commit baseline
git commit -m "Initial commit: baseline HTML pages and test configuration"

# Create main branch
git branch -M main
```

---

## Testing Visual Regression

### Basic Visual Test

```bash
cd tests
./run-visual-test.sh
```

**What Happens:**
1. Starts local HTTP server on port 8080
2. Creates baseline branch and captures screenshots
3. Switches to feature branch with modified HTML
4. Runs visual comparison
5. Generates HTML report with diff visualization
6. Opens report in browser

**Expected Output:**
```
🎨 IRIS Visual Regression Testing
==================================

📡 Starting local server...
📸 Creating baseline screenshots...
✅ Baseline created

🔄 Switching to test branch...
🔍 Running visual diff against baseline...

✅ Visual regression test complete!
📊 Report: .iris/reports/diff-report.html

🎉 Test complete! Check the HTML report for results.
```

### Manual Visual Test Steps

```bash
# Start server
python3 -m http.server 8080 --directory pages &

# Capture baseline
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --baseline main \
  --update-baseline

# Make changes to homepage.html (edit CSS, content, etc.)

# Run comparison
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --baseline main \
  --threshold 0.05 \
  --format html

# View report
open .iris/reports/visual-diff-*.html
```

### Multi-Device Testing

```bash
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --devices desktop,tablet,mobile \
  --baseline main \
  --format html
```

**Output:**
- Desktop: 1920x1080 screenshots
- Tablet: 768x1024 screenshots
- Mobile: 375x667 screenshots

---

## Testing Accessibility

### Basic Accessibility Test

```bash
cd tests
./run-a11y-test.sh
```

**What Happens:**
1. Starts local HTTP server
2. Runs axe-core WCAG 2.1 AA/AAA scans
3. Tests keyboard navigation (Tab order, focus traps)
4. Simulates screen reader (ARIA labels, landmarks, headings)
5. Generates detailed HTML report

**Expected Output:**
```
♿ IRIS Accessibility Testing
==============================

📡 Starting local server...
🔍 Running WCAG 2.1 AA compliance tests...

Accessibility Score: 95/100
✅ 0 critical violations
✅ 0 serious violations
⚠️  2 moderate violations
ℹ️  5 minor violations

✅ Accessibility test complete!
📊 Report: .iris/reports/a11y-report.html
```

### Manual Accessibility Test

```bash
# Start server
python3 -m http.server 8080 --directory pages &

# Run accessibility scan
iris a11y \
  --pages "http://localhost:8080/homepage.html" \
  --tags wcag2a,wcag2aa,wcag21aa \
  --include-keyboard \
  --include-screenreader \
  --format html

# View report
open .iris/reports/a11y-*.html
```

### Keyboard Navigation Testing Only

```bash
iris a11y \
  --pages "http://localhost:8080/homepage.html" \
  --include-keyboard \
  --format json \
  --output keyboard-test.json
```

**Tests:**
- Tab order validation
- Focus trap detection
- Arrow key navigation
- Escape key handling

---

## AI Semantic Analysis

### Setup AI Provider

**Option 1: OpenAI (Recommended)**

```bash
export OPENAI_API_KEY="sk-your-openai-key-here"

# Or add to ~/.bashrc or ~/.zshrc
echo 'export OPENAI_API_KEY="sk-your-key"' >> ~/.bashrc
```

**Option 2: Anthropic Claude**

```bash
export ANTHROPIC_API_KEY="sk-ant-your-anthropic-key-here"
```

**Option 3: Ollama (Free, Local)**

```bash
# Install Ollama
curl https://ollama.ai/install.sh | sh

# Pull vision model
ollama pull llava

# Start Ollama server (if not auto-started)
ollama serve

# Set endpoint
export OLLAMA_ENDPOINT="http://localhost:11434"
export OLLAMA_MODEL="llava:latest"
```

### Configure AI Provider

**Create/Edit `~/.iris/config.json`:**

```bash
mkdir -p ~/.iris
cat > ~/.iris/config.json << 'EOF'
{
  "ai": {
    "provider": "openai",
    "apiKey": "sk-your-key-here",
    "model": "gpt-4-vision-preview"
  },
  "visual": {
    "semantic": {
      "enabled": true,
      "confidence": 0.7
    }
  }
}
EOF
```

### Run Visual Test with AI Analysis

```bash
# Start server
python3 -m http.server 8080 --directory pages &

# Run with AI semantic analysis
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --baseline main \
  --semantic \
  --format html

# View AI analysis in report
open .iris/reports/visual-diff-*.html
```

**AI Analysis Provides:**
- **Classification**: Intentional change vs. regression
- **Confidence**: 0-1 score (e.g., 0.92 = 92% confident)
- **Change Type**: Layout, color, content, typography
- **Severity**: Low, medium, high, critical
- **Reasoning**: Detailed explanation
- **Suggestions**: Actionable recommendations
- **Regions**: Specific affected areas with coordinates

**Example AI Output:**
```json
{
  "classification": "intentional",
  "confidence": 0.89,
  "description": "Header gradient colors changed from purple to pink theme",
  "severity": "medium",
  "changeType": "color",
  "reasoning": "Consistent color scheme change across header, buttons, and links suggests intentional redesign",
  "suggestions": [
    "Update brand colors in design system",
    "Verify color contrast meets WCAG AA standards",
    "Test on different displays for color accuracy"
  ]
}
```

---

## CI/CD Integration

### GitHub Actions Workflow

**Create `.github/workflows/iris-tests.yml`:**

```yaml
name: IRIS Visual & Accessibility Tests

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  visual-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: |
          npm install -g iris-suite
          npm install

      - name: Start test server
        run: |
          python3 -m http.server 8080 --directory pages &
          sleep 2

      - name: Run visual regression tests
        run: |
          iris visual-diff \
            --pages "http://localhost:8080/homepage.html" \
            --baseline main \
            --devices desktop,mobile \
            --format junit \
            --output test-results/visual-results.xml

      - name: Run accessibility tests
        run: |
          iris a11y \
            --pages "http://localhost:8080/homepage.html" \
            --tags wcag2a,wcag2aa \
            --format junit \
            --output test-results/a11y-results.xml

      - name: Upload test results
        uses: actions/upload-artifact@v3
        if: always()
        with:
          name: test-reports
          path: .iris/reports/

      - name: Publish test results
        uses: EnricoMi/publish-unit-test-result-action@v2
        if: always()
        with:
          files: test-results/*.xml
```

### Local CI Test

```bash
# Simulate CI environment
docker run -it --rm \
  -v $(pwd):/workspace \
  -w /workspace \
  node:18 \
  bash -c "
    npm install -g iris-suite &&
    python3 -m http.server 8080 --directory pages &
    sleep 2 &&
    iris visual-diff --pages 'http://localhost:8080/homepage.html' --format junit &&
    iris a11y --pages 'http://localhost:8080/homepage.html' --format junit
  "
```

---

## Troubleshooting

### Issue: IRIS command not found

**Solution:**
```bash
# Re-link globally
cd /path/to/iris
npm link

# Or use npx
npx iris --help

# Or use node directly
node /path/to/iris/dist/cli.js --help
```

### Issue: Module not found errors

**Solution:**
```bash
cd /path/to/iris
npm install
npm run build
npm link
```

### Issue: Port 8080 already in use

**Solution:**
```bash
# Find and kill process using port 8080
lsof -ti:8080 | xargs kill -9

# Or use different port
python3 -m http.server 8081 --directory pages
# Then update test URLs to use 8081
```

### Issue: AI provider errors

**OpenAI Error: "Invalid API key"**
```bash
# Verify key is set
echo $OPENAI_API_KEY

# Check if key is valid (starts with sk-)
# Regenerate key at https://platform.openai.com/api-keys
```

**Ollama Error: "Connection refused"**
```bash
# Start Ollama server
ollama serve

# Check if running
curl http://localhost:11434/api/version

# Pull vision model
ollama pull llava
```

### Issue: Playwright browser not found

**Solution:**
```bash
# Install Playwright browsers
npx playwright install chromium

# Or install all browsers
npx playwright install
```

### Issue: Permission denied on test scripts

**Solution:**
```bash
chmod +x tests/*.sh
```

### Issue: Git baseline not found

**Solution:**
```bash
# Create baseline branch
git checkout -b baseline-branch
iris visual-diff --pages "http://localhost:8080/homepage.html" --update-baseline
git add .iris/baselines/
git commit -m "Add visual test baselines"
```

---

## Next Steps

### 1. Explore Advanced Features

```bash
# Mask dynamic content
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --mask ".timestamp,.random-id"

# Exclude elements
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --exclude ".ads,.tracking"

# Adjust concurrency
iris visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --concurrency 5
```

### 2. Review Documentation

- **API Reference**: `docs/api/visual-testing.md`
- **User Guides**: `docs/guides/`
- **Examples**: `examples/`

### 3. Join Community

- **Issues**: https://github.com/frankbria/iris/issues
- **Discussions**: https://github.com/frankbria/iris/discussions

---

## Summary

**You've successfully:**
- ✅ Set up IRIS development environment
- ✅ Created sample test repository
- ✅ Run visual regression tests
- ✅ Run accessibility tests
- ✅ (Optional) Configured AI semantic analysis
- ✅ Set up CI/CD integration

**Total Time**: 15-20 minutes

**What You Can Test Now:**
- Visual regressions across pages
- Responsive design (multi-device)
- WCAG 2.1 AA/AAA compliance
- Keyboard navigation
- Screen reader compatibility
- AI-powered change analysis

**Next Phase**: Integrate IRIS into your real projects!
