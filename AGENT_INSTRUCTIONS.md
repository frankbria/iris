# Agent Instructions for IRIS Development

This document provides guidance for the AI agent driving development of the AI‑Driven UI Development Orchestrator (IRIS). It relies on the detailed product requirements, user stories, development plan, and technical specifications in the `docs/` folder.

## Project Overview

IRIS ("Interface Recognition & Interaction Suite") gives AI coding assistants **eyes and hands** to see and interact with user interfaces. See:
- `docs/prd.md` for the refined Product Requirements Document (PRD).
- `docs/user_stories.md` for user stories and success criteria.
- `docs/dev_plan.md` for the incremental development plan.
- `docs/tech_specs.md` for technical specifications and system architecture.

## Phase 1 – Foundations (Core CLI & Browser Automation)

Implement the core foundations before any other features:

1. **CLI commands**: scaffold a TypeScript/Node.js CLI (`run`, `watch`, `connect`) with commander.js or similar.
2. **Browser automation**: integrate Playwright and expose a module for launching and controlling browsers.
3. **Natural language translation**: wire up an AI API client (OpenAI/Anthropic) with fallback rules to translate plain English commands to Playwright actions.
4. **Protocol layer**: implement JSON‑RPC over WebSocket for external integrations.
5. **Persistence**: store test run results in a local SQLite database.

Deliver each bullet as a minimal, tested increment so the CLI is demo‑ready at the end of Phase 1.

## Phase 2 – Enhanced Testing (Visual Regression & Accessibility)

Continue by adding:

- Automated screenshot capture and baseline comparisons.
- Visual diff engine (pixel comparison + AI anomaly classification).
- Axe‑core integration for WCAG compliance.
- Keyboard navigation and screen reader simulation tests.

## Phase 3+ – Performance, Integrations, and AI Enhancements

Refer to `docs/dev_plan.md` and `docs/tech_specs.md` for Phase 3 (performance monitoring) and beyond.

## Implementation Guidelines

- Follow existing code style and structure.
- Fix root causes, not just symptoms.
- Update documentation as features land.
- Write minimal tests for each new module.

## Feature Development Quality Standards

**CRITICAL**: All new features MUST meet the following mandatory requirements before being considered complete.

### Testing Requirements

- **Minimum Coverage**: 85% code coverage ratio required for all new code
- **Test Pass Rate**: 100% - all tests must pass, no exceptions
- **Test Types Required**:
  - Unit tests for all business logic and core modules
  - Integration tests for browser automation
  - End-to-end tests for CLI commands
- **Coverage Validation**: Run coverage reports before marking features complete:
  ```bash
  # Jest with coverage
  npm run test -- --coverage
  ```
- **Test Quality**: Tests must validate behavior, not just achieve coverage metrics
- **Test Documentation**: Complex test scenarios must include comments explaining the test strategy
- **Browser Testing**: Use data URLs for isolated browser testing

### Git Workflow Requirements

Before moving to the next feature, ALL changes must be:

1. **Committed with Clear Messages**:
   ```bash
   git add .
   git commit -m "feat(module): descriptive message following conventional commits"
   ```
   - Use conventional commit format: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, etc.
   - Include scope when applicable: `feat(cli):`, `fix(browser):`, `test(automation):`
   - Write descriptive messages that explain WHAT changed and WHY

2. **Pushed to Remote Repository**:
   ```bash
   git push origin <branch-name>
   ```
   - Never leave completed features uncommitted
   - Push regularly to maintain backup and enable collaboration
   - Ensure CI/CD pipelines pass before considering feature complete

3. **Branch Hygiene**:
   - Work on feature branches, never directly on `main`
   - Branch naming convention: `feature/<feature-name>`, `fix/<issue-name>`, `docs/<doc-update>`
   - Create pull requests for all significant changes

4. **Phase Alignment**:
   - Ensure features align with current development phase
   - Update development plan when phase goals are completed
   - Reference phase objectives in implementation decisions

### Documentation Requirements

**ALL implementation documentation MUST remain synchronized with the codebase**:

1. **Code Documentation**:
   - TypeScript: JSDoc comments for all public functions, classes, and interfaces
   - Update inline comments when implementation changes
   - Remove outdated comments immediately

2. **Implementation Documentation**:
   - Update relevant sections in CLAUDE.md and this file
   - Keep technical specifications current (`docs/tech_specs.md`)
   - Update development roadmap (`docs/dev_plan.md`)
   - Update configuration examples when defaults change
   - Document breaking changes prominently

3. **README Updates**:
   - Keep feature lists current
   - Update setup instructions when dependencies change
   - Maintain accurate command examples
   - Update version compatibility information

4. **Project Status Documentation**:
   - Update status reports in `/plan` directory
   - Keep user stories current (`docs/user_stories.md`)
   - Document new CLI commands and options
   - Update architecture diagrams when structure changes

### Feature Completion Checklist

Before marking ANY feature as complete, verify:

- [ ] All tests pass (`npm run test`)
- [ ] Code coverage meets 85% minimum threshold
- [ ] Coverage report reviewed for meaningful test quality
- [ ] TypeScript compilation succeeds (`npm run build`)
- [ ] Code formatted according to project standards
- [ ] All changes committed with conventional commit messages
- [ ] All commits pushed to remote repository
- [ ] Implementation documentation updated
- [ ] Inline code comments updated or added
- [ ] CLAUDE.md updated (if new patterns introduced)
- [ ] This AGENT_INSTRUCTIONS.md updated (if guidelines change)
- [ ] Breaking changes documented
- [ ] CLI functionality manually tested
- [ ] Browser automation tested with real scenarios
- [ ] Phase objectives updated (if completed)
- [ ] Status assessment conducted (if major milestone)
- [ ] CI/CD pipeline passes

### Rationale

These standards ensure:
- **Quality**: High test coverage and pass rates prevent regressions in automation tools
- **Traceability**: Git commits provide clear history of changes during development
- **Maintainability**: Current documentation reduces onboarding time and prevents knowledge loss
- **Collaboration**: Pushed changes enable team visibility and code review
- **Reliability**: Consistent quality gates maintain stability of automation framework
- **Alignment**: Features stay aligned with development phases and project goals
- **Assessment**: Regular status checks ensure development claims match reality

**Enforcement**: AI agents should automatically apply these standards to all feature development tasks without requiring explicit instruction for each task.

---

_End of agent instructions._
