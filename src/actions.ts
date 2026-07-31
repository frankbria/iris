/**
 * The action vocabulary: what IRIS can be asked to do to a page.
 *
 * This lives apart from `translator.ts` on purpose. `translator` imports the AI
 * client, and the AI client needs to validate actions it parses back from a
 * model — importing the schema from `translator` would close that loop into a
 * real runtime cycle. (`base.ts` already imports `Action` from `translator`, but
 * type-only, so it is erased at compile time and costs nothing.) Keeping the
 * vocabulary in a leaf module with no project imports lets every layer share one
 * definition safely.
 *
 * `translator.ts` re-exports everything here, so existing
 * `import { Action } from './translator'` call sites keep working.
 */

import { z } from 'zod';

/**
 * What an assertion can check.
 *
 * DOM/URL state only — deliberately not "does this look right", which needs
 * vision and belongs to the agent loop. This enum is the extension point when
 * that lands.
 */
export type AssertKind = 'text_visible' | 'element_visible' | 'url_matches' | 'element_absent';

export type Action =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'navigate'; url: string }
  | {
      type: 'assert';
      kind: AssertKind;
      /** Text content, selector, or URL substring, depending on `kind`. */
      target: string;
      /** Human phrasing, carried into reports. */
      description?: string;
    };

/**
 * Runtime schema for the Action union.
 *
 * One definition shared by the AI parse path and the JSON-RPC boundary. They
 * previously diverged: `protocol.ts` declared its own copy while the AI clients
 * did `parsed.actions || []` with no validation at all, so a hallucinated action
 * shape flowed straight to the executor.
 */
export const ActionSchema: z.ZodType<Action> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: z.string().min(1) }),
  z.object({ type: z.literal('fill'), selector: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('navigate'), url: z.string().url() }),
  z.object({
    type: z.literal('assert'),
    kind: z.enum(['text_visible', 'element_visible', 'url_matches', 'element_absent']),
    target: z.string().min(1),
    description: z.string().optional(),
  }),
]);

/**
 * Validate a model's `actions` array.
 *
 * All-or-nothing by design: a model that emitted one malformed action has
 * misunderstood the task, and silently executing the subset it got right is
 * worse than reporting a translation failure — the user would see a partial
 * run presented as a complete one.
 */
export function parseActions(
  value: unknown,
): { ok: true; actions: Action[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'actions was not an array' };
  }

  const actions: Action[] = [];
  for (const [index, candidate] of value.entries()) {
    const result = ActionSchema.safeParse(candidate);
    if (!result.success) {
      const detail = result.error.issues[0]?.message ?? 'invalid shape';
      return { ok: false, reason: `action[${index}] is invalid: ${detail}` };
    }
    actions.push(result.data);
  }

  return { ok: true, actions };
}

/**
 * One-line human description of an action, for progress narration.
 *
 * Lives beside the union so adding a member forces this to be updated in one
 * place — the CLI and the watcher previously each inlined their own version and
 * both broke the moment the union grew.
 */
export function describeAction(action: Action): string {
  switch (action.type) {
    case 'navigate':
      return `navigate ${action.url}`;
    case 'click':
      return `click ${action.selector}`;
    case 'fill':
      return `fill ${action.selector} = "${action.text}"`;
    case 'assert':
      return `assert ${action.kind} ${action.target}`;
  }
}
