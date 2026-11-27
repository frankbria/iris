/**
 * The documentation link the hosted MCP tool gives for a violated rule (#648) is built
 * from the rule id, not read from a scan. Held here against the installed axe-core's own
 * rule list, so an axe upgrade that changes the link's form fails this file.
 */
import axe from 'axe-core';
import { axeRuleHelpUrl } from '../../src/mcp/axe-help-url';

describe('axeRuleHelpUrl', () => {
  it("equals axe's own helpUrl for every rule of the installed version", () => {
    const rules = axe.getRules();
    expect(rules.length).toBeGreaterThan(50);
    for (const rule of rules) {
      expect(axeRuleHelpUrl(rule.ruleId)).toBe(rule.helpUrl);
    }
  });

  it('keeps an id that is not a rule name inside one path segment', () => {
    const link = new URL(axeRuleHelpUrl('a/b?c=d#e f'));
    expect(link.origin).toBe('https://dequeuniversity.com');
    expect(link.pathname.split('/')).toHaveLength(5); // '', rules, axe, <version>, <rule>
    expect(link.search).toBe('?application=axeAPI');
    expect(link.hash).toBe('');
  });
});
