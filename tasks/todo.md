# #658 [P1.43] Credential-stripping patterns take quadratic time on long input

## Plan (self-authored; no plan on the issue)

`stripUserinfo` (src/report-encoding.ts) and `redactString` (src/log.ts) start their userinfo
pattern with an unanchored scheme, so on a long run of scheme characters every start position
scans to the end of the run. Measured again before coding (10,000 and 40,000 characters):
letters 189 ms / 2,677 ms; `a…a://b…b` 156 ms / 2,692 ms. Measuring every pattern in
`redactString` found one more: `QUERY_PARAM` on a run of `?` (256 ms / 3,192 ms), because `?`
is allowed in a parameter name.

1. **Linear userinfo pattern, same match set.** Match the whole run of scheme characters and
   make `://userinfo@` an optional tail: `([a-z0-9+.-]+)(:\/\/[^\s/?#]+@)?`. Every run is
   consumed by one match, so no position inside it is tried again; the replacement applies
   when the tail matched and the run holds a letter (the old pattern's leftmost match starts
   at the run's first letter, and what precedes it stays). One helper in report-encoding,
   used by both (`+` for `stripUserinfo`, `*` for `redactString`, as today).
2. **Linear `QUERY_PARAM`**, same trick: `=value` becomes the optional tail.
3. **Cut before the patterns** in `boundedError` and `erroredPage`: at most 16,384 UTF-16
   units go to `stripAnsi` and the patterns. A cut can land inside a URL whose `@` is past
   it, so a cut text also loses a trailing partial copy of the quoted URL, a trailing
   authority with no terminator, and a lone high surrogate.
4. **Selector bound (the issue asks for a decision): yes**, 4,096 characters on `selector`
   (click, fill) and on an assertion's `target`, in the shared `ActionSchema`.
5. Docs: `.claude/rules/rpc-server.md`, `ai-and-visual.md`, `docs/integration-surfaces.md`,
   `plans/README.md` (P1.43 row), `tasks/lessons.md`.

## Acceptance criteria

- [ ] Both helpers linear on adversarial input: 1 MB against 100 KB by ratio (letters,
      `a1a1…`, `a.a.…`, plus `a…://b…` and `???…`), monotonic clock, never `Date.now()`
- [ ] Match set unchanged: existing cases pass, plus `...http://u:p@h` and `1http://u:p@h`
- [ ] Error text cut before the patterns in `boundedError` and `erroredPage`, by code point
- [ ] Decision on an upper bound for RPC selectors

## Assumptions and decisions

- A 1 MB ratio test cannot be shown red on the old pattern (it would run for about half an
  hour per shape); red is shown at 10,000 / 40,000 characters instead.
- 16,384 units is far above the 500 code points stored and any real Playwright call log.
- 4,096 characters is far above any selector a person or a model writes; a longer one is
  refused with zod's message at the RPC boundary and in the AI parse path.
