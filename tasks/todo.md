# Issue #293 — [P1.14] Agent loop error surfacing

Plan self-authored (no plan on the issue). No architectural fork; approved autonomously.

## Steps
1. `AITranslationResponse.error?: string` (src/ai-client/base.ts). The three text clients'
   catch blocks set it (provider unreachable, HTTP error, unreadable reply). A schema-invalid
   but parsed reply stays an empty plan without `error` (the model answered).
2. `runAgentLoop`: a plan with `error` ends the run `terminationReason: 'error'` at once,
   instead of counting as an empty plan (`no_actions`).
3. One helper `withPageTimeout(promise, ms, fallback)` (src/page-timeout.ts) bounding page calls
   that have no Playwright timeout of their own (`page.title()`, `page.evaluate()`):
   - agent loop `safeTitle`, `ariaSnapshot({ timeout })`
   - capture `generateMetadata` / `generateErrorMetadata` (title, viewport), `waitForFunction` timeout
   - visual-runner fonts wait (best-effort, like hosted-job's)
   - executor `getPageContext` reuses the helper
4. Tests: a real Ollama-shaped HTTP server that fails -> loop `error`; real Chromium page that
   busy-loops its main thread -> observePage and capture return within the bound.

## Acceptance criteria
- [ ] Provider errors propagate as `error` status
- [ ] All page-evaluated calls bounded by a timeout
- [ ] Tests with a failing provider and a never-resolving page
