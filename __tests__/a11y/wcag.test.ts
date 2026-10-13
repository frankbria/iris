import axe from 'axe-core';
import { unknownAxeTags, wcagTags } from '../../src/a11y/wcag';

describe('wcagTags (#290)', () => {
  it('A is WCAG 2.0 and 2.1 level A', () => {
    expect(wcagTags('A')).toEqual(['wcag2a', 'wcag21a']);
  });

  it('AA adds 2.0, 2.1 and 2.2 AA', () => {
    expect(wcagTags('AA')).toEqual(['wcag2a', 'wcag21a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  });

  it('AAA adds 2.0 AAA on top of AA', () => {
    expect(wcagTags('AAA')).toEqual([...wcagTags('AA'), 'wcag2aaa']);
  });

  // A tag axe does not know selects nothing, silently; a misspelt one would read as clean.
  it('every tag selects at least one axe rule', () => {
    const ruleTags = new Set(axe.getRules().flatMap((r) => r.tags));
    for (const tag of wcagTags('AAA')) expect(ruleTags).toContain(tag);
  });
});

// #500: a tag that selects no axe rule makes a scan that finds nothing and passes.
describe('unknownAxeTags', () => {
  it('names the tags the installed axe-core does not know', async () => {
    expect(await unknownAxeTags(['wcag2a', 'wcg21aa', 'best-practice', 'nope'])).toEqual([
      'wcg21aa',
      'nope',
    ]);
  });

  it('knows every tag of every built-in level', async () => {
    expect(await unknownAxeTags(wcagTags('AAA'))).toEqual([]);
  });
});
