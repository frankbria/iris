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

## 2026-07-03 — mutation checks need golden values, not just invariants (PR #95)
Identical-image / invariant-style tests (ssim=1 for equal inputs) survive
coefficient mutations — any weighting maps equal inputs to equal outputs. When
vendoring numeric code, pin a golden output for a fixed asymmetric input and
verify it against the upstream package before trusting it.

## 2026-07-03 — run prettier --write in the same step as writing any new file
Committed a new test file before format:check again despite the existing
memory; the fix cost an extra commit + CI cycle. Format immediately after
Write/Edit, not as a pre-push afterthought.

## 2026-09-25 — scrubbing leaked values: don't re-leak them while fixing (PR #366)
- A guard test against leaked values must report `file:line` only. `expect(matches).toEqual([])`
  prints the matched value, and CI logs are public — a failing run republishes it.
- The raw branch diff's `-` lines contain the values being removed. Redact before handing the
  diff to an external reviewer, and post only the verdict (not the transcript) to the PR.
- Never put the leaked specifics in commit messages, PR bodies or demo docs; describe by category.

## 2026-09-25 — tests that must fail fast, and a self-inflicted pkill (PR #367)
- A test that times out abandons its body: a `try/finally` teardown never runs, the open
  server keeps Jest alive, and a regression HANGS CI instead of failing. Put servers/sockets
  in `beforeEach`/`afterEach` for any test whose failure mode is "no reply".
- `pkill -f "<pattern>"` inside a compound command matched that command's own shell and
  killed it — including the `cp` that restored a mutated source file. Kill by PID, or
  restore in a separate step.
- Jest modern fake timers fake `process.nextTick` and `setImmediate` too; to emit an event
  from a fake under fake timers, use a native `Promise.resolve().then(...)`.
- An in-process test cannot see a process crash (Jest absorbs unhandled rejections). For
  "the server must survive X", spawn the real entry point.

## 2026-09-25 — sandboxed Chromium and a swept-in file (PR #369)
- `git commit -a` swept the user's uncommitted `tasks/lessons.md` into a feature commit.
  When the tree starts dirty, stage explicit paths; check `git show --stat HEAD` after.
- Sandboxed Chromium needs unprivileged user namespaces. Blocked by Docker's default
  seccomp AND by ubuntu-24.04 AppArmor (GitHub runners): prove the target environment
  launches before assuming "works locally" means "works in CI / the container".
- Chromium rewrites its argv; `/proc/<pid>/cmdline` of the direct child is the reliable
  way to see launch flags (CDP getBrowserCommandLine needs --enable-automation).

## 2026-09-25 — wait loops, masked exit codes, and cap_drop vs seccomp (PR #370)
- `until ! pgrep -f "codex review"` never ended: `pgrep -f` matched the wait loop's own
  command line. Wait on a PID or an output marker (`grep -q "exit" <file>`), not a pgrep pattern.
- `cmd | head -1; echo $?` reports head's status. In demo evidence capture `rc=$?` before any pipe.
- `cap_drop: ALL` also removes the caps Docker's seccomp profile keys rules on
  (`CAP_SYS_CHROOT` -> `chroot`), so a profile that only unblocks user namespaces still fails
  at the sandbox's chroot. Read the actual Chromium error (`sys_chroot(...) == 0`) before
  guessing which syscall is missing.
- Compose hashes a file secret's mount spec, not its content: rotating it needs
  `--force-recreate` (bot review caught this).

## 2026-09-25 — range tables vs the hygiene guard, and push batching (PR #371)
- Tests for network ranges collide with the #329 repo-hygiene IPv4 guard (CGNAT is tailnet
  space). Use range *edges* in tests and allowlist those exact values — never widen the guard
  to a whole range.
- The CLAUDE.md test count went stale twice in one PR. Update it in the last commit before merge.
- Every push cancels the in-flight CI GLM review and leaves a "did not complete" comment.
  Batch fix commits into one push where possible.

## 2026-09-26 — hosted URL policy (PR #372)
- `cmd 2>&1 > file` sends stderr to the terminal and only stdout to the file. Jest writes its
  summary to stderr, so the log had coverage but no pass/fail counts. Use `> file 2>&1`.
- Only run `prettier --write` on files inside the `format:check` globs. `jest.setup.ts` is
  outside them and not prettier-clean, so one list entry turned into a 63-line reformat.
- A "touch the file until it reacts" loop that writes faster than the watcher's debounce keeps
  resetting the timer and never fires. Wait for ready, then write at intervals above the debounce.
- Playwright's `routeWebSocket` hooks new documents. `page.setContent()` makes none, so a socket
  opened after it is not routed. Navigate first, then exercise the route.
- A per-caller guard misses callers. Before calling a policy "enforced everywhere", grep for raw
  `page.goto`/`navigate(` and for every channel the interception layer cannot see (file://, WS).
  The internal review caught `watch`, and the CI GLM caught unpinned WebSockets.
- `gh pr edit --body-file` fails on the Projects-classic deprecation error. Use
  `gh api -X PATCH repos/<o>/<r>/pulls/<n> -F body=@file` instead.

## 2026-09-26 — runner URL policy (PR #373)
- A real-browser test that fails only under `jest --coverage` is invisible to CI, which runs
  without coverage. Before calling such a failure a regression, reproduce it on main in a
  worktree. Here it was the pre-existing `cov_* is not defined` in `page.evaluate`.
- Fixing one instance of a pattern is not fixing the pattern. The CI bot found a third
  instrumented callback (`waitForFunction`) in the same file. Grep for every sibling call
  (`evaluate(`, `waitForFunction(`, `$eval(`) before writing "fixed" in a commit or doc.
- ts-node run from a cwd outside the repo fails with TS diagnostic 5109 (no tsconfig). For
  CLI demos in a temp cwd, `npm run build` and run `dist/cli.js`.
- `pkill -f <pattern>` inside a compound Bash command can match the command's own shell and
  kill it (exit 144). Stop background demo servers by port or PID instead.

## 2026-09-26 — hosted egress proxy (PR #374)
- A paused socket never sees its peer's FIN. A raw test server that never reads its socket
  never emits 'end'/'close', so a "was it closed?" assertion reads open no matter what the code
  does. `socket.resume()` in test servers. The same fact made a proposed CONNECT guard
  (`if (client.destroyed) return` after an await) dead code: the handed-over socket is paused.
- `execFileSync` in a process that also hosts the server under test deadlocks: the child
  waits on a server whose event loop the sync spawn is blocking. Spawn async in demos.
- Chromium's Local Network Access blocks a public page's requests to loopback by itself. A
  negative control that loads a public page shows "0 hits" with no IRIS layer at all; load the
  control page from loopback, and mutate the layer under test to prove it is the one refusing.
- A reviewer's crash claim ("no 'error' listener → uncaught") needs an out-of-process repro:
  Node 24 drops an IncomingMessage 'error' nobody listens to. Jest can't tell either way.
- opencode/GLM stalled again (180s, no stream bytes); codex fallback answered.

## 2026-09-26 — URL guard follow-ups (PR #377)
- Before running a real-browser suite, look for orphaned test processes from earlier
  sessions (`ps -eo pid,ppid,lstart,args | grep jest`; parent = init). One had been stuck for
  73 minutes, adding exactly the host load #142 warns about, and a stale 0-byte
  `.git/index.lock` sat beside it.
- Playwright continues redirect hops inside its own Fetch handler, so no `route` ever sees
  them. When a page-scoped hook is structurally too late, a browser-level CDP session
  (`browser.newBrowserCDPSession()`) can `Fetch.enable` for all targets. `targetCreated.openerId`
  arrives before the target's first request. codex claimed browser-level Fetch is rejected;
  a 20-line experiment settled it before any rebuttal.
- "Passes 3/3" is not the same as "structurally guaranteed". Two reviewers flagged a timing
  window the test could not force. Disabling the layer that usually wins, then checking the
  other layer still holds, turned it into evidence instead of luck.
- This repo's Jest reporter prints no per-test lines, even with `--verbose`. For a demo's
  per-test listing use `--json | jq '.testResults[].assertionResults[]'`.
- The codex path was already in memory (nvm v24.12.0) and I still guessed another
  version first. Read the memory note before invoking the fallback.


## 2026-09-26 — RPC server limits (PR #380)
- Run mutation checks *after* a cross-family reviewer finishes, or in a worktree. opencode reads
  the live working tree, saw the scripted mutations mid-review, and spent effort flagging
  "uncommitted edits that must not ship".
- An unquoted heredoc (`<<EOF`) around a Python edit makes bash run every backtick in the
  replacement text. A PR-body edit silently lost a `` `file.ts` `` span that way. Quote the
  delimiter (`<<'EOF'`) and pass shell values through the environment.
- `gh issue comment` has no `--jq`. With `2>/dev/null` the usage error vanished, and the comment
  looked posted when it was not. Never silence stderr on a write to GitHub; read back the URL.
- A string-anchored edit applied after prettier can match twice: two tests ending in the same
  three lines. Anchor on something unique to the target test, and assert the count.
- A RED run for a "browser leaked after close" bug hangs Jest: the orphaned Chromium keeps the
  worker alive. Run such REDs with `timeout ... --forceExit`, then check for stray `chrome`
  processes by PID.
- Moving auth into `verifyClient` turns a refusal from a 1008 close into an HTTP status. Every
  consumer of the old signal (tests, healthcheck comment, README) had to move with it; grep for
  the close code before changing the refusal path.

## 2026-09-27 — Browser session lifecycle (PR #381)
- One test's orphaned Chromium contaminates the next: a "kill the browser" test picked the
  leaked pid from the previous test and passed on unfixed code. Read a RED run per test (`-t`),
  not only as a whole file, before trusting which tests are red.
- Chromium `close()` took 1.4-1.9s bare and up to 9s end to end on a loaded WSL host. Waits
  for a process to exit need a long poll budget. An orphan never exits, so the budget costs
  no signal. Don't read slow exits as a leak.
- Playwright fires `disconnected` ~100ms after a SIGKILLed browser has left /proc. A test that
  waits on the pid alone races it; wait on something the server reports (`hasPage`).
- Ad hoc `ts-node` probes fail with TS5109 unless given `-P tsconfig.json` and run from the
  repo root, not the scratchpad.
- Wait for the machine to quiet down (`/proc/loadavg`) before a full run. At load 13-16 the
  a11y/visual E2E suites failed 26 tests that pass at load <6. Cheaper than triaging them.

## 2026-09-27 — Data dir and budgets (PR #384)
- `pkill -f "<pattern>"` matches the shell running it when the pattern appears in that
  same command line. The call died with exit 144 and none of the edits after it ran. Stop
  background jobs with TaskStop, or `pgrep` then kill by pid in a separate call.
- `prettier --write` on a file outside `format:check`'s scope (jest.setup.ts) reformatted
  ~60 unrelated lines, and the reviewer flagged the noise. Only run `--write` on files
  inside the CI format scope; hand-format the rest.
- Under Jest, `process.env.HOME = …` does not move `os.homedir()`: the test env's
  process.env is a copy the native call never reads. Spy on `os.homedir` instead.
- A `jest.mock('../src/config', () => ({ loadConfig: … }))` that replaces the whole
  module breaks the moment the code under test imports a new export. Seven watcher tests
  failed with "resolveBudget is not a function". Spread `jest.requireActual` under stubs.
- A setup file's `afterAll` runs BEFORE the test file's own `afterAll` (registration
  order), so cleanup there can pull a directory out from under a test still writing to it.
  Clean up at the start of the next file instead.
- Any new env or config input needs its hermetic guard in the same PR. Budgets made the
  real ~/.iris/config.json reach the suite; the post-PR reviewer caught it, not me.
- Building the image locally (~5 min) gave the one piece of evidence nothing else could:
  the read-only root filesystem refusing /app/.iris while /data took all three stores.
- PR #385: mutation testing by `git checkout -- <file>` to revert also reverts any
  UNCOMMITTED fix in that file. It silently wiped the warn-once fix. Commit before
  mutating, or revert the mutation with the inverse edit.
- PR #385: opencode's streamed output puts its final heading mid-line ("…checking:# Review"),
  so `sed -n '/^# Review/,$p'` matched nothing and the PR got an empty review comment.
  Slice from the heading text with no `^` anchor, and grep the comment for a finding
  before posting it.
- PR #385: the CI reviewer's "pre-existing, not a regression" note (0/0 = NaN let the
  first paid call through a $0 budget) was a real bug behind a README promise. A
  reviewer's out-of-scope aside is still worth checking against the docs.
- PR #387: `git checkout -q <tracked> <untracked>` fails as a WHOLE when one path is
  untracked (the demo script lives in ignored tasks/). The tracked file I had swapped
  for main's version stayed swapped and nearly got committed. Restore each file on its
  own and run `git status --short` right after.
- PR #387: a surviving mutant was a finding, not a weak test. Breaking the `-` boundary
  changed nothing because the snapshot regex already anchored `-`, and that exposed the
  whole "longest prefix" comparison as dead code. Ask why a mutant survives before
  adding a test to kill it.
- PR #387: "any `-suffix` inherits the family price" read as the natural answer to "fall back
  by family" and was wrong in the unsafe direction (variants cost more). For a budget
  gate, check every fallback against which way it errs.
- PR #389: `import … from '../src/ai-client'` resolves to the deprecated `src/ai-client.ts`
  re-export file, not `src/ai-client/index.ts`. A new export added only to the index reads
  as "no exported member" in tests. Import new symbols from their own module.
- PR #389: the cross-family reviewer's Major rested on wrong token math (OpenAI high detail
  without the 768px downscale). Verifying before fixing split it: the vision half was
  rebutted, while the text half was real (an uncapped instruction) and got fixed.
- PR #389: fault injection that closes a SQLite handle breaks the reads that run before the
  step under test. To fail only writes, use a trigger:
  `CREATE TRIGGER … BEFORE INSERT … SELECT RAISE(FAIL, 'database or disk is full')`.
- PR #391: my "report why a provider was skipped" change assigned `lastError` on the
  unavailable path, so with fallback on, a later vendor's "not available" overwrote the
  configured provider's real 401. The CI bot caught it. In a fallback loop, a note that
  something was skipped must never replace a real error (`??=`, not `=`).
- PR #391: the first demo run served scenarios B-D from the vision cache that scenario A
  filled, so each vendor showed 0 requests. When a demo counts vendor hits through the
  smart client, give every scenario its own images, or the cache answers instead.
- PR #391: in a loaded full run the MCP suite failed on `npx tsc` ("Cannot find module
  '../../package.json'" inside npm itself). It passed 7/7 alone. Treat it as the host,
  like #142, and not as the diff.

## #339 / PR #393 (2026-09-28)
- A private-backlog issue ("see tasks/security-backlog.md") can't be verified from the repo. Ask first, then audit and put the audit list in the PR body for the maintainer to check against the backlog.
- A red local run on an IO-bound WSL host (iowait 25-48%, load ~8 on 4 cores) timed out 45 browser tests the diff never touched. An A/B against a `main` worktree on the same subset settled it in minutes (main: 4/86 failed too). Do the A/B instead of arguing from the pattern.
- Structure equivalence (benign vs hostile render parse to the same skeleton) catches injections that substring tests miss. Reviewers still found a hole in it: Markdown block syntax after a list marker. Test the encoder in every template context it lands in, not only in isolation.

## #247 / PR #394 (2026-09-28)
- The global Nova setup command is stale: the shadcn preset API rejects `baseColor=gray`/`theme=gray` (400; valid: neutral, stone, zinc, mauve, olive, mist, taupe…). The registry still serves `/r/colors/gray.json`. Scaffold with `neutral`, then apply its `cssVarsV4` tokens. Probe the preset URL with curl before running `shadcn create`: the CLI only reports "400".
- The scaffold's own ESLint 10 crashes `eslint-config-next` (eslint-plugin-react peer ≤ ^9.7). Lint the pristine scaffold before blaming the workspace; pin ESLint 9 in the app.
- Proving `require(esm)` needs a real Node process plus a control run (`--no-experimental-require-module` → ERR_REQUIRE_ESM). Jest's sandbox can't load ESM at all, so an in-process test proves nothing.
- Built CSS reports `lab()`, not the `oklch()` in the source. Read chroma from the a/b axes when demoing theme tokens.
- opencode stalled (outage signature) on both attempts; the codex fallback worked unchanged. The CI GLM bug-hunt still gave a GLM-family pass on the PR.
- Scaffold code is code: the Nova theme-provider shipped a bare-key WCAG 2.1.4 violation. Review vendored scaffolds like our own diff.

## #248 / PR #402 (2026-09-29)
- Kysely 0.29 moved `Migrator` to `kysely/migration`; the root export is a `KyselyTypeError` stub. Under `node10` resolution the subpath needs a types-only tsconfig `paths` entry; Node resolves it at runtime via `exports`.
- `pg` has no connect timeout: a host that accepts and never answers hangs forever (WSL blackholes 127.0.0.1:1, #382). The demo found it, not the tests. Test timeouts with a silent `net.createServer`, which blackholes on every host.
- `pkill -f "<pattern>"` inside a Bash tool call matches the tool's own shell command line and kills it (exit 144). Use `pgrep -af` to inspect, and kill by PID.
- A local deploy rehearsal is cheap and worth it: extract the remote script from ci.yml verbatim, run the root parts in an alpine container (no sudo), and run the compose sequence against a locally built image. It caught the "every deploy recreates Postgres" issue in the order it would happen.
- `jest -t` skips the setup tests a later test depends on (here: migrate before the catalog check), so a mutation "caught" under `-t` can fail for the wrong reason. Run the whole file and read which test failed.
- opencode stalled again (3rd run in a row); codex fallback + the CI GLM workflow covered it.

## #249 / PR #403 (2026-09-29)
- Repeated the #248 `pkill -f` self-kill. The lesson was on disk but uncommitted, so nothing surfaced it. Commit lessons at merge time, not "later".
- `cmd > log; tail log` in a background task reports tail's exit code. The "exit 0" notice hid a failing test. Read the `Tests:` line, never the exit status.
- A Python regex edit over Prettier-wrapped JSX removed half a two-line `if` and left an unconditional `return`. tsc, ESLint and `next build` all passed; only the E2E caught it. After a scripted edit, re-read the function, or edit with exact multi-line matches.
- A cross-family reviewer given a pasted diff while commits keep landing reviews a stale diff, and a concurrent `next build` gives it stale results. Freeze the branch while a review runs, or accept that it reviews HEAD.
- Playwright restarts the worker after a failed test, which resets module-level state (an IP counter). Each test's isolation key must be random or derived from test info.
- An E2E "flake" that passed alone was a real race: /login and /forgot-password both have an "Email" field, and the test filled the old one mid-navigation. Wait for the URL after a client-side link click.
- Demo evidence must be checked before it is written. A note claimed session revocation before any query had run, and `$RANDOM` made invalid IP octets. Run the query, then write the claim.

## #250 / PR #407 (2026-10-01)
- Two new advisories landed mid-PR (brace-expansion high, then a Next critical) and failed CI's `npm audit` gate on code the diff never touched. Run `npm audit --omit=dev --audit-level=high` locally before each push; fix it in the PR, since the gate blocks every branch.
- For a security bump, take the oldest patched release, not the newest: the Next advisory range ended at 16.3.5, so 16.3.6 (8 days old) beat 16.3.8 (12 hours old). `npm dedupe` "fixed" a stray vulnerable peer copy by rewriting 4,000 lockfile lines; a root `overrides` pin changed only Next's tree.
- An authorization test must assert the refusal's code, not "not ok". The first E2E draft for "member cannot invite" would have passed on BetterAuth's CSRF Origin refusal. A non-member invite is 400 `MEMBER_NOT_FOUND`, not 403.
- A cross-family reviewer re-run after each fix round paid off: passes 2 and 3 found a P1 (the invite form followed the session's active org, not the rendered one) and two P2s that pass 1 and the internal review missed.
- BetterAuth's client follows `signIn`'s `callbackURL` itself, so a `router.push(next)` after it never mattered. Read what the client does before layering navigation on top.
- A session restart wiped the scratchpad, including the saved PR body. GitHub is the durable copy: `gh pr view --json body` before editing.
- opencode stalled for the 4th run in a row; codex plus the CI GLM workflow covered review.

## #340 / PR #411 (2026-10-02)
- Again a private-backlog issue. Asking first worked: the maintainer chose "derive from the ADR", and the PR body listed the derived criteria for checking against the backlog.
- Read a plugin's permission model before writing a role test. BetterAuth's org roles have no `apiKey` statement, so org-owned keys were owner-only, and admins were refused, until the roles were extended.
- A plugin option that is copied onto each row at creation (the api-key limiter) cannot be fixed later by changing the config. Decide it before the first key exists, and tell the issue that owns it (#342) about the backfill.
- `npm install <pkg> -w <workspace>` resolved the newest release and nested a second `better-auth` under the workspace (231 lockfile lines). Pin the root's range by hand, then `npm install --prefer-dedupe`; the lockfile diff should be one line.
- A native `window.confirm` hangs the whole agent-browser session (even `get url` times out). In a demo, replace `window.confirm` with an eval before the click.
- Two full local E2E runs failed 4 and 6 specs, mostly in files the diff never touched; `vmstat` showed 24-29% iowait while otherwise idle. The changed spec run on its own, plus CI, settled it in minutes.
- opencode worked this time on both passes (about 15 minutes each). Each pass read the plugin source and ran the suites itself.
