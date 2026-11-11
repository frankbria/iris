# #314 [P2.3] Hosted MCP over HTTP with tenant auth and metering

## Plan (self-authored; the issue had none)

**Shape.** `POST /v1/mcp` on the hosted `iris connect` listener: MCP Streamable HTTP, stateless (one JSON response per request, no session id, no SSE stream; `GET`/`DELETE` answer 405). It sits under `/v1/`, so the ingress already routes and rate-limits it.

**Auth and limits.** The job API's own path: `Authorization: Bearer iris_…`, suspension 403, the key and org request buckets (429), the pending-verification cap, the 64 KiB body cap, a request line in the log and the metrics (`POST /v1/mcp`).

**A tool call is a hosted a11y job.** `run_accessibility_test { url, wcagLevel? }` queues a one-page a11y job through the same store as `POST /v1/a11y/jobs`, so the worker scans it (hardened Chromium, egress proxy, deadline) and writes the run to history and one `a11y_job` usage row, in the transaction that already does so. Nothing new meters or stores. The per-org cap is `maxQueuedJobsPerOrg` and the plan's `runsPerMonth`; both refusals are tool errors that say so (this answers the first note from #362: the cap is per tenant).

**Waiting.** The call waits for the job up to a bound below the ingress's 75 s read timeout, then answers `status: running` with the job id; a second tool, `get_accessibility_test_result { jobId }`, reads it later (third note from #362). A client that goes away while its job is still queued gets the job canceled, so nothing runs or is billed for it (second note): a new `cancel` on the org's job store, queued jobs only.

**What a result says.** The stored a11y result holds counts per impact only. For the tool to name what failed, the stored page result gains `violationRules`: axe's rule id, impact and node count, at most 50 (axe's own vocabulary, no page text; no migration, the column is JSON). The REST job and run reads show it too. Failures go through the fixed vocabulary from #362 (`scanFailureReason`); a job's stored error text never reaches the model.

**Not in this change.** Visual-diff tools; keyboard-check detail (#646 is with the owner; the hosted job runs the keyboard checks as every hosted a11y job does, and the tool reports only whether they passed); SSE and sessions.

## Steps
1. `history-store`: `violationRules` in the stored a11y page result; `OrgJobs.cancel(id)`. Tests: `db/history-store`, `db/jobs` (real Postgres).
2. `src/mcp/hosted.ts`: the two tools over an org's job store, and the HTTP handler. `src/jobs-api.ts`: the auth-and-charge step shared with it. `src/protocol.ts`: route, label, wait bound in `ServerLimits`.
3. Tests: `__tests__/mcp/hosted-http.test.ts` (real sockets, the SDK's own HTTP client, in-memory job store: auth, limits, refusals, wait, cancel, org isolation) and `__tests__/hosted-mcp-job.test.ts` (real Postgres + Chromium + worker: tool call -> history row + usage row; runs in CI).
4. Docs: README, `.claude/rules/rpc-server.md`, `docs/data-flows.md`, `docs/integration-surfaces.md`, ADR 0001 §7, `plans/README.md`.

## Acceptance criteria
- [ ] Streamable HTTP transport behind the API-key auth
- [ ] Scans recorded in history and usage
