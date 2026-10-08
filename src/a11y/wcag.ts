/**
 * The axe tags of a WCAG conformance level, for every surface that takes a level (the
 * `iris a11y` default, the MCP tool, hosted jobs). Each level includes the ones below.
 *
 * A level means the current WCAG (2.2), so it carries the 2.1 and 2.2 criteria too: axe
 * tags each rule with the version that introduced it, and "AA" as `wcag2a, wcag2aa` alone
 * skipped `autocomplete-valid`, `target-size` and the rest (#290). axe has no rules at
 * 2.1/2.2 AAA, and a tag that selects nothing is a silent no-op, so none are listed.
 */
const A = ['wcag2a', 'wcag21a'];
const AA = [...A, 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const TAGS = { A, AA, AAA: [...AA, 'wcag2aaa'] };

export type WcagLevel = keyof typeof TAGS;

export function wcagTags(level: WcagLevel): string[] {
  return [...TAGS[level]];
}
