# #648 [P3.36] Hosted MCP: report where a redirect landed, and axe's help URL for each violated rule

## Plan (self-authored; no plan on the issue)

The hosted MCP tool (`src/mcp/hosted.ts`) words its answer from the stored a11y page result
(`resultsOf` in `src/history-store.ts`). The stored `url` is the page as requested, so a scan
that was redirected reads as findings on the requested URL; and the stored rules have no
documentation link.

1. **Store where a redirect landed.** `resultsOf` adds `landedUrl` to an a11y page result
   when `scannedPage(page.page, page.axeResult.url)` says the scan was redirected: origin and
   path, long segments cut, at most 200 characters (the cut the stdio tool already uses).
   Absent when the scan stayed where it was asked, and for a page that could not be scanned.
   Tests: `__tests__/db/history-store.test.ts`.
2. **Derive axe's help URL, store nothing.** `axeRuleHelpUrl(ruleId)` builds
   `https://dequeuniversity.com/rules/axe/<major.minor>/<rule>?application=axeAPI` from the
   installed axe-core's `package.json` (read without loading axe into the API process). A
   test holds it equal to `helpUrl` of every rule `axe.getRules()` lists, so an axe upgrade
   that changes the form goes red. Tests: `__tests__/mcp/axe-help-url.test.ts`.
3. **The hosted tool reports both.** `url` becomes the page that was scanned, `redirected`
   says whether that differs from the request, `redirectedFrom` carries the requested URL
   when it does; each violation gains `helpUrl`; the text names both. Tests:
   `__tests__/mcp/hosted-http.test.ts`, and a redirect case in the real-browser
   `__tests__/hosted-mcp-job.test.ts` (CI only on this host).
4. **Docs.** `docs/data-flows.md` (what is newly stored), `.claude/rules/rpc-server.md`,
   `docs/integration-surfaces.md` / README where the hosted tool's output is described,
   `plans/README.md` (P3.36 done; the P3.38 row for #660 that iteration 13 asked for).

## Acceptance criteria

- [ ] A hosted a11y result records the landing URL when it differs from the request, cut as
      `scannedPage()` does, and the MCP tool reports it with `redirected`.
- [ ] Each violated rule carries axe's help URL in the tool result (stored, or derived from
      the installed axe version).
- [ ] `docs/data-flows.md` says what is newly stored.

## Decisions taken (no architectural fork)

- **Help URL derived, not stored.** The issue allows either. axe runs inside the page under
  test, so the `helpUrl` it returns is text a hostile page can choose; a derived URL is built
  from the rule id alone, always points at Deque, and also covers runs stored since #647.
  The version in it is the one installed when the result is read, not when it was scanned.
- **`url` in the hosted result changes meaning on a redirect** (the scanned page, as the
  stdio tool reports it); `redirectedFrom` keeps the requested URL readable for a caller
  that only holds a job id.
- **A relative page pattern records no landing URL.** `iris a11y` with a `baseURL` stores the
  pattern (`/checkout`), and history does not know the base it was resolved against; hosted
  jobs always carry absolute URLs, which is what the issue is about.
- **axe's rule description is not added**: the context mentions it, the criteria do not, and
  it would have to be stored (page-chosen text) or loaded from axe in the API process.
