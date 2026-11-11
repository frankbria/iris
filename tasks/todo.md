# #662 [P3.39] a11y: a client-side navigation is not reported as a redirect; portal run detail does not show landedUrl

## Plan (self-authored; no plan on the issue)

1. Tests first, real Chromium (CI only on this host): `url-policy-guard.test.ts` for the new
   `guardedDocumentUrl()` (script, meta refresh, `history.replaceState`; a script that moves
   on to the metadata host; a script that moves on to a dead host), `mcp/tools.test.ts`
   (stdio tool: `redirected: true` and the second page), `hosted-mcp-job.test.ts` (hosted
   tool and the stored `landedUrl`; a script that moves on to a name the egress proxy
   refuses), `runner-url-policy.test.ts` (the runner's own error text).
2. `guardedDocumentUrl(page, requested)` in `src/url-policy-guard.ts`: the URL of the
   document the page holds now, refused when that is Chromium's error page or a URL the
   page's policy refuses. `testPage` in `src/a11y/a11y-runner.ts` hands that to axe in
   place of the last HTTP response's URL.
3. Portal: `describeResult` (`apps/portal/lib/run-format.ts`) names the landing page beside
   the requested one; unit test and the run-detail E2E.
4. Docs: `.claude/rules/browser-safety.md`, `.claude/rules/rpc-server.md`,
   `docs/data-flows.md`, README, `plans/README.md` (P3.39 done, P3.41 row for #666).

## Decisions
- The URL is read once, just before axe runs, as the issue proposes. A page that navigates
  while axe runs fails the scan as before (the execution context is gone); nothing compares
  the URL again afterwards, because a single-page app may rewrite its URL at any time.
- A move that only changes the fragment (a hash router) is still not a redirect:
  `scannedPage()` compares without the fragment, and a landing URL is reported without one.
- A refused client-side navigation uses the words of a refused HTTP redirect ("redirects
  to …, which is blocked by navigation policy"), so the MCP tools' fixed vocabulary applies.
- `guardedGoto` keeps returning the response's URL: the executor, watcher and visual runner
  ignore it, and changing what it throws for them is outside this issue.

## Acceptance criteria
- [ ] The runner reports the document's URL at the time axe runs; a page that navigates
      client-side shows `redirected: true` and the second page's URL in the stdio tool, the
      hosted tool and the stored `landedUrl`.
- [ ] The URL policy still holds for the page that is scanned.
- [ ] The portal's run detail shows where a redirected page landed.
