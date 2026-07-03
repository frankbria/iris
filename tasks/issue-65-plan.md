# Issue #65 — [P1.3] Path-traversal gap in BaselineManager branch handling + false-coverage traversal test

**Plan source:** self-authored (issue had acceptance criteria but no plan comment). No architectural fork — proceeding autonomously per phase-04.

## Confirmed defects

1. `src/visual/baseline.ts:296-306` — `generateBaselinePath`/`generateMetadataPath` join raw `branch` into paths used by save/load/info/delete. `listBaselines` (l.188) and `cleanupOldBaselines` (l.210) also join raw branch. A caller-supplied `../../../../etc` branch escapes `baselineDir` on write/read/unlink. Existing `sanitizeReference` (l.286) is only applied on the `resolveReference` path.
2. `src/visual/storage.ts:448` — `isValidImagePath` uses `normalized.startsWith(this.baseDir)` without a trailing separator: sibling dir `/base-evil` passes for baseDir `/base`.
3. `__tests__/visual/storage.test.ts:473` — traversal test uses a nonexistent path, so `loadImage` returns `null` at the existence check (`storage.ts:191`); the guard at l.196 is never executed. Test passes even with the guard deleted.

## Steps (TDD)

1. **RED — tests**
   - `__tests__/visual/baseline.test.ts`: malicious branch (`../../../../etc`) on `saveBaseline`/`loadBaseline`/`deleteBaseline` — assert nothing is written/read/deleted outside `baselineDir` (plant a sentinel file outside and verify it survives; assert saved path is inside `path.resolve(baselineDir) + path.sep`).
   - `__tests__/visual/storage.test.ts`: rewrite the traversal test — create a **real** `.png` outside baseDir and assert `loadImage` **throws** `Invalid image path`; add a sibling-prefix case (`${baseDir}-evil/x.png` exists → throws).
2. **GREEN — fixes**
   - `baseline.ts`: route all branch-dir construction through one private helper that applies `sanitizeReference(branch)` and verifies the resolved dir stays within `path.resolve(baselineDir) + path.sep` (throw on violation — defense in depth). Use it in `generateBaselinePath`, `generateMetadataPath`, `listBaselines`, `cleanupOldBaselines`.
   - `storage.ts:448`: compare against `this.baseDir + path.sep` (baseDir is already `path.resolve`d in the constructor).
3. **Verify**: `npm run verify` (typecheck + lint + test), prettier --write before push (CI blocks on format).

## Acceptance criteria (from issue)

- [ ] `branch` sanitized like `testName`
- [ ] Resolved paths verified within `path.resolve(baseDir)+path.sep` for all read/write/delete
- [ ] Traversal test reaches the guard with an existing out-of-base file and asserts the real contract (throw)

## Known limitation / deviation

- Sanitizing branch means legit slashy branches (`feature/foo`) now map to `feature-foo/` instead of nested dirs — same convention StorageManager and `resolveReference` already use. Pre-existing nested-dir baselines are orphaned (loadBaseline falls back to `main`). Accepted: the acceptance criteria explicitly require sanitization.
