/**
 * Axe-core Integration Module
 *
 * Runs axe-core in a CDP isolated world of every frame it scans (#350). An isolated world
 * shares the page's DOM but none of its JavaScript: the page cannot replace `window.axe`,
 * poison the builtins axe uses, or answer in axe's place. `@axe-core/playwright` ran axe in
 * the page's main world, where a page that pinned `window.axe` wrote its own verdict and
 * IRIS reported it as axe-core's.
 */

import type { CDPSession, Page } from 'playwright';
import { source as axeSource } from 'axe-core';
import type { ContextObject, PartialResult, RunOptions } from 'axe-core';
import { z } from 'zod';
import type { A11yResult, A11yViolation } from './types';

export interface AxeConfig {
  /** Per-rule enable/disable, merged with `disableRules` into one axe `rules` map. */
  rules: Record<string, { enabled: boolean }>;
  /** WCAG tag filter. Ignored when `runOnlyRules` is set — axe allows one runOnly. */
  tags: string[];
  /** Run ONLY these rules (CLI `--rules`). Takes precedence over `tags`. */
  runOnlyRules?: string[];
  include: string[];
  exclude: string[];
  disableRules: string[];
  /** Upper bound in ms on a single axe analysis; a hung scan fails instead of stalling. */
  timeout: number;
}

const WORLD_NAME = 'iris-axe';

/** One frame's isolated world, with axe-core injected. */
interface AxeWorld {
  cdp: CDPSession;
  contextId: number;
}

async function openWorld(cdp: CDPSession, frameId: string): Promise<AxeWorld> {
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId,
    worldName: WORLD_NAME,
  });
  const world = { cdp, contextId: executionContextId };
  await call(world, 'function (source) { (0, eval)(source); }', [axeSource]);
  return world;
}

/**
 * Call `fn` in the world with JSON arguments. Arguments travel as CDP values, never spliced
 * into source, since they include page-controlled strings (frame selectors, partials).
 * With `byValue: false` the result is a remote object id (a DOM element).
 */
async function call(
  world: AxeWorld,
  fn: string,
  args: unknown[],
  byValue = true,
): Promise<unknown> {
  const reply = await world.cdp.send('Runtime.callFunctionOn', {
    functionDeclaration: fn,
    executionContextId: world.contextId,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: byValue,
  });
  if (reply.exceptionDetails) {
    // The description is the whole stack; history and reports keep one line.
    const detail = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text;
    throw new Error(detail.split('\n')[0]);
  }
  return byValue ? reply.result.value : reply.result.objectId;
}

/**
 * `runPartial` in this frame and, depth first, in every frame axe finds inside it: the
 * order `finishRun` expects (what `@axe-core/playwright` built). A child frame that cannot
 * be scanned is `null` with its subtree; the top frame's failure throws.
 */
async function framePartials(
  world: AxeWorld,
  context: ContextObject,
  options: RunOptions,
  oopifSessions: Map<string, CDPSession>,
): Promise<(PartialResult | null)[]> {
  const frames = (await call(world, 'function (c) { return axe.utils.getFrameContexts(c); }', [
    context,
  ])) as { frameSelector: unknown; frameContext: ContextObject }[];
  const own = (await call(world, 'function (c, o) { return axe.runPartial(c, o); }', [
    context,
    options,
  ])) as PartialResult;

  const partials: (PartialResult | null)[] = [own];
  for (const { frameSelector, frameContext } of frames) {
    try {
      const objectId = (await call(
        world,
        'function (s) { return axe.utils.shadowSelect(s); }',
        [frameSelector],
        false,
      )) as string;
      const { node } = await world.cdp.send('DOM.describeNode', { objectId });
      if (!node.frameId) throw new Error('frame has no document');
      // An out-of-process frame is its own target, reachable only through its own session.
      const child = await openWorld(oopifSessions.get(node.frameId) ?? world.cdp, node.frameId);
      partials.push(...(await framePartials(child, frameContext, options, oopifSessions)));
    } catch {
      partials.push(null);
    }
  }
  return partials;
}

/** axe over every frame of the page, each in its own isolated world. */
async function runIsolated(
  page: Page,
  context: ContextObject,
  options: RunOptions,
): Promise<unknown> {
  const browserContext = page.context();
  const sessions: CDPSession[] = [];
  try {
    const top = await browserContext.newCDPSession(page);
    sessions.push(top);
    // newCDPSession(frame) succeeds only for an out-of-process frame: map each by its id.
    const oopifSessions = new Map<string, CDPSession>();
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const session = await browserContext.newCDPSession(frame).catch(() => null);
      if (!session) continue;
      sessions.push(session);
      // A frame removed after attaching has no tree: leave it out (it becomes a null
      // partial in framePartials) rather than failing the whole scan.
      const tree = await session.send('Page.getFrameTree').catch(() => null);
      if (tree) oopifSessions.set(tree.frameTree.frame.id, session);
    }
    const { frameTree } = await top.send('Page.getFrameTree');
    const world = await openWorld(top, frameTree.frame.id);
    const partials = await framePartials(world, context, options, oopifSessions);
    return await call(world, 'function (p, o) { return axe.finishRun(p, o); }', [
      partials,
      options,
    ]);
  } finally {
    await Promise.all(sessions.map((s) => s.detach().catch(() => {})));
  }
}

// What IRIS reads from an axe result. axe's own output, but checked anyway: every report
// writer calls .map/.join on these fields, and a shape that slipped through used to throw
// there and lose the whole report (#350, the #393 comment).
const Target = z.array(z.union([z.string(), z.array(z.string())]));
const RuleNode = z.object({ target: Target, html: z.string() });
const RawRule = z.object({ id: z.string(), description: z.string(), nodes: z.array(RuleNode) });
const RawAxeResult = z.object({
  violations: z.array(
    RawRule.extend({
      impact: z.enum(['minor', 'moderate', 'serious', 'critical']).nullish(),
      tags: z.array(z.string()),
      help: z.string(),
      helpUrl: z.string(),
      nodes: z.array(RuleNode.extend({ failureSummary: z.string().optional() })),
    }),
  ),
  passes: z.array(RawRule),
  incomplete: z.array(RawRule),
  inapplicable: z.array(z.object({ id: z.string(), description: z.string() })),
  testEngine: z.object({ name: z.string(), version: z.string() }).partial().optional(),
});

/**
 * An axe result as IRIS's `A11yResult`, after checking its shape. Throws
 * "axe returned a malformed result" for anything else, which the runner records as a page
 * error (never a pass, #287).
 */
export function toA11yResult(raw: unknown, testName: string, url: string): A11yResult {
  const parsed = RawAxeResult.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `axe returned a malformed result (${issue?.path.join('.') || 'result'}: ${issue?.message})`,
    );
  }
  const r = parsed.data;
  // Targets keep axe's form: a shadow-DOM element's target is itself an array.
  type Targets = string[];
  const violations: A11yViolation[] = r.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? 'moderate',
    tags: v.tags,
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      target: n.target as Targets,
      html: n.html,
      failureSummary: n.failureSummary,
      element: n.target[0] as string | undefined,
    })),
  }));
  const rules = (list: z.infer<typeof RawRule>[]) =>
    list.map((p) => ({
      id: p.id,
      description: p.description,
      nodes: p.nodes.map((n) => ({ target: n.target as Targets, html: n.html })),
    }));
  const passes = rules(r.passes);
  const incomplete = rules(r.incomplete);
  const inapplicable = r.inapplicable.map((i) => ({ id: i.id, description: i.description }));

  return {
    testName,
    url,
    timestamp: new Date(),
    passed: violations.length === 0,
    violations,
    passes,
    incomplete,
    inapplicable,
    summary: {
      total: violations.length + passes.length + incomplete.length + inapplicable.length,
      violations: violations.length,
      passes: passes.length,
      incomplete: incomplete.length,
      inapplicable: inapplicable.length,
    },
    testRunner: {
      name: r.testEngine?.name || 'axe-core',
      // 'unknown' rather than a pinned number: a stale version stated with confidence is
      // worse than admitting axe did not report one (issue #81).
      version: r.testEngine?.version ?? 'unknown',
    },
  };
}

/**
 * AxeRunner handles axe-core execution and result processing
 */
export class AxeRunner {
  private config: AxeConfig;

  constructor(config: AxeConfig) {
    this.config = config;
  }

  /**
   * The axe context and run options for this runner's config.
   *
   * One rules map merges `rules` and `disableRules`. An explicit rule list (`runOnlyRules`)
   * is the narrower, more deliberate request, so it wins over the tag filter: axe takes a
   * single runOnly.
   *
   * @param forcedInclude Restrict to a single selector (used by runOnElement),
   *                      overriding `config.include`.
   */
  private axeArgs(forcedInclude?: string): { context: ContextObject; options: RunOptions } {
    const rules: Record<string, { enabled: boolean }> = { ...this.config.rules };
    for (const ruleId of this.config.disableRules) {
      rules[ruleId] = { enabled: false };
    }
    const options: RunOptions = {};
    if (Object.keys(rules).length > 0) options.rules = rules;
    if (this.config.runOnlyRules && this.config.runOnlyRules.length > 0) {
      options.runOnly = { type: 'rule', values: this.config.runOnlyRules };
    } else if (this.config.tags.length > 0) {
      options.runOnly = { type: 'tag', values: this.config.tags };
    }
    // The context shape @axe-core/playwright built: an empty include is the whole page.
    const context = {
      include: forcedInclude ? [forcedInclude] : this.config.include,
      exclude: this.config.exclude,
    } as ContextObject;
    return { context, options };
  }

  /**
   * Run analysis under the configured timeout. axe exposes no timeout of its own
   * (RunOptions has only the iframe-specific frameWaitTime/pingWaitTime), so the
   * bound is applied here — otherwise a hung scan blocks the run indefinitely.
   */
  private async analyzeWithTimeout(page: Page, forcedInclude?: string): Promise<unknown> {
    const { context, options } = this.axeArgs(forcedInclude);
    const scan = runIsolated(page, context, options);
    const { timeout } = this.config;
    if (!timeout || timeout <= 0) {
      return scan;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        scan,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Axe analysis timed out after ${timeout}ms`)),
            timeout,
          );
        }),
      ]);
    } finally {
      // Without this the pending timer keeps the event loop alive on the happy path.
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Run axe-core accessibility tests on a page
   */
  async run(page: Page, testName: string, url: string): Promise<A11yResult> {
    try {
      return toA11yResult(await this.analyzeWithTimeout(page), testName, url);
    } catch (error) {
      throw new Error(
        `Axe-core execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Run axe-core scoped to a single element.
   *
   * KEPT DELIBERATELY, though nothing in `src` calls it (issue #81 listed it as
   * dead). It is a working, tested, exported method on a class this package
   * exports — scoping a scan to one component is the obvious thing a library
   * consumer wants, and deleting it would be a breaking change to buy back ~40
   * lines. Reconsider if `AxeRunner` ever stops being public.
   */
  async runOnElement(
    page: Page,
    selector: string,
    testName: string,
    url: string,
  ): Promise<A11yResult> {
    try {
      const result = toA11yResult(
        await this.analyzeWithTimeout(page, selector),
        `${testName}_${selector}`,
        url,
      );
      // An element scan reports its violations only, as it always has.
      return {
        ...result,
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: result.violations.length,
          violations: result.violations.length,
          passes: 0,
          incomplete: 0,
          inapplicable: 0,
        },
      };
    } catch (error) {
      throw new Error(
        `Axe-core element scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get severity count from results
   */
  getSeverityCounts(result: A11yResult): Record<string, number> {
    const counts: Record<string, number> = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    };

    result.violations.forEach((violation) => {
      const impact = violation.impact || 'moderate';
      counts[impact] = (counts[impact] || 0) + 1;
    });

    return counts;
  }

  /**
   * Check if result passes based on failure threshold
   */
  checkThreshold(result: A11yResult, threshold: Record<string, boolean>): boolean {
    for (const violation of result.violations) {
      const impact = violation.impact || 'moderate';
      if (threshold[impact]) {
        return false; // Fail if any violation matches the threshold
      }
    }
    return true;
  }
}
