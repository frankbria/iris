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

/**
 * The tags in `tags` that select no rule in the installed axe-core (#500). axe runs the
 * union of a tag list, so a misspelt tag silently scans with fewer rules, and a list of only
 * misspelt tags scans with none and passes. axe-core is loaded only when this is asked.
 */
export async function unknownAxeTags(tags: string[]): Promise<string[]> {
  const { default: axe } = await import('axe-core');
  return tags.filter((tag) => axe.getRules([tag]).length === 0);
}
