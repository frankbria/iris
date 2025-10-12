/**
 * VisualReporter - Multi-format report generation for visual regression tests
 *
 * Generates comprehensive reports in HTML, JSON, JUnit XML, and Markdown formats
 * with interactive diff viewers, severity filtering, and artifact management.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { VisualTestResult } from './visual-runner';

export interface ReportConfig {
  format: 'html' | 'json' | 'junit' | 'markdown';
  outputPath?: string;
  title?: string;
  includeScreenshots?: boolean;
  includePassedTests?: boolean;
  relativePaths?: boolean;
  timestamp?: Date;
}

export interface ReportArtifacts {
  reportPath: string;
  screenshotPaths: string[];
  artifactDir: string;
}

/**
 * VisualReporter generates multi-format reports for visual regression tests
 */
export class VisualReporter {
  private config: ReportConfig;

  constructor(config: Partial<ReportConfig> = {}) {
    this.config = {
      format: config.format || 'html',
      outputPath: config.outputPath,
      title: config.title || 'IRIS Visual Regression Report',
      includeScreenshots: config.includeScreenshots !== false,
      includePassedTests: config.includePassedTests !== false,
      relativePaths: config.relativePaths !== false,
      timestamp: config.timestamp || new Date()
    };
  }

  /**
   * Generate report from visual test results
   */
  async generateReport(results: VisualTestResult): Promise<ReportArtifacts> {
    // Determine output path
    const outputPath = this.config.outputPath || this.getDefaultOutputPath();

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate report based on format
    let reportContent: string;
    switch (this.config.format) {
      case 'html':
        reportContent = await this.generateHTMLReport(results);
        break;
      case 'json':
        reportContent = this.generateJSONReport(results);
        break;
      case 'junit':
        reportContent = this.generateJUnitReport(results);
        break;
      case 'markdown':
        reportContent = this.generateMarkdownReport(results);
        break;
      default:
        throw new Error(`Unsupported report format: ${this.config.format}`);
    }

    // Write report to file
    fs.writeFileSync(outputPath, reportContent, 'utf-8');

    // Copy artifacts if needed
    const artifactDir = await this.organizeArtifacts(results, outputDir);

    return {
      reportPath: outputPath,
      screenshotPaths: results.results.map(r => r.screenshotPath),
      artifactDir
    };
  }

  /**
   * Generate HTML report with interactive diff viewer
   */
  private async generateHTMLReport(results: VisualTestResult): Promise<string> {
    const { summary, results: testResults } = results;

    // Build HTML structure
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHtml(this.config.title!)}</title>
  <style>
    ${this.getHTMLStyles()}
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="report-header">
      <h1>
        <svg class="logo" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        ${this.escapeHtml(this.config.title!)}
      </h1>
      <div class="meta">
        <span class="timestamp">${this.formatTimestamp(this.config.timestamp!)}</span>
        <span class="duration">Duration: ${this.formatDuration(results.duration)}</span>
      </div>
    </header>

    <!-- Summary Stats -->
    <section class="summary-stats">
      <div class="stat-card ${summary.overallStatus}">
        <div class="stat-label">Status</div>
        <div class="stat-value status-${summary.overallStatus}">
          ${summary.overallStatus.toUpperCase()}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Tests</div>
        <div class="stat-value">${summary.totalComparisons}</div>
      </div>
      <div class="stat-card passed">
        <div class="stat-label">Passed</div>
        <div class="stat-value">${summary.passed}</div>
      </div>
      <div class="stat-card failed">
        <div class="stat-label">Failed</div>
        <div class="stat-value">${summary.failed}</div>
      </div>
      ${summary.newBaselines > 0 ? `
      <div class="stat-card new">
        <div class="stat-label">New Baselines</div>
        <div class="stat-value">${summary.newBaselines}</div>
      </div>
      ` : ''}
    </section>

    <!-- Severity Breakdown -->
    ${this.generateSeverityBreakdown(summary)}

    <!-- Filters -->
    <section class="filters">
      <button class="filter-btn active" data-filter="all">All Tests</button>
      <button class="filter-btn" data-filter="failed">Failed Only</button>
      <button class="filter-btn" data-filter="passed">Passed Only</button>
      ${Object.keys(summary.severityCounts).length > 0 ? `
      <button class="filter-btn" data-filter="breaking">Breaking</button>
      <button class="filter-btn" data-filter="moderate">Moderate</button>
      <button class="filter-btn" data-filter="minor">Minor</button>
      ` : ''}
    </section>

    <!-- Test Results -->
    <section class="test-results">
      ${this.generateTestResultCards(testResults)}
    </section>
  </div>

  <script>
    ${this.getHTMLScript()}
  </script>
</body>
</html>`;

    return html;
  }

  /**
   * Generate severity breakdown section
   */
  private generateSeverityBreakdown(summary: VisualTestResult['summary']): string {
    const { severityCounts } = summary;
    if (Object.keys(severityCounts).length === 0) {
      return '';
    }

    return `
    <section class="severity-breakdown">
      <h2>Severity Breakdown</h2>
      <div class="severity-stats">
        ${severityCounts.breaking ? `
        <div class="severity-card breaking">
          <div class="severity-label">Breaking</div>
          <div class="severity-value">${severityCounts.breaking}</div>
        </div>
        ` : ''}
        ${severityCounts.moderate ? `
        <div class="severity-card moderate">
          <div class="severity-label">Moderate</div>
          <div class="severity-value">${severityCounts.moderate}</div>
        </div>
        ` : ''}
        ${severityCounts.minor ? `
        <div class="severity-card minor">
          <div class="severity-label">Minor</div>
          <div class="severity-value">${severityCounts.minor}</div>
        </div>
        ` : ''}
      </div>
    </section>`;
  }

  /**
   * Generate test result cards with diff viewers
   */
  private generateTestResultCards(results: VisualTestResult['results']): string {
    return results
      .filter(result => this.config.includePassedTests || !result.passed)
      .map((result, index) => {
        const statusClass = result.passed ? 'passed' : 'failed';
        const severityClass = result.severity || '';

        return `
        <div class="test-card ${statusClass} ${severityClass}" data-status="${statusClass}" data-severity="${severityClass}">
          <div class="test-header">
            <div class="test-title">
              <span class="status-icon ${statusClass}">
                ${result.passed ? '✓' : '✗'}
              </span>
              <h3>${this.escapeHtml(result.page)} - ${this.escapeHtml(result.device)}</h3>
            </div>
            <div class="test-meta">
              ${result.severity ? `<span class="severity-badge ${result.severity}">${result.severity}</span>` : ''}
            </div>
          </div>

          <div class="test-metrics">
            <div class="metric">
              <span class="metric-label">Similarity</span>
              <span class="metric-value">${(result.similarity * 100).toFixed(2)}%</span>
            </div>
            <div class="metric">
              <span class="metric-label">Pixel Diff</span>
              <span class="metric-value">${(result.pixelDifference * 100).toFixed(2)}%</span>
            </div>
            <div class="metric">
              <span class="metric-label">Threshold</span>
              <span class="metric-value">${(result.threshold * 100).toFixed(2)}%</span>
            </div>
          </div>

          ${result.aiAnalysis ? `
          <div class="ai-analysis">
            <h4>AI Analysis</h4>
            <div class="analysis-content">
              <div class="analysis-classification">
                <strong>Classification:</strong> ${this.escapeHtml(result.aiAnalysis.classification)}
                <span class="confidence">(${(result.aiAnalysis.confidence * 100).toFixed(0)}% confidence)</span>
              </div>
              <div class="analysis-description">
                ${this.escapeHtml(result.aiAnalysis.description)}
              </div>
            </div>
          </div>
          ` : ''}

          ${!result.passed && this.config.includeScreenshots ? `
          <div class="diff-viewer">
            <div class="diff-controls">
              <button class="diff-mode-btn active" data-mode="side-by-side">Side by Side</button>
              <button class="diff-mode-btn" data-mode="overlay">Overlay</button>
              <button class="diff-mode-btn" data-mode="diff-only">Diff Only</button>
            </div>

            <div class="diff-images side-by-side">
              ${result.baselinePath ? `
              <div class="image-container">
                <div class="image-label">Baseline</div>
                <img src="${this.getRelativePath(result.baselinePath!)}" alt="Baseline" class="comparison-image baseline">
              </div>
              ` : ''}
              <div class="image-container">
                <div class="image-label">Current</div>
                <img src="${this.getRelativePath(result.screenshotPath)}" alt="Current" class="comparison-image current">
              </div>
              ${result.diffPath ? `
              <div class="image-container">
                <div class="image-label">Difference</div>
                <img src="${this.getRelativePath(result.diffPath!)}" alt="Diff" class="comparison-image diff">
              </div>
              ` : ''}
            </div>
          </div>
          ` : ''}
        </div>`;
      })
      .join('\n');
  }

  /**
   * Generate JSON report
   */
  private generateJSONReport(results: VisualTestResult): string {
    // Filter results based on configuration
    const filteredResults = this.config.includePassedTests
      ? results.results
      : results.results.filter(r => !r.passed);

    return JSON.stringify({
      metadata: {
        title: this.config.title,
        timestamp: this.config.timestamp,
        format: 'json',
        version: '1.0.0'
      },
      summary: results.summary,
      results: filteredResults,
      duration: results.duration
    }, null, 2);
  }

  /**
   * Generate JUnit XML report for CI/CD integration
   */
  private generateJUnitReport(results: VisualTestResult): string {
    const { summary, results: testResults, duration } = results;

    const testsuites = testResults.reduce((acc: any, result) => {
      const suiteName = result.page;
      if (!acc[suiteName]) {
        acc[suiteName] = [];
      }
      acc[suiteName].push(result);
      return acc;
    }, {});

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${this.escapeXml(this.config.title!)}" tests="${summary.totalComparisons}" failures="${summary.failed}" time="${(duration / 1000).toFixed(3)}">
${Object.entries(testsuites).map(([suiteName, tests]: [string, any]) => {
  const suiteTests = tests as VisualTestResult['results'];
  const suiteFailed = suiteTests.filter(t => !t.passed).length;
  const suiteTime = duration / summary.totalComparisons / 1000;

  return `  <testsuite name="${this.escapeXml(suiteName)}" tests="${suiteTests.length}" failures="${suiteFailed}" time="${suiteTime.toFixed(3)}">
${suiteTests.map((test, index) => {
  const testName = `${test.page} [${test.device}]`;
  const testTime = (duration / summary.totalComparisons / 1000).toFixed(3);

  return `    <testcase name="${this.escapeXml(testName)}" classname="${this.escapeXml(suiteName)}" time="${testTime}">
${!test.passed ? `      <failure message="Visual regression detected" type="VisualDiff">
Similarity: ${(test.similarity * 100).toFixed(2)}%
Pixel Difference: ${(test.pixelDifference * 100).toFixed(2)}%
Threshold: ${(test.threshold * 100).toFixed(2)}%
Severity: ${test.severity || 'unknown'}
${test.aiAnalysis ? `AI Classification: ${test.aiAnalysis.classification}
AI Description: ${test.aiAnalysis.description}` : ''}
      </failure>` : ''}
    </testcase>`;
}).join('\n')}
  </testsuite>`;
}).join('\n')}
</testsuites>`;

    return xml;
  }

  /**
   * Generate Markdown report
   */
  private generateMarkdownReport(results: VisualTestResult): string {
    const { summary, results: testResults, duration } = results;

    let markdown = `# ${this.config.title}\n\n`;
    markdown += `**Generated:** ${this.formatTimestamp(this.config.timestamp!)}\n`;
    markdown += `**Duration:** ${this.formatDuration(duration)}\n\n`;

    // Summary
    markdown += `## Summary\n\n`;
    markdown += `- **Status:** ${summary.overallStatus.toUpperCase()}\n`;
    markdown += `- **Total Tests:** ${summary.totalComparisons}\n`;
    markdown += `- **Passed:** ${summary.passed}\n`;
    markdown += `- **Failed:** ${summary.failed}\n`;
    if (summary.newBaselines > 0) {
      markdown += `- **New Baselines:** ${summary.newBaselines}\n`;
    }
    markdown += `\n`;

    // Severity Breakdown
    if (Object.keys(summary.severityCounts).length > 0) {
      markdown += `### Severity Breakdown\n\n`;
      if (summary.severityCounts.breaking) {
        markdown += `- **Breaking:** ${summary.severityCounts.breaking}\n`;
      }
      if (summary.severityCounts.moderate) {
        markdown += `- **Moderate:** ${summary.severityCounts.moderate}\n`;
      }
      if (summary.severityCounts.minor) {
        markdown += `- **Minor:** ${summary.severityCounts.minor}\n`;
      }
      markdown += `\n`;
    }

    // Test Results
    markdown += `## Test Results\n\n`;
    testResults.forEach((result, index) => {
      const statusEmoji = result.passed ? '✅' : '❌';
      markdown += `### ${statusEmoji} ${result.page} [${result.device}]\n\n`;
      markdown += `- **Status:** ${result.passed ? 'PASSED' : 'FAILED'}\n`;
      if (result.severity) {
        markdown += `- **Severity:** ${result.severity.toUpperCase()}\n`;
      }
      markdown += `- **Similarity:** ${(result.similarity * 100).toFixed(2)}%\n`;
      markdown += `- **Pixel Difference:** ${(result.pixelDifference * 100).toFixed(2)}%\n`;
      markdown += `- **Threshold:** ${(result.threshold * 100).toFixed(2)}%\n`;

      if (result.aiAnalysis) {
        markdown += `\n**AI Analysis:**\n`;
        markdown += `- Classification: ${result.aiAnalysis.classification}\n`;
        markdown += `- Confidence: ${(result.aiAnalysis.confidence * 100).toFixed(0)}%\n`;
        markdown += `- Description: ${result.aiAnalysis.description}\n`;
      }

      markdown += `\n`;
    });

    return markdown;
  }

  /**
   * Organize artifacts (copy screenshots to report directory)
   */
  private async organizeArtifacts(results: VisualTestResult, outputDir: string): Promise<string> {
    const artifactDir = path.join(outputDir, 'artifacts');

    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    // Copy screenshots if needed
    if (this.config.includeScreenshots && this.config.format === 'html') {
      for (const result of results.results) {
        // Copy current screenshot
        if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
          const filename = path.basename(result.screenshotPath);
          const destPath = path.join(artifactDir, filename);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(result.screenshotPath, destPath);
          }
        }

        // Copy baseline if exists
        if (result.baselinePath && fs.existsSync(result.baselinePath)) {
          const filename = path.basename(result.baselinePath);
          const destPath = path.join(artifactDir, `baseline_${filename}`);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(result.baselinePath, destPath);
          }
        }

        // Copy diff if exists
        if (result.diffPath && fs.existsSync(result.diffPath)) {
          const filename = path.basename(result.diffPath);
          const destPath = path.join(artifactDir, `diff_${filename}`);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(result.diffPath, destPath);
          }
        }
      }
    }

    return artifactDir;
  }

  /**
   * Get default output path based on format
   */
  private getDefaultOutputPath(): string {
    const timestamp = this.config.timestamp!.getTime();
    const extension = this.config.format === 'junit' ? 'xml' : this.config.format;
    return path.join('.iris', 'reports', `visual-report-${timestamp}.${extension}`);
  }

  /**
   * Get relative path for HTML report links
   */
  private getRelativePath(absolutePath: string): string {
    if (!this.config.relativePaths) {
      return absolutePath;
    }
    return path.relative(path.dirname(this.config.outputPath || ''), absolutePath);
  }

  /**
   * HTML styles
   */
  private getHTMLStyles(): string {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background: #f5f5f5;
        color: #333;
        line-height: 1.6;
      }

      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 2rem;
      }

      .report-header {
        background: white;
        border-radius: 8px;
        padding: 2rem;
        margin-bottom: 2rem;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }

      .report-header h1 {
        display: flex;
        align-items: center;
        gap: 1rem;
        font-size: 2rem;
        margin-bottom: 0.5rem;
      }

      .logo {
        color: #6366f1;
      }

      .meta {
        display: flex;
        gap: 2rem;
        color: #666;
        font-size: 0.9rem;
      }

      .summary-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 1rem;
        margin-bottom: 2rem;
      }

      .stat-card {
        background: white;
        border-radius: 8px;
        padding: 1.5rem;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }

      .stat-label {
        color: #666;
        font-size: 0.875rem;
        margin-bottom: 0.5rem;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .stat-value {
        font-size: 2rem;
        font-weight: bold;
      }

      .status-passed { color: #10b981; }
      .status-failed { color: #ef4444; }
      .passed .stat-value { color: #10b981; }
      .failed .stat-value { color: #ef4444; }
      .new .stat-value { color: #6366f1; }

      .severity-breakdown {
        background: white;
        border-radius: 8px;
        padding: 2rem;
        margin-bottom: 2rem;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }

      .severity-breakdown h2 {
        margin-bottom: 1rem;
      }

      .severity-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 1rem;
      }

      .severity-card {
        padding: 1rem;
        border-radius: 6px;
        text-align: center;
      }

      .severity-card.breaking { background: #fee2e2; border: 2px solid #ef4444; }
      .severity-card.moderate { background: #fef3c7; border: 2px solid #f59e0b; }
      .severity-card.minor { background: #dbeafe; border: 2px solid #3b82f6; }

      .severity-label {
        font-size: 0.875rem;
        color: #666;
        margin-bottom: 0.5rem;
      }

      .severity-value {
        font-size: 1.5rem;
        font-weight: bold;
      }

      .filters {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 2rem;
        flex-wrap: wrap;
      }

      .filter-btn {
        padding: 0.5rem 1rem;
        border: 2px solid #e5e7eb;
        background: white;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.875rem;
        transition: all 0.2s;
      }

      .filter-btn:hover {
        border-color: #6366f1;
      }

      .filter-btn.active {
        background: #6366f1;
        color: white;
        border-color: #6366f1;
      }

      .test-results {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }

      .test-card {
        background: white;
        border-radius: 8px;
        padding: 1.5rem;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        border-left: 4px solid #e5e7eb;
      }

      .test-card.passed {
        border-left-color: #10b981;
      }

      .test-card.failed {
        border-left-color: #ef4444;
      }

      .test-card.hidden {
        display: none;
      }

      .test-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
      }

      .test-title {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .status-icon {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        font-size: 1.2rem;
      }

      .status-icon.passed {
        background: #d1fae5;
        color: #10b981;
      }

      .status-icon.failed {
        background: #fee2e2;
        color: #ef4444;
      }

      .test-title h3 {
        font-size: 1.25rem;
      }

      .severity-badge {
        padding: 0.25rem 0.75rem;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: bold;
        text-transform: uppercase;
      }

      .severity-badge.breaking {
        background: #fee2e2;
        color: #991b1b;
      }

      .severity-badge.moderate {
        background: #fef3c7;
        color: #92400e;
      }

      .severity-badge.minor {
        background: #dbeafe;
        color: #1e40af;
      }

      .test-metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 1rem;
        margin-bottom: 1rem;
      }

      .metric {
        padding: 0.75rem;
        background: #f9fafb;
        border-radius: 4px;
      }

      .metric-label {
        display: block;
        font-size: 0.75rem;
        color: #666;
        margin-bottom: 0.25rem;
      }

      .metric-value {
        font-size: 1.125rem;
        font-weight: bold;
      }

      .ai-analysis {
        margin-bottom: 1rem;
        padding: 1rem;
        background: #f0f9ff;
        border-radius: 6px;
        border: 1px solid #bae6fd;
      }

      .ai-analysis h4 {
        margin-bottom: 0.5rem;
        color: #0c4a6e;
      }

      .analysis-classification {
        margin-bottom: 0.5rem;
      }

      .confidence {
        color: #666;
        font-size: 0.875rem;
        margin-left: 0.5rem;
      }

      .analysis-description {
        color: #334155;
        line-height: 1.5;
      }

      .diff-viewer {
        margin-top: 1rem;
      }

      .diff-controls {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }

      .diff-mode-btn {
        padding: 0.5rem 1rem;
        border: 2px solid #e5e7eb;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        transition: all 0.2s;
      }

      .diff-mode-btn:hover {
        border-color: #6366f1;
      }

      .diff-mode-btn.active {
        background: #6366f1;
        color: white;
        border-color: #6366f1;
      }

      .diff-images {
        display: grid;
        gap: 1rem;
      }

      .diff-images.side-by-side {
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }

      .diff-images.overlay,
      .diff-images.diff-only {
        grid-template-columns: 1fr;
      }

      .image-container {
        background: #f9fafb;
        border-radius: 4px;
        padding: 0.5rem;
      }

      .image-label {
        font-size: 0.875rem;
        color: #666;
        margin-bottom: 0.5rem;
        font-weight: 500;
      }

      .comparison-image {
        width: 100%;
        height: auto;
        border-radius: 4px;
        border: 1px solid #e5e7eb;
      }

      @media (max-width: 768px) {
        .container {
          padding: 1rem;
        }

        .summary-stats {
          grid-template-columns: 1fr;
        }

        .diff-images.side-by-side {
          grid-template-columns: 1fr;
        }
      }
    `;
  }

  /**
   * JavaScript for interactive features
   */
  private getHTMLScript(): string {
    return `
      // Filter functionality
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          // Update active state
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          const filter = btn.dataset.filter;
          const cards = document.querySelectorAll('.test-card');

          cards.forEach(card => {
            if (filter === 'all') {
              card.classList.remove('hidden');
            } else if (filter === 'passed' || filter === 'failed') {
              const status = card.dataset.status;
              card.classList.toggle('hidden', status !== filter);
            } else {
              // Severity filter
              const severity = card.dataset.severity;
              card.classList.toggle('hidden', severity !== filter);
            }
          });
        });
      });

      // Diff mode switching
      document.querySelectorAll('.diff-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const card = btn.closest('.test-card');
          const diffImages = card.querySelector('.diff-images');

          // Update active state
          card.querySelectorAll('.diff-mode-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          // Update display mode
          const mode = btn.dataset.mode;
          diffImages.className = 'diff-images ' + mode;

          // Show/hide appropriate images
          const baseline = card.querySelector('.baseline')?.closest('.image-container');
          const current = card.querySelector('.current')?.closest('.image-container');
          const diff = card.querySelector('.diff')?.closest('.image-container');

          if (mode === 'side-by-side') {
            if (baseline) baseline.style.display = 'block';
            if (current) current.style.display = 'block';
            if (diff) diff.style.display = 'block';
          } else if (mode === 'overlay') {
            if (baseline) baseline.style.display = 'block';
            if (current) current.style.display = 'block';
            if (diff) diff.style.display = 'none';
          } else if (mode === 'diff-only') {
            if (baseline) baseline.style.display = 'none';
            if (current) current.style.display = 'none';
            if (diff) diff.style.display = 'block';
          }
        });
      });
    `;
  }

  /**
   * Utility: Escape HTML
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Utility: Escape XML
   */
  private escapeXml(text: string): string {
    return this.escapeHtml(text);
  }

  /**
   * Utility: Format timestamp
   */
  private formatTimestamp(date: Date): string {
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  /**
   * Utility: Format duration
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  }
}
