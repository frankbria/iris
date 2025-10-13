#!/bin/bash

set -e

echo "♿ IRIS Accessibility Testing"
echo "============================"
echo ""

if [ ! -f "../../dist/cli.js" ]; then
    echo "Building IRIS..."
    cd ../.. && npm run build && cd examples/accessibility-audit
fi

echo "🚀 Starting HTTP server..."
npx http-server -p 8080 -s &
SERVER_PID=$!
sleep 2

cleanup() { kill $SERVER_PID 2>/dev/null || true; }
trap cleanup EXIT

echo "Testing accessible page..."
node ../../dist/cli.js a11y \
    --pages "http://localhost:8080/accessible-page.html" \
    --tags "wcag2a,wcag2aa" \
    --fail-on "critical,serious" \
    --include-keyboard

echo ""
echo "Testing inaccessible page..."
node ../../dist/cli.js a11y \
    --pages "http://localhost:8080/inaccessible-page.html" \
    --tags "wcag2a,wcag2aa" \
    --fail-on "critical,serious" \
    --format html \
    --output ../../.iris/a11y-report.html || true

echo ""
echo "📋 Report: ../../.iris/a11y-report.html"
echo "🎉 Testing complete!"
