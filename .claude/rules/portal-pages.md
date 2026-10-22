---
paths:
  - "apps/portal/**"
  - "src/audit-reads.ts"
  - "src/run-reads.ts"
  - "docs/data-flows.md"
  - "docs/legal/**"
---

### Audit Log Page (issue #541)

`/audit` in the portal shows the org's `audit_log` (#361) to owners and admins (`isManager(role)`
in `lib/org.ts`, the one owner-or-admin check; members see "Only owners and admins…").
`src/audit-reads.ts` (`auditPage`) is lean, like `run-reads`: one org's entries, newest first,
paged by the identity id (`nextCursor`; a cursor it did not make is `InvalidAuditCursorError`,
shown as a link back), the actor's name and email by a left join (gone users show their id),
strings through `redactStrings`. Retention of the log is still the owner's decision (#541).

### Privacy, subprocessors and DPA (issue #277)

Drafts at `/privacy`, `/subprocessors` and `/dpa` (`apps/portal/content/legal/{privacy,
subprocessors,dpa}.md`), same renderer and draft banner as #276; owner/counsel approval is
#450. `docs/legal/dpa-template.md` is a copy of `dpa.md` (a portal test keeps them equal).

- **`docs/data-flows.md` is the source of truth** for what is stored, where, for how long
  and what goes to which third party, each entry citing its code. A change that adds or
  alters a store, a personal-data field, a retention period or a transmission updates it in
  the same PR, and the privacy page / subprocessor table if customers can see the change.
  Undecided retention says "undecided (#349)"; never invent a period.
- **Their versions are `PUBLISHED_VERSIONS`** in `src/legal/versions.ts`, not
  `LEGAL_VERSIONS`: every key of the latter is one a user must accept (`acceptance.ts`
  iterates it), and these need no acceptance. `ACCEPTED_TERMS` is unchanged.
- The renderer also takes simple pipe tables (header, `|---|` row, cells through the same
  escaping `inline()`). `LegalFooter` (on legal pages and the `(auth)` layout) links all five
  documents; it is a `nav`, not a list, so the renderer's list tests are unaffected.

### Portal Runs Pages (issue #270)

`/runs` and `/runs/[id]` in `apps/portal`, reading the org's runs straight from Postgres
(ADR 0001: the portal never calls the public API). Visual diff images and approval are #463.

- **The portal imports `src/run-reads.ts`, not `src/history-store.ts`.** The read path
  (types, keyset cursor, `listPage`, `get`) lives in `run-reads` with no dependency beyond
  Kysely; `history-store` uses and re-exports it. Importing `history-store` pulled the
  a11y runner (Playwright) into the portal bundle and broke `next build` on
  `src/ai-client.ts`'s type re-exports.
- **The org comes from `requireOrg()` only**, so another org's run id is `notFound()`.
- **The list's `loading.tsx` lives in a `(list)` route group.** A `loading.tsx` at `/runs`
  also wraps `/runs/[id]`: the page streams, and `notFound()` then arrives after a 200.
  The group's `layout.tsx` runs `requireOrg()` above that boundary, so a signed-out or
  terms-pending visitor gets a real 307, not a 200 with a meta refresh. `requireOrg` is
  wrapped in React `cache()`, so the page reuses the layout's answer.
- **A failed job's detail shows its `error`** (`run-reads` `get()` selects it, the API too):
  a job that could not run has no summary and no results, only that reason.
- **The error page calls `retry()`** (Next 16: refresh, then reset). `reset()` alone re-renders
  the same failed result.
- **Filters and paging are links** (no client script); a bad or stale cursor shows a
  message with a link back to the newest page, not an error page.
- Run detail goes through `redactStrings()` (src/log.ts), the same pass as the API (#269).
- `lib/run-format.ts` turns a stored result into words per run kind; unit-tested.
- **Visual runs show their screenshots (#463)**: artifact keys are taken out of the results
  before redaction and signed (`visualImages()` in `lib/runs.ts`, the API's
  `signRunArtifacts`, only with `IRIS_S3_*` in the portal), then rendered as baseline /
  this run / differences with alt text naming page and device. A failed comparison gets an
  **Approve as new baseline** form only when `hasPermission({ visualBaseline: ['approve'] })`
  passes (owners and admins, a `createAuth()` role resource); the server action checks it
  again, refuses a suspended org, and calls `approveVisualResult()` from
  `src/visual-baselines.ts` (the lean module the API uses too: never `history-store`).
  Approval writes the baseline row and an `audit_log` row (`visual_baseline.approve`) in one
  transaction; `approved_by` is `user:<id>` from the portal, `key:<id>` from the API.
- Portal E2E has a SeaweedFS bucket of its own (`iris-portal-e2e`, made by global setup);
  `IRIS_TEST_S3_*` default to docker-compose.dev.yml's.
