# CI/CD Integration Guide

Integrate IRIS visual regression and accessibility testing into your CI/CD pipeline.

## Table of Contents

- [GitHub Actions](#github-actions)
- [GitLab CI](#gitlab-ci)
- [Jenkins](#jenkins)
- [CircleCI](#circleci)
- [Best Practices](#best-practices)

---

## GitHub Actions

### Complete Workflow

```yaml
# .github/workflows/iris-tests.yml
name: IRIS Visual & Accessibility Tests

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  visual-regression:
    name: Visual Regression Tests
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for baseline comparison

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: |
          npm ci
          npx playwright install chromium

      - name: Build IRIS
        run: npm run build

      - name: Run visual regression tests
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          npm start visual-diff \
            --pages "/,/products,/about" \
            --baseline main \
            --semantic \
            --threshold 0.1 \
            --format junit \
            --output ./test-results/visual-junit.xml

      - name: Upload visual test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: visual-test-results
          path: test-results/
          retention-days: 30

      - name: Upload visual diff images
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-diff-images
          path: visual-test-results/
          retention-days: 7

      - name: Publish test results
        if: always()
        uses: EnricoMi/publish-unit-test-result-action@v2
        with:
          files: |
            test-results/visual-junit.xml

  accessibility:
    name: Accessibility Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: |
          npm ci
          npx playwright install chromium

      - name: Build IRIS
        run: npm run build

      - name: Run accessibility tests
        run: |
          npm start a11y \
            --pages "/,/products,/about" \
            --tags "wcag2a,wcag2aa,wcag21aa" \
            --fail-on "critical,serious" \
            --include-keyboard \
            --format junit \
            --output ./test-results/a11y-junit.xml

      - name: Upload accessibility test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: accessibility-test-results
          path: test-results/
          retention-days: 30

      - name: Publish test results
        if: always()
        uses: EnricoMi/publish-unit-test-result-action@v2
        with:
          files: |
            test-results/a11y-junit.xml

      - name: Comment PR with results
        if: github.event_name == 'pull_request' && always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const summary = JSON.parse(
              fs.readFileSync('./test-results/accessibility-summary.json', 'utf8')
            );

            const comment = `## ♿ Accessibility Test Results

            **Score**: ${summary.score}/100
            **Status**: ${summary.passed ? '✅ PASSED' : '❌ FAILED'}
            **Total Violations**: ${summary.totalViolations}

            ### Violations by Severity
            - **Critical**: ${summary.violationsBySeverity.critical}
            - **Serious**: ${summary.violationsBySeverity.serious}
            - **Moderate**: ${summary.violationsBySeverity.moderate}
            - **Minor**: ${summary.violationsBySeverity.minor}

            [View detailed report](../actions/runs/${{ github.run_id }})
            `;

            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: comment
            });
```

### Matrix Testing (Multiple Browsers/Viewports)

```yaml
visual-regression-matrix:
  name: Visual Tests (${{ matrix.device }})
  runs-on: ubuntu-latest
  strategy:
    matrix:
      device: [desktop, mobile, tablet]
      include:
        - device: desktop
          pages: '/,/products'
        - device: mobile
          pages: '/,/products,/menu'
        - device: tablet
          pages: '/'

  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '18'

    - run: npm ci && npm run build

    - run: |
        npm start visual-diff \
          --pages "${{ matrix.pages }}" \
          --devices "${{ matrix.device }}" \
          --format json \
          --output "./results/${{ matrix.device }}-results.json"
```

---

## GitLab CI

### Complete Pipeline

```yaml
# .gitlab-ci.yml
stages:
  - test
  - report

variables:
  PLAYWRIGHT_BROWSERS_PATH: $CI_PROJECT_DIR/.playwright

cache:
  paths:
    - node_modules/
    - .playwright/

before_script:
  - npm ci
  - npx playwright install chromium
  - npm run build

visual-regression:
  stage: test
  image: node:18
  timeout: 15m
  script:
    - |
      npm start visual-diff \
        --pages "/,/products,/about" \
        --baseline $CI_MERGE_REQUEST_TARGET_BRANCH_NAME \
        --semantic \
        --format junit \
        --output ./test-results/visual-junit.xml
  artifacts:
    when: always
    paths:
      - test-results/
      - visual-test-results/
    reports:
      junit: test-results/visual-junit.xml
    expire_in: 30 days
  allow_failure: true
  only:
    - merge_requests
    - main

accessibility:
  stage: test
  image: node:18
  timeout: 10m
  script:
    - |
      npm start a11y \
        --pages "/,/products,/about" \
        --tags "wcag2a,wcag2aa" \
        --fail-on "critical,serious" \
        --format junit \
        --output ./test-results/a11y-junit.xml
  artifacts:
    when: always
    paths:
      - test-results/
    reports:
      junit: test-results/a11y-junit.xml
    expire_in: 30 days
  only:
    - merge_requests
    - main

report:
  stage: report
  image: alpine:latest
  script:
    - echo "Tests completed"
  dependencies:
    - visual-regression
    - accessibility
  when: always
```

---

## Jenkins

### Jenkinsfile

```groovy
// Jenkinsfile
pipeline {
    agent {
        docker {
            image 'node:18'
            args '-v /var/run/docker.sock:/var/run/docker.sock'
        }
    }

    environment {
        OPENAI_API_KEY = credentials('openai-api-key')
        IRIS_DB_PATH = "${WORKSPACE}/.iris/iris.db"
    }

    stages {
        stage('Setup') {
            steps {
                sh 'npm ci'
                sh 'npx playwright install chromium'
                sh 'npm run build'
            }
        }

        stage('Visual Regression Tests') {
            steps {
                script {
                    try {
                        sh '''
                            npm start visual-diff \
                              --pages "/,/products,/about" \
                              --baseline ${GIT_BRANCH} \
                              --semantic \
                              --format junit \
                              --output ./test-results/visual-junit.xml
                        '''
                    } catch (Exception e) {
                        currentBuild.result = 'UNSTABLE'
                    }
                }
            }
            post {
                always {
                    junit 'test-results/visual-junit.xml'
                    archiveArtifacts artifacts: 'visual-test-results/**', allowEmptyArchive: true
                }
            }
        }

        stage('Accessibility Tests') {
            steps {
                sh '''
                    npm start a11y \
                      --pages "/,/products,/about" \
                      --tags "wcag2a,wcag2aa" \
                      --fail-on "critical,serious" \
                      --format junit \
                      --output ./test-results/a11y-junit.xml
                '''
            }
            post {
                always {
                    junit 'test-results/a11y-junit.xml'
                }
                failure {
                    emailext (
                        subject: "Accessibility Tests Failed: ${env.JOB_NAME} - Build ${env.BUILD_NUMBER}",
                        body: "Check console output at ${env.BUILD_URL} to view the results.",
                        to: "${env.CHANGE_AUTHOR_EMAIL}"
                    )
                }
            }
        }
    }

    post {
        always {
            cleanWs()
        }
    }
}
```

---

## CircleCI

### Config

```yaml
# .circleci/config.yml
version: 2.1

orbs:
  node: circleci/node@5.0.0

executors:
  node-playwright:
    docker:
      - image: cimg/node:18.0-browsers
    resource_class: medium

jobs:
  visual-regression:
    executor: node-playwright
    steps:
      - checkout
      - node/install-packages
      - run:
          name: Install Playwright
          command: npx playwright install chromium
      - run:
          name: Build IRIS
          command: npm run build
      - run:
          name: Run visual regression tests
          command: |
            npm start visual-diff \
              --pages "/,/products" \
              --semantic \
              --format junit \
              --output ./test-results/visual-junit.xml
      - store_test_results:
          path: test-results
      - store_artifacts:
          path: visual-test-results
          destination: visual-diffs

  accessibility:
    executor: node-playwright
    steps:
      - checkout
      - node/install-packages
      - run:
          name: Install Playwright
          command: npx playwright install chromium
      - run:
          name: Build IRIS
          command: npm run build
      - run:
          name: Run accessibility tests
          command: |
            npm start a11y \
              --pages "/,/products" \
              --tags "wcag2a,wcag2aa" \
              --fail-on "critical,serious" \
              --format junit \
              --output ./test-results/a11y-junit.xml
      - store_test_results:
          path: test-results
      - store_artifacts:
          path: test-results

workflows:
  test:
    jobs:
      - visual-regression:
          filters:
            branches:
              only:
                - main
                - develop
      - accessibility:
          filters:
            branches:
              only:
                - main
                - develop
```

---

## Best Practices

### 1. Baseline Management

```bash
# Strategy 1: Branch-based baselines
npm start visual-diff --baseline main --pages "/"

# Strategy 2: Commit-based baselines
npm start visual-diff --baseline abc123 --pages "/"

# Strategy 3: Update baselines on merge to main
if [[ "$CI_BRANCH" == "main" ]]; then
  npm start visual-diff --update-baseline --pages "/"
fi
```

### 2. Test Isolation

```yaml
# Run tests in parallel for faster feedback
parallel:
  - visual-regression-desktop
  - visual-regression-mobile
  - accessibility-tests
```

### 3. Artifact Management

```yaml
# Upload relevant artifacts only
artifacts:
  when: on_failure  # Only upload on failure
  paths:
    - visual-test-results/diff/*.png  # Only diff images
    - test-results/*.xml              # JUnit reports
  expire_in: 7 days                   # Auto-cleanup
```

### 4. Conditional Execution

```yaml
# Skip tests for documentation changes
rules:
  - if: '$CI_COMMIT_MESSAGE =~ /\[skip tests\]/'
    when: never
  - changes:
      - "**.md"
    when: never
  - when: always
```

### 5. Performance Optimization

```bash
# Use caching
cache:
  - node_modules/
  - .playwright/
  - baselines/

# Limit concurrency
npm start visual-diff --concurrency 2

# Test critical paths only on PR, full suite on main
if [[ "$CI_EVENT" == "pull_request" ]]; then
  PAGES="/"
else
  PAGES="/,/products,/about,/contact"
fi
```

### 6. Failure Handling

```yaml
# Mark as unstable but don't fail build
allow_failure:
  exit_codes: [4, 5]  # A11y and visual regression exit codes

# Continue on error
continue-on-error: true
```

### 7. Notification Strategy

```yaml
# Slack notification on failure
- name: Notify Slack
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    text: 'Visual regression detected in ${{ github.ref }}'
    webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

### 8. Security

```yaml
# Never expose API keys in logs
env:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

# Use secrets manager
- name: Get secrets
  uses: aws-actions/aws-secretsmanager-get-secrets@v1
  with:
    secret-ids: |
      OPENAI_API_KEY
```

### 9. Reporting

```typescript
// Generate summary for CI
const summary = {
  visual: {
    total: result.summary.totalComparisons,
    passed: result.summary.passed,
    failed: result.summary.failed
  },
  accessibility: {
    score: a11yResult.summary.score,
    violations: a11yResult.summary.totalViolations
  }
};

fs.writeFileSync('ci-summary.json', JSON.stringify(summary));
```

### 10. Scheduled Testing

```yaml
# Nightly full regression suite
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM daily
  workflow_dispatch:     # Manual trigger
```

## Troubleshooting

### Browser Not Found in CI

```yaml
- name: Install browsers
  run: |
    npx playwright install chromium --with-deps
```

### Timeout Issues

```yaml
# Increase timeout
timeout-minutes: 30

# Or in script
npm start visual-diff --timeout 60000
```

### Memory Issues

```yaml
# Increase Node.js memory
env:
  NODE_OPTIONS: '--max-old-space-size=4096'
```

### Permission Issues

```yaml
# Fix permissions
- run: chmod -R 755 ~/.iris
```

## See Also

- [Visual Regression Testing Guide](./visual-regression-testing.md)
- [Accessibility Testing Guide](./accessibility-testing.md)
- [API Documentation](../api/)
