# CI/CD Integration Example

This example demonstrates integrating IRIS visual regression and accessibility testing into CI/CD pipelines.

## What This Demonstrates

- GitHub Actions workflow configuration
- Visual regression testing in CI
- Accessibility testing in CI
- Automated baseline management
- Report artifact storage
- PR comment integration
- Parallel test execution

## Files

- `.github/workflows/iris-tests.yml` - Complete GitHub Actions workflow
- `.github/workflows/visual-only.yml` - Visual regression only
- `.github/workflows/a11y-only.yml` - Accessibility testing only
- `ci-test-page.html` - Sample page for CI testing
- `scripts/update-baseline.sh` - Baseline update script
- `scripts/post-pr-comment.sh` - PR comment script

## GitHub Actions Setup

### 1. Copy Workflow to Your Repository

```bash
# From your project root
mkdir -p .github/workflows
cp examples/ci-cd-integration/.github/workflows/iris-tests.yml .github/workflows/
```

### 2. Configure Secrets (Optional)

For AI-powered visual analysis, add API keys to repository secrets:

```
Settings → Secrets and variables → Actions → New repository secret

- OPENAI_API_KEY (for AI visual classification)
- ANTHROPIC_API_KEY (alternative to OpenAI)
```

### 3. Push and Test

```bash
git add .github/workflows/iris-tests.yml
git commit -m "ci: add IRIS visual and accessibility testing"
git push
```

## Workflow Overview

### Complete IRIS Testing Workflow

```yaml
name: IRIS Tests

on:
  pull_request:
  push:
    branches: [main, develop]

jobs:
  visual-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
      - name: Install IRIS
        run: npm install iris-suite
      - name: Run Visual Tests
        run: iris visual-diff --pages "/" --fail-on moderate
      - name: Upload Reports
        uses: actions/upload-artifact@v3
        with:
          name: visual-report
          path: .iris/visual-report.html

  a11y-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run Accessibility Tests
        run: iris a11y --pages "/" --fail-on critical,serious
      - name: Upload Reports
        uses: actions/upload-artifact@v3
        with:
          name: a11y-report
          path: .iris/a11y-report.html
```

## Testing Strategies

### On Pull Requests

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'src/**'
      - 'public/**'
      - 'components/**'
```

Only run tests when UI-related files change.

### On Main Branch

```yaml
on:
  push:
    branches: [main]
```

Update baselines after merging approved changes.

### Scheduled Testing

```yaml
on:
  schedule:
    - cron: '0 2 * * *'  # Run daily at 2 AM
```

Catch gradual regressions from dependencies.

## Baseline Management

### Auto-Update on Main

```yaml
- name: Update Baseline
  if: github.ref == 'refs/heads/main'
  run: |
    iris visual-diff --update-baseline
    git config user.name "GitHub Actions"
    git config user.email "actions@github.com"
    git add .iris/baselines/
    git commit -m "chore: update visual baselines [skip ci]"
    git push
```

### Manual Baseline Update

```bash
# Local workflow
./scripts/update-baseline.sh
git add .iris/baselines/
git commit -m "chore: update baselines after UI redesign"
git push
```

## Report Artifacts

### Store Test Reports

```yaml
- name: Upload Visual Report
  if: always()
  uses: actions/upload-artifact@v3
  with:
    name: visual-regression-report
    path: .iris/visual-report.html
    retention-days: 30
```

Access from: Actions → Workflow run → Artifacts

### Store Screenshots

```yaml
- name: Upload Screenshots
  if: failure()
  uses: actions/upload-artifact@v3
  with:
    name: visual-diffs
    path: |
      .iris/screenshots/diff/**
      .iris/screenshots/current/**
```

## PR Comments

### Post Test Results to PR

```yaml
- name: Comment PR
  if: github.event_name == 'pull_request'
  uses: actions/github-script@v6
  with:
    script: |
      const fs = require('fs');
      const report = JSON.parse(fs.readFileSync('.iris/visual-report.json'));

      const comment = `## 🎯 IRIS Test Results

      **Visual Regression:** ${report.summary.failed > 0 ? '❌ Failed' : '✅ Passed'}
      - Comparisons: ${report.summary.totalComparisons}
      - Passed: ${report.summary.passed}
      - Failed: ${report.summary.failed}

      [View Full Report](artifacts/visual-report.html)`;

      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: comment
      });
```

## Multi-Device CI Testing

```yaml
strategy:
  matrix:
    device: [desktop, tablet, mobile]
steps:
  - name: Test ${{ matrix.device }}
    run: |
      iris visual-diff \
        --devices ${{ matrix.device }} \
        --output visual-${{ matrix.device }}.html
```

## Performance Optimization

### Cache Dependencies

```yaml
- name: Cache node modules
  uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
```

### Parallel Execution

```yaml
jobs:
  visual:
    runs-on: ubuntu-latest
  a11y:
    runs-on: ubuntu-latest
  # Both run in parallel
```

### Concurrency Limits

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

## Exit Codes

IRIS uses specific exit codes for CI integration:

- `0` - All tests passed
- `3` - Environment/runtime error
- `4` - Accessibility violations found
- `5` - Visual regressions detected

### Conditional Failure

```yaml
- name: Visual Tests (Warning Only)
  run: iris visual-diff || exit 0

- name: A11y Tests (Fail Build)
  run: iris a11y --fail-on critical,serious
```

## Integration Examples

### With Next.js

```yaml
- name: Build Next.js
  run: npm run build

- name: Start Server
  run: npm start &

- name: Wait for Server
  run: npx wait-on http://localhost:3000

- name: Run IRIS Tests
  run: iris visual-diff --pages "http://localhost:3000"
```

### With Docker

```yaml
- name: Build Docker Image
  run: docker build -t app .

- name: Run Container
  run: docker run -d -p 8080:8080 app

- name: Test with IRIS
  run: iris visual-diff --pages "http://localhost:8080"
```

### With Playwright Test

```yaml
- name: Run E2E Tests
  run: npx playwright test

- name: Visual Regression Check
  run: iris visual-diff --pages "http://localhost:3000"
```

## Troubleshooting

### Fonts Not Loading

```yaml
- name: Install Fonts
  run: |
    sudo apt-get update
    sudo apt-get install -y fonts-liberation
```

### Flaky Tests

```yaml
- name: Visual Tests with Retry
  run: |
    iris visual-diff --threshold 0.15 || \
    iris visual-diff --threshold 0.15 || \
    exit 1
```

### Baseline Sync Issues

```yaml
- name: Sync Baselines
  run: |
    git fetch origin main
    git checkout origin/main -- .iris/baselines/
```

## Next Steps

- See [basic-visual-test](../basic-visual-test) for local testing
- Check [multi-device-visual](../multi-device-visual) for responsive CI
- Review [accessibility-audit](../accessibility-audit) for a11y CI

## Learn More

- [GitHub Actions Documentation](https://docs.github.com/actions)
- [IRIS CI Best Practices](../../docs/ci-cd-guide.md)
- [Workflow Examples](../../.github/workflows/)
