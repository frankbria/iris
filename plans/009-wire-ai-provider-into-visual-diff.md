# Plan 009: Make `iris visual-diff --semantic` actually run AI analysis

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/cli.ts src/visual/visual-runner.ts src/visual/ai-classifier.ts`
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

`iris visual-diff --semantic` — the CLI entry point to the project's entire AI-vision investment (SmartAIVisionClient, LRU+SQLite cache, token-based cost tracker, AIVisualClassifier) — **crashes 100% of the time**, even with `OPENAI_API_KEY` correctly set. The CLI never plumbs any API key into the runner config, so the classifier's constructor guard throws before any test runs. On top of that, the hardcoded model names (`gpt-4-vision-preview`, `claude-3-opus-20240229`) are retired models that would fail even if a key were wired. Fixing this one wiring gap flips a large, well-tested subsystem from unreachable to delivering. There is no GitHub issue tracking this.

## Current state

- `src/cli.ts` — `visual-diff` command (registered around line 271). Builds the runner config around lines 339–346 with a hardcoded provider and **no apiKey field**:

```ts
// src/cli.ts:339-346
        diff: {
          threshold: options.threshold,
          semanticAnalysis: options.semantic,
          aiProvider: 'openai' as const,
          antiAliasing: true,
          regions: [],
          maxConcurrency: options.concurrency,
        },
```

- `src/visual/visual-runner.ts:40-43` — the config type: `diff: { ...; semanticAnalysis: boolean; aiProvider: AIProvider; ... }` (no apiKey). Lines 122–130 construct the classifier without a key and with retired model names:

```ts
// src/visual/visual-runner.ts:122-130
    if (config.diff.semanticAnalysis) {
      this.aiClassifier = new AIVisualClassifier({
        provider: config.diff.aiProvider,
        model:
          config.diff.aiProvider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229',
        maxTokens: 1024,
        temperature: 0.1,
      });
    }
```

- `src/visual/ai-classifier.ts:28-33` — `AIProviderConfig { provider: AIProvider; apiKey?: string; model?: string; ... }`. Lines 138–156 (`validateProviderConfig`) throw `'OpenAI API key is required for provider "openai"'` when provider is `openai`/`claude` with no `apiKey`. Provider `'ollama'` requires no key.
- `src/config.ts:128-150` — `loadFromEnvironment()` already resolves provider+key from env (`OPENAI_API_KEY` → openai, `ANTHROPIC_API_KEY` → anthropic, `OLLAMA_ENDPOINT` → ollama). `loadConfig()` is exported from the same file. **Note the vocabulary mismatch**: config.ts uses provider name `'anthropic'`, while `AIProviderConfig` in ai-classifier.ts uses `'claude'` (see its `validProviders` list at ai-classifier.ts:140-143). You must map `anthropic` → `claude` when passing through.
- `src/ai-client/smart-client.ts:61` — the smart client's default fallback chain is `['ollama', 'openai', 'anthropic']`; Ollama is free and keyless.
- Repo conventions: strict TS, conventional commits (`fix(scope): ...`), Prettier enforced in CI (run `npm run format` before committing), tests in `__tests__/` using Jest + ts-jest.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | exit 0              |
| Tests     | `npx jest __tests__/cli.test.ts __tests__/visual` | all pass |
| Full gate | `npm run verify`         | exit 0              |
| Format    | `npm run format`         | files rewritten     |

## Scope

**In scope** (the only files you should modify):
- `src/cli.ts` (visual-diff command config assembly + new `--provider` option)
- `src/visual/visual-runner.ts` (config type + classifier construction)
- `__tests__/` — new/updated tests for the wiring

**Out of scope** (do NOT touch, even though they look related):
- `src/visual/ai-classifier.ts` — its validation guard is correct; do not weaken it.
- `src/ai-client/**` — the smart client, cache, and cost tracker work; this plan only wires config *into* them.
- Issue #68 (circuit breaker blocks free calls) and #74 (fallback single apiKey) — tracked separately; do not attempt here.
- The `run`/`watch`/`a11y` commands.

## Git workflow

- Branch: `fix/009-wire-semantic-ai-provider`
- Conventional commits, e.g. `fix(cli): wire AI provider + API key into visual-diff --semantic`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend the runner config type with credentials

In `src/visual/visual-runner.ts`, extend the `diff` section of `VisualTestRunnerConfig` (lines 40-43 area) with two optional fields: `apiKey?: string;` and `aiModel?: string;`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Pass credentials and a living model into the classifier

Replace the construction at `src/visual/visual-runner.ts:122-130` so it passes `apiKey: config.diff.apiKey` and uses `config.diff.aiModel` when provided, with updated defaults for current models: `'gpt-4o'` for openai and `'claude-3-5-sonnet-20241022'` for claude. (These are the models the cost tracker already has pricing for — see `DEFAULT_PRICING` in `src/ai-client/cost-tracker.ts`.)

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Resolve provider + key in the CLI and add `--provider`

In `src/cli.ts` visual-diff command:
1. Add an option: `.option('--provider <name>', 'AI provider for --semantic (openai|anthropic|ollama). Default: auto-detect from environment')`.
2. In the action, when `options.semantic` is true, resolve provider and key: if `options.provider` is given use it; otherwise call `loadConfig()` from `./config` and use its `ai.provider`/`ai.apiKey`. Map the config vocabulary to the classifier vocabulary: `'anthropic'` → `'claude'`; `'openai'` and `'ollama'` pass through.
3. Replace the hardcoded `aiProvider: 'openai' as const` with the resolved provider, and add `apiKey` to the diff config.
4. If provider resolves to openai/claude but no key is found, print a clear error (`--semantic requires an API key: set OPENAI_API_KEY or ANTHROPIC_API_KEY, or use --provider ollama`) and `process.exit(2)` **before** constructing the runner — never let the constructor throw be the user's error message.

**Verify**: `npm run typecheck && npm run lint` → exit 0.

### Step 4: Tests

Add to `__tests__/` (model the mocking style on `__tests__/cli.test.ts`, which spies on `console.log` and calls `runCli`):
- `visual-diff --semantic` with `OPENAI_API_KEY` set in env → runner config receives `aiProvider: 'openai'` and the key (mock `VisualTestRunner` and assert constructor args; jest.mock the module).
- `--semantic --provider ollama` with no keys → no error exit; provider `'ollama'` reaches the runner.
- `--semantic` with no keys and no provider → exits 2 with the guidance message, and `VisualTestRunner` is never constructed.

**Verify**: `npx jest __tests__/cli.test.ts` (or your new test file) → all pass.

### Step 5: Full gate + docs touch

Update the `--semantic` flag description in `src/cli.ts` and the README's visual-diff section if it documents `--semantic` (check `grep -n "semantic" README.md`) to mention provider auto-detection and `--provider`.

**Verify**: `npm run verify` → exit 0. `npm run format` before committing.

## Test plan

New tests as in Step 4; pattern: `__tests__/cli.test.ts`. Existing visual-runner tests must keep passing unchanged (`npx jest __tests__/visual`).

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `grep -n "gpt-4-vision-preview" src/` returns no matches
- [ ] `grep -n "aiProvider: 'openai' as const" src/cli.ts` returns no matches
- [ ] New tests from Step 4 exist and pass
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- The excerpts above don't match the live code (drift).
- `AIProviderConfig` no longer accepts `'ollama'` or the `'claude'`/`'anthropic'` naming mismatch has been unified — the mapping in Step 3 would then be wrong.
- Making the tests pass appears to require modifying `src/visual/ai-classifier.ts` validation.

## Maintenance notes

- Plan 015 (watch-mode AI feedback) and plan 016 (surface AI intelligence) both assume this wiring exists — land this first.
- Reviewer should scrutinize: the `anthropic`→`claude` mapping, and that the no-key error path exits before any Playwright/browser work starts.
- Deferred: defaulting the provider to ollama-first via the smart-client chain when nothing is configured (blocked by #68's circuit-breaker bug; revisit after #68 lands).
