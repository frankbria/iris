#!/bin/bash

# IRIS Demo Setup Script
# Automatically creates a sample repository and runs tests

set -e

DEMO_DIR="${1:-../iris-demo-project}"
IRIS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     IRIS Visual & Accessibility Testing Demo Setup        ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "This script will:"
echo "  1. Create a demo project at: $DEMO_DIR"
echo "  2. Set up sample HTML pages"
echo "  3. Run visual regression tests"
echo "  4. Run accessibility tests"
echo "  5. Generate reports"
echo ""
read -p "Press Enter to continue or Ctrl+C to cancel..."
echo ""

# Step 1: Build and link IRIS
echo "📦 Step 1: Building IRIS..."
cd "$IRIS_DIR"
npm run build > /dev/null 2>&1
echo "✅ IRIS built successfully"
echo ""

# Step 2: Create demo directory
echo "📁 Step 2: Creating demo project..."
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"

# Initialize Git
if [ ! -d ".git" ]; then
    git init
    git checkout -b main
fi

# Create directory structure
mkdir -p pages tests .iris/reports

echo "✅ Project structure created"
echo ""

# Step 3: Create sample HTML
echo "📄 Step 3: Creating sample HTML pages..."

cat > pages/homepage.html << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IRIS Demo - Homepage</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            line-height: 1.6;
            color: #333;
        }
        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 3rem 2rem;
            text-align: center;
        }
        header h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
        nav {
            background: #2d3748;
            padding: 1rem;
        }
        nav ul {
            list-style: none;
            display: flex;
            justify-content: center;
            gap: 2rem;
            flex-wrap: wrap;
        }
        nav a {
            color: white;
            text-decoration: none;
            font-weight: 500;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            transition: background 0.3s;
        }
        nav a:hover { background: rgba(255, 255, 255, 0.1); }
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
            margin-bottom: 3rem;
        }
        .hero h2 {
            font-size: 2rem;
            margin-bottom: 1rem;
            color: #2d3748;
        }
        .hero p {
            font-size: 1.2rem;
            color: #4a5568;
            margin-bottom: 2rem;
        }
        .cta-button {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 1rem 2.5rem;
            border-radius: 6px;
            text-decoration: none;
            font-weight: 600;
            font-size: 1.1rem;
            transition: all 0.3s;
            box-shadow: 0 4px 6px rgba(102, 126, 234, 0.3);
        }
        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 12px rgba(102, 126, 234, 0.4);
        }
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            margin: 3rem 0;
        }
        .feature-card {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            border-left: 4px solid #667eea;
            transition: all 0.3s;
        }
        .feature-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
        }
        .feature-card h3 {
            color: #667eea;
            margin-bottom: 1rem;
            font-size: 1.3rem;
        }
        .feature-card p { color: #4a5568; line-height: 1.7; }
        footer {
            background: #2d3748;
            color: white;
            text-align: center;
            padding: 2rem;
            margin-top: 4rem;
        }
        @media (max-width: 768px) {
            header h1 { font-size: 2rem; }
            .hero h2 { font-size: 1.5rem; }
            nav ul { flex-direction: column; gap: 0.5rem; align-items: center; }
            .features { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <header role="banner">
        <h1>🎯 IRIS Testing Suite</h1>
        <p>Visual Regression & Accessibility Testing Made Simple</p>
    </header>

    <nav role="navigation" aria-label="Main navigation">
        <ul>
            <li><a href="#home">Home</a></li>
            <li><a href="#features">Features</a></li>
            <li><a href="#docs">Documentation</a></li>
            <li><a href="#get-started">Get Started</a></li>
        </ul>
    </nav>

    <main role="main">
        <section class="hero">
            <h2>Automated Visual & Accessibility Testing</h2>
            <p>Catch regressions before they reach production with AI-powered analysis</p>
            <a href="#get-started" class="cta-button" role="button" tabindex="0">Start Testing Now</a>
        </section>

        <section class="features" id="features">
            <article class="feature-card">
                <h3>📸 Visual Regression</h3>
                <p>Pixel-perfect comparison with SSIM analysis. Automatically detect visual changes across your application.</p>
            </article>

            <article class="feature-card">
                <h3>🤖 AI-Powered Analysis</h3>
                <p>Semantic understanding using GPT-4 Vision, Claude, or Ollama. Distinguish intentional changes from regressions.</p>
            </article>

            <article class="feature-card">
                <h3>♿ WCAG Compliance</h3>
                <p>Automated WCAG 2.1 Level AA/AAA testing with axe-core integration. Ensure accessibility for all users.</p>
            </article>

            <article class="feature-card">
                <h3>📱 Multi-Device</h3>
                <p>Test responsive designs across desktop, tablet, and mobile viewports with parallel execution.</p>
            </article>

            <article class="feature-card">
                <h3>⚡ CI/CD Ready</h3>
                <p>Seamless integration with GitHub Actions, GitLab CI, Jenkins, and CircleCI with JUnit reports.</p>
            </article>

            <article class="feature-card">
                <h3>📊 Detailed Reports</h3>
                <p>Interactive HTML reports with side-by-side comparisons, diff visualizations, and actionable insights.</p>
            </article>
        </section>
    </main>

    <footer role="contentinfo">
        <p>&copy; 2025 IRIS Testing Suite • Open Source MIT License • Version 2.0.0</p>
    </footer>
</body>
</html>
EOF

echo "✅ Sample HTML created"
echo ""

# Step 4: Create test script
echo "🔧 Step 4: Creating test scripts..."

cat > tests/run-demo.sh << 'EOF'
#!/bin/bash
set -e

echo "🚀 Running IRIS Demo Tests"
echo "=========================="
echo ""

# Start HTTP server
echo "📡 Starting local server on port 8080..."
python3 -m http.server 8080 --directory pages > /dev/null 2>&1 &
SERVER_PID=$!
sleep 2

echo "✅ Server started (PID: $SERVER_PID)"
echo ""

# Run visual regression test
echo "📸 Running visual regression test..."
node "$IRIS_DIR/dist/cli.js" visual-diff \
  --pages "http://localhost:8080/homepage.html" \
  --baseline main \
  --devices desktop \
  --threshold 0.1 \
  --format html \
  --output .iris/reports/visual-report.html \
  || echo "⚠️  Visual diff detected changes (expected on first run)"

echo ""

# Run accessibility test
echo "♿ Running accessibility test..."
node "$IRIS_DIR/dist/cli.js" a11y \
  --pages "http://localhost:8080/homepage.html" \
  --tags wcag2a,wcag2aa \
  --include-keyboard \
  --format html \
  --output .iris/reports/a11y-report.html

echo ""
echo "✅ Tests complete!"
echo ""
echo "📊 Reports generated:"
echo "   - Visual: .iris/reports/visual-report.html"
echo "   - A11y:   .iris/reports/a11y-report.html"
echo ""

# Cleanup
kill $SERVER_PID 2>/dev/null || true

echo "🎉 Demo complete! Check the reports directory."
EOF

chmod +x tests/run-demo.sh

echo "✅ Test scripts created"
echo ""

# Step 5: Create configuration
echo "⚙️  Step 5: Creating IRIS configuration..."

cat > .irisrc << 'EOF'
{
  "visual": {
    "threshold": 0.1,
    "devices": ["desktop"],
    "capture": {
      "waitForFonts": true,
      "disableAnimations": true,
      "stabilizationDelay": 500
    }
  },
  "accessibility": {
    "wcagLevel": "AA",
    "includeKeyboard": true
  }
}
EOF

echo "✅ Configuration created"
echo ""

# Step 6: Initial commit
echo "📝 Step 6: Creating initial Git commit..."
git add .
git commit -m "Initial commit: IRIS demo project" > /dev/null 2>&1 || echo "Already committed"
echo "✅ Git repository initialized"
echo ""

# Step 7: Run tests
echo "🧪 Step 7: Running demo tests..."
echo ""
sleep 1

cd tests
IRIS_DIR="$IRIS_DIR" ./run-demo.sh

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                    Demo Setup Complete!                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "📁 Demo project created at: $DEMO_DIR"
echo ""
echo "📖 What to do next:"
echo "   1. View HTML reports in .iris/reports/"
echo "   2. Modify pages/homepage.html and re-run tests"
echo "   3. Try multi-device testing: --devices desktop,tablet,mobile"
echo "   4. Enable AI analysis: --semantic (requires API key)"
echo ""
echo "🔗 Useful commands:"
echo "   cd $DEMO_DIR"
echo "   ./tests/run-demo.sh          # Run all tests"
echo "   node $IRIS_DIR/dist/cli.js --help  # See all options"
echo ""
echo "📚 Documentation: $IRIS_DIR/docs/GETTING_STARTED_GUIDE.md"
echo ""
