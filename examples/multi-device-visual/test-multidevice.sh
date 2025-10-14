#!/bin/bash

# Multi-Device Visual Regression Testing Script for IRIS
# Tests responsive design across desktop, tablet, and mobile viewports

set -e

echo "📱 IRIS Multi-Device Visual Testing"
echo "===================================="
echo ""

# Check if IRIS is built
if [ ! -f "../../dist/cli.js" ]; then
    echo "❌ IRIS not built. Building now..."
    cd ../..
    npm run build
    cd examples/multi-device-visual
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

# Define devices to test
DEVICES="desktop,tablet,mobile"

# Check command line arguments
if [ "$1" == "--update-baseline" ]; then
    echo "📸 Creating baselines for all devices..."
    echo "   Devices: desktop, tablet, mobile"
    echo ""

    node ../../dist/cli.js visual-diff \
        --pages "http://localhost:8080/responsive-page.html" \
        --devices "$DEVICES" \
        --threshold 0.1 \
        --concurrency 3 \
        --update-baseline

    echo ""
    echo "✅ Baselines created for all devices!"
    echo ""
    echo "📁 Baseline locations:"
    echo "   Desktop: ../../.iris/baselines/responsive-page_html_desktop.png"
    echo "   Tablet:  ../../.iris/baselines/responsive-page_html_tablet.png"
    echo "   Mobile:  ../../.iris/baselines/responsive-page_html_mobile.png"

elif [ -d "../../.iris/baselines" ] && [ "$(ls -A ../../.iris/baselines 2>/dev/null)" ]; then
    echo "📸 Running multi-device comparison..."
    echo "   Devices: desktop (1920×1080), tablet (768×1024), mobile (375×667)"
    echo "   Concurrency: 3 (parallel execution)"
    echo ""

    # Run visual diff across all devices
    node ../../dist/cli.js visual-diff \
        --pages "http://localhost:8080/responsive-page.html" \
        --devices "$DEVICES" \
        --threshold 0.1 \
        --concurrency 3 \
        --format html \
        --output ../../.iris/multi-device-report.html \
        --fail-on moderate

    EXIT_CODE=$?

    echo ""
    if [ $EXIT_CODE -eq 0 ]; then
        echo "✅ All device tests passed!"
        echo "   Desktop: ✓ No regressions"
        echo "   Tablet:  ✓ No regressions"
        echo "   Mobile:  ✓ No regressions"
    elif [ $EXIT_CODE -eq 5 ]; then
        echo "⚠️  Visual differences detected on one or more devices"
        echo ""
        echo "📋 Report: ../../.iris/multi-device-report.html"
        echo ""
        echo "💡 To investigate:"
        echo "   1. Open report in browser"
        echo "   2. Check device-specific diffs"
        echo "   3. Review responsive breakpoints"
        echo ""
        echo "💡 If changes are intentional:"
        echo "   ./test-multidevice.sh --update-baseline"
    else
        echo "❌ Multi-device testing failed with exit code $EXIT_CODE"
    fi

else
    echo "📸 No baselines found. Creating initial baselines..."
    echo "   This will capture screenshots for:"
    echo "   - Desktop (1920×1080)"
    echo "   - Tablet (768×1024)"
    echo "   - Mobile (375×667)"
    echo ""

    node ../../dist/cli.js visual-diff \
        --pages "http://localhost:8080/responsive-page.html" \
        --devices "$DEVICES" \
        --concurrency 3 \
        --update-baseline

    echo ""
    echo "✅ Multi-device baselines created!"
    echo ""
    echo "💡 Next steps:"
    echo "   1. Make responsive design changes"
    echo "   2. Run ./test-multidevice.sh to detect differences"
    echo "   3. Review device-specific reports"
fi

echo ""
echo "📊 Test Summary:"
echo "   Total devices tested: 3"
echo "   Parallel execution: Yes"
echo "   Output: ../../.iris/multi-device-report.html"
echo ""
echo "🎉 Multi-device test complete!"
