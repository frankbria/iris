# #660 [P3.38] redactString: a run of bare separators costs a callback each

## Plan (self-authored; no plan on the issue)

1. Tests first (`__tests__/url-credentials.test.ts`): a megabyte of `&`, `;`, `#`, `?` and
   mixes through `redactString`, timed against the pre-#658 pattern in the same test (a
   ratio, never an absolute time); `;`, `%` and an encoded `k` in the 60,000-string
   comparison, with the name decoded in its reference; more shapes on the ladder.
2. `QUERY_PARAM` (`src/log.ts`) needs `=value` again, so a bare separator is no match and
   no callback; a `?` begins a match only as the first of its name (a lookbehind placed
   after the `\?`), which keeps #658's linear time and the match set.
3. Docs: `.claude/rules/rpc-server.md`, `plans/README.md` (P3.38 done; rows for #662, #664).

## Decisions
- Of the issue's two options, neither as written: "skip when the text holds no `=`" leaves
  `&&&…=` slow, and "consume runs without a callback" still costs one match per run. The
  pattern simply does not match where no value follows.

## Acceptance criteria
- [ ] 1 MB of `&`, `;`, `#`, `?` in a few milliseconds, still linear (ladder passes)
- [ ] Match set unchanged (60,000-string comparison with `%` and `decodedName`)
- [ ] Options weighed
