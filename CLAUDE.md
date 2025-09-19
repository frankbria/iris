# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IRIS (Interface Recognition & Interaction Suite) is an AI-powered UI understanding and testing toolkit under active development. The project gives AI coding assistants "eyes and hands" to see and interact with user interfaces through natural language commands.

## Development Commands

```bash
# Build the TypeScript source
npm run build

# Run tests
npm run test

# Start development server (ts-node)
npm start

# Run CLI commands during development
npm start run "natural language instruction"
npm start watch [target]
npm start connect
```

## Architecture

### Core Modules

**CLI Layer (`src/cli.ts`)**
- Entry point with commander.js-based CLI
- Three main commands: `run`, `watch`, `connect`
- Currently scaffolded with placeholder implementations

**Browser Automation (`src/browser.ts`)**
- Playwright wrapper for browser control
- Provides basic functions: `launchBrowser`, `navigate`, `click`, `typeText`, `takeScreenshot`
- Used for UI interaction and visual testing

### Project Structure

```
src/
├── cli.ts          # CLI interface and command routing
└── browser.ts      # Browser automation wrapper

__tests__/
├── cli.test.ts     # CLI command testing
└── browser.test.ts # Browser automation testing

docs/               # Detailed project documentation
├── prd.md         # Product Requirements Document
├── tech_specs.md  # Technical specifications
├── dev_plan.md    # Development roadmap
└── user_stories.md # User stories and acceptance criteria
```

## Development Guidelines

### Phase 1 Focus
The project is currently in Phase 1 (Foundations). Implementation should focus on:
1. CLI command scaffolding with commander.js
2. Browser automation with Playwright integration
3. Natural language translation to browser actions
4. JSON-RPC/WebSocket protocol layer
5. Local SQLite persistence for test results

### Testing Strategy
- Jest with ts-jest preset for TypeScript support
- Browser tests use data URLs for isolated testing
- CLI tests mock console output for verification
- Tests are located in `__tests__/` directory

### Build Configuration
- TypeScript compilation from `src/` to `dist/`
- CommonJS modules targeting ES2020
- Strict TypeScript configuration
- Node.js >=18.0.0 required

## Key Dependencies

- **commander**: CLI framework for command parsing
- **playwright**: Browser automation and testing
- **jest + ts-jest**: Testing framework with TypeScript support

## Future Phases

See `docs/dev_plan.md` for complete roadmap:
- Phase 2: Visual regression testing and accessibility validation
- Phase 3: Performance monitoring and AI enhancements

Refer to `AGENT_INSTRUCTIONS.md` for detailed AI agent development guidance.

## Project Assessment Process

You will occasionally be asked to assess the current state of the development project. This involves a comprehensive review to understand where the project stands relative to its specifications and development plan.

### Assessment Steps

1. **Codebase Review**: Thoroughly examine all source code in `src/` and related files to understand current implementation state
2. **Test Analysis**: Run `npm run test` and analyze coverage, pass rates, and test quality
3. **Specification Comparison**: Review documentation in `/docs` directory and compare against actual implementation
4. **Development Plan Review**: Examine to-do lists and status files in `/plan` directory to understand what's marked as complete vs. actual state

### Assessment Output

Create a status report in `/plan/status_YYYYMMDDHHMM.md` with the following format:

#### Status
**Red/Yellow/Green assessment** based on:
- Codebase quality and completeness
- Test output and coverage
- Alignment with development plan claims

#### Summary
**Bullet points of positive findings:**
- What has been successfully implemented
- Working functionality confirmed by tests
- Progress that aligns with development plan

#### Feedback
**Bullet points of issues and discrepancies:**
- Functionality claimed as complete but not working
- Test failures or inadequate coverage
- Gaps between development plan claims and actual implementation
- Code quality concerns or architectural issues

This assessment provides an objective view of project status and helps identify where development claims may not match reality.