# Phase 1 To-Do List (Foundations)

This list breaks down the core tasks needed to complete **Phase 1 – Foundations (Core CLI & Browser Automation)** as defined in `AGENT_INSTRUCTIONS.md` and the docs folder.

## 1. CLI Commands
+ [x] Scaffold a TypeScript/Node.js CLI project (commander.js or similar).
+ [x] Implement the `run` command stub with help text and argument parsing.
+ [x] Implement the `watch` command stub to watch files or URL and trigger runs.
+ [x] Implement the `connect` command stub to start the JSON‑RPC/WebSocket server.
+ [x] Integrate a basic reporting/logging mechanism for command output.

## 2. Browser Automation Module
+ [x] Add Playwright dependency and TypeScript types.
+ [x] Create a `browser.ts` module to launch, close, and control browser contexts.
+ [x] Expose core actions: `navigate`, `click`, `type`, `screenshot`, etc.
+ [x] Write a smoke test to validate Playwright can launch a page and perform a simple click.

## 3. Natural Language → Playwright Translation
- [ ] Define an AI client interface supporting OpenAI/Anthropic backends.
- [ ] Implement fallback translation rules for basic commands (click, fill, navigate).
- [ ] Wire the `run` command to send the user’s natural‑language instruction to the translator.
- [ ] Add unit tests covering common translation mappings.

## 4. Protocol Layer (JSON‑RPC over WebSocket)
- [ ] Implement a lightweight WebSocket server exposing JSON‑RPC 2.0 endpoints.
- [ ] Define RPC methods for `executeCommand`, `getStatus`, and `streamLogs`.
- [ ] Integrate server startup into the `connect` command.
- [ ] Add an integration test simulating an RPC client issuing a command and receiving a result.

## 5. Persistence (SQLite Storage)
- [ ] Add SQLite dependency (e.g. better‑sqlite3) and initialize DB schema.
- [ ] Create migrations or initialization logic for the `test_results` table.
- [ ] Implement a `db.ts` module to insert and query test run records.
- [ ] Hook into the `run` command to persist start/end timestamps and status.
- [ ] Write tests for DB module CRUD operations.

## 6. Documentation & Testing
- [ ] Update `README.md` with Phase 1 usage examples for `run`, `watch`, and `connect`.
- [ ] Create basic unit and integration tests under `test/` (e.g. Jest or Mocha).
- [ ] Ensure new TypeScript code compiles with the project tsconfig and linter.

---

_End of Phase 1 to-do list._
