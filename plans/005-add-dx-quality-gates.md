# Plan 005: Add quality gates — typecheck/lint/format scripts, `.env.example`, and CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. When done, update
> this plan's status row in `plans/README.md` unless a reviewer told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 65633a6..HEAD -- package.json`
> If `package.json` changed since this plan was written, re-read its `scripts`
> block before proceeding; on a mismatch with "Current state", treat it as a
> STOP condition.

## Status

- **Priority**: P2 (`[P2.1]`)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (but landing it first makes 001–004 verifiable in CI)
- **Category**: dx / tooling
- **Planned at**: commit `65633a6`, 2026-06-21
- **Issue**: https://github.com/frankbria/iris/issues/5

## Why this matters

The repo compiles cleanly (`npx tsc --noEmit` exits 0) but **nothing enforces
it**: there is no `typecheck` script, no linter, no formatter, no
`.env.example`, and no CI (`.github/` does not exist). Regressions and style
drift can land unnoticed, and a new contributor has no one-command way to verify
the project or know which env vars the CLI needs. Adding the gates is purely
additive, low-risk, and makes every other plan in this set verifiable in CI.

## Current state

`package.json` scripts block today:

```json
"scripts": {
  "build": "tsc",
  "test": "jest",
  "start": "ts-node src/cli.ts"
},
```

- No `lint` / `format` / `typecheck` / `verify` scripts.
- `tsconfig.json` already has `"strict": true`; `npx tsc --noEmit` passes.
- No `.github/workflows/` directory.
- No `.env.example`. The CLI reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `OLLAMA_ENDPOINT`, `OLLAMA_MODEL` (see `src/config.ts:74-85`) and
  `IRIS_DB_PATH` (see `src/watcher.ts`).
- `engines.node` is `>=18.0.0` (Node 18 is past LTS; CI should run on 20).

The project is TypeScript-only — ignore the Python `ruff`/`black` mention in any
global instructions; it does not apply here.

## Commands you will need

| Purpose        | Command                          | Expected on success      |
|----------------|----------------------------------|--------------------------|
| Install        | `npm install`                    | exit 0                   |
| Typecheck      | `npx tsc --noEmit`               | exit 0, no output        |
| Lint (new)     | `npm run lint`                   | exit 0 (after Step 2)    |
| Format check   | `npm run format:check`           | exit 0 (after Step 2)    |
| Tests          | `npx jest`                       | runs (counts per baseline)|

## Scope

**In scope**:
- `package.json` — add scripts + devDependencies
- `.eslintrc.json` (or `eslint.config.js`) — minimal config
- `.prettierrc` + `.prettierignore`
- `.env.example` — documented placeholder vars (NO real values)
- `.github/workflows/ci.yml` — install + typecheck + lint + test
- `README.md` — a short "Verify your setup" subsection pointing at `npm run verify`

**Out of scope** (do NOT touch):
- Reformatting the entire codebase. Add the formatter and a `format` script, but
  do NOT run `prettier --write` across `src/` in this plan — a repo-wide reformat
  is a separate, noisy change that would collide with plans 001–004. The CI uses
  `format:check` in **warn-only** mode for now (Step 4).
- Fixing pre-existing lint findings beyond what's needed for `npm run lint` to
  exit 0 on a minimal ruleset (see Step 2 / STOP conditions).
- The 2 failing tests (plan 002) — CI may show them red until 002 lands; that's
  expected and noted in Step 4.

## Git workflow

- Branch: `improve/005-add-dx-quality-gates`
- Commit style: `chore(dx): add typecheck/lint/format scripts, env example, CI`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add scripts to package.json

Add to the `scripts` block:

```json
"typecheck": "tsc --noEmit",
"lint": "eslint \"src/**/*.ts\" \"__tests__/**/*.ts\"",
"format": "prettier --write \"src/**/*.ts\" \"__tests__/**/*.ts\"",
"format:check": "prettier --check \"src/**/*.ts\" \"__tests__/**/*.ts\"",
"verify": "npm run typecheck && npm run lint && npm test"
```

### Step 2: Add ESLint + Prettier with a minimal, non-noisy ruleset

Install dev deps: `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`,
`eslint`, `prettier`. Configure ESLint for TypeScript with a **lenient** base so
`npm run lint` exits 0 on the current code (recommended set, but downgrade rules
that would produce hundreds of errors — e.g. `@typescript-eslint/no-explicit-any`
set to `"warn"`, not `"error"`, since the codebase has intentional `as any` casts
that other plans address). Goal: a working gate that passes today, tightened
later — not a wall of errors.

Add `.prettierrc` matching the existing code style (2-space indent, single
quotes, semicolons — confirm by inspecting a few `src/*.ts` files first).

**Verify**: `npm run lint` → exit 0. `npm run typecheck` → exit 0.

### Step 3: Add `.env.example`

Create `.env.example` listing every env var the code reads, with placeholder
(non-secret) values and a one-line comment each:

```
# AI provider credentials (set the one matching your provider)
OPENAI_API_KEY=sk-...            # OpenAI GPT-4o vision/text
ANTHROPIC_API_KEY=sk-ant-...     # Anthropic Claude vision/text
OLLAMA_ENDPOINT=http://localhost:11434   # Local Ollama (no key)
OLLAMA_MODEL=llama2
# Optional: override the SQLite DB path
IRIS_DB_PATH=~/.iris/iris.db
```

Do NOT put real credentials in this file.

### Step 4: Add CI workflow

Create `.github/workflows/ci.yml` running on push + PR, Node 20:

```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run format:check || echo "::warning::formatting drift (non-blocking)"
      - run: npm test
      - run: npm audit --omit=dev --audit-level=high
```

Note: `npm test` may report the 2 known failures until plan 002 lands, and
`npm audit` will fail until plan 001 lands. That is acceptable — CI turning green
is itself the signal those plans are done. If you need CI green immediately,
land 001 and 002 first.

**Verify**: the workflow file is valid YAML — `npx --yes js-yaml .github/workflows/ci.yml`
parses without error (or any YAML linter you have). You cannot run GitHub Actions
locally; correctness is verified by structure + the individual commands passing
locally.

### Step 5: Document the one-command verify in README

Add a short subsection under setup: "Run `npm run verify` to typecheck, lint, and
test in one step." Keep it to a few lines.

## Test plan

No application tests change. The "tests" for this plan are that the new scripts
run and exit as specified:
- `npm run typecheck` → 0
- `npm run lint` → 0
- `npm run format:check` → runs (may report drift; non-blocking)
- `.github/workflows/ci.yml` parses as valid YAML

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run verify` exists and runs (test step may show plan-002 failures)
- [ ] `.env.example` exists and contains NO real secrets (`grep -iE 'sk-[a-z0-9]{20,}' .env.example` returns nothing)
- [ ] `.github/workflows/ci.yml` exists and is valid YAML
- [ ] Only in-scope files modified; no `src/**` files reformatted (`git diff --stat` shows no mass `src/` churn)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A minimal ESLint config still produces so many errors that `npm run lint` can't
  exit 0 without disabling core rules wholesale — report the top error categories
  so the operator can decide the ruleset, rather than silencing everything.
- Prettier wants to reformat large swaths of `src/` even in `--check` mode — that
  is expected; keep it non-blocking (Step 4) and do NOT auto-format in this plan.
- Adding the lint devDeps surfaces a peer-dependency conflict with the installed
  TypeScript/Jest versions — report the conflict.

## Maintenance notes

- Once plans 001 and 002 land, flip CI's `format:check` and `npm test` to
  blocking, and consider a follow-up plan to run `npm run format` repo-wide in
  one isolated commit.
- Bump `engines.node` to `>=20.0.0` in a follow-up once CI confirms the suite
  passes on Node 20 (left out here to keep this plan additive-only).
- A reviewer should confirm `.env.example` carries no real keys and that CI does
  not echo secrets.
