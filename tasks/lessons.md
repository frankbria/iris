# Lessons

## IRIS CI enforces prettier `format:check` as a blocking build step
CLAUDE.md calls `format:check` "non-blocking", but the GitHub Actions `build` job
runs `npm run format:check` and fails the build on any unformatted file. Run
`npx prettier --write` on all touched files (or `npm run format:check`) BEFORE
pushing — don't rely on the local `verify` script, which omits format:check.

## Never `git checkout <file>` to undo a mutation on UNCOMMITTED work
For a mutation-check (break prod → a test must fail), `git checkout src/foo.ts`
restores the last *commit*, silently wiping any uncommitted edits. Back up to a
scratch file and `cp` it back instead — and run the mutate→test→restore as a
single foreground command so a killed background job can't leave prod mutated.

## `showboat exec` requires a `<lang>` positional arg
Signature is `showboat exec <file> <lang> [code]` — omitting the lang makes it
try to fork/exec the command string as a literal binary path ("no such file or
directory"). Use `showboat exec demo.md bash 'node script.js'`. Demos that drive
compiled code should `npm run build` first and require the `dist/` path.

## Test fidelity: import real code, never an in-file stub (issue #62)
When a test file defines its own copy of the class under test, coverage is
illusory. Import the production class; mock only SDK/collaborator boundaries.
Prove fidelity with a mutation check (break prod → a test must fail).

## 2026-07-02 — showboat exec pitfalls
- `showboat exec` syntax is `exec <file> <lang> [code]` and does NOT run through a shell from the current dir — use `--workdir` for repo-relative commands and absolute paths elsewhere.
- When a command fails, change it before re-running: I re-sent an identical failing jest command 3 times. Diff the retry against the failure before executing.
