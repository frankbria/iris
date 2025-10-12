/**
 * Tests for VisualReporter - Multi-format report generation
 */

import * as fs from 'fs';
import * as path from 'path';
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
        minor: 0
      }
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
        baselinePath: '/tmp/baseline-home-desktop.png'
      },
      {
        page: '/about',
        device: 'mobile',
        passed: false,
        similarity: 0.85,
        pixelDifference: 0.15,
        threshold: 0.1,
        severity: 'breaking',
        screenshotPath: '/tmp/about-mobile.png',
        baselinePath: '/tmp/baseline-about-mobile.png',
        diffPath: '/tmp/diff-about-mobile.png',
        aiAnalysis: {
          classification: 'unintentional',
          confidence: 0.95,
          description: 'Layout shift detected in navigation bar',
          severity: 'high'
        }
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
        diffPath: '/tmp/diff-contact-tablet.png'
      }
    ],
    duration: 5000,
    reportPath: undefined
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
        outputPath: path.join(tempDir, 'report.json')
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
        format: 'json'
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
        outputPath: path.join(tempDir, 'report.html')
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
        outputPath: path.join(tempDir, 'report-summary.html')
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
        outputPath: path.join(tempDir, 'report-severity.html')
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
        outputPath: path.join(tempDir, 'report-results.html')
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
        outputPath: path.join(tempDir, 'report-ai.html')
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
        outputPath: path.join(tempDir, 'report-diff.html')
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
        outputPath: path.join(tempDir, 'report-filters.html')
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
        outputPath: path.join(tempDir, 'report-js.html')
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
        title: 'Custom Test Report'
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('Custom Test Report');
    });
  });

  describe('JUnit XML Report Generation', () => {
    it('should generate valid JUnit XML report', async () => {
      const reporter = new VisualReporter({
        format: 'junit',
        outputPath: path.join(tempDir, 'report.xml')
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
        outputPath: path.join(tempDir, 'report-suite.xml')
      });

      const artifacts = await reporter.generateReport(mockResults);
      const content = fs.readFileSync(artifacts.reportPath, 'utf-8');

      expect(content).toContain('tests="3"');
      expect(content).toContain('failures="2"');
    });

    it('should include failure details', async () => {
      const reporter = new VisualReporter({
        format: 'junit',
        outputPath: path.join(tempDir, 'report-failures.xml')
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
        outputPath: path.join(tempDir, 'report-ai-junit.xml')
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
        outputPath: path.join(tempDir, 'report.md')
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
        outputPath: path.join(tempDir, 'report-summary.md')
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
        outputPath: path.join(tempDir, 'report-severity.md')
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
        outputPath: path.join(tempDir, 'report-results.md')
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
        outputPath: path.join(tempDir, 'report-ai.md')
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
        includePassedTests: false
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
        timestamp: customDate
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
        outputPath: path.join(tempDir, 'report.pdf')
      });

      await expect(reporter.generateReport(mockResults)).rejects.toThrow('Unsupported report format');
    });

    it('should create output directory if it does not exist', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'deep', 'path');
      const reporter = new VisualReporter({
        format: 'json',
        outputPath: path.join(nestedDir, 'report.json')
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
        includeScreenshots: true
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.artifactDir).toContain('artifacts');
      expect(fs.existsSync(artifacts.artifactDir)).toBe(true);
    });

    it('should return screenshot paths', async () => {
      const reporter = new VisualReporter({
        format: 'json',
        outputPath: path.join(tempDir, 'report-screenshots.json')
      });

      const artifacts = await reporter.generateReport(mockResults);

      expect(artifacts.screenshotPaths).toHaveLength(3);
      expect(artifacts.screenshotPaths[0]).toBe('/tmp/home-desktop.png');
    });
  });
});
