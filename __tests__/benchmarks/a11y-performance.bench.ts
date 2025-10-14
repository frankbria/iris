/**
 * Accessibility testing performance benchmarks
 * Tests axe-core performance and database write performance
 */

import { chromium, Browser, Page } from 'playwright';
import { AxeRunner } from '../../src/a11y/axe-integration';
import { initializeDatabase, insertA11yTestResult, insertTestRun, A11yTestResult } from '../../src/db';
import { benchmark, benchmarkSuite, formatResults, saveBenchmarkResults } from './bench-utils';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

const RESULTS_DIR = '.iris-bench-results';
const TEST_DB = '.iris-bench-a11y.db';

/**
 * Generate test HTML pages of varying complexity
 */
function generateTestHTML(complexity: 'simple' | 'medium' | 'complex'): string {
  if (complexity === 'simple') {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Simple Test Page</title>
      </head>
      <body>
        <h1>Hello World</h1>
        <p>This is a simple test page.</p>
        <button>Click Me</button>
      </body>
      </html>
    `;
  }

  if (complexity === 'medium') {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Medium Test Page</title>
      </head>
      <body>
        <header>
          <nav>
            <ul>
              <li><a href="/">Home</a></li>
              <li><a href="/about">About</a></li>
              <li><a href="/contact">Contact</a></li>
            </ul>
          </nav>
        </header>
        <main>
          <h1>Welcome</h1>
          <form>
            <label for="name">Name:</label>
            <input type="text" id="name" name="name">
            <label for="email">Email:</label>
            <input type="email" id="email" name="email">
            <button type="submit">Submit</button>
          </form>
          <article>
            <h2>Article Title</h2>
            <p>Lorem ipsum dolor sit amet.</p>
          </article>
        </main>
        <footer>
          <p>&copy; 2024 Test Site</p>
        </footer>
      </body>
      </html>
    `;
  }

  // Complex page with many elements
  const items = Array.from({ length: 100 }, (_, i) => `
    <article>
      <h3>Item ${i + 1}</h3>
      <p>Description for item ${i + 1}</p>
      <button aria-label="Action for item ${i + 1}">Action</button>
    </article>
  `).join('\n');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Complex Test Page</title>
      <style>
        body { font-family: Arial, sans-serif; }
        .container { max-width: 1200px; margin: 0 auto; }
        nav { background: #333; color: white; padding: 1rem; }
        nav ul { display: flex; gap: 1rem; list-style: none; }
        nav a { color: white; text-decoration: none; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
        article { border: 1px solid #ddd; padding: 1rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <header role="banner">
          <nav role="navigation" aria-label="Main navigation">
            <ul>
              <li><a href="/">Home</a></li>
              <li><a href="/products">Products</a></li>
              <li><a href="/services">Services</a></li>
              <li><a href="/about">About</a></li>
              <li><a href="/contact">Contact</a></li>
            </ul>
          </nav>
        </header>
        <main role="main">
          <h1>Product Catalog</h1>
          <form role="search">
            <label for="search">Search products:</label>
            <input type="search" id="search" name="q">
            <button type="submit">Search</button>
          </form>
          <div class="grid">
            ${items}
          </div>
        </main>
        <aside role="complementary">
          <h2>Filters</h2>
          <form>
            <fieldset>
              <legend>Category</legend>
              <label><input type="checkbox" name="category" value="electronics"> Electronics</label>
              <label><input type="checkbox" name="category" value="books"> Books</label>
              <label><input type="checkbox" name="category" value="clothing"> Clothing</label>
            </fieldset>
          </form>
        </aside>
        <footer role="contentinfo">
          <p>&copy; 2024 Test Site. All rights reserved.</p>
        </footer>
      </div>
    </body>
    </html>
  `;
}

/**
 * Benchmark: Single page axe-core scan
 */
async function benchmarkSinglePageAxe(browser: Browser, complexity: 'simple' | 'medium' | 'complex') {
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = generateTestHTML(complexity);
  await page.setContent(html);

  const axeRunner = new AxeRunner({
    rules: {},
    tags: ['wcag2a', 'wcag2aa'],
    include: [],
    exclude: [],
    disableRules: [],
    timeout: 30000
  });

  return async () => {
    await axeRunner.run(page, `test-${complexity}`, 'data:text/html');
  };
}

/**
 * Benchmark: Multi-page axe-core scan (sequential)
 */
async function benchmarkMultiPageAxeSequential(browser: Browser, pageCount: number) {
  const context = await browser.newContext();
  const pages: Page[] = [];
  const runners: AxeRunner[] = [];

  // Prepare pages
  for (let i = 0; i < pageCount; i++) {
    const page = await context.newPage();
    const html = generateTestHTML('medium');
    await page.setContent(html);
    pages.push(page);

    const runner = new AxeRunner({
      rules: {},
      tags: ['wcag2a', 'wcag2aa'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000
    });
    runners.push(runner);
  }

  return async () => {
    for (let i = 0; i < pages.length; i++) {
      await runners[i].run(pages[i], `page-${i}`, 'data:text/html');
    }
  };
}

/**
 * Benchmark: Multi-page axe-core scan (parallel)
 */
async function benchmarkMultiPageAxeParallel(browser: Browser, pageCount: number) {
  const context = await browser.newContext();
  const pages: Page[] = [];
  const runners: AxeRunner[] = [];

  for (let i = 0; i < pageCount; i++) {
    const page = await context.newPage();
    const html = generateTestHTML('medium');
    await page.setContent(html);
    pages.push(page);

    const runner = new AxeRunner({
      rules: {},
      tags: ['wcag2a', 'wcag2aa'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000
    });
    runners.push(runner);
  }

  return async () => {
    await Promise.all(
      pages.map((page, i) => runners[i].run(page, `page-${i}`, 'data:text/html'))
    );
  };
}

/**
 * Benchmark: Database write performance
 */
function benchmarkDatabaseWrites(recordCount: number) {
  const db = initializeDatabase(TEST_DB);

  // Create test run
  const testRunId = insertTestRun(db, {
    instruction: 'Benchmark test',
    status: 'success',
    startTime: new Date()
  });

  const testResults: A11yTestResult[] = [];
  for (let i = 0; i < recordCount; i++) {
    testResults.push({
      testRunId,
      page: `/page-${i}`,
      violationsCritical: Math.floor(Math.random() * 3),
      violationsSerious: Math.floor(Math.random() * 5),
      violationsModerate: Math.floor(Math.random() * 10),
      violationsMinor: Math.floor(Math.random() * 15),
      keyboardPassed: Math.random() > 0.5,
      screenReaderPassed: Math.random() > 0.5,
      score: Math.random() * 100,
      status: Math.random() > 0.7 ? 'passed' : 'failed',
      timestamp: new Date()
    });
  }

  return async () => {
    for (const result of testResults) {
      insertA11yTestResult(db, result);
    }
  };
}

/**
 * Benchmark: Database batch writes with transaction
 */
function benchmarkDatabaseBatchWrites(recordCount: number) {
  const db = initializeDatabase(TEST_DB);

  const testRunId = insertTestRun(db, {
    instruction: 'Benchmark batch test',
    status: 'success',
    startTime: new Date()
  });

  const testResults: A11yTestResult[] = [];
  for (let i = 0; i < recordCount; i++) {
    testResults.push({
      testRunId,
      page: `/page-${i}`,
      violationsCritical: Math.floor(Math.random() * 3),
      violationsSerious: Math.floor(Math.random() * 5),
      violationsModerate: Math.floor(Math.random() * 10),
      violationsMinor: Math.floor(Math.random() * 15),
      keyboardPassed: Math.random() > 0.5,
      screenReaderPassed: Math.random() > 0.5,
      score: Math.random() * 100,
      status: Math.random() > 0.7 ? 'passed' : 'failed',
      timestamp: new Date()
    });
  }

  return async () => {
    const insert = db.transaction((results: A11yTestResult[]) => {
      for (const result of results) {
        insertA11yTestResult(db, result);
      }
    });

    insert(testResults);
  };
}

/**
 * Benchmark: Rule-specific scans
 */
async function benchmarkRuleSpecificScan(browser: Browser, ruleCount: number) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = generateTestHTML('complex');
  await page.setContent(html);

  const allTags = ['wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'section508', 'best-practice'];
  const tags = allTags.slice(0, Math.min(ruleCount, allTags.length));

  const axeRunner = new AxeRunner({
    rules: {},
    tags,
    include: [],
    exclude: [],
    disableRules: [],
    timeout: 30000
  });

  return async () => {
    await axeRunner.run(page, 'rule-specific-test', 'data:text/html');
  };
}

/**
 * Run all accessibility performance benchmarks
 */
async function runA11yBenchmarks() {
  console.log('🚀 Starting Accessibility Performance Benchmarks...\n');

  // Ensure directories exist
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  // Cleanup old test database
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }

  // Launch browser
  const browser = await chromium.launch({ headless: true });

  try {
    const suite = await benchmarkSuite('Accessibility Testing Performance', [
      {
        name: 'Simple Page Axe Scan',
        fn: await benchmarkSinglePageAxe(browser, 'simple'),
        options: { iterations: 30, warmup: 3 }
      },
      {
        name: 'Medium Page Axe Scan',
        fn: await benchmarkSinglePageAxe(browser, 'medium'),
        options: { iterations: 25, warmup: 3 }
      },
      {
        name: 'Complex Page Axe Scan',
        fn: await benchmarkSinglePageAxe(browser, 'complex'),
        options: { iterations: 15, warmup: 2 }
      },
      {
        name: '5 Pages Sequential Axe Scan',
        fn: await benchmarkMultiPageAxeSequential(browser, 5),
        options: { iterations: 8, warmup: 2 }
      },
      {
        name: '5 Pages Parallel Axe Scan',
        fn: await benchmarkMultiPageAxeParallel(browser, 5),
        options: { iterations: 8, warmup: 2 }
      },
      {
        name: '10 Pages Sequential Axe Scan',
        fn: await benchmarkMultiPageAxeSequential(browser, 10),
        options: { iterations: 5, warmup: 1 }
      },
      {
        name: '10 Pages Parallel Axe Scan',
        fn: await benchmarkMultiPageAxeParallel(browser, 10),
        options: { iterations: 5, warmup: 1 }
      },
      {
        name: 'DB Write 10 Records',
        fn: benchmarkDatabaseWrites(10),
        options: { iterations: 50, warmup: 5 }
      },
      {
        name: 'DB Write 50 Records',
        fn: benchmarkDatabaseWrites(50),
        options: { iterations: 20, warmup: 3 }
      },
      {
        name: 'DB Write 100 Records',
        fn: benchmarkDatabaseWrites(100),
        options: { iterations: 10, warmup: 2 }
      },
      {
        name: 'DB Batch Write 100 Records',
        fn: benchmarkDatabaseBatchWrites(100),
        options: { iterations: 15, warmup: 2 }
      },
      {
        name: 'WCAG 2A Rules Only',
        fn: await benchmarkRuleSpecificScan(browser, 1),
        options: { iterations: 20, warmup: 3 }
      },
      {
        name: 'WCAG 2A + 2AA Rules',
        fn: await benchmarkRuleSpecificScan(browser, 2),
        options: { iterations: 20, warmup: 3 }
      },
      {
        name: 'All WCAG Rules',
        fn: await benchmarkRuleSpecificScan(browser, 5),
        options: { iterations: 15, warmup: 2 }
      }
    ]);

    // Display results
    console.log(formatResults(suite));

    // Save results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsPath = path.join(RESULTS_DIR, `a11y-perf-${timestamp}.json`);
    saveBenchmarkResults(suite, resultsPath);
    console.log(`✅ Results saved to: ${resultsPath}`);
  } finally {
    await browser.close();

    // Cleanup test database
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
  }

  return;
}

// Run if executed directly
if (require.main === module) {
  runA11yBenchmarks()
    .then(() => {
      console.log('\n✅ All accessibility benchmarks completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Benchmark failed:', error);
      process.exit(1);
    });
}

export { runA11yBenchmarks };
