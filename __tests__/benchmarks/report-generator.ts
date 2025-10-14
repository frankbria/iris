/**
 * Performance report generator
 * Generates comprehensive HTML and markdown reports from benchmark results
 */

import * as fs from 'fs';
import * as path from 'path';
import { BenchmarkSuite, BenchmarkResult, compareBenchmarks } from './bench-utils';

interface ReportOptions {
  outputDir?: string;
  format?: 'html' | 'markdown' | 'both';
  includeCharts?: boolean;
  compareWith?: string; // Path to baseline results
}

/**
 * Generate performance report from benchmark results
 */
export function generateReport(resultsPath: string, options: ReportOptions = {}) {
  const {
    outputDir = '.iris-bench-results',
    format = 'both',
    includeCharts = true,
    compareWith
  } = options;

  // Load results
  const results: BenchmarkSuite & { timestamp: string; platform: any } = JSON.parse(
    fs.readFileSync(resultsPath, 'utf-8')
  );

  let baseline: BenchmarkSuite | null = null;
  if (compareWith && fs.existsSync(compareWith)) {
    baseline = JSON.parse(fs.readFileSync(compareWith, 'utf-8'));
  }

  // Generate reports
  if (format === 'html' || format === 'both') {
    const htmlReport = generateHTMLReport(results, baseline, includeCharts);
    const htmlPath = path.join(outputDir, `report-${results.timestamp.replace(/[:.]/g, '-')}.html`);
    fs.writeFileSync(htmlPath, htmlReport);
    console.log(`📄 HTML report saved: ${htmlPath}`);
  }

  if (format === 'markdown' || format === 'both') {
    const mdReport = generateMarkdownReport(results, baseline);
    const mdPath = path.join(outputDir, `report-${results.timestamp.replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(mdPath, mdReport);
    console.log(`📄 Markdown report saved: ${mdPath}`);
  }
}

/**
 * Generate HTML report
 */
function generateHTMLReport(
  results: BenchmarkSuite & { timestamp: string; platform: any },
  baseline: BenchmarkSuite | null,
  includeCharts: boolean
): string {
  const comparisonRows = baseline ? generateComparisonRows(results, baseline) : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IRIS Performance Report - ${results.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 2rem;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    h1 {
      color: #2c3e50;
      margin-bottom: 0.5rem;
      border-bottom: 3px solid #3498db;
      padding-bottom: 0.5rem;
    }
    h2 {
      color: #34495e;
      margin: 2rem 0 1rem;
      border-left: 4px solid #3498db;
      padding-left: 1rem;
    }
    .meta {
      background: #ecf0f1;
      padding: 1rem;
      border-radius: 4px;
      margin: 1rem 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
    }
    .meta-item {
      display: flex;
      flex-direction: column;
    }
    .meta-label {
      font-size: 0.875rem;
      color: #7f8c8d;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .meta-value {
      font-size: 1.125rem;
      font-weight: 600;
      color: #2c3e50;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
      font-size: 0.95rem;
    }
    th {
      background: #3498db;
      color: white;
      padding: 0.75rem;
      text-align: left;
      font-weight: 600;
      position: sticky;
      top: 0;
    }
    td {
      padding: 0.75rem;
      border-bottom: 1px solid #ecf0f1;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .number {
      text-align: right;
      font-family: 'Courier New', monospace;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 3px;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .badge-faster {
      background: #27ae60;
      color: white;
    }
    .badge-slower {
      background: #e74c3c;
      color: white;
    }
    .badge-neutral {
      background: #95a5a6;
      color: white;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      margin: 2rem 0;
    }
    .summary-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 1.5rem;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .summary-card h3 {
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 0.5rem;
      opacity: 0.9;
    }
    .summary-card .value {
      font-size: 2rem;
      font-weight: 700;
    }
    .chart {
      margin: 2rem 0;
      padding: 1rem;
      background: #f8f9fa;
      border-radius: 4px;
    }
    .bar {
      display: flex;
      align-items: center;
      margin: 0.5rem 0;
    }
    .bar-label {
      width: 200px;
      font-size: 0.875rem;
      padding-right: 1rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-container {
      flex: 1;
      background: #ecf0f1;
      border-radius: 3px;
      height: 24px;
      position: relative;
    }
    .bar-fill {
      background: linear-gradient(90deg, #3498db, #2ecc71);
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .bar-value {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.875rem;
      font-weight: 600;
      color: white;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎯 IRIS Performance Report</h1>
    <p><strong>${results.name}</strong></p>

    <div class="meta">
      <div class="meta-item">
        <span class="meta-label">Timestamp</span>
        <span class="meta-value">${new Date(results.timestamp).toLocaleString()}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Platform</span>
        <span class="meta-value">${results.platform.platform} (${results.platform.arch})</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Node Version</span>
        <span class="meta-value">${results.platform.node}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">CPU Cores</span>
        <span class="meta-value">${results.platform.cpus}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Memory</span>
        <span class="meta-value">${(results.platform.memory / (1024 ** 3)).toFixed(2)} GB</span>
      </div>
    </div>

    <div class="summary-grid">
      <div class="summary-card">
        <h3>Total Duration</h3>
        <div class="value">${(results.summary.totalDuration / 1000).toFixed(2)}s</div>
      </div>
      <div class="summary-card">
        <h3>Total Iterations</h3>
        <div class="value">${results.summary.totalIterations}</div>
      </div>
      <div class="summary-card">
        <h3>Avg Throughput</h3>
        <div class="value">${results.summary.avgThroughput.toFixed(2)} ops/s</div>
      </div>
      <div class="summary-card">
        <h3>Peak Memory</h3>
        <div class="value">${(results.summary.peakMemory / (1024 ** 2)).toFixed(2)} MB</div>
      </div>
    </div>

    <h2>📊 Benchmark Results</h2>
    <table>
      <thead>
        <tr>
          <th>Benchmark</th>
          <th class="number">Iterations</th>
          <th class="number">Avg Time</th>
          <th class="number">Min Time</th>
          <th class="number">Max Time</th>
          <th class="number">Throughput</th>
          ${baseline ? '<th class="number">vs Baseline</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${results.results.map(result => {
          const row = `
            <tr>
              <td>${result.name}</td>
              <td class="number">${result.iterations}</td>
              <td class="number">${result.avgTime.toFixed(2)} ms</td>
              <td class="number">${result.minTime.toFixed(2)} ms</td>
              <td class="number">${result.maxTime.toFixed(2)} ms</td>
              <td class="number">${result.throughput.toFixed(2)} ops/s</td>
            </tr>
          `;
          return row;
        }).join('')}
        ${comparisonRows}
      </tbody>
    </table>

    ${includeCharts ? generateChartsHTML(results) : ''}

    <h2>💾 Memory Usage</h2>
    <table>
      <thead>
        <tr>
          <th>Benchmark</th>
          <th class="number">Heap Used</th>
          <th class="number">Heap Total</th>
          <th class="number">External</th>
          <th class="number">RSS</th>
        </tr>
      </thead>
      <tbody>
        ${results.results.map(result => `
          <tr>
            <td>${result.name}</td>
            <td class="number">${(result.memoryUsage.heapUsed / (1024 ** 2)).toFixed(2)} MB</td>
            <td class="number">${(result.memoryUsage.heapTotal / (1024 ** 2)).toFixed(2)} MB</td>
            <td class="number">${(result.memoryUsage.external / (1024 ** 2)).toFixed(2)} MB</td>
            <td class="number">${(result.memoryUsage.rss / (1024 ** 2)).toFixed(2)} MB</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <footer style="margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #ecf0f1; text-align: center; color: #7f8c8d;">
      <p>Generated by IRIS Performance Benchmark Suite</p>
      <p style="font-size: 0.875rem;">${new Date().toLocaleString()}</p>
    </footer>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Generate comparison rows for baseline vs current
 */
function generateComparisonRows(current: BenchmarkSuite, baseline: BenchmarkSuite): string {
  const rows: string[] = [];

  for (const currentResult of current.results) {
    const baselineResult = baseline.results.find(r => r.name === currentResult.name);
    if (baselineResult) {
      const comparison = compareBenchmarks(baselineResult, currentResult);
      const badge = comparison.faster
        ? `<span class="badge badge-faster">↑ ${Math.abs(comparison.percentChange).toFixed(1)}% faster</span>`
        : `<span class="badge badge-slower">↓ ${Math.abs(comparison.percentChange).toFixed(1)}% slower</span>`;

      rows.push(`<td class="number">${badge}</td>`);
    } else {
      rows.push(`<td class="number"><span class="badge badge-neutral">N/A</span></td>`);
    }
  }

  return rows.join('');
}

/**
 * Generate charts HTML
 */
function generateChartsHTML(results: BenchmarkSuite): string {
  const maxTime = Math.max(...results.results.map(r => r.avgTime));

  return `
    <h2>📈 Performance Visualization</h2>
    <div class="chart">
      <h3>Average Execution Time</h3>
      ${results.results.map(result => {
        const widthPercent = (result.avgTime / maxTime) * 100;
        return `
          <div class="bar">
            <div class="bar-label" title="${result.name}">${result.name}</div>
            <div class="bar-container">
              <div class="bar-fill" style="width: ${widthPercent}%"></div>
              <div class="bar-value">${result.avgTime.toFixed(2)}ms</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * Generate Markdown report
 */
function generateMarkdownReport(
  results: BenchmarkSuite & { timestamp: string; platform: any },
  baseline: BenchmarkSuite | null
): string {
  const lines: string[] = [];

  lines.push(`# IRIS Performance Report`);
  lines.push(`**${results.name}**\n`);

  lines.push(`## Environment`);
  lines.push(`- **Timestamp**: ${new Date(results.timestamp).toLocaleString()}`);
  lines.push(`- **Platform**: ${results.platform.platform} (${results.platform.arch})`);
  lines.push(`- **Node**: ${results.platform.node}`);
  lines.push(`- **CPUs**: ${results.platform.cpus}`);
  lines.push(`- **Memory**: ${(results.platform.memory / (1024 ** 3)).toFixed(2)} GB\n`);

  lines.push(`## Summary`);
  lines.push(`- **Total Duration**: ${(results.summary.totalDuration / 1000).toFixed(2)}s`);
  lines.push(`- **Total Iterations**: ${results.summary.totalIterations}`);
  lines.push(`- **Average Throughput**: ${results.summary.avgThroughput.toFixed(2)} ops/s`);
  lines.push(`- **Peak Memory**: ${(results.summary.peakMemory / (1024 ** 2)).toFixed(2)} MB\n`);

  lines.push(`## Benchmark Results\n`);
  lines.push(`| Benchmark | Iterations | Avg Time | Min Time | Max Time | Throughput |`);
  lines.push(`|-----------|------------|----------|----------|----------|------------|`);

  for (const result of results.results) {
    lines.push(
      `| ${result.name} | ${result.iterations} | ${result.avgTime.toFixed(2)}ms | ${result.minTime.toFixed(2)}ms | ${result.maxTime.toFixed(2)}ms | ${result.throughput.toFixed(2)} ops/s |`
    );
  }

  if (baseline) {
    lines.push(`\n## Comparison with Baseline\n`);
    lines.push(`| Benchmark | Current | Baseline | Change | Status |`);
    lines.push(`|-----------|---------|----------|--------|--------|`);

    for (const currentResult of results.results) {
      const baselineResult = baseline.results.find(r => r.name === currentResult.name);
      if (baselineResult) {
        const comparison = compareBenchmarks(baselineResult, currentResult);
        const status = comparison.faster ? '✅ Faster' : '❌ Slower';
        lines.push(
          `| ${currentResult.name} | ${currentResult.avgTime.toFixed(2)}ms | ${baselineResult.avgTime.toFixed(2)}ms | ${comparison.percentChange.toFixed(1)}% | ${status} |`
        );
      }
    }
  }

  lines.push(`\n## Memory Usage\n`);
  lines.push(`| Benchmark | Heap Used | Heap Total | External | RSS |`);
  lines.push(`|-----------|-----------|------------|----------|-----|`);

  for (const result of results.results) {
    lines.push(
      `| ${result.name} | ${(result.memoryUsage.heapUsed / (1024 ** 2)).toFixed(2)} MB | ${(result.memoryUsage.heapTotal / (1024 ** 2)).toFixed(2)} MB | ${(result.memoryUsage.external / (1024 ** 2)).toFixed(2)} MB | ${(result.memoryUsage.rss / (1024 ** 2)).toFixed(2)} MB |`
    );
  }

  lines.push(`\n---`);
  lines.push(`*Generated by IRIS Performance Benchmark Suite on ${new Date().toLocaleString()}*`);

  return lines.join('\n');
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: ts-node report-generator.ts <results-path> [baseline-path]');
    process.exit(1);
  }

  const resultsPath = args[0];
  const baselinePath = args[1];

  if (!fs.existsSync(resultsPath)) {
    console.error(`Error: Results file not found: ${resultsPath}`);
    process.exit(1);
  }

  generateReport(resultsPath, {
    format: 'both',
    includeCharts: true,
    compareWith: baselinePath
  });

  console.log('\n✅ Report generation completed!');
}

export { generateReport };
