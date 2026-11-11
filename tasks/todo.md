# #541 [P2.31] Audit log: a read surface for org admins, and a retention period

## Plan (self-authored)

Where the issue stands (main at 568dc6b):

- Criterion 1 (owners and admins read their org's entries, newest first, paged; members
  refused) and criterion 2 (`redactStrings()` over what is read) shipped in PR #577
  (`src/audit-reads.ts`, portal `/audit`, `apps/portal/e2e/audit.spec.ts`).
- Criterion 3 was waiting on the owner. Decision on the issue, 2026-11-08: **90 days**.
  Nothing enforces it yet, and `docs/data-flows.md` still says "undecided".

So this PR is criterion 3.

## Decisions

- **An API key's creation entry is kept while the key exists.** `api_key.create` is the
  only record of who made a key (#340 stores no creator), and #408 and #457 read it to
  revoke a member's keys when they are removed, leave or are banned. Deleting it at 90 days
  would leave every key older than that live after its creator is gone. The entry goes on
  the first pass after the key is revoked (once it is past 90 days). Everything else goes
  at 90 days.
- The period is a constant (`AUDIT_RETENTION_DAYS`), like `RUN_RETENTION_DAYS`: an owner
  decision, not operator configuration.
- No migration: one delete a day by `created_at`, a sequential scan of a table that now
  holds at most about 90 days.
- The privacy policy (`apps/portal/content/legal/privacy.md`) is not edited: it does not
  mention the audit log today, and its wording is the owner's.

## Steps

1. `__tests__/db/offboarding.test.ts`: entries older than 90 days go, newer stay, another
   org's too; a live key's creation entry stays and still revokes the key when its creator
   leaves, then goes; the report counts them; a failing step does not stop the others.
2. `src/audit-log.ts`: `AUDIT_RETENTION_DAYS = 90`. `src/offboarding.ts`: an `audit` step in
   `runRetention`, `auditEntriesDeleted` in the report. `src/cli.ts`: the command's
   description.
3. `__tests__/admin-cli.test.ts`: `iris admin retention` prints `auditEntriesDeleted`.
4. Portal `/audit`: say that entries are kept 90 days.
5. Docs: `docs/data-flows.md`, `.claude/rules/hosted-data.md`, the runbook's retention
   section, `plans/README.md` (P2.31 done; rows for #651 and #652), `tasks/lessons.md`.

## Acceptance criteria

- [x] Owners and admins see their org's entries, newest first, paged; members refused (#577).
- [x] Redaction pass as for runs (#577).
- [ ] Retention period decided by the owner (90 days) and enforced by `iris admin
      retention`; `docs/data-flows.md` updated.
