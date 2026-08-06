/**
 * Tests for VisualReporter - Multi-format report generation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VisualReporter } from '../../src/visual/reporter';
import type { VisualTestResult } from '../../src/visual/visual-runner';

describe('VisualReporter', () => {
  const mockResults: VisualTestResult = {
    summary: {
      totalComparisons: 3,
      passed: 1,
      failed: 2,
      newBaselines: 0,
      overallStatus: 'failed',
      severityCounts: {
        breaking: 1,
        moderate: 1,
        minor: 0,
      },
    },
    results: [
      {
        page: '/home',
        device: 'desktop',
        passed: true,
        similarity: 1.0,
        pixelDifference: 0,
        threshold: 0.1,
        screenshotPath: '/tmp/home-desktop.png',
        baselinePath: '/tmp/baseline-home-desktop.png',
      },
      {
        page: '/about',
        device: 'mobile',
        passed: false,
        similarity: 0.85,
        pixelDifference: 0.15,
        threshold: 0.1,
        ssim: 0.78,
        severity: 'breaking',
        screenshotPath: '/tmp/about-mobile.png',
        baselinePath: '/tmp/baseline-about-mobile.png',
        diffPath: '/tmp/diff-about-mobile.png',
        aiAnalysis: {
          classification: 'unintentional',
          confidence: 0.95,
          description: 'Layout shift detected in navigation bar',
          severity: 'high',
          suggestions: ['Check the flex-basis on .nav', 'Compare against the previous release'],
          isIntentional: false,
          changeType: 'layout',
          reasoning: 'The nav dropped 12px with no corresponding markup change',
        },
      },
      {
        page: '/contact',
        device: 'tablet',
        passed: false,
        similarity: 0.92,
        pixelDifference: 0.08,
        threshold: 0.1,
        severity: 'moderate',
        screenshotPath: '/tmp/contact-tablet.png',
        baselinePath: '/tmp/baseline-contact-tablet.png',
        diffPath: '/tmp/diff-contact-tablet.png',
      },
    ],
    duration: 5000,
    reportPath: undefined,
  };

  const tempDir = path.join(__dirname, '__temp_reports__');

  beforeAll(() => {
    // Create temp directory for test outputs
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('JSON Report Generation', () => {
    it('should generate valid JSON report', async () => {
      const reporter = new VisualReporter({
        format: 'json',
        outputPath: path.join(tempDir, 'report.json'),
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.reportPath).toContain('report.json');
      expect(fs.existsSync(artifacts.reportPath)).toBe(true);

      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');
      const json = JSON.parse(content);

      expect(json.metadata).toBeDefined();
      expect(json.summary).toEqual(mockResults.summary);
      expect(json.results).toHaveLength(3);
      expect(json.duration).toBe(5000);
    });

    it('should use default path when not specified', async () => {
      const reporter = new VisualReporter({
        format: 'json',
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.reportPath).toContain('.iris/reports');
      expect(artifacts.reportPath).toMatch(/visual-report-\d+\.json$/);
      expect(fs.existsSync(artifacts.reportPath)).toBe(true);

      // Cleanup
      fs.unlinkSync(artifacts.reportPath);
    });
  });

  describe('HTML Report Generation', () => {
    it('should generate valid HTML report', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.reportPath).toContain('report.html');
      expect(fs.existsSync(artifacts.reportPath)).toBe(true);

      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      // Verify HTML structure
      expect(content).toContain('<!DOCTYPE html>');
      expect(content).toContain('<title>IRIS Visual Regression Report</title>');
      expect(content).toContain('report-header');
      expect(content).toContain('summary-stats');
    });

    it('should include summary statistics in HTML', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-summary.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('Total Tests');
      expect(content).toContain('>3<'); // totalComparisons
      expect(content).toContain('Passed');
      expect(content).toContain('>1<'); // passed
      expect(content).toContain('Failed');
      expect(content).toContain('>2<'); // failed
    });

    it('should include severity breakdown in HTML', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-severity.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('Severity Breakdown');
      expect(content).toContain('severity-card breaking');
      expect(content).toContain('severity-card moderate');
    });

    it('should include test result cards', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-results.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('test-card');
      expect(content).toContain('/home - desktop');
      expect(content).toContain('/about - mobile');
      expect(content).toContain('/contact - tablet');
    });

    it('should include AI analysis in HTML when available', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-ai.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('AI Analysis');
      expect(content).toContain('unintentional');
      expect(content).toContain('Layout shift detected');
      expect(content).toContain('95% confidence');
    });

    it('should include interactive diff viewer', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-diff.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('diff-viewer');
      expect(content).toContain('side-by-side');
      expect(content).toContain('overlay');
      expect(content).toContain('diff-only');
    });

    it('should include filter buttons', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-filters.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('filter-btn');
      expect(content).toContain('data-filter="all"');
      expect(content).toContain('data-filter="failed"');
      expect(content).toContain('data-filter="passed"');
      expect(content).toContain('data-filter="breaking"');
      expect(content).toContain('data-filter="moderate"');
    });

    it('should include JavaScript for interactivity', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-js.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('<script>');
      expect(content).toContain('querySelectorAll');
      expect(content).toContain('addEventListener');
    });

    it('should support custom title', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-title.html'),
        title: 'Custom Test Report',
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('Custom Test Report');
    });

    // Issue #77: SSIM reached the report only after being wired into the diff
    // engine; before that the docs advertised a metric nothing ever displayed.
    it('should show the structural similarity metric for failures that carry one', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-ssim.html'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('Structural');
      expect(content).toContain('78.00%'); // /about carries ssim 0.78
    });

    it('should omit the structural metric for results without one', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-nossim.html'),
      });

      const artifacts = await reporter.generateReport({
        ...mockResults,
        // Only the passing /home result, which never carries an SSIM score.
        results: [mockResults.results[0]],
      });
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).not.toContain('Structural');
    });
  });

  describe('JUnit XML Report Generation', () => {
    it('should generate valid JUnit XML report', async () => {
      const reporter = new VisualReporter({
        format: 'junit',
        outputPath: path.join(tempDir, 'report.xml'),
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.reportPath).toContain('report.xml');
      expect(fs.existsSync(artifacts.reportPath)).toBe(true);

      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      // Verify XML structure
      expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(content).toContain('<testsuites');
      expect(content).toContain('<testsuite');
      expect(content).toContain('<testcase');
    });

    it('should include test suite attributes', async () => {
      const reporter = new VisualReporter({
        format: 'junit',
        outputPath: path.join(tempDir, 'report-suite.xml'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('tests="3"');
      expect(content).toContain('failures="2"');
    });

    it('should include failure details', async () => {
      const reporter = new VisualReporter({
        format: 'junit',
        outputPath: path.join(tempDir, 'report-failures.xml'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('<failure');
      expect(content).toContain('Visual regression detected');
      expect(content).toContain('Similarity:');
      expect(content).toContain('Pixel Difference:');
      expect(content).toContain('Severity:');
    });

    it('should include AI analysis in failure messages', async () => {
      const reporter = new VisualReporter({
        format: 'junit',
        outputPath: path.join(tempDir, 'report-ai-junit.xml'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('AI Classification');
      expect(content).toContain('unintentional');
      expect(content).toContain('Layout shift detected');
    });
  });

  describe('Markdown Report Generation', () => {
    it('should generate valid Markdown report', async () => {
      const reporter = new VisualReporter({
        format: 'markdown',
        outputPath: path.join(tempDir, 'report.md'),
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.reportPath).toContain('report.md');
      expect(fs.existsSync(artifacts.reportPath)).toBe(true);

      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      // Verify Markdown structure
      expect(content).toMatch(/^# /);
      expect(content).toContain('## Summary');
      expect(content).toContain('## Test Results');
    });

    it('should include summary statistics in Markdown', async () => {
      const reporter = new VisualReporter({
        format: 'markdown',
        outputPath: path.join(tempDir, 'report-summary.md'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('- **Total Tests:** 3');
      expect(content).toContain('- **Passed:** 1');
      expect(content).toContain('- **Failed:** 2');
    });

    it('should include severity breakdown in Markdown', async () => {
      const reporter = new VisualReporter({
        format: 'markdown',
        outputPath: path.join(tempDir, 'report-severity.md'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('### Severity Breakdown');
      expect(content).toContain('- **Breaking:** 1');
      expect(content).toContain('- **Moderate:** 1');
    });

    it('should include test results with emojis', async () => {
      const reporter = new VisualReporter({
        format: 'markdown',
        outputPath: path.join(tempDir, 'report-results.md'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('### ✅ /home [desktop]');
      expect(content).toContain('### ❌ /about [mobile]');
      expect(content).toContain('### ❌ /contact [tablet]');
    });

    it('should include AI analysis in Markdown', async () => {
      const reporter = new VisualReporter({
        format: 'markdown',
        outputPath: path.join(tempDir, 'report-ai.md'),
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('**AI Analysis:**');
      expect(content).toContain('- Classification: unintentional');
      expect(content).toContain('- Confidence: 95%');
      expect(content).toContain('- Description: Layout shift detected');
    });
  });

  describe('Configuration Options', () => {
    it('should filter out passed tests when includePassedTests is false', async () => {
      const reporter = new VisualReporter({
        format: 'json',
        outputPath: path.join(tempDir, 'report-no-passed.json'),
        includePassedTests: false,
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');
      const json = JSON.parse(content);

      // Only failed tests should be in results
      const allPassed = json.results.every((r: any) => !r.passed);
      expect(allPassed).toBe(true);
    });

    it('should use custom timestamp', async () => {
      const customDate = new Date('2025-01-15T10:30:00Z');
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-timestamp.html'),
        timestamp: customDate,
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('January 15, 2025');
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unsupported format', async () => {
      const reporter = new VisualReporter({
        format: 'pdf' as any,
        outputPath: path.join(tempDir, 'report.pdf'),
      });

      await expect(reporter.generateReport(mockResults)).rejects.toThrow(
        'Unsupported report format',
      );
    });

    it('should create output directory if it does not exist', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'deep', 'path');
      const reporter = new VisualReporter({
        format: 'json',
        outputPath: path.join(nestedDir, 'report.json'),
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(fs.existsSync(artifacts.reportPath)).toBe(true);
    });
  });

  describe('Artifact Management', () => {
    it('should create artifact directory', async () => {
      const reporter = new VisualReporter({
        format: 'html',
        outputPath: path.join(tempDir, 'report-artifacts.html'),
        includeScreenshots: true,
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.artifactDir).toContain('artifacts');
      expect(fs.existsSync(artifacts.artifactDir)).toBe(true);
    });

    it('should return screenshot paths', async () => {
      const reporter = new VisualReporter({
        format: 'json',
        outputPath: path.join(tempDir, 'report-screenshots.json'),
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.screenshotPaths).toHaveLength(3);
      expect(artifacts.screenshotPaths[0]).toBe('/tmp/home-desktop.png');
    });
  });
});

/**
 * The AI's fuller output in reports (issue #123 / plan 016 steps 1-2).
 *
 * The classifier already computed suggestions, reasoning, isIntentional and
 * changeType; the runner copied four fields and dropped the rest, so work that
 * had already been paid for never reached a reader.
 */
describe('VisualReporter renders the full AI analysis', () => {
  let tempDir: string;

  const withAnalysis = (
    analysis: NonNullable<VisualTestResult['results'][0]['aiAnalysis']>,
  ): VisualTestResult => ({
    summary: {
      totalComparisons: 1,
      passed: 0,
      failed: 1,
      newBaselines: 0,
      overallStatus: 'failed',
      severityCounts: { breaking: 1, moderate: 0, minor: 0 },
    },
    results: [
      {
        page: '/',
        device: 'desktop',
        passed: false,
        similarity: 0.8,
        pixelDifference: 0.2,
        threshold: 0.1,
        severity: 'breaking',
        screenshotPath: '/tmp/a.png',
        aiAnalysis: analysis,
      },
    ],
    duration: 1,
  });

  const base = {
    classification: 'unintentional',
    confidence: 0.9,
    description: 'The header moved',
    severity: 'high',
    suggestions: ['Check the margin on .header'],
    isIntentional: false,
    changeType: 'layout',
    reasoning: 'No markup change accompanies the shift',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-reporter-ai-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  type Analysis = NonNullable<VisualTestResult['results'][0]['aiAnalysis']>;

  const render = async (format: 'html' | 'markdown' | 'junit', analysis: Analysis = base) => {
    const reporter = new VisualReporter({
      format,
      outputPath: path.join(tempDir, `report.${format}`),
    });
    const artifacts = await reporter.generateReport(withAnalysis(analysis));
    return fs.readFileSync(artifacts.reportPath, 'utf-8');
  };

  describe('HTML', () => {
    it('renders suggestions, reasoning and the intent badge', async () => {
      const content = await render('html');

      expect(content).toContain('Check the margin on .header');
      expect(content).toContain('No markup change accompanies the shift');
      expect(content).toContain('Looks unintentional');
    });

    it('escapes suggestion text, which the model wrote', async () => {
      // Suggestions are model output quoting page content, so they reach the
      // report as untrusted strings — a report that executes them is a report
      // that turned a visual diff into stored XSS.
      const content = await render('html', {
        ...base,
        suggestions: ['<script>alert(1)</script>'],
        reasoning: '<img src=x onerror=alert(2)>',
      });

      expect(content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(content).not.toContain('<script>alert(1)</script>');
      expect(content).toContain('&lt;img src=x onerror=alert(2)&gt;');
    });

    it('omits each section when the model did not supply it', async () => {
      // An empty suggestions list should not render an empty bulleted list, and
      // an undefined intent should not be reported as "unintentional".
      const content = await render('html', {
        classification: 'unknown',
        confidence: 0.5,
        description: 'Something changed',
        severity: 'low',
        suggestions: [],
      });

      // Asserted on the rendered ELEMENT, not the bare class name: the
      // stylesheet always ships every selector, so `not.toContain('analysis-
      // suggestions')` would be matching CSS and would pass however the markup
      // behaved.
      expect(content).not.toContain('<div class="analysis-suggestions">');
      expect(content).not.toContain('<div class="analysis-reasoning">');
      expect(content).not.toContain('<span class="intent-badge');
    });
  });

  describe('a failed analysis', () => {
    // The classifier answers a provider outage with a fallback that carries a
    // severity, an isIntentional and a description that is really an error
    // string. Rendering it as a verdict presents an outage as a judgement —
    // and the new intent badge made that worse, not better.
    const failed = {
      classification: 'unknown',
      confidence: 0.5,
      description: 'Failed to analyze visual changes: All providers failed',
      severity: 'medium',
      suggestions: ['Review the visual changes manually', 'Check AI provider configuration'],
      isIntentional: false,
      changeType: 'unknown',
      reasoning: 'Analysis failed: All providers failed',
      analysisFailed: true,
    };

    it('is never rendered as an intent judgement in HTML', async () => {
      const content = await render('html', failed);

      expect(content).toContain('Analysis unavailable');
      expect(content).toContain('All providers failed');
      // The specific trap: isIntentional is false in the fallback.
      expect(content).not.toContain('Looks unintentional');
      expect(content).not.toContain('<div class="analysis-reasoning">');
      // Troubleshooting suggestions still help, so they stay.
      expect(content).toContain('Check AI provider configuration');
    });

    it('is marked unavailable in Markdown rather than classified', async () => {
      const content = await render('markdown', failed);

      expect(content).toContain('- Analysis unavailable:');
      expect(content).not.toContain('- Classification: unknown');
      expect(content).not.toContain('- Looks intentional:');
      expect(content).not.toContain('- Change type:');
    });

    it('is marked unavailable in JUnit rather than classified', async () => {
      const content = await render('junit', failed);

      expect(content).toContain('AI Analysis Unavailable:');
      expect(content).not.toContain('AI Classification:');
      expect(content).not.toContain('AI Reasoning:');
    });
  });

  describe('Markdown', () => {
    it('lists suggestions and reasoning as bullets', async () => {
      const content = await render('markdown');

      expect(content).toContain('- Reasoning: No markup change accompanies the shift');
      expect(content).toContain('- Looks intentional: no');
      expect(content).toContain('- Change type: layout');
      expect(content).toContain('  - Check the margin on .header');
    });
  });

  describe('JUnit', () => {
    it('escapes the failure body so the XML stays parseable', async () => {
      // The <failure> body carries model-authored text quoting page content. A
      // bare `<` or `&` makes the document unparseable, which fails the CI job
      // for a reason that has nothing to do with the regression. Attributes were
      // already escaped; the body was not.
      const content = await render('junit', {
        ...base,
        description: 'The <header> & <nav> moved',
        reasoning: 'a < b && c > d',
        suggestions: ['Check <script> ordering'],
      });

      expect(content).toContain('&lt;header&gt; &amp; &lt;nav&gt;');
      expect(content).toContain('a &lt; b &amp;&amp; c &gt; d');
      expect(content).toContain('Check &lt;script&gt; ordering');
      expect(content).not.toContain('<header>');

      // The real invariant, stronger than the substrings above and needing no
      // XML parser: the failure body contains no unescaped markup character at
      // all. A half-escaped document would satisfy the checks above and still
      // fail to parse.
      const body = content.slice(content.indexOf('<failure'), content.indexOf('</failure>'));
      const afterOpenTag = body.slice(body.indexOf('>') + 1);
      expect(afterOpenTag).not.toMatch(/[<>]/);
      expect(afterOpenTag).not.toMatch(/&(?!(amp|lt|gt|quot|#0?39);)/);
    });

    it('appends reasoning and suggestions to the failure message', async () => {
      // No schema change: JUnit consumers read the message text, so the extra
      // context goes there rather than into new elements they would ignore.
      const content = await render('junit');

      expect(content).toContain('AI Reasoning: No markup change accompanies the shift');
      expect(content).toContain('- Check the margin on .header');
    });
  });
});
