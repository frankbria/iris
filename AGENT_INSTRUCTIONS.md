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

---

_End of agent instructions._
