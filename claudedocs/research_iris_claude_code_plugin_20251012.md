# IRIS as a Claude Code MCP Plugin: Architecture & Implementation Guide

**Research Date**: October 12, 2025
**Research Depth**: Deep Analysis
**Confidence Level**: High (0.85)
**Sources**: Context7 Documentation, Anthropic Official Docs, MCP Specification 2025-06-18

---

## Executive Summary

IRIS (Interface Recognition & Interaction Suite) has strong potential to become a Claude Code plugin through the Model Context Protocol (MCP). This document outlines the complete architecture, required implementations, and deployment strategy for transforming IRIS into an MCP server that integrates seamlessly with Claude Code.

**Key Findings**:
- ✅ IRIS architecture is highly compatible with MCP server model
- ✅ Claude Code plugin system (Public Beta 2025) supports MCP servers
- ✅ TypeScript SDK provides comprehensive MCP server implementation
- ✅ Distribution via npm and Claude Code plugin marketplace is established
- ⚡ Estimated implementation effort: 2-3 weeks for full integration

---

## Table of Contents

1. [Understanding the Plugin Ecosystem](#1-understanding-the-plugin-ecosystem)
2. [IRIS Current Architecture Analysis](#2-iris-current-architecture-analysis)
3. [MCP Server Architecture Design](#3-mcp-server-architecture-design)
4. [Feature Set Implementation](#4-feature-set-implementation)
5. [Deployment Guidelines](#5-deployment-guidelines)
6. [Integration Workflow](#6-integration-workflow)
7. [Code Examples](#7-code-examples)
8. [Testing & Validation](#8-testing--validation)
9. [Timeline & Resources](#9-timeline--resources)

---

## 1. Understanding the Plugin Ecosystem

### 1.1 Claude Code Plugin System (2025)

Claude Code introduced a comprehensive plugin system in public beta that allows:

- **Single-Command Installation**: Install plugins with `/plugin` command
- **Marketplace Support**: Distribute via GitHub repositories or custom URLs
- **Plugin Composition**: Bundle slash commands, MCP servers, agents, and hooks
- **Team Distribution**: Configure at repository level for consistent tooling

### 1.2 Model Context Protocol (MCP)

**What is MCP?**
- Open protocol standardizing how applications provide context to LLMs
- Developed by Anthropic, adopted by OpenAI (March 2025)
- 5,000+ active MCP servers as of May 2025
- Think of it as "USB-C for AI" - universal connection standard

**MCP Core Concepts**:
```
┌─────────────────┐
│  Claude Code    │  (Client)
│    Terminal     │
└────────┬────────┘
         │ JSON-RPC 2.0
         │ over stdio/HTTP
         │
┌────────▼────────┐
│   MCP Server    │
│  (Your Tool)    │
├─────────────────┤
│  • Resources    │  (Read data)
│  • Tools        │  (Perform actions)
│  • Prompts      │  (Templates)
└─────────────────┘
```

**Key Features**:
- **Resources**: Expose data sources (files, databases, APIs)
- **Tools**: Provide actionable capabilities
- **Prompts**: Define reusable prompt templates
- **Sampling**: Request LLM completions from client
- **Transport**: stdio, HTTP, or SSE connections

### 1.3 Integration Benefits

**For IRIS**:
- Direct access to Claude's reasoning within testing workflows
- Natural language interface for test configuration
- Automated test result interpretation
- Seamless CI/CD integration through Claude Code

**For Claude Code Users**:
- Visual regression testing without context switching
- Accessibility validation with AI-powered analysis
- Multi-device testing through natural language commands
- Git-integrated baseline management

---

## 2. IRIS Current Architecture Analysis

### 2.1 Existing Structure

**Current IRIS Components**:
```typescript
iris-suite/
├── src/
│   ├── cli.ts                  // Commander.js CLI
│   ├── browser.ts              // Playwright wrapper
│   ├── executor.ts             // Action execution
│   ├── translator.ts           // NL to action translation
│   ├── visual/
│   │   ├── visual-runner.ts    // Visual test orchestration
│   │   ├── capture.ts          // Screenshot capture
│   │   ├── diff.ts             // Pixel/SSIM comparison
│   │   ├── baseline.ts         // Git integration
│   │   ├── ai-classifier.ts    // AI semantic analysis
│   │   └── reporter.ts         // Multi-format reporting
│   └── a11y/
│       ├── a11y-runner.ts      // Accessibility orchestration
│       ├── axe-integration.ts  // WCAG compliance
│       └── keyboard-tester.ts  // Keyboard navigation
├── package.json                // npm configuration
└── dist/                       // Compiled JavaScript
```

### 2.2 Compatibility Assessment

**✅ Strong Compatibility Points**:

1. **Modular Design**: IRIS already has clean separation of concerns
2. **Async Operations**: All testing operations are async (MCP requirement)
3. **Structured Output**: Tests return structured JSON results
4. **TypeScript**: Same language as MCP SDK
5. **CLI Foundation**: Easy to adapt commands to MCP tools

**⚠️ Adaptation Requirements**:

1. **Transport Layer**: Need to add MCP protocol transport
2. **Tool Registration**: Convert CLI commands to MCP tools
3. **Resource Exposure**: Expose test results, baselines as resources
4. **Schema Validation**: Add Zod schemas for input/output
5. **Error Handling**: Adapt to MCP error response format

### 2.3 Current CLI Commands → MCP Tools Mapping

| IRIS CLI Command | MCP Tool Name | Input Schema | Output Schema |
|------------------|---------------|--------------|---------------|
| `iris visual-diff` | `run-visual-test` | pages, baseline, devices, threshold | test results, diffs, severity |
| `iris a11y` | `run-accessibility-test` | pages, tags, include options | violations, score |
| `iris run` | `execute-ui-action` | instruction, headless, timeout | action results |
| `iris watch` | `watch-for-changes` | target, instruction, options | watch status |

---

## 3. MCP Server Architecture Design

### 3.1 Proposed Architecture

```
┌─────────────────────────────────────────────────┐
│         Claude Code (MCP Client)                │
│  - Natural language commands                    │
│  - Context awareness                            │
│  - Reasoning & analysis                         │
└──────────────────┬──────────────────────────────┘
                   │ MCP Protocol
                   │ (JSON-RPC 2.0)
┌──────────────────▼──────────────────────────────┐
│         IRIS MCP Server                         │
├─────────────────────────────────────────────────┤
│  MCP Layer (NEW)                                │
│  ├── Transport Handler (stdio/HTTP)            │
│  ├── Tool Registry                              │
│  ├── Resource Manager                           │
│  └── Prompt Templates                           │
├─────────────────────────────────────────────────┤
│  IRIS Core (EXISTING)                           │
│  ├── Visual Testing Engine                      │
│  ├── Accessibility Testing Engine               │
│  ├── Browser Automation                         │
│  ├── AI Analysis (GPT-4V, Claude, Ollama)      │
│  └── Report Generation                          │
└─────────────────────────────────────────────────┘
```

### 3.2 Module Structure

**New Files to Create**:
```typescript
src/mcp/
├── server.ts              // Main MCP server initialization
├── tools.ts               // Tool definitions and handlers
├── resources.ts           // Resource providers
├── prompts.ts             // Prompt templates
├── transport.ts           // Transport configuration
└── types.ts               // MCP-specific types
```

### 3.3 Core Implementation Pattern

```typescript
// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools';
import { registerResources } from './resources';
import { registerPrompts } from './prompts';

export async function createIRISMcpServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'iris-testing-suite',
    version: '2.0.0',
    description: 'Visual regression and accessibility testing for Claude Code'
  });

  // Register all capabilities
  await registerTools(server);
  await registerResources(server);
  await registerPrompts(server);

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = await createIRISMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('IRIS MCP Server started successfully');
}
```

---

## 4. Feature Set Implementation

### 4.1 MCP Tools (Required Implementation)

#### Tool 1: Visual Regression Testing

**Tool Definition**:
```typescript
import { z } from 'zod';

server.registerTool(
  'run-visual-test',
  {
    title: 'Visual Regression Test',
    description: 'Run visual regression tests on specified pages',
    inputSchema: {
      pages: z.array(z.string()).describe('URLs or patterns to test'),
      baseline: z.string().default('main').describe('Git branch/commit for baseline'),
      devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).default(['desktop']),
      threshold: z.number().min(0).max(1).default(0.1),
      semantic: z.boolean().default(false).describe('Enable AI semantic analysis'),
      updateBaseline: z.boolean().default(false)
    },
    outputSchema: {
      status: z.enum(['passed', 'failed', 'error']),
      totalComparisons: z.number(),
      passed: z.number(),
      failed: z.number(),
      severityCounts: z.object({
        breaking: z.number(),
        moderate: z.number(),
        minor: z.number()
      }),
      reportPath: z.string().optional(),
      diffs: z.array(z.object({
        page: z.string(),
        device: z.string(),
        diffPercentage: z.number(),
        severity: z.enum(['breaking', 'moderate', 'minor']),
        aiAnalysis: z.string().optional()
      }))
    }
  },
  async (input) => {
    const { VisualTestRunner } = await import('../visual/visual-runner');

    const runner = new VisualTestRunner({
      pages: input.pages,
      baseline: { strategy: 'branch', reference: input.baseline },
      devices: input.devices,
      diff: {
        threshold: input.threshold,
        semanticAnalysis: input.semantic,
        aiProvider: 'openai'
      },
      updateBaseline: input.updateBaseline
    });

    const result = await runner.run();

    const output = {
      status: result.summary.overallStatus,
      totalComparisons: result.summary.totalComparisons,
      passed: result.summary.passed,
      failed: result.summary.failed,
      severityCounts: result.summary.severityCounts,
      reportPath: result.reportPath,
      diffs: result.comparisons.map(c => ({
        page: c.page,
        device: c.device,
        diffPercentage: c.diffPercentage,
        severity: c.severity,
        aiAnalysis: c.aiAnalysis?.explanation
      }))
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output
    };
  }
);
```

#### Tool 2: Accessibility Testing

**Tool Definition**:
```typescript
server.registerTool(
  'run-accessibility-test',
  {
    title: 'Accessibility Test',
    description: 'Run WCAG accessibility tests on specified pages',
    inputSchema: {
      pages: z.array(z.string()).describe('URLs or patterns to test'),
      tags: z.array(z.string()).default(['wcag2a', 'wcag2aa']),
      includeKeyboard: z.boolean().default(true),
      includeScreenReader: z.boolean().default(false),
      failOn: z.array(z.enum(['critical', 'serious', 'moderate', 'minor']))
        .default(['critical', 'serious'])
    },
    outputSchema: {
      passed: z.boolean(),
      totalViolations: z.number(),
      score: z.number().min(0).max(100),
      violationsBySeverity: z.object({
        critical: z.number(),
        serious: z.number(),
        moderate: z.number(),
        minor: z.number()
      }),
      reportPath: z.string().optional(),
      violations: z.array(z.object({
        id: z.string(),
        impact: z.string(),
        description: z.string(),
        helpUrl: z.string(),
        nodes: z.array(z.object({
          html: z.string(),
          target: z.array(z.string())
        }))
      }))
    }
  },
  async (input) => {
    const { AccessibilityRunner } = await import('../a11y/a11y-runner');

    const runner = new AccessibilityRunner({
      pages: input.pages,
      axe: {
        tags: input.tags,
        rules: {},
        include: [],
        exclude: [],
        disableRules: []
      },
      keyboard: {
        testFocusOrder: input.includeKeyboard,
        testTrapDetection: input.includeKeyboard,
        testArrowKeyNavigation: input.includeKeyboard,
        testEscapeHandling: input.includeKeyboard,
        customSequences: []
      },
      screenReader: {
        testAriaLabels: input.includeScreenReader,
        testLandmarkNavigation: input.includeScreenReader,
        testImageAltText: input.includeScreenReader,
        testHeadingStructure: input.includeScreenReader,
        simulateScreenReader: input.includeScreenReader
      },
      failureThreshold: input.failOn.reduce((acc, impact) => {
        acc[impact] = true;
        return acc;
      }, {} as Record<string, boolean>)
    });

    const result = await runner.run();

    const output = {
      passed: result.summary.passed,
      totalViolations: result.summary.totalViolations,
      score: result.summary.score,
      violationsBySeverity: result.summary.violationsBySeverity,
      reportPath: result.reportPath,
      violations: result.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        helpUrl: v.helpUrl,
        nodes: v.nodes
      }))
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output
    };
  }
);
```

#### Tool 3: UI Action Execution

**Tool Definition**:
```typescript
server.registerTool(
  'execute-ui-action',
  {
    title: 'Execute UI Action',
    description: 'Execute natural language UI interaction commands',
    inputSchema: {
      instruction: z.string().describe('Natural language instruction (e.g., "click submit button")'),
      url: z.string().url().optional().describe('Page URL to execute action on'),
      headless: z.boolean().default(true),
      timeout: z.number().default(30000)
    },
    outputSchema: {
      success: z.boolean(),
      actions: z.array(z.object({
        type: z.string(),
        selector: z.string().optional(),
        duration: z.number()
      })),
      error: z.string().optional(),
      screenshot: z.string().optional().describe('Base64 screenshot if action fails')
    }
  },
  async (input) => {
    const { translate } = await import('../translator');
    const { ActionExecutor } = await import('../executor');

    const result = await translate(input.instruction);
    const executor = new ActionExecutor({
      timeout: input.timeout,
      trackContext: true,
      browserOptions: { headless: input.headless }
    });

    await executor.launchBrowser();
    const page = await executor.createPage();

    if (input.url) {
      await page.goto(input.url);
    }

    const execResults = [];
    for (const action of result.actions) {
      const execResult = await executor.executeAction(action, page);
      execResults.push(execResult);
    }

    await executor.cleanup();

    const output = {
      success: execResults.every(r => r.success),
      actions: execResults.map(r => ({
        type: r.action.type,
        selector: r.action.selector,
        duration: r.duration
      })),
      error: execResults.find(r => !r.success)?.error
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output
    };
  }
);
```

### 4.2 MCP Resources (Data Exposure)

#### Resource 1: Test Results

```typescript
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

server.registerResource(
  'test-results',
  new ResourceTemplate('iris://results/{testId}', { list: undefined }),
  {
    title: 'Test Results',
    description: 'Access test results by ID',
    mimeType: 'application/json'
  },
  async (uri, { testId }) => {
    const { initializeDatabase, getVisualTestResults, getA11yTestResults } =
      await import('../db');

    const dbPath = process.env.IRIS_DB_PATH ||
      path.join(os.homedir(), '.iris', 'iris.db');
    const db = initializeDatabase(dbPath);

    const visualResults = getVisualTestResults(db, { testRunId: parseInt(testId) });
    const a11yResults = getA11yTestResults(db, { testRunId: parseInt(testId) });

    db.close();

    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({ visual: visualResults, accessibility: a11yResults }, null, 2)
      }]
    };
  }
);
```

#### Resource 2: Baseline Images

```typescript
server.registerResource(
  'baseline-image',
  new ResourceTemplate('iris://baseline/{page}/{device}', { list: undefined }),
  {
    title: 'Baseline Image',
    description: 'Access baseline screenshot for comparison',
    mimeType: 'image/png'
  },
  async (uri, { page, device }) => {
    const { BaselineManager } = await import('../visual/baseline');
    const manager = new BaselineManager({
      storageRoot: '.iris/baselines',
      branchIsolation: true
    });

    const baselinePath = await manager.getBaselinePath(page, device);
    const fs = await import('fs/promises');
    const imageBuffer = await fs.readFile(baselinePath);

    return {
      contents: [{
        uri: uri.href,
        mimeType: 'image/png',
        blob: imageBuffer.toString('base64')
      }]
    };
  }
);
```

### 4.3 MCP Prompts (Templates)

#### Prompt 1: Visual Test Review

```typescript
server.registerPrompt(
  'review-visual-test',
  {
    title: 'Review Visual Test Results',
    description: 'Analyze visual regression test results and provide insights',
    argsSchema: {
      testId: z.string()
    }
  },
  ({ testId }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please review the visual regression test results for test ID ${testId}.

Access the results using the resource iris://results/${testId}, then:
1. Summarize the overall test status
2. Identify critical visual regressions requiring immediate attention
3. Suggest whether detected changes appear intentional or are likely bugs
4. Recommend next steps for the development team

Focus on actionable insights and prioritize breaking changes.`
      }
    }]
  })
);
```

#### Prompt 2: Accessibility Audit

```typescript
server.registerPrompt(
  'audit-accessibility',
  {
    title: 'Comprehensive Accessibility Audit',
    description: 'Generate a detailed accessibility audit report',
    argsSchema: {
      pages: z.array(z.string())
    }
  },
  ({ pages }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Conduct a comprehensive WCAG 2.1 Level AA accessibility audit for these pages:
${pages.map(p => `- ${p}`).join('\n')}

Use the run-accessibility-test tool with these parameters:
- tags: ['wcag2a', 'wcag2aa', 'wcag21aa']
- includeKeyboard: true
- includeScreenReader: true
- failOn: ['critical', 'serious']

Then analyze the results and provide:
1. Executive summary of accessibility compliance status
2. Critical violations that must be fixed for compliance
3. Severity-prioritized remediation roadmap
4. Code examples for fixing top 3 issues
5. Long-term recommendations for maintaining accessibility

Format the output as a professional audit report suitable for stakeholders.`
      }
    }]
  })
);
```

---

## 5. Deployment Guidelines

### 5.1 Package Configuration

**Update package.json**:
```json
{
  "name": "@your-org/iris-mcp-server",
  "version": "2.0.0",
  "description": "IRIS MCP server for Claude Code - Visual regression and accessibility testing",
  "keywords": [
    "mcp",
    "claude-code",
    "visual-testing",
    "accessibility",
    "a11y",
    "testing",
    "playwright"
  ],
  "main": "dist/mcp/server.js",
  "bin": {
    "iris": "./dist/cli.js",
    "iris-mcp": "./dist/mcp/server.js"
  },
  "scripts": {
    "build": "tsc",
    "mcp:start": "node dist/mcp/server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@anthropic-ai/sdk": "^0.65.0",
    "@axe-core/playwright": "^4.8.1",
    "commander": "^11.0.0",
    "playwright": "^1.35.0",
    "zod": "^3.22.4",
    "sharp": "^0.33.0",
    "pixelmatch": "^5.3.0",
    "image-ssim": "^0.2.0"
  },
  "peerDependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

### 5.2 Claude Code Configuration

**Create .claude-plugin/plugin.json**:
```json
{
  "name": "iris-testing-suite",
  "version": "2.0.0",
  "description": "Visual regression and accessibility testing for web applications",
  "author": "IRIS Team",
  "homepage": "https://github.com/frankbria/iris",
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["-y", "@your-org/iris-mcp-server"],
      "env": {
        "IRIS_DB_PATH": "${HOME}/.iris/iris.db"
      }
    }
  },
  "commands": [
    {
      "name": "visual-test",
      "description": "Run visual regression test",
      "prompt": "Run visual regression test on {{url}} comparing against {{baseline}} branch"
    },
    {
      "name": "a11y-audit",
      "description": "Run accessibility audit",
      "prompt": "Run comprehensive accessibility audit on {{url}} for WCAG 2.1 Level AA compliance"
    }
  ],
  "agents": [],
  "hooks": []
}
```

### 5.3 Distribution Methods

#### Method 1: npm Registry

```bash
# 1. Build the package
npm run build

# 2. Test locally
npm link
claude --mcp-server iris-mcp

# 3. Publish to npm
npm publish --access public

# 4. Users install with
npm install -g @your-org/iris-mcp-server
```

#### Method 2: Claude Code Plugin Marketplace

**Create .claude-plugin/marketplace.json**:
```json
{
  "marketplace": {
    "name": "IRIS Testing Suite",
    "description": "Official marketplace for IRIS testing plugins",
    "url": "https://github.com/frankbria/iris-plugins"
  },
  "plugins": [
    {
      "id": "iris-testing-suite",
      "name": "IRIS Testing Suite",
      "version": "2.0.0",
      "description": "Visual regression and accessibility testing",
      "author": "IRIS Team",
      "installUrl": "https://github.com/frankbria/iris/releases/download/v2.0.0/iris-plugin.tar.gz",
      "tags": ["testing", "visual", "accessibility", "a11y"],
      "mcpServer": true,
      "requiresApiKeys": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
    }
  ]
}
```

**Host on GitHub**:
```bash
# 1. Create releases with plugin bundles
gh release create v2.0.0 --title "IRIS MCP Plugin v2.0.0" \
  --notes "Visual regression and accessibility testing for Claude Code"

# 2. Users add marketplace
/plugin marketplace add frankbria/iris-plugins

# 3. Users install plugin
/plugin install iris-testing-suite
```

#### Method 3: Direct GitHub Installation

```bash
# Users can install directly from GitHub
/plugin install frankbria/iris-mcp-server
```

### 5.4 Configuration Files

**User-level config (~/.claude/claude.json)**:
```json
{
  "mcpServers": {
    "iris": {
      "command": "iris-mcp",
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
        "IRIS_DB_PATH": "${HOME}/.iris/iris.db"
      },
      "timeout": 300000
    }
  }
}
```

**Project-level config (.claude/mcp-servers.json)**:
```json
{
  "iris": {
    "command": "npx",
    "args": ["-y", "@your-org/iris-mcp-server"],
    "env": {
      "IRIS_BASELINES": "${PWD}/.iris/baselines",
      "IRIS_REPORTS": "${PWD}/.iris/reports"
    }
  }
}
```

---

## 6. Integration Workflow

### 6.1 User Experience Flow

**Scenario: Visual Regression Testing**

```
User in Claude Code Terminal:
──────────────────────────────────────────────────────
> "Run visual regression tests on my homepage"

Claude Code (with IRIS plugin):
──────────────────────────────────────────────────────
🤔 I'll run visual tests on your homepage comparing
   against the main branch baseline.

[Calling tool: run-visual-test]
  pages: ["http://localhost:3000"]
  baseline: "main"
  devices: ["desktop", "tablet", "mobile"]
  threshold: 0.1

🎯 Visual Test Results:
   ✅ Desktop: PASSED (0.02% diff - within threshold)
   ⚠️  Tablet: MODERATE changes detected (2.3% diff)
   ❌ Mobile: BREAKING changes detected (15.7% diff)

📊 Summary:
   - 1 passed, 2 failed
   - Breaking: 1, Moderate: 1, Minor: 0

The mobile layout shows significant changes in the
navigation menu. Would you like me to:
1. Show you the diff images
2. Update the baseline if changes are intentional
3. Investigate the root cause of the mobile issue
```

### 6.2 Developer Workflow Integration

**CI/CD Integration**:
```yaml
# .github/workflows/visual-regression.yml
name: Visual Regression Tests

on: [pull_request]

jobs:
  visual-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Install IRIS MCP Server
        run: npm install -g @your-org/iris-mcp-server

      - name: Run Visual Tests
        run: |
          claude --headless "Run visual regression tests on all pages in ./pages
          comparing against main branch. Report failures as GitHub comment."
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### 6.3 Natural Language Interface Examples

```
Example Queries:
──────────────────────────────────────────────────────

1. "Check accessibility compliance for my login page"
   → Runs a11y test with WCAG 2.1 AA standards

2. "Compare my homepage against yesterday's version"
   → Visual diff with timestamp-based baseline

3. "Test responsive design across all devices"
   → Multi-device visual test (desktop, tablet, mobile)

4. "Show me keyboard navigation issues on the dashboard"
   → Focused a11y test with keyboard testing enabled

5. "Update visual baselines for the checkout flow"
   → Updates baselines for specified pages

6. "Generate an accessibility audit report for stakeholders"
   → Uses audit-accessibility prompt with professional formatting
```

---

## 7. Code Examples

### 7.1 Complete MCP Server Entry Point

```typescript
#!/usr/bin/env node
// src/mcp/index.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerVisualTools } from './tools/visual';
import { registerAccessibilityTools } from './tools/accessibility';
import { registerUITools } from './tools/ui-actions';
import { registerResources } from './resources';
import { registerPrompts } from './prompts';

async function main() {
  const server = new McpServer({
    name: 'iris-testing-suite',
    version: '2.0.0',
    description: 'Visual regression and accessibility testing MCP server'
  });

  // Register all capabilities
  registerVisualTools(server);
  registerAccessibilityTools(server);
  registerUITools(server);
  registerResources(server);
  registerPrompts(server);

  // Setup stdio transport for Claude Code
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Log to stderr (stdout is used for MCP protocol)
  console.error('✅ IRIS MCP Server started successfully');
  console.error('   Ready to receive commands from Claude Code');
}

main().catch(err => {
  console.error('❌ Failed to start IRIS MCP Server:', err);
  process.exit(1);
});
```

### 7.2 Tool with Input Elicitation

```typescript
// Advanced: Interactive tool that asks for user confirmation
server.registerTool(
  'update-baselines',
  {
    title: 'Update Visual Baselines',
    description: 'Update baseline images after confirming changes are intentional',
    inputSchema: {
      pages: z.array(z.string()),
      device: z.string(),
      branch: z.string().default('main')
    },
    outputSchema: {
      updated: z.boolean(),
      count: z.number(),
      message: z.string()
    }
  },
  async (input) => {
    // Show diffs first
    const diffs = await getVisualDiffs(input.pages, input.device);

    // Elicit user confirmation
    const confirmation = await server.server.elicitInput({
      message: `Found ${diffs.length} visual changes. Are these intentional?`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Confirm baseline update',
            description: 'Update baselines with these changes?'
          },
          reason: {
            type: 'string',
            title: 'Update reason',
            description: 'Why are these changes being made?'
          }
        },
        required: ['confirm']
      }
    });

    if (confirmation.action !== 'accept' || !confirmation.content?.confirm) {
      return {
        content: [{ type: 'text', text: 'Baseline update cancelled' }],
        structuredContent: { updated: false, count: 0, message: 'Cancelled by user' }
      };
    }

    // Proceed with update
    const { BaselineManager } = await import('../visual/baseline');
    const manager = new BaselineManager({ storageRoot: '.iris/baselines' });

    await manager.updateBaselines(input.pages, input.device, input.branch);

    const output = {
      updated: true,
      count: diffs.length,
      message: `Updated ${diffs.length} baselines. Reason: ${confirmation.content.reason}`
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output
    };
  }
);
```

### 7.3 Resource with Context-Aware Completion

```typescript
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';

server.registerResource(
  'test-history',
  new ResourceTemplate('iris://history/{project}/{testType}', {
    list: undefined,
    complete: {
      // Intelligent project name completion
      project: async (value) => {
        const projects = await listRecentProjects();
        return projects.filter(p => p.startsWith(value));
      },
      // Test type completion based on selected project
      testType: async (value, context) => {
        const project = context?.arguments?.['project'];
        if (!project) return ['visual', 'accessibility'];

        const availableTypes = await getAvailableTestTypes(project);
        return availableTypes.filter(t => t.startsWith(value));
      }
    }
  }),
  {
    title: 'Test History',
    description: 'Historical test results for a project'
  },
  async (uri, { project, testType }) => {
    const history = await getTestHistory(project, testType);
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(history, null, 2)
      }]
    };
  }
);
```

---

## 8. Testing & Validation

### 8.1 Local Testing Setup

```bash
# 1. Build MCP server
npm run build

# 2. Test MCP server locally with CLI
node dist/mcp/server.js

# 3. Test with Claude Code local config
cat > ~/.claude/test-mcp.json << 'EOF'
{
  "mcpServers": {
    "iris-local": {
      "command": "node",
      "args": ["/path/to/iris/dist/mcp/server.js"],
      "env": {
        "IRIS_DB_PATH": "/tmp/iris-test.db",
        "NODE_ENV": "development"
      }
    }
  }
}
EOF

claude --config ~/.claude/test-mcp.json

# 4. Verify tools are registered
/tools list
# Should show: run-visual-test, run-accessibility-test, execute-ui-action

# 5. Test basic tool invocation
"Run a simple visual test on https://example.com"
```

### 8.2 Integration Tests

```typescript
// __tests__/mcp/integration.test.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createIRISMcpServer } from '../../src/mcp/server';

describe('IRIS MCP Server Integration', () => {
  let server: McpServer;

  beforeEach(async () => {
    server = await createIRISMcpServer();
  });

  test('should register all tools', async () => {
    const tools = await server.server.listTools();
    expect(tools.tools).toHaveLength(3);
    expect(tools.tools.map(t => t.name)).toContain('run-visual-test');
    expect(tools.tools.map(t => t.name)).toContain('run-accessibility-test');
    expect(tools.tools.map(t => t.name)).toContain('execute-ui-action');
  });

  test('should execute visual test tool', async () => {
    const result = await server.server.callTool({
      name: 'run-visual-test',
      arguments: {
        pages: ['https://example.com'],
        baseline: 'main',
        devices: ['desktop'],
        threshold: 0.1
      }
    });

    expect(result.content).toBeDefined();
    expect(result.structuredContent).toHaveProperty('status');
    expect(result.structuredContent).toHaveProperty('totalComparisons');
  });

  test('should provide resources', async () => {
    const resources = await server.server.listResources();
    expect(resources.resources.length).toBeGreaterThan(0);
  });

  test('should provide prompts', async () => {
    const prompts = await server.server.listPrompts();
    expect(prompts.prompts.length).toBeGreaterThan(0);
    expect(prompts.prompts.map(p => p.name)).toContain('review-visual-test');
  });
});
```

### 8.3 Validation Checklist

**Before Publishing**:
- [ ] All tools registered and callable
- [ ] Input/output schemas validated with Zod
- [ ] Resources accessible and return correct MIME types
- [ ] Prompts generate valid message structures
- [ ] Error handling returns proper MCP error responses
- [ ] stdio transport works with Claude Code
- [ ] HTTP transport works (if supported)
- [ ] Environment variables properly configured
- [ ] Timeouts and cancellation handled correctly
- [ ] Documentation complete and accurate
- [ ] Examples tested and verified
- [ ] npm package builds successfully
- [ ] Claude Code plugin.json validates
- [ ] Security audit passed (no credential leaks)
- [ ] Performance benchmarks acceptable
- [ ] Cross-platform compatibility verified

---

## 9. Timeline & Resources

### 9.1 Implementation Phases

**Phase 1: Core MCP Integration (Week 1)**
- [ ] Set up MCP SDK dependencies
- [ ] Create MCP server entry point
- [ ] Implement stdio transport
- [ ] Register basic visual test tool
- [ ] Test with Claude Code locally

**Phase 2: Tool Implementation (Week 2)**
- [ ] Implement all 3 core tools (visual, a11y, ui-action)
- [ ] Add input/output schemas
- [ ] Implement error handling
- [ ] Add resource providers
- [ ] Create prompt templates

**Phase 3: Polish & Distribution (Week 3)**
- [ ] Create plugin.json configuration
- [ ] Write comprehensive documentation
- [ ] Create usage examples
- [ ] Set up npm publishing
- [ ] Create GitHub marketplace listing
- [ ] Integration testing
- [ ] Performance optimization

### 9.2 Required Dependencies

**New Dependencies**:
```json
{
  "@modelcontextprotocol/sdk": "^1.0.0",
  "zod": "^3.22.4"  // Already present, may need update
}
```

**Development Dependencies**:
```json
{
  "@types/node": "^18.16.18",  // Already present
  "typescript": "^5.1.6"  // Already present
}
```

### 9.3 Effort Estimation

| Task | Effort | Complexity | Priority |
|------|--------|------------|----------|
| MCP server setup | 4 hours | Low | Critical |
| Visual test tool | 6 hours | Medium | Critical |
| A11y test tool | 6 hours | Medium | Critical |
| UI action tool | 4 hours | Low | High |
| Resource providers | 4 hours | Low | High |
| Prompt templates | 2 hours | Low | Medium |
| Documentation | 8 hours | Low | High |
| Testing | 8 hours | Medium | Critical |
| Deployment setup | 4 hours | Low | High |
| **Total** | **46 hours** | **~2-3 weeks** | - |

### 9.4 Success Metrics

**Technical Metrics**:
- ✅ MCP protocol compliance (validated by SDK)
- ✅ Tool response time < 5 seconds (excluding test execution)
- ✅ Resource access time < 1 second
- ✅ 95%+ test coverage for MCP layer
- ✅ Zero protocol errors in integration tests

**User Experience Metrics**:
- ✅ Installation time < 2 minutes
- ✅ First successful test < 5 minutes after installation
- ✅ Natural language command understanding > 90%
- ✅ User satisfaction score > 4/5
- ✅ GitHub stars/downloads growth

**Ecosystem Integration**:
- ✅ Listed in official Claude Code plugin marketplace
- ✅ Compatible with latest Claude Code version
- ✅ Works across Windows, macOS, Linux
- ✅ CI/CD templates for major platforms
- ✅ Community contributions and feedback

---

## 10. Conclusion & Next Steps

### 10.1 Key Takeaways

✅ **High Compatibility**: IRIS architecture aligns well with MCP server model
✅ **Clear Path Forward**: Implementation roadmap is well-defined with 2-3 week timeline
✅ **Strong Value Proposition**: Brings professional visual & a11y testing to Claude Code
✅ **Ecosystem Ready**: Plugin distribution mechanisms are mature and documented
✅ **Minimal Risk**: Leverages existing IRIS functionality, additive integration

### 10.2 Recommended Immediate Actions

1. **Week 1: Proof of Concept**
   ```bash
   # Create minimal MCP server with one tool
   mkdir src/mcp
   npm install @modelcontextprotocol/sdk
   # Implement basic visual-test tool
   # Test with Claude Code locally
   ```

2. **Week 2: Full Implementation**
   - Complete all 3 tools
   - Add resources and prompts
   - Write comprehensive tests
   - Create documentation

3. **Week 3: Launch**
   - Publish to npm as `@your-org/iris-mcp-server`
   - Submit to Claude Code plugin marketplace
   - Announce to IRIS community
   - Gather early feedback

### 10.3 Future Enhancements

**Phase 2 Features** (Post-Launch):
- **Sampling Integration**: Use Claude's vision for enhanced semantic analysis
- **Streaming Results**: Real-time test progress updates
- **Team Collaboration**: Share baselines and results across team
- **Custom Reporters**: User-defined report templates
- **Plugin Extensions**: Allow community-contributed test types

**Phase 3 Features** (3-6 months):
- **Multi-Project Support**: Manage tests across multiple projects
- **Historical Analytics**: Trend analysis and regression tracking
- **Smart Baselines**: AI-assisted baseline management
- **Performance Testing**: Integrate Core Web Vitals monitoring
- **Visual Workflow Recording**: Record and replay user interactions

---

## Appendix: Additional Resources

### A. MCP Specification References

- **Official Spec**: https://modelcontextprotocol.io/specification/2025-06-18
- **TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **Claude Code Docs**: https://docs.claude.com/en/docs/claude-code/mcp
- **Plugin System**: https://docs.claude.com/en/docs/claude-code/plugins

### B. Example MCP Servers

1. **GitHub MCP Server**: https://github.com/anthropics/mcp-server-github
2. **File System MCP**: https://github.com/modelcontextprotocol/mcp-server-filesystem
3. **Postgres MCP**: https://github.com/modelcontextprotocol/mcp-server-postgres

### C. IRIS Documentation

- **Current README**: /home/frankbria/projects/iris/README.md
- **Getting Started**: /home/frankbria/projects/iris/docs/GETTING_STARTED_GUIDE.md
- **API Docs**: /home/frankbria/projects/iris/docs/api/
- **Phase 2 Report**: /home/frankbria/projects/iris/plan/phase2_completion_report.md

### D. Contact & Support

- **IRIS GitHub**: https://github.com/frankbria/iris
- **Issues**: https://github.com/frankbria/iris/issues
- **Twitter**: @FrankBria18044

---

**Document Version**: 1.0
**Last Updated**: October 12, 2025
**Research Conducted By**: Claude Code + Deep Research Agent
**Confidence Assessment**: High (0.85/1.0)
**Recommended Action**: Proceed with implementation
