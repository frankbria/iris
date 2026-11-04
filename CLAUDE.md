# CLAUDE.md

IRIS (Interface Recognition & Interaction Suite): an AI-powered UI understanding and testing
toolkit that gives AI coding assistants "eyes and hands" through natural-language commands.

## Commands

```bash
npm run build          # cleans dist/ first
npm run test
npm run typecheck      # tsc --noEmit
npm run lint           # eslint flat config
npm run format:check   # blocks CI: run prettier --write first
npm run verify         # typecheck + lint + test
npm start [run "<instruction>" | watch [target] | connect]   # ts-node CLI

# Portal workspace (apps/portal), from the repo root
npm run dev|test|lint|build -w @iris/portal
```

## Where the knowledge lives

- File tree: `.claude/.codebase-info/structure.md`.
- Design notes and gotchas, by area, in `.claude/rules/` (loaded automatically when you touch
  matching paths; read the file directly when working nearby):
  - `ai-and-visual.md`: AI clients, cost tracker and budgets, models and pricing, vision,
    visual diff, a11y runner, config layering, data dir, local SQLite
  - `browser-safety.md`: URL policy and guard, egress proxy, agent policy, executor
    (retries, assertions, credential references), translator, `iris run` exit codes, hung
    pages, report encoding
  - `rpc-server.md`: `iris connect` RPC (JSON-RPC, limits, auth, tenant limits, `observe`,
    shutdown, error policy), observability, browser session lifecycle
  - `hosted-data.md`: Postgres and migrations, jobs/worker, results API, artifact store and
    quota, usage ledger, plans, managed AI credits, audit log, offboarding, run history
  - `auth-and-orgs.md`: workspaces, BetterAuth accounts, terms, orgs, API keys, BYOK,
    suspensions and bans
  - `portal-pages.md`, `deploy-ops.md` (ingress, container, npm package), `testing.md`
    (hermeticity, `jest.setup.ts`)
- Data stores, retention, transmissions: `docs/data-flows.md`. Ops: `docs/runbook-production.md`.
- Project assessments ("assess the current state"): use the `project-assessment` skill.

## A red suite may be the machine (#142)

Browser-driving suites miss deadlines under CPU load and fail like logic bugs (a different
test each run, often in untouched code; `--coverage` makes it worse). Re-run the failing
suite alone on a quiet machine before calling it a regression. Never "fix" it by raising
timeouts or cutting Jest concurrency: both were measured and only hide the signal. A
negative elapsed time is the WSL2 clock stepping back (#190), so never assert on a
`Date.now()` delta.

## Quality standards

- Coverage >=85% for new code (repo ~93% statements / ~82% branch); 100% pass of
  non-skipped tests.
- Conventional commits with scope (`feat(cli):`); branches `feature/…`, `fix/…`, `docs/…`;
  PR to main, CI green before done.
- Docs in the same PR: the matching `.claude/rules/*.md` file (new patterns and gotchas;
  add a file with `paths:` front matter for a new area), `docs/data-flows.md`, README
  examples, JSDoc on public APIs. See `AGENT_INSTRUCTIONS.md`.

## Issues

GitHub issues via `gh`; `plans/README.md` is the canonical "what's next" (it wins over other
planning docs). Every issue title starts `[PX.Y]` with the matching `priority-pX` label:
P0 launch blocker, P1 pre-launch hardening, P2 post-launch fast-follow, P3 polish. `Y`
orders within the tier by importance and dependency (blockers first; renumber neighbours
if needed). Read the issue's acceptance criteria before coding; close via `closes #N` and
update `plans/README.md`.
