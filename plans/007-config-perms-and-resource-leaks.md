# Plan 007: Restrict config-file permissions and close leaked resource handles

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. When done, update
> this plan's status row in `plans/README.md` unless a reviewer told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 65633a6..HEAD -- src/config.ts src/watcher.ts src/visual/visual-runner.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (`[P2.3]`)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / bug
- **Planned at**: commit `65633a6`, 2026-06-21
- **Issue**: https://github.com/frankbria/iris/issues/7

## Why this matters

Two small, independent defensive fixes bundled because each is a few lines:

1. **Config secrets are world-readable.** `saveConfig()` writes
   `~/.iris/config.json` — which can contain `ai.apiKey` — with no `mode`
   argument, so it inherits the process umask (commonly `0o644`, readable by
   every user on the host). On shared/multi-user machines that exposes API keys.
2. **Resource handles leak.** `VisualTestRunner.run()` closes the browser in its
   `finally` but never closes the AI classifier, which owns SQLite handles
   (cache + cost-tracker) via `SmartAIVisionClient`. `AIVisualClassifier.close()`
   already exists and is simply never called. Separately, `watcher.ts` calls
   `db.close()` inside a `try` so a throwing `insertTestRun()` skips the close.
   Over long-running watch sessions these accumulate file descriptors.

## Current state

`src/config.ts:59-68` — no `mode` on the secrets file:

```ts
export function saveConfig(config: IrisConfig): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));   // <-- no { mode: 0o600 }
}
```

`src/visual/ai-classifier.ts:507-509` — the close method exists:

```ts
close(): void {
  this.smartClient.close();
}
```

`src/visual/visual-runner.ts:103` declares `private aiClassifier?: AIVisualClassifier;`
and `run()`'s `finally` (around lines 206-210) closes the browser but does NOT
call `this.aiClassifier?.close()`:

```ts
} finally {
  if (this.browser) {
    await this.browser.close();
  }
  // <-- aiClassifier never closed here
}
```

`src/watcher.ts:232-252` — `db.close()` is inside the try, before the catch, so
a throw in `insertTestRun()` skips it:

```ts
try {
  const dbPath = process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');
  const db = initializeDatabase(dbPath);
  // ...build instructionDetail...
  insertTestRun(db, { instruction: instructionDetail, status, startTime, endTime });
  db.close();                                  // <-- skipped if insertTestRun throws
} catch (dbError) {
  console.error('⚠️  Failed to persist watch execution to database:', dbError);
}
```

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Install   | `npm install`                                    | exit 0              |
| Typecheck | `npx tsc --noEmit`                               | exit 0, no output   |
| Config tests | `npx jest __tests__/config.test.ts`           | all pass            |
| Watcher tests| `npx jest __tests__/watcher.test.ts`          | all pass            |
| Runner tests | `npx jest __tests__/visual/visual-runner.test.ts` | all pass        |

## Scope

**In scope**:
- `src/config.ts` — add `{ mode: 0o600 }` to the write, `0o700` to the mkdir
- `src/visual/visual-runner.ts` — call `this.aiClassifier?.close()` in `finally`
- `src/watcher.ts` — move `db.close()` into a nested `finally`
- `__tests__/config.test.ts` — assert the file mode (POSIX only)

**Out of scope** (do NOT touch):
- `SmartAIVisionClient` / `AIVisualClassifier.close()` internals — they already
  work; only the call site is missing.
- The `as any` on the runner error result (that's noise from plan 002's area;
  not this plan).
- Any secrets-at-rest encryption / keyring integration — `0o600` is the agreed
  scope; a keyring is a possible follow-up, not part of this plan.

## Git workflow

- Branch: `improve/007-config-perms-and-resource-leaks`
- Commit style: `fix(config): write config.json with 0600 perms` and
  `fix(visual,watcher): close leaked db/classifier handles`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Restrict config file + directory permissions

In `saveConfig()`:

```ts
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
```

Note: `writeFileSync`'s `mode` only applies when the file is *created*; if the
file already exists with looser perms, also `fs.chmodSync(configPath, 0o600)`
after the write to tighten existing files.

**Verify**: `npx jest __tests__/config.test.ts` → all pass.

### Step 2: Close the AI classifier in the runner's finally

In `visual-runner.ts` `run()`'s `finally` block, after closing the browser, add:

```ts
if (this.aiClassifier) {
  this.aiClassifier.close();
}
```

`AIVisualClassifier.close()` already exists (`ai-classifier.ts:507`) and calls
`smartClient.close()`, which closes the cache and cost-tracker SQLite handles.

**Verify**: `npx jest __tests__/visual/visual-runner.test.ts` → all pass.

### Step 3: Make watcher db.close() unconditional

Restructure so `db.close()` always runs:

```ts
try {
  const dbPath = process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');
  const db = initializeDatabase(dbPath);
  try {
    // ...build instructionDetail...
    insertTestRun(db, { instruction: instructionDetail, status, startTime, endTime });
  } finally {
    db.close();
  }
} catch (dbError) {
  console.error('⚠️  Failed to persist watch execution to database:', dbError);
}
```

**Verify**: `npx jest __tests__/watcher.test.ts` → all pass.

### Step 4: Add a config-permission test

In `__tests__/config.test.ts`, add a test (guarded to POSIX — skip on Windows
where mode bits differ) that calls `saveConfig`, then `fs.statSync(path).mode &
0o777` equals `0o600`. Model on the existing config tests in that file.

**Verify**: `npx jest __tests__/config.test.ts` → all pass, including the new
test.

## Test plan

- New: config-file-mode test in `__tests__/config.test.ts` (POSIX-guarded).
- Existing watcher and runner tests must continue to pass (regression guard for
  the close-handle changes).
- Verification: `npx jest __tests__/config.test.ts __tests__/watcher.test.ts __tests__/visual/visual-runner.test.ts`
  → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `grep -n "mode: 0o600" src/config.ts` returns a match
- [ ] `grep -n "aiClassifier?.close\|aiClassifier.close" src/visual/visual-runner.ts` returns a match in the finally block
- [ ] `npx jest __tests__/config.test.ts __tests__/watcher.test.ts __tests__/visual/visual-runner.test.ts` → all pass
- [ ] New config-mode test exists and passes on POSIX
- [ ] Only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `__tests__/config.test.ts` mocks `fs` such that real file modes can't be
  asserted — report; the test may need a real tmp-dir write instead of the mock.
- Calling `aiClassifier.close()` in the runner finally breaks an existing test
  because that test reuses the classifier across runs — report the test; do not
  remove the close.
- `saveConfig` turns out to never be called anywhere in the codebase (keys only
  flow from env vars) — still apply the perms fix (defense in depth) but note the
  reduced real-world exposure in your report.

## Maintenance notes

- If a future change adds secret encryption or OS keyring storage, the `0o600`
  write remains correct as a baseline.
- A reviewer should confirm the watcher's `db.close()` now runs on the
  `insertTestRun`-throws path, and that the runner closes the classifier exactly
  once (no double-close).
