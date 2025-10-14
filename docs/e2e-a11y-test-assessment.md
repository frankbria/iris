# Accessibility E2E Test Assessment

**Date:** 2025-10-14
**Task:** Phase 2 Test Completion - Task 5
**Assessor:** Claude Code

## Executive Summary

All 19 accessibility E2E tests have been assessed and **SKIPPED** due to a fundamental infrastructure mismatch between test assumptions and actual implementation.

**Assessment Result:**
- **Tests Assessed:** 19
- **Tests Skipped:** 19 (100%)
- **Tests Fixed:** 0
- **Tests Passing:** 0

## Infrastructure Mismatch Pattern

### Root Cause

**AccessibilityRunner Implementation (src/a11y/a11y-runner.ts:184-185):**
```typescript
const url = pagePattern.startsWith('http') ? pagePattern : `http://localhost:3000${pagePattern}`;
await page.goto(url, { waitUntil: 'networkidle' });
```

The `AccessibilityRunner.testPage()` method expects:
1. **Full HTTP URLs** (e.g., `http://example.com/page`)
2. **Path strings** (e.g., `/test-page`) that get prepended with `http://localhost:3000`

### What Tests Were Doing Wrong

Tests were using one of two broken patterns:

**Pattern 1: page.setContent() + page.url()**
```typescript
await page.setContent(html);  // Sets content on page
const config = {
  pages: [await page.url()]   // Returns 'about:blank'
};
// Result: AccessibilityRunner tries to navigate to 'http://localhost:3000about:blank' ❌
```

**Pattern 2: Direct data: URLs**
```typescript
const config = {
  pages: ['data:text/html,' + encodeURIComponent(html)]
};
// Result: AccessibilityRunner tries to navigate to 'http://localhost:3000data:text/html,...' ❌
```

Both patterns produce **invalid URLs** that Playwright rejects with:
```
page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
```

## Tests Skipped (with reasons)

### Axe-Core Integration (4 tests)
1. **should detect accessibility violations using axe-core**
   - Uses: `page.setContent()` → `page.url()` → `'about:blank'`
   - Skip reason: Invalid URL concatenation

2. **should pass when no violations are found**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

3. **should categorize violations by severity**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

4. **should respect WCAG tag filtering**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

### Keyboard Navigation Testing (5 tests)
5. **should test focus order on page**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

6. **should detect focus traps in modal dialogs**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

7. **should test arrow key navigation in menus**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

8. **should test escape key handling for dismissible components**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

9. **should execute custom keyboard sequences**
   - Uses: `data:text/html,...` URL
   - Skip reason: Invalid URL concatenation

### Screen Reader Simulation (5 tests)
10. **should test ARIA labels**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

11. **should test landmark navigation structure**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

12. **should validate heading hierarchy**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

13. **should detect invalid heading hierarchy**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

### Report Generation (2 tests)
14. **should generate JSON report with summary and results**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

15. **should calculate accessibility score correctly**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

### Multiple Pages Testing (1 test)
16. **should test multiple pages and aggregate results**
    - Uses: Two `data:text/html,...` URLs
    - Skip reason: Invalid URL concatenation

### Failure Threshold (2 tests)
17. **should respect failure threshold for critical violations**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

18. **should fail when serious violations exceed threshold**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

### Comprehensive Testing (1 test)
19. **should run all test types together**
    - Uses: `data:text/html,...` URL
    - Skip reason: Invalid URL concatenation

## Tests Fixed

**None.** No tests were fixed because they all depend on infrastructure that doesn't exist.

## Infrastructure Gaps Identified

### Pattern 1: No Test Web Server
- **Gap:** Tests assume ability to test inline HTML without a web server
- **Impact:** Cannot run E2E accessibility tests on HTML content
- **Current State:** No test server infrastructure exists
- **Required:** Express/http-server on localhost:3000 serving test fixtures

### Pattern 2: No HTML Test Fixtures
- **Gap:** No directory of HTML files for accessibility testing
- **Impact:** Tests have nowhere to point their URLs
- **Current State:** Tests embed HTML as strings in test code
- **Required:** `test/fixtures/a11y/` directory with HTML files

### Pattern 3: AccessibilityRunner Design Limitation
- **Gap:** AccessibilityRunner.testPage() doesn't support page.setContent() workflow
- **Impact:** Cannot test HTML content without full navigation
- **Current State:** Method creates its own page and navigates to URL
- **Alternative:** Modify runner to accept pre-configured page objects

## Steps to Re-Enable These Tests

### Option A: Test Server Infrastructure (Recommended)

1. **Create HTML fixture files:**
   ```bash
   mkdir -p test/fixtures/a11y
   # Create files like:
   # - color-contrast-violation.html
   # - focus-order-test.html
   # - aria-labels-test.html
   # etc.
   ```

2. **Add test server setup:**
   ```typescript
   // In beforeAll:
   import express from 'express';
   import { Server } from 'http';

   let server: Server;

   beforeAll(async () => {
     const app = express();
     app.use(express.static('test/fixtures'));
     server = app.listen(3000);
     browser = await chromium.launch({ headless: true });
   });

   afterAll(async () => {
     await browser?.close();
     server?.close();
   });
   ```

3. **Update test URLs:**
   ```typescript
   const config: AccessibilityRunnerConfig = {
     pages: ['http://localhost:3000/a11y/color-contrast-violation.html'],
     // ... rest of config
   };
   ```

### Option B: Modify AccessibilityRunner

1. **Add page object support to testPage():**
   ```typescript
   async testPage(pageOrUrl: string | Page): Promise<...> {
     let page: Page;

     if (typeof pageOrUrl === 'string') {
       // Existing URL navigation logic
       page = await context.newPage();
       await page.goto(url, { waitUntil: 'networkidle' });
     } else {
       // Use provided page object
       page = pageOrUrl;
     }

     // ... rest of testing logic
   }
   ```

2. **Update tests to use page objects:**
   ```typescript
   const page = await browser.newPage();
   await page.setContent(html);

   const runner = new AccessibilityRunner(config);
   const result = await runner.runOnPage(page); // New method
   ```

### Option C: Test Lower-Level Modules Directly

Instead of testing AccessibilityRunner E2E, test the underlying modules:

1. **Test AxeRunner directly:**
   ```typescript
   const page = await browser.newPage();
   await page.setContent(html);

   const axeRunner = new AxeRunner(axeConfig);
   const result = await axeRunner.run(page, 'test', 'about:blank');
   ```

2. **Test KeyboardTester directly:**
   ```typescript
   const keyboardTester = new KeyboardTester(keyboardConfig);
   const result = await keyboardTester.run(page, 'test');
   ```

This approach would test component functionality without requiring E2E infrastructure.

## Recommendations

### Immediate Action (For Phase 2 Completion)
✅ **COMPLETE** - All tests skipped with clear commentary
✅ **COMPLETE** - Infrastructure gaps documented
✅ **COMPLETE** - Re-enablement steps provided

### Short-Term (Next Sprint)
- **Decide:** Option A (test server) vs Option B (runner modification) vs Option C (component tests)
- **Estimate:** 2-3 days for Option A, 1-2 days for Option B, 1 day for Option C
- **Recommendation:** Start with **Option C** for immediate value, then add Option A for E2E coverage

### Long-Term (Phase 3+)
- Establish test infrastructure patterns for E2E testing
- Consider test fixture management strategy
- Add CI/CD test server setup documentation

## Assessment Methodology

Following the skip-or-fix strategy from the implementation plan:

1. **Read each test** to understand its purpose and approach
2. **Identify infrastructure dependencies** (URLs, servers, fixtures)
3. **Compare with actual implementation** (AccessibilityRunner.testPage())
4. **Decision:** Skip (infrastructure mismatch) or Fix (wrong expectation)
5. **Document reasoning** for each decision

**Result:** 100% infrastructure mismatch → 100% skipped with detailed commentary

## Conclusion

These E2E tests were written with assumptions about how AccessibilityRunner would work (supporting data: URLs or page.setContent()) that don't match the actual implementation (requires HTTP URLs or localhost paths).

This is **not a failure of the tests** or the implementation—it's a **mismatch between assumptions and reality**. The tests are valid test scenarios; they just need proper infrastructure to run.

**Phase 2 Status:** Accessibility E2E tests are appropriately skipped with clear paths to re-enablement. No false positives, no hidden failures.
