export type Action =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'navigate'; url: string };

/**
 * Translate a natural language instruction into Playwright actions.
 * Fallbacks to basic regex-based parsing for click, fill, and navigate commands.
 */
export function translate(instruction: string): Action[] {
  const trimmed = instruction.trim();
  const clickMatch = /^click (.+)$/i.exec(trimmed);
  if (clickMatch) {
    return [{ type: 'click', selector: clickMatch[1] }];
  }
  const fillMatch = /^fill (.+) with (.+)$/i.exec(trimmed);
  if (fillMatch) {
    return [{ type: 'fill', selector: fillMatch[1], text: fillMatch[2] }];
  }
  const navMatch = /^navigate to (.+)$/i.exec(trimmed);
  if (navMatch) {
    return [{ type: 'navigate', url: navMatch[1] }];
  }
  // Unrecognized instruction: return empty action list
  return [];
}
