#!/bin/bash
# IRIS Verification Script - Run tests and build checks
# Usage: ./scripts/verify.sh [--verbose]

set -e

VERBOSE=false
if [[ "$1" == "--verbose" ]]; then
    VERBOSE=true
fi

echo "╔════════════════════════════════════════════════════════════╗"
echo "║              IRIS Verification Script                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Run tests
echo "Running tests..."
if [ "$VERBOSE" = true ]; then
    npm test
else
    npm test > /dev/null 2>&1 && echo "✓ Tests passed" || (echo "✗ Tests failed" && exit 1)
fi

# Build TypeScript
echo "Building TypeScript..."
if [ "$VERBOSE" = true ]; then
    npm run build
else
    npm run build > /dev/null 2>&1 && echo "✓ Build successful" || (echo "✗ Build failed" && exit 1)
fi

echo ""
echo "✓ All checks passed"
