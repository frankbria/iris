# Accessibility Testing API

Complete API reference for IRIS accessibility testing features.

## Table of Contents

- [Overview](#overview)
- [Core Types](#core-types)
- [Accessibility Runner](#accessibility-runner)
- [Axe Runner](#axe-runner)
- [Keyboard Tester](#keyboard-tester)
- [Screen Reader Simulation](#screen-reader-simulation)
- [WCAG Compliance](#wcag-compliance)
- [Error Handling](#error-handling)
- [Examples](#examples)

---

## Overview

The accessibility testing module provides comprehensive WCAG 2.1 AA/AAA compliance validation, keyboard navigation testing, and screen reader simulation capabilities.

### Quick Example

```typescript
import { AccessibilityRunner } from '@iris/a11y';

const runner = new AccessibilityRunner({
  pages: ['/', '/products', '/about'],
  axe: {
    rules: {},
    tags: ['wcag2a', 'wcag2aa'],
    include: [],
    exclude: [],
    disableRules: [],
    timeout: 30000
  },
  keyboard: {
    testFocusOrder: true,
    testTrapDetection: true,
    testArrowKeyNavigation: true,
    testEscapeHandling: true,
    customSequences: []
  },
  screenReader: {
    testAriaLabels: true,
    testLandmarkNavigation: true,
    testImageAltText: true,
    testHeadingStructure: true,
    simulateScreenReader: true
  },
  failureThreshold: {
    critical: true,
    serious: true,
    moderate: false,
    minor: false
  },
  reporting: {
    includePassedTests: false,
    groupByImpact: true,
    includeScreenshots: true
  }
});

const result = await runner.run();
console.log(`Accessibility score: ${result.summary.score}/100`);
console.log(`Total violations: ${result.summary.totalViolations}`);
```

---

## Core Types

### A11yTestConfig

Configuration for a single accessibility test.

```typescript
interface A11yTestConfig {
  testName: string;                    // Unique test identifier
  url: string;                         // URL to test
  selector?: string;                   // Optional element selector
  rules?: {
    wcag2a?: boolean;                  // WCAG 2.0 Level A (default: true)
    wcag2aa?: boolean;                 // WCAG 2.0 Level AA (default: true)
    wcag2aaa?: boolean;                // WCAG 2.0 Level AAA (default: false)
    section508?: boolean;              // Section 508 (default: false)
    bestPractice?: boolean;            // Best practices (default: true)
  };
  tags?: string[];                     // Specific axe rule tags
  excludeRules?: string[];             // Rules to exclude
  includeRules?: string[];             // Only run these rules
  disableRules?: string[];             // Disable specific rules
  timeout?: number;                    // Test timeout in ms (default: 10000)
}
```

**Example:**

```typescript
const config: A11yTestConfig = {
  testName: 'homepage-a11y',
  url: 'https://example.com',
  selector: 'main',                   // Test only main content
  rules: {
    wcag2a: true,
    wcag2aa: true,
    wcag2aaa: false,
    section508: true,
    bestPractice: true
  },
  tags: ['wcag2aa', 'best-practice'],
  excludeRules: ['color-contrast'],   // Skip contrast in dev mode
  timeout: 15000
};
```

### A11yResult

Result of an accessibility test.

```typescript
interface A11yResult {
  testName: string;
  url: string;
  timestamp: Date;
  passed: boolean;                    // Whether test passed
  violations: A11yViolation[];        // WCAG violations found
  passes: A11yPass[];                 // Rules that passed
  incomplete: A11yIncomplete[];       // Rules needing review
  inapplicable: A11yInapplicable[];   // Rules that don't apply
  summary: {
    total: number;                    // Total rules checked
    violations: number;
    passes: number;
    incomplete: number;
    inapplicable: number;
  };
  testRunner: {
    name: string;                     // 'axe-core'
    version: string;
  };
}
```

### A11yViolation

Details of a WCAG violation.

```typescript
interface A11yViolation {
  id: string;                         // Rule ID (e.g., 'color-contrast')
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  tags: string[];                     // Associated tags (e.g., ['wcag2aa'])
  description: string;                // What the rule checks
  help: string;                       // How to fix
  helpUrl: string;                    // Documentation URL
  nodes: Array<{
    target: string[];                 // CSS selectors
    html: string;                     // Element HTML
    failureSummary?: string;          // Why it failed
    element?: string;                 // Primary selector
  }>;
}
```

**Example:**

```typescript
const violation: A11yViolation = {
  id: 'color-contrast',
  impact: 'serious',
  tags: ['wcag2aa', 'wcag143'],
  description: 'Ensures the contrast between foreground and background colors...',
  help: 'Elements must have sufficient color contrast',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.8/color-contrast',
  nodes: [
    {
      target: ['#submit-button'],
      html: '<button id="submit-button">Submit</button>',
      failureSummary: 'Element has insufficient color contrast of 3.1:1...',
      element: '#submit-button'
    }
  ]
};
```

### KeyboardTestResult

Result of keyboard navigation testing.

```typescript
interface KeyboardTestResult {
  testName: string;
  passed: boolean;
  interactions: Array<{
    key: string;                      // Key pressed (e.g., 'Tab')
    target: string;                   // Element selector
    expectedBehavior: string;         // What should happen
    actualBehavior: string;           // What actually happened
    success: boolean;
    timestamp: Date;
  }>;
  focusOrder: Array<{
    element: string;
    tabIndex: number;
    focusable: boolean;
    visible: boolean;
  }>;
  trapTests: Array<{
    container: string;                // Modal or dialog selector
    trapped: boolean;                 // Whether focus is trapped
    escapeMethod?: string;            // How to escape (e.g., 'Escape')
  }>;
}
```

### ScreenReaderTestResult

Result of screen reader simulation.

```typescript
interface ScreenReaderTestResult {
  testName: string;
  passed: boolean;
  announcements: Array<{
    element: string;
    expectedText: string;
    actualText: string;
    role?: string;
    properties: Record<string, string>;  // ARIA properties
    success: boolean;
  }>;
  landmarkStructure: Array<{
    type: string;                     // 'banner', 'navigation', 'main', etc.
    label?: string;                   // aria-label if present
    element: string;
    level?: number;
  }>;
  headingStructure: Array<{
    level: number;                    // 1-6
    text: string;
    element: string;
  }>;
}
```

---

## Accessibility Runner

High-level orchestrator for comprehensive accessibility testing.

### Constructor

```typescript
class AccessibilityRunner {
  constructor(config: AccessibilityRunnerConfig);
}
```

### AccessibilityRunnerConfig

```typescript
interface AccessibilityRunnerConfig {
  pages: string[];                    // URL patterns to test
  axe: {
    rules: Record<string, { enabled: boolean }>;
    tags: string[];                   // e.g., ['wcag2a', 'wcag2aa']
    include: string[];                // Selectors to include
    exclude: string[];                // Selectors to exclude
    disableRules: string[];
    timeout: number;
  };
  keyboard: {
    testFocusOrder: boolean;
    testTrapDetection: boolean;
    testArrowKeyNavigation: boolean;
    testEscapeHandling: boolean;
    customSequences: Array<{
      name: string;
      keys: string[];
      expectedBehavior: string;
      validator?: string;             // JavaScript validation code
    }>;
  };
  screenReader: {
    testAriaLabels: boolean;
    testLandmarkNavigation: boolean;
    testImageAltText: boolean;
    testHeadingStructure: boolean;
    simulateScreenReader: boolean;
  };
  failureThreshold: Record<string, boolean>;  // Which impacts fail the test
  reporting: {
    includePassedTests: boolean;
    groupByImpact: boolean;
    includeScreenshots: boolean;
  };
  output?: {
    format: 'html' | 'json' | 'junit';
    path?: string;
  };
}
```

**Example:**

```typescript
const runner = new AccessibilityRunner({
  pages: ['/', '/products', '/about', '/contact'],
  axe: {
    rules: {},
    tags: ['wcag2a', 'wcag2aa', 'wcag21aa'],
    include: [],
    exclude: ['.third-party-widget'],
    disableRules: [],
    timeout: 30000
  },
  keyboard: {
    testFocusOrder: true,
    testTrapDetection: true,
    testArrowKeyNavigation: true,
    testEscapeHandling: true,
    customSequences: [
      {
        name: 'product-filter-navigation',
        keys: ['Tab', 'ArrowDown', 'Enter'],
        expectedBehavior: 'Should navigate and select filter option',
        validator: 'document.querySelector(".filter").classList.contains("active")'
      }
    ]
  },
  screenReader: {
    testAriaLabels: true,
    testLandmarkNavigation: true,
    testImageAltText: true,
    testHeadingStructure: true,
    simulateScreenReader: true
  },
  failureThreshold: {
    critical: true,
    serious: true,
    moderate: false,
    minor: false
  },
  reporting: {
    includePassedTests: false,
    groupByImpact: true,
    includeScreenshots: true
  },
  output: {
    format: 'html',
    path: './reports/accessibility-report.html'
  }
});
```

### run()

Execute accessibility tests.

```typescript
async run(): Promise<AccessibilityTestResult>;
```

**AccessibilityTestResult:**

```typescript
interface AccessibilityTestResult {
  summary: {
    totalViolations: number;
    score: number;                    // 0-100 accessibility score
    passed: boolean;
    violationsBySeverity: {
      critical: number;
      serious: number;
      moderate: number;
      minor: number;
    };
    pagesTested: number;
    keyboardTestsPassed: number;
    keyboardTestsFailed: number;
  };
  results: Array<{
    page: string;
    axeResult: A11yResult;
    keyboardResult?: KeyboardTestResult;
    screenReaderResult?: ScreenReaderTestResult;
  }>;
  reportPath?: string;
  duration: number;
}
```

**Example:**

```typescript
const result = await runner.run();

console.log('=== Accessibility Test Results ===');
console.log(`Score: ${result.summary.score}/100`);
console.log(`Total Violations: ${result.summary.totalViolations}`);
console.log(`Pages Tested: ${result.summary.pagesTested}`);

if (!result.summary.passed) {
  console.log('\n=== Violations by Severity ===');
  console.log(`Critical: ${result.summary.violationsBySeverity.critical}`);
  console.log(`Serious: ${result.summary.violationsBySeverity.serious}`);
  console.log(`Moderate: ${result.summary.violationsBySeverity.moderate}`);
  console.log(`Minor: ${result.summary.violationsBySeverity.minor}`);

  if (result.reportPath) {
    console.log(`\nDetailed report: ${result.reportPath}`);
  }

  process.exit(1);
} else {
  console.log('\n✅ All accessibility tests passed!');
}
```

---

## Axe Runner

Axe-core integration for WCAG compliance testing.

### Constructor

```typescript
class AxeRunner {
  constructor(config: AxeConfig);
}
```

**AxeConfig:**

```typescript
interface AxeConfig {
  rules: Record<string, { enabled: boolean }>;
  tags: string[];
  include: string[];
  exclude: string[];
  disableRules: string[];
  timeout: number;
}
```

### run()

Run axe-core on a page.

```typescript
async run(
  page: Page,
  testName: string,
  url: string
): Promise<A11yResult>;
```

**Example:**

```typescript
import { AxeRunner } from '@iris/a11y';
import { chromium } from 'playwright';

const axeRunner = new AxeRunner({
  rules: {},
  tags: ['wcag2a', 'wcag2aa'],
  include: [],
  exclude: [],
  disableRules: [],
  timeout: 30000
});

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com');

const result = await axeRunner.run(page, 'homepage', 'https://example.com');

console.log(`Test: ${result.testName}`);
console.log(`Passed: ${result.passed}`);
console.log(`Violations: ${result.violations.length}`);

result.violations.forEach(violation => {
  console.log(`\n[${violation.impact.toUpperCase()}] ${violation.id}`);
  console.log(`  ${violation.help}`);
  console.log(`  Affected elements: ${violation.nodes.length}`);
  violation.nodes.forEach(node => {
    console.log(`    - ${node.target.join(' > ')}`);
  });
});

await browser.close();
```

### runOnElement()

Run axe-core on a specific element.

```typescript
async runOnElement(
  page: Page,
  selector: string,
  testName: string,
  url: string
): Promise<A11yResult>;
```

**Example:**

```typescript
// Test only the navigation menu
const navResult = await axeRunner.runOnElement(
  page,
  'nav.main-menu',
  'navigation-menu',
  'https://example.com'
);
```

### getSeverityCounts()

Get violation counts by severity.

```typescript
getSeverityCounts(result: A11yResult): Record<string, number>;
```

**Returns:**

```typescript
{
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}
```

### checkThreshold()

Check if result passes based on threshold.

```typescript
checkThreshold(
  result: A11yResult,
  threshold: Record<string, boolean>
): boolean;
```

**Example:**

```typescript
const passes = axeRunner.checkThreshold(result, {
  critical: true,
  serious: true,
  moderate: false,
  minor: false
});

if (!passes) {
  console.error('Test failed: Critical or serious violations found');
}
```

---

## Keyboard Tester

Tests keyboard navigation and focus management.

### Constructor

```typescript
class KeyboardTester {
  constructor(config: KeyboardTestConfig);
}
```

**KeyboardTestConfig:**

```typescript
interface KeyboardTestConfig {
  testFocusOrder: boolean;
  testTrapDetection: boolean;
  testArrowKeyNavigation: boolean;
  testEscapeHandling: boolean;
  customSequences: Array<{
    name: string;
    keys: string[];
    expectedBehavior: string;
    validator?: string;
  }>;
}
```

### run()

Run keyboard navigation tests.

```typescript
async run(
  page: Page,
  testName: string
): Promise<KeyboardTestResult>;
```

**Example:**

```typescript
import { KeyboardTester } from '@iris/a11y';
import { chromium } from 'playwright';

const keyboardTester = new KeyboardTester({
  testFocusOrder: true,
  testTrapDetection: true,
  testArrowKeyNavigation: true,
  testEscapeHandling: true,
  customSequences: [
    {
      name: 'dropdown-navigation',
      keys: ['Tab', 'Enter', 'ArrowDown', 'Enter'],
      expectedBehavior: 'Opens dropdown and selects second option',
      validator: 'document.querySelector(".dropdown-item:nth-child(2)").classList.contains("selected")'
    }
  ]
});

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com');

const result = await keyboardTester.run(page, 'homepage-keyboard');

console.log(`Keyboard Test: ${result.testName}`);
console.log(`Passed: ${result.passed}`);

console.log('\n=== Focus Order ===');
result.focusOrder.forEach((element, index) => {
  console.log(`${index + 1}. ${element.element} (tabIndex: ${element.tabIndex})`);
});

console.log('\n=== Interactions ===');
result.interactions.forEach(interaction => {
  const status = interaction.success ? '✅' : '❌';
  console.log(`${status} ${interaction.key} on ${interaction.target}`);
  console.log(`   Expected: ${interaction.expectedBehavior}`);
  console.log(`   Actual: ${interaction.actualBehavior}`);
});

if (result.trapTests.length > 0) {
  console.log('\n=== Focus Traps ===');
  result.trapTests.forEach(trap => {
    console.log(`${trap.container}: ${trap.trapped ? 'Trapped' : 'Not trapped'}`);
    if (trap.escapeMethod) {
      console.log(`  Escape: ${trap.escapeMethod}`);
    }
  });
}

await browser.close();
```

---

## Screen Reader Simulation

Simulates screen reader behavior and validates ARIA.

### Screen Reader Testing

```typescript
// Screen reader testing is integrated into AccessibilityRunner
// See AccessibilityRunner documentation for configuration
```

**Example Screen Reader Test:**

```typescript
const runner = new AccessibilityRunner({
  pages: ['/'],
  axe: { /* minimal config */ },
  keyboard: { /* minimal config */ },
  screenReader: {
    testAriaLabels: true,
    testLandmarkNavigation: true,
    testImageAltText: true,
    testHeadingStructure: true,
    simulateScreenReader: true
  },
  failureThreshold: {},
  reporting: {}
});

const result = await runner.run();

const srResult = result.results[0].screenReaderResult;

if (srResult) {
  console.log('=== ARIA Labels ===');
  srResult.announcements.forEach(announcement => {
    const status = announcement.success ? '✅' : '❌';
    console.log(`${status} ${announcement.element}`);
    console.log(`   Expected: "${announcement.expectedText}"`);
    console.log(`   Actual: "${announcement.actualText}"`);
  });

  console.log('\n=== Landmarks ===');
  srResult.landmarkStructure.forEach(landmark => {
    console.log(`${landmark.type}: ${landmark.element}`);
    if (landmark.label) {
      console.log(`  Label: ${landmark.label}`);
    }
  });

  console.log('\n=== Heading Structure ===');
  srResult.headingStructure.forEach(heading => {
    console.log(`${'  '.repeat(heading.level - 1)}H${heading.level}: ${heading.text}`);
  });
}
```

---

## WCAG Compliance

### WCAG Levels

```typescript
type WcagLevel = 'A' | 'AA' | 'AAA';
```

### WCAG Principles

```typescript
type WcagPrinciple = 'perceivable' | 'operable' | 'understandable' | 'robust';
```

### checkWcagCompliance()

Check WCAG compliance level for a page.

```typescript
async function checkWcagCompliance(
  url: string,
  level: WcagLevel = 'AA'
): Promise<ComplianceStatus>;
```

**ComplianceStatus:**

```typescript
interface ComplianceStatus {
  level: WcagLevel;
  passed: boolean;
  violations: A11yViolation[];
  coverage: number;                   // 0-1 percentage of rules checked
  lastTested: Date;
}
```

**Example:**

```typescript
import { checkWcagCompliance } from '@iris/a11y';

const compliance = await checkWcagCompliance('https://example.com', 'AA');

console.log(`WCAG ${compliance.level} Compliance: ${compliance.passed ? 'PASS' : 'FAIL'}`);
console.log(`Coverage: ${(compliance.coverage * 100).toFixed(1)}%`);
console.log(`Violations: ${compliance.violations.length}`);

if (!compliance.passed) {
  console.log('\nViolations:');
  compliance.violations.forEach(v => {
    console.log(`  - [${v.impact}] ${v.id}: ${v.help}`);
  });
}
```

---

## Error Handling

### Error Classes

**A11yTestError**

Base error class for accessibility testing.

```typescript
class A11yTestError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, any>
  );
}
```

**AxeRunnerError**

```typescript
class AxeRunnerError extends A11yTestError {
  constructor(message: string, details?: Record<string, any>);
}
```

**KeyboardNavigationError**

```typescript
class KeyboardNavigationError extends A11yTestError {
  constructor(message: string, details?: Record<string, any>);
}
```

**ScreenReaderError**

```typescript
class ScreenReaderError extends A11yTestError {
  constructor(message: string, details?: Record<string, any>);
}
```

### Error Handling Example

```typescript
import {
  AccessibilityRunner,
  AxeRunnerError,
  KeyboardNavigationError
} from '@iris/a11y';

try {
  const result = await runner.run();
  // Process result
} catch (error) {
  if (error instanceof AxeRunnerError) {
    console.error(`Axe-core failed: ${error.message}`);
    console.error('Details:', error.details);
  } else if (error instanceof KeyboardNavigationError) {
    console.error(`Keyboard testing failed: ${error.message}`);
  } else {
    console.error('Unknown error:', error);
  }
}
```

---

## Examples

### Complete Workflow Example

```typescript
import { AccessibilityRunner } from '@iris/a11y';

const runner = new AccessibilityRunner({
  pages: [
    '/',
    '/products',
    '/product/123',
    '/cart',
    '/checkout'
  ],
  axe: {
    rules: {},
    tags: ['wcag2a', 'wcag2aa', 'wcag21aa'],
    include: [],
    exclude: ['.third-party-ad', '.analytics-widget'],
    disableRules: [],
    timeout: 30000
  },
  keyboard: {
    testFocusOrder: true,
    testTrapDetection: true,
    testArrowKeyNavigation: true,
    testEscapeHandling: true,
    customSequences: [
      {
        name: 'product-quick-view',
        keys: ['Tab', 'Enter', 'Escape'],
        expectedBehavior: 'Opens and closes product quick view modal',
        validator: 'document.querySelector(".quick-view-modal") === null'
      },
      {
        name: 'add-to-cart',
        keys: ['Tab', 'Tab', 'Enter'],
        expectedBehavior: 'Adds product to cart',
        validator: 'document.querySelector(".cart-count").textContent !== "0"'
      }
    ]
  },
  screenReader: {
    testAriaLabels: true,
    testLandmarkNavigation: true,
    testImageAltText: true,
    testHeadingStructure: true,
    simulateScreenReader: true
  },
  failureThreshold: {
    critical: true,
    serious: true,
    moderate: false,
    minor: false
  },
  reporting: {
    includePassedTests: false,
    groupByImpact: true,
    includeScreenshots: true
  },
  output: {
    format: 'html',
    path: './reports/accessibility-report.html'
  }
});

const result = await runner.run();

console.log('=== Accessibility Test Results ===');
console.log(`Overall Score: ${result.summary.score}/100`);
console.log(`Status: ${result.summary.passed ? 'PASSED' : 'FAILED'}`);
console.log(`Duration: ${result.duration}ms`);

console.log('\n=== Test Coverage ===');
console.log(`Pages Tested: ${result.summary.pagesTested}`);
console.log(`Total Violations: ${result.summary.totalViolations}`);

console.log('\n=== Violations by Severity ===');
console.log(`Critical: ${result.summary.violationsBySeverity.critical}`);
console.log(`Serious: ${result.summary.violationsBySeverity.serious}`);
console.log(`Moderate: ${result.summary.violationsBySeverity.moderate}`);
console.log(`Minor: ${result.summary.violationsBySeverity.minor}`);

console.log('\n=== Keyboard Navigation ===');
console.log(`Tests Passed: ${result.summary.keyboardTestsPassed}`);
console.log(`Tests Failed: ${result.summary.keyboardTestsFailed}`);

if (!result.summary.passed) {
  console.log('\n=== Detailed Violations ===');
  result.results.forEach(pageResult => {
    if (pageResult.axeResult.violations.length > 0) {
      console.log(`\nPage: ${pageResult.page}`);
      pageResult.axeResult.violations.forEach(violation => {
        console.log(`  [${violation.impact.toUpperCase()}] ${violation.id}`);
        console.log(`    ${violation.help}`);
        console.log(`    Affected: ${violation.nodes.length} element(s)`);
        console.log(`    Help: ${violation.helpUrl}`);
      });
    }
  });

  if (result.reportPath) {
    console.log(`\n📋 Full report: ${result.reportPath}`);
  }

  process.exit(1);
} else {
  console.log('\n✅ All accessibility tests passed!');
  process.exit(0);
}
```

### CI/CD Integration Example

```typescript
// accessibility-test.ts
import { AccessibilityRunner } from '@iris/a11y';

async function runAccessibilityTests() {
  const runner = new AccessibilityRunner({
    pages: process.env.TEST_PAGES?.split(',') || ['/'],
    axe: {
      rules: {},
      tags: ['wcag2a', 'wcag2aa'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000
    },
    keyboard: {
      testFocusOrder: true,
      testTrapDetection: true,
      testArrowKeyNavigation: false,
      testEscapeHandling: true,
      customSequences: []
    },
    screenReader: {
      testAriaLabels: true,
      testLandmarkNavigation: true,
      testImageAltText: true,
      testHeadingStructure: true,
      simulateScreenReader: false
    },
    failureThreshold: {
      critical: true,
      serious: true,
      moderate: false,
      minor: false
    },
    reporting: {
      includePassedTests: false,
      groupByImpact: true,
      includeScreenshots: true
    },
    output: {
      format: 'junit',
      path: './test-results/accessibility-junit.xml'
    }
  });

  try {
    const result = await runner.run();

    // Write summary to file for CI consumption
    const fs = await import('fs');
    fs.writeFileSync(
      './test-results/accessibility-summary.json',
      JSON.stringify({
        score: result.summary.score,
        passed: result.summary.passed,
        totalViolations: result.summary.totalViolations,
        violationsBySeverity: result.summary.violationsBySeverity,
        duration: result.duration
      }, null, 2)
    );

    if (!result.summary.passed) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Accessibility testing failed:', error);
    process.exit(1);
  }
}

runAccessibilityTests();
```

---

## See Also

- [Accessibility Testing Guide](../guides/accessibility-testing.md)
- [Visual Testing API](./visual-testing.md)
- [CI/CD Integration Guide](../guides/ci-cd-integration.md)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
