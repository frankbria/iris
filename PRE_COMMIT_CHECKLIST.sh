#!/bin/bash
# IRIS Pre-Commit Verification Script
# Run this script before committing to ensure everything is ready

set -e  # Exit on any error

echo "╔════════════════════════════════════════════════════════════╗"
echo "║       IRIS Pre-Commit Verification Checklist              ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track overall status
CHECKS_PASSED=0
CHECKS_FAILED=0

# Function to report success
check_pass() {
    echo -e "${GREEN}✓${NC} $1"
    CHECKS_PASSED=$((CHECKS_PASSED + 1))
}

# Function to report failure
check_fail() {
    echo -e "${RED}✗${NC} $1"
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
}

# Function to report warning
check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

echo "1. Running Tests..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if npm test 2>&1 | grep -q "Tests:.*221 passed"; then
    check_pass "Tests passing (221/223 - 99.1% pass rate)"
else
    check_fail "Tests not passing as expected"
    echo "   Expected: 221 passing, 2 skipped"
    echo "   Run 'npm test' to see details"
fi
echo ""

echo "2. Building TypeScript..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if npm run build > /dev/null 2>&1; then
    check_pass "TypeScript compilation successful"
else
    check_fail "TypeScript compilation failed"
    echo "   Run 'npm run build' to see errors"
fi
echo ""

echo "3. Checking Git Status..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check for modified config files
if git status --short | grep -q "M package.json\|M tsconfig.json\|M jest.config.ts"; then
    check_pass "Configuration files modified (expected)"
fi

# Check for new Phase 2 files
if git status --short | grep -q "?? src/visual/\|?? src/a11y/\|?? src/utils/"; then
    check_pass "Phase 2 source files detected"
fi

# Check for new test files
if git status --short | grep -q "?? __tests__/visual/\|?? __tests__/a11y/\|?? __tests__/utils/"; then
    check_pass "Phase 2 test files detected"
fi

# Check for documentation files
if git status --short | grep -q "?? DEVELOPMENT_INSTRUCTIONS.md\|?? CODEBASE_ANALYSIS_SUMMARY.md"; then
    check_pass "Documentation files detected"
fi

# Check for unwanted files
if git status --short | grep -q "coverage/\|dist/\|jest.setup.js\|node_modules/"; then
    check_warn "Build artifacts or coverage files detected in git status"
    echo "   These should be in .gitignore and not committed"
    echo "   Run: git restore coverage/ dist/ jest.setup.*"
fi

# Check .gitignore
if git status --short | grep -q ".gitignore"; then
    check_pass ".gitignore updated (expected)"
fi

echo ""

echo "4. Checking File Structure..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check Phase 2 visual module
if [ -f "src/visual/capture.ts" ] && [ -f "src/visual/diff.ts" ] && [ -f "src/visual/baseline.ts" ]; then
    check_pass "Visual regression module complete"
else
    check_fail "Visual regression module incomplete"
fi

# Check Phase 2 test files
if [ -d "__tests__/visual/" ] && [ -d "__tests__/a11y/" ] && [ -d "__tests__/utils/" ]; then
    check_pass "Phase 2 test structure in place"
else
    check_fail "Phase 2 test structure missing"
fi

# Check documentation
if [ -f "DEVELOPMENT_INSTRUCTIONS.md" ] && [ -f "GIT_COMMIT_GUIDE.md" ]; then
    check_pass "Development documentation complete"
else
    check_fail "Development documentation missing"
fi

echo ""

echo "5. Dependencies Check..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check if node_modules exists
if [ -d "node_modules" ]; then
    check_pass "Dependencies installed"
else
    check_fail "Dependencies not installed - run 'npm install'"
fi

# Check for Phase 2 dependencies
if grep -q "\"sharp\"" package.json && grep -q "\"pixelmatch\"" package.json; then
    check_pass "Phase 2 dependencies present in package.json"
else
    check_fail "Phase 2 dependencies missing"
fi

echo ""

echo "6. Code Quality Checks..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check TypeScript strict mode
if grep -q "\"strict\": true" tsconfig.json; then
    check_pass "TypeScript strict mode enabled"
else
    check_warn "TypeScript strict mode not enabled"
fi

# Check for console.log in source files (except tests)
if git diff --cached --name-only | grep "^src/" | xargs grep -l "console.log" 2>/dev/null | grep -v test; then
    check_warn "console.log statements found in source files"
    echo "   Consider using proper logging instead"
fi

echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "                    Verification Summary"
echo "═══════════════════════════════════════════════════════════════"
echo ""

if [ $CHECKS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC} ($CHECKS_PASSED passed)"
    echo ""
    echo "Next steps:"
    echo "1. Review changes: git status"
    echo "2. Stage files: git add src/ __tests__/ docs/ *.md package.json tsconfig.json jest.config.ts .gitignore"
    echo "3. Commit: git commit -F COMMIT_MESSAGE.txt (or use custom message)"
    echo "4. Push: git push origin main"
    echo ""
    exit 0
else
    echo -e "${RED}✗ Some checks failed${NC} ($CHECKS_PASSED passed, $CHECKS_FAILED failed)"
    echo ""
    echo "Please fix the issues above before committing."
    echo ""
    exit 1
fi
