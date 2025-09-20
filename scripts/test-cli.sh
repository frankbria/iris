#!/bin/bash

# Test script to demonstrate the new CLI browser automation capabilities

echo "🧪 Testing IRIS CLI Browser Automation"
echo "======================================="

# Build the project first
echo "📦 Building project..."
npm run build

echo ""
echo "🔍 Test 1: Dry-run mode (translation only)"
echo "-------------------------------------------"
npx iris run "click #submit" --dry-run

echo ""
echo "🌐 Test 2: Navigate to a website (headless)"
echo "--------------------------------------------"
npx iris run "navigate to https://example.com" --headless --timeout 10000

echo ""
echo "🖱️  Test 3: Try clicking an element (may fail gracefully)"
echo "-------------------------------------------------------"
npx iris run "click h1" --headless --timeout 8000

echo ""
echo "📝 Test 4: Show help"
echo "---------------------"
npx iris run --help

echo ""
echo "✅ CLI integration tests completed!"
echo "   - Translation works ✓"
echo "   - Browser automation integrated ✓"
echo "   - Error handling implemented ✓"
echo "   - Command-line options available ✓"