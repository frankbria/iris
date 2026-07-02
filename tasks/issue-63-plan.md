# Issue #63 — config loadFromEnvironment mutates shared DEFAULT_CONFIG

**Plan source:** CodeRabbit comment on issue #63, adapted to codebase (verified against `src/config.ts` as of main @ b2a4315).
**Approval:** autonomous — no architectural fork (design choice resolved: nested spreads, consistent with `mergeConfig`).

## Bug
`loadFromEnvironment()` (`src/config.ts:129`) does `const config = { ...DEFAULT_CONFIG }` — a shallow copy — then mutates `config.ai.*`. Since `config.ai === DEFAULT_CONFIG.ai`, the module-level default is permanently rewritten. In a long-running `connect` server/watcher, provider/model become sticky after the first env-driven load (e.g., anthropic/claude-3-haiku persists after keys are cleared).

## Steps (TDD)
1. **RED**: Add regression test in `describe('loadConfig')` (`__tests__/config.test.ts`):
   - Load with `ANTHROPIC_API_KEY` set → assert anthropic/claude-3-haiku-20240307.
   - Delete key, load again → assert clean defaults (openai/gpt-4o-mini, no apiKey).
   - Assert the two configs' `ai` objects are distinct references.
   - Conventions: `mockOs.homedir('/home/test')`, `mockFs.existsSync(false)`, inline env management.
2. **GREEN**: In `loadFromEnvironment()`, replace shallow copy with per-key spreads of `ai`, `watch`, `browser` (mirrors `mergeConfig`). No other signature/behavior changes.
3. Verify: `npm run verify` (typecheck + lint + full test suite).

## Acceptance criteria
- [ ] Defaults deep-cloned before mutation
- [ ] Test calling `loadConfig()` twice under different env asserts independence
- [ ] All existing tests still pass
