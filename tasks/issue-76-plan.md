# Issue #76 — [P2.5] CI hardening + supply-chain

**Plan source:** self-authored (no plan comment on issue). No architectural fork — proceeding autonomously.

## Key decisions (autonomous)

- **image-ssim: vendor, not replace.** Issue allows either. Vendoring the single MIT-licensed TS source file into `src/vendor/image-ssim.ts` keeps diff behavior byte-identical and removes the abandoned (2015) dependency. Rewriting SSIM would be new risk for zero benefit.
- **"Schedule sharp/playwright upgrades"** = bump both now + Dependabot for ongoing scheduling. sharp `^0.33.0 → ^0.35.3`, playwright `^1.35.0 → ^1.61.1` (both latest stable).
- **Dependabot over Renovate** — native to GitHub, zero extra service.

## Steps

1. **Example workflow fixes** — `examples/ci-cd-integration/.github/workflows/iris-tests.yml`
   - `actions/checkout@v3 → v4`, `actions/setup-node@v3 → v4`, `actions/upload-artifact@v3 → v4`, `actions/github-script@v6 → v7`
   - Node `18 → 20` (matches `engines >=20`)
   - Top-level `permissions: contents: read`; job overrides: visual-regression + accessibility get `pull-requests: write` (PR comments); update-baselines gets `contents: write` (pushes baselines)
2. **Main CI permissions** — `.github/workflows/ci.yml`: add `permissions: contents: read`
3. **Dependabot** — new `.github/dependabot.yml`: weekly `npm` + `github-actions` ecosystems
4. **Dependency bumps** — `package.json`: sharp `^0.35.3`, playwright `^1.61.1`; `npm install`; full test run (sharp is native — preprocessor tests must pass)
5. **Vendor image-ssim** — copy `node_modules/image-ssim/index.ts` → `src/vendor/image-ssim.ts` (retain MIT header); update `src/visual/diff.ts` to import it (drops the dynamic-require + eslint-disable); update `__tests__/visual/diff.test.ts` mocks to the new path; remove `image-ssim` from `package.json`

## Acceptance criteria (from issue)

- [ ] Example actions bumped to v4/v7 and Node 20
- [ ] Least-privilege `permissions:` on both workflows
- [ ] sharp/playwright upgrades scheduled (bumped now + Dependabot)
- [ ] image-ssim vendored or replaced
- [ ] Dependabot/Renovate added

## Test strategy

- Steps 1–3 are YAML: validate with `actionlint` if available, else YAML parse + manual review; demo shows the diffs against each criterion.
- Step 4: existing preprocessor/vision tests exercise sharp; existing browser tests exercise playwright. `npm run verify` must stay green (699/700 baseline).
- Step 5: existing `__tests__/visual/diff.test.ts` SSIM tests re-pointed at the vendor module prove identical behavior.
