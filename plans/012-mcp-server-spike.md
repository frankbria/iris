# Plan 012: MCP server spike — make IRIS drivable by Claude Code (one real tool first)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/ package.json`
> On drift in `src/a11y/` or `package.json`, compare "Current state" excerpts
> before proceeding; mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: M (spike scope — deliberately ONE tool)
- **Risk**: LOW (additive; new directory + one dependency)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

The PRD's core identity is "a bridge that gives AI coding assistants eyes and hands" and explicitly promises "Claude MCP integration" and "Claude Code adapters" (docs/prd.md Phase 3, docs/tech_specs.md "MCP for Claude ecosystem compatibility"). None of it exists: there is no MCP code in the repo, and the existing WebSocket JSON-RPC server (`src/protocol.ts`) speaks no dialect any mainstream assistant understands. A complete, high-confidence MCP design already exists at `claudedocs/research_iris_claude_code_plugin_20251012.md` (41KB: architecture, three tools, resources, deployment). This plan implements the smallest real slice — an MCP stdio server exposing ONE tool (accessibility testing) — and verifies it loads in Claude Code. Fan-out to the other tools happens in a follow-up once the spike proves the shape.

## Current state

- **No MCP anywhere**: `grep -rn "modelcontextprotocol" package.json src/` → no matches.
- **The design doc**: `claudedocs/research_iris_claude_code_plugin_20251012.md`. Read sections 3 (MCP Server Architecture Design, from line ~154), 4.1 Tool 2: Accessibility Testing (line ~318), and 5.2 Claude Code Configuration (line ~678) before writing code. It proposes `server.registerTool(...)` with the TypeScript SDK and a module layout under a new `src/mcp/` directory. Treat it as design guidance; where it conflicts with the current SDK API, the SDK wins.
- **The engine to wrap**: `src/a11y/a11y-runner.ts` — `AccessibilityRunner` used by the CLI at `src/cli.ts:417-512` (the `a11y` command). Read that CLI action for the exact constructor/config/run/result wiring and mirror it — it is the known-good usage pattern. Result objects are plain serializable data.
- **Known trap**: keyboard/screen-reader sub-checks hardcode success (tracked issue #73) and axe rule options are parsed but unapplied (#72). The MCP tool must therefore expose ONLY the axe-core violations portion honestly; do not surface keyboard/screenreader "passes".
- **Auth/keys**: a11y needs no AI key (axe-core is local). That's one reason it's the right spike tool.
- Conventions: strict TS (CommonJS output, ES2020, Node >=20.9 — see tsconfig.json), conventional commits, Prettier, Jest in `__tests__/`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install dep | `npm install @modelcontextprotocol/sdk` | exit 0, lockfile updated |
| Typecheck | `npm run typecheck`      | exit 0              |
| Build     | `npm run build`          | exit 0, dist/mcp/ exists |
| Tests     | `npx jest __tests__/mcp` | all pass            |
| Full gate | `npm run verify`         | exit 0              |
| Smoke     | `node dist/mcp/server.js` then send an MCP `initialize` + `tools/list` over stdio (see Step 4 script) | tool `run_accessibility_test` listed |

## Scope

**In scope**:
- `src/mcp/` (new: `server.ts`, `tools.ts`)
- `package.json` (dependency + `iris-mcp` bin entry)
- `.mcp.json.example` (new, documented example for Claude Code)
- `__tests__/mcp/` (new)
- README (one short "MCP (experimental)" subsection)

**Out of scope**:
- `src/protocol.ts` — do not modify or remove (that decision is plans/017).
- Visual-diff and run tools — follow-up after the spike is accepted.
- MCP resources/prompts from the design doc — tools only for the spike.
- Publishing, plugin marketplace, `plugin.json` — deployment comes later.
- Fixing #72/#73 — honest scoping around them only.

## Git workflow

- Branch: `feat/012-mcp-server-spike`
- Conventional commits, e.g. `feat(mcp): add MCP stdio server with run_accessibility_test tool`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Dependency + skeleton

`npm install @modelcontextprotocol/sdk`. Create `src/mcp/server.ts`: an MCP server over `StdioServerTransport` (import from the SDK; consult the SDK's README/types in `node_modules/@modelcontextprotocol/sdk` for the current `McpServer`/`registerTool` API — the design doc's code sketch may be slightly stale). Server name `iris`, version from package.json.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: The tool

In `src/mcp/tools.ts`, register `run_accessibility_test`:
- Input schema (zod, already a dependency): `{ url: string, wcagLevel?: 'AA'|'AAA' }`.
- Implementation: construct and run `AccessibilityRunner` exactly as `src/cli.ts:417-512` does (same config defaults), against the given URL.
- Output: structured content with the axe violations summary only — count, and per-violation `{ id, impact, description, nodes: count }` — plus a `passed` boolean derived from violations count. Explicitly omit keyboard/screen-reader results (see Known trap).
- Errors (page unreachable, Playwright missing) → MCP tool error result with the message, never a crash.

**Verify**: `npm run typecheck && npm run lint` → exit 0.

### Step 3: bin entry + example config

Add to package.json `"bin"`: `"iris-mcp": "./dist/mcp/server.js"` (keep existing `iris` bin). Add a shebang `#!/usr/bin/env node` line to server.ts. Create `.mcp.json.example`:

```json
{
  "mcpServers": {
    "iris": { "command": "node", "args": ["./dist/mcp/server.js"] }
  }
}
```

**Verify**: `npm run build` → exit 0 and `test -f dist/mcp/server.js` → exit 0.

### Step 4: Protocol smoke test

Write `__tests__/mcp/server.test.ts`: spawn `node dist/mcp/server.js`, write an MCP `initialize` request then `tools/list` over stdin (JSON-RPC 2.0, newline-delimited per stdio transport spec), assert the response lists `run_accessibility_test` with the input schema. Then call the tool against a data-URL or a local `file://` fixture page containing a known violation (e.g. an image without alt) — follow the existing browser-test convention of data URLs (see `__tests__/browser.test.ts`) — and assert at least one violation is returned. If `src/url-policy.ts` blocks the chosen scheme through this path, use a localhost http server fixture instead (pattern: any existing e2e test under `__tests__/e2e/`).

**Verify**: `npx jest __tests__/mcp` → all pass.

### Step 5: Live verification in Claude Code + README

Copy `.mcp.json.example` to `.mcp.json` locally (do not commit `.mcp.json`), run `claude mcp list` or launch Claude Code in the repo, and confirm the `iris` server and its tool appear. Capture the observed output in the PR/report. Add the README "MCP (experimental)" subsection: what works (one tool), how to configure, what's next.

**Verify**: manual — tool listed in Claude Code. Then `npm run verify` → exit 0.

## Test plan

Step 4's protocol-level test is the core (spawned process, real stdio, real axe run on a fixture). Pattern for browser fixtures: `__tests__/browser.test.ts` (data URLs). No mocking of the MCP SDK.

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `npx jest __tests__/mcp` passes, including a real tool call returning ≥1 violation on the fixture
- [ ] `node dist/mcp/server.js` responds to `initialize` + `tools/list` with `run_accessibility_test`
- [ ] Claude Code lists the server (manual check recorded)
- [ ] `.mcp.json` NOT committed; `.mcp.json.example` committed
- [ ] `plans/README.md` status row updated

## STOP conditions

- `@modelcontextprotocol/sdk` install fails or its current API diverges so far from the design doc that the tool registration shape is unclear — report with the SDK version and observed API.
- `AccessibilityRunner` cannot be constructed outside the CLI without refactoring it (i.e. it reads CLI-only state) — report; refactoring the runner is out of scope.
- The stdio server can't run under CommonJS output (ESM-only SDK) — report the exact error; a tsconfig change is a project-level decision, not yours.

## Maintenance notes

- Follow-up (separate plan/issue): `run_visual_test` and `execute_ui_action` tools per design doc sections 4.1 Tool 1/Tool 3, plus MCP resources for report artifacts; then plugin packaging (design doc section 5).
- The tool result shapes should stay aligned with the CLI `--format json` outputs (plans/011) — one contract, two transports.
- Reviewer: check the honest scoping (no keyboard/SR claims), error paths (unreachable URL), and that the server does not hold a browser open between calls.
