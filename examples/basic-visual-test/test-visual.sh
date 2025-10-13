#!/bin/bash

# Basic Visual Regression Testing Script for IRIS
# This script demonstrates how to run visual tests with IRIS

set -e  # Exit on error

echo "🎯 IRIS Basic Visual Testing Example"
echo "====================================="
echo ""

# Check if IRIS is built
if [ ! -f "../../dist/cli.js" ]; then
    echo "❌ IRIS not built. Building now..."
    cd ../..
    npm run build
    cd examples/basic-visual-test
    echo "✅ Build complete"
    echo ""
fi

# Start HTTP server
echo "🚀 Starting HTTP server on port 8080..."
npx http-server -p 8080 -s &
SERVER_PID=$!
sleep 2

# Trap to ensure server cleanup
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Check if baseline exists
if [ -d "../../.iris/baselines" ] && [ "$(ls -A ../../.iris/baselines 2>/dev/null)" ]; then
    echo "📸 Baseline found. Running comparison..."
    echo ""

    # Run visual diff
    node ../../dist/cli.js visual-diff \
        --pages "http://localhost:8080/sample-page.html" \
        --threshold 0.1 \
        --format html \
        --output ../../.iris/visual-report.html \
        --fail-on moderate

    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        echo ""
        echo "✅ Visual tests passed!"
        echo "   No regressions detected"
    elif [ $EXIT_CODE -eq 5 ]; then
        echo ""
        echo "⚠️  Visual differences detected"
        echo "   Check report: ../../.iris/visual-report.html"
        echo ""
        echo "💡 Tip: Review changes and update baseline if intentional:"
        echo "   ./test-visual.sh --update-baseline"
    else
        echo ""
        echo "❌ Visual testing failed with exit code $EXIT_CODE"
    fi
else
    echo "📸 No baseline found. Creating initial baseline..."
    echo ""

    # Create baseline
    node ../../dist/cli.js visual-diff \
        --pages "http://localhost:8080/sample-page.html" \
        --update-baseline

    echo ""
    echo "✅ Baseline created successfully!"
    echo ""
    echo "💡 Next steps:"
    echo "   1. Make changes to sample-page.html"
    echo "   2. Run ./test-visual.sh again to detect differences"
fi

echo ""
echo "📁 Output location:"
echo "   Baselines: ../../.iris/baselines/"
echo "   Screenshots: ../../.iris/screenshots/"
if [ -f "../../.iris/visual-report.html" ]; then
    echo "   Report: ../../.iris/visual-report.html"
fi
echo ""
echo "🎉 Test complete!"
