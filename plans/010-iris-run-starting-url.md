# Plan 010: Give `iris run` a starting page (`--url`) so actions stop executing against about:blank

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/cli.ts src/executor.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

`iris run "<instruction>"` launches a browser, creates a page — and never navigates anywhere. The page sits on `about:blank`, so every instruction that doesn't *begin* with a navigation action ("click …", "fill …", and every goal-style AI-translated plan) executes its clicks and fills against a blank page and fails 100% of the time. The product's headline promise ("describe behavior in plain English and IRIS verifies it") is structurally impossible from the CLI without a starting page. The sibling commands `visual-diff` and `a11y` already accept `--base-url`/`IRIS_BASE_URL`; `run` is the odd one out. No GitHub issue tracks this.

## Current state

- `src/cli.ts:11-24` — the `run` command registration. Options today are only `--dry-run`, `--headless`, `--timeout`:

```ts
// src/cli.ts:11-21
program
  .command('run <instruction>')
  .description('Run a natural language instruction')
  .option('--dry-run', 'Only translate without executing actions')
  .option('--headless', 'Run browser in headless mode (default: true)')
  .option(
    '--timeout <ms>',
    'Timeout for actions in milliseconds',
    (v) => parseIntOption(v, { min: 1000, max: 3600000, name: 'timeout' }),
    30000,
  )
```

- `src/cli.ts:66-84` (inside the action) — after `executor.launchBrowser()` and `executor.createPage()`, the code goes straight into the action loop. There is no initial `navigate`.
- `src/cli.ts:34` — translation happens with no context: `const result = await translate(instruction);`
- `src/executor.ts` — `ActionExecutor.executeAction(action, page)` executes `navigate` actions through the URL policy (`assertNavigationAllowed` imported from `./url-policy` at `executor.ts:12`). Reuse this path: performing the initial navigation as a normal `navigate` action keeps the URL policy applied with zero new security surface.
- `visual-diff` precedent for the flag (same file): `baseURL: options.baseUrl || process.env.IRIS_BASE_URL` (near `src/cli.ts:350`).
- Repo conventions: strict TS, conventional commits, Prettier before commit, Jest tests in `__tests__/`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Tests     | `npx jest __tests__/cli.test.ts` | all pass    |
| Full gate | `npm run verify`         | exit 0              |
| Manual    | `npm start run "click on text=More information" --url https://example.com` | action executes against example.com (may fail selector, must NOT fail with blank-page symptom) |

## Scope

**In scope**:
- `src/cli.ts` (run command only)
- `__tests__/cli.test.ts` (extend)
- `README.md` (run usage example gains `--url`)

**Out of scope**:
- `src/executor.ts`, `src/url-policy.ts` — reuse as-is.
- `src/translator.ts` — no grammar changes here (that's plan 013/014 territory).
- The `watch` command's target handling.

## Git workflow

- Branch: `fix/010-run-starting-url`
- Conventional commits, e.g. `fix(cli): add --url starting page to iris run`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the option

Add to the `run` command registration: `.option('--url <url>', 'Starting page URL (or set IRIS_BASE_URL)')`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Navigate before executing, pass context to translate

In the `run` action:
1. Resolve `const startUrl = options.url || process.env.IRIS_BASE_URL;`
2. Pass it to translation for better AI plans: `await translate(instruction, startUrl ? { url: startUrl } : undefined);` (the signature `translate(instruction, context?: { url?: string })` already exists — see `src/translator.ts:31-34`).
3. In the non-dry-run branch, after `createPage()` and before the action loop, when `startUrl` is set AND the first translated action is not itself a `navigate`, execute an initial navigation **through the executor** so URL policy applies: `await executor.executeAction({ type: 'navigate', url: startUrl }, page);` — and if that result has `success: false`, print the error and exit with status error (do not run the remaining actions against about:blank).

**Verify**: `npm run typecheck && npm run lint` → exit 0.

### Step 3: Tests

Extend `__tests__/cli.test.ts` (match its existing console-spy + `runCli` style):
- `run "click foo" --dry-run --url https://example.com` → translation receives context url (assert via console output or by mocking `./translator`).
- Non-dry-run with `--url`: mock `ActionExecutor`; assert the first executed action is `{type:'navigate', url:'https://example.com'}` followed by the translated action.
- Non-dry-run with `--url` where the mocked initial navigation returns `success:false` → remaining actions are NOT executed.
- Instruction already starting with navigation + `--url` → no doubled navigate (initial nav skipped).

**Verify**: `npx jest __tests__/cli.test.ts` → all pass.

### Step 4: Docs + gate

Update the README "Natural Language Commands" example to show `--url`. Run `npm run format`.

**Verify**: `npm run verify` → exit 0.

## Test plan

As Step 3; pattern file: `__tests__/cli.test.ts`.

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `iris run --help` (via `npm start run --help` or built bin) lists `--url`
- [ ] New tests exist and pass, including the skip-doubled-navigate case
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpts don't match live code (drift).
- `translate` no longer accepts a context second argument.
- Making the initial navigation work appears to require changes to `url-policy.ts` (it shouldn't — navigate actions already route through it).

## Maintenance notes

- Plan 014 (agentic loop) builds on this: the loop's initial observation requires a loaded page. Keep the `--url`/`IRIS_BASE_URL` resolution in one obvious place.
- Reviewer: check the "first action is already navigate" skip logic and the fail-fast on failed initial navigation.
