# Plan 011: `iris run --json` + an assistant-facing integration doc

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/cli.ts README.md`
> On any in-scope drift, compare "Current state" excerpts to live code first;
> mismatch = STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (pairs well after plans/010)
- **Category**: dx
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

IRIS's product vision is "a bridge that gives AI coding assistants eyes and hands" — but today no assistant can consume `iris run`: it emits only emoji-decorated human text, and no doc tells an assistant-using developer what to run or how to parse results. Shelling out to a CLI with JSON output IS the lowest-effort real integration that works with every assistant (Claude Code, Cursor, Copilot) *today*, no protocol required. The runner commands already have `--format json`; `run` is the gap. This is the works-now tier while the MCP server (plans/012) lands.

## Current state

- `src/cli.ts:25-108` — the `run` action prints human text only (`console.log` with emoji), collects `executionResults: any[]`, tracks `status: 'success' | 'error'`. Excerpt of the result loop:

```ts
// src/cli.ts:88-96 (inside the action loop)
              const execResult = await executor.executeAction(action, page);
              executionResults.push(execResult);

              if (execResult.success) {
                console.log(`   ✅ Success (${execResult.duration}ms)`);
```

- Translation result shape available at `src/cli.ts:34-41`: `{ actions, method, confidence, reasoning }` (from `src/translator.ts:9-14`).
- Execution result shape: `src/executor.ts:14-24` — `{ success, action, error?, duration?, context?: { url?, title?, timestamp } }`.
- Precedent: `visual-diff` has `.option('--format <type>', 'Output format (html|json|junit)', 'html')` near `src/cli.ts:289`.
- Exit codes already in use elsewhere: visual-diff uses 2/3/5, a11y uses 4 (see `src/cli.ts:374-414, 493-511`). `run` currently records status in the DB but does not set a distinct exit code convention — keep process exit behavior as-is except where specified below.
- README integration guidance currently points assistants at `iris connect` (README.md, "JSON-RPC protocol" bullets) — a surface no mainstream assistant can consume.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Tests     | `npx jest __tests__/cli.test.ts` | all pass    |
| Full gate | `npm run verify`         | exit 0              |
| Manual    | `npm start run "go to https://example.com" --json` | single JSON object on stdout, no emoji lines |

## Scope

**In scope**:
- `src/cli.ts` (run command only)
- `__tests__/cli.test.ts` (extend)
- `README.md` (new section "Using IRIS from an AI assistant")

**Out of scope**:
- `src/protocol.ts` (canonical-surface decision is plans/017)
- visual-diff/a11y commands (already have JSON)
- Any change to human-mode output.

## Git workflow

- Branch: `feat/011-run-json-output`
- Conventional commits, e.g. `feat(cli): add --json machine-readable output to iris run`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add `--json` flag and suppress human logs in JSON mode

Add `.option('--json', 'Emit a single machine-readable JSON result on stdout', false)`. In the action, when `options.json` is set, route all current `console.log` narration through a helper that no-ops in JSON mode (smallest diff: `const say = options.json ? () => {} : console.log;` and replace `console.log` calls inside the action with `say`). Errors still go to stderr.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Emit the JSON envelope

At the end of the action (success and error paths, including dry-run), when `options.json` is set, print exactly one JSON object:

```json
{
  "instruction": "...",
  "translation": { "method": "pattern|ai", "confidence": 0.9, "reasoning": "...", "actions": [...] },
  "executed": true,
  "results": [ { "success": true, "action": {...}, "error": null, "duration": 123, "context": {...} } ],
  "status": "success|error"
}
```

`executed:false` with `results: []` for `--dry-run`. Use the existing `status` variable; do not invent new status values.

**Verify**: `npm start run "click on nothing" --dry-run --json | node -e "JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('valid')"` → prints `valid`.

### Step 3: Tests

Extend `__tests__/cli.test.ts`:
- `--dry-run --json` → stdout parses as JSON; `executed === false`; `translation.actions` present; no emoji narration lines captured.
- JSON mode with mocked executor → `results` array carries per-action success/error; `status` reflects a failed action.

**Verify**: `npx jest __tests__/cli.test.ts` → all pass.

### Step 4: README — "Using IRIS from an AI assistant"

Add a README section documenting the assistant-facing contract: the three useful commands (`iris run --json --url <u> "<instruction>"`, `iris visual-diff --format json`, `iris a11y --format json`), the JSON shapes (one example each — for run use the Step 2 envelope), and exit-code meanings (visual-diff 2/3/5, a11y 4 — read the exact semantics from `src/cli.ts:374-414,493-511` and document what you find, don't guess). Reposition the JSON-RPC/`connect` bullets as "advanced/experimental" rather than the primary integration path.

**Verify**: `npm run verify` → exit 0. `npm run format` before commit.

## Test plan

As Step 3; pattern: `__tests__/cli.test.ts` console-spy style — for JSON mode capture `console.log` calls and `JSON.parse` the single captured line.

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `npm start run "x" --dry-run --json` emits exactly one parseable JSON object and nothing else on stdout
- [ ] README contains the "Using IRIS from an AI assistant" section with all three commands
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Drift vs excerpts.
- The run action's structure has materially changed (e.g. plans/010 or /014 landed first and reshaped the loop) — reconcile with the live shape, and if the envelope no longer fits, report rather than invent a new schema.

## Maintenance notes

- The JSON envelope becomes a public contract once documented — future changes must be additive.
- Plans/012 (MCP) should reuse these same result shapes for its tool outputs; keep them in sync.
- Reviewer: confirm no narration leaks to stdout in JSON mode (assistants will pipe this).
