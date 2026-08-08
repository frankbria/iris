/**
 * Agent loop core (issue #121).
 *
 * observePage runs against real Chromium — a mocked page cannot tell a working
 * digest from a broken one. The loop's control flow uses a mocked AI client,
 * because what is under test there is termination and context threading, not
 * the model.
 */

import { chromium, Browser, Page } from 'playwright';
import { observePage, runAgentLoop, MAX_DIGEST_CHARS, MAX_URL_CHARS } from '../src/agent-loop';
import { ActionExecutor } from '../src/executor';
import * as aiClient from '../src/ai-client';
import type { Action } from '../src/actions';

const PAGE = `<!doctype html><html lang="en"><head><title>Checkout</title></head><body>
  <h1>Your cart</h1>
  <button id="pay">Pay now</button>
  <a href="https://example.com/help">Help</a>
</body></html>`;

const load = (page: Page, html: string) =>
  page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));

describe('agent loop', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    // ActionExecutor only applies its timeout to pages IT creates; the agent loop
    // is handed a page, so set it here or missing-selector cases wait the full 30s.
    page.setDefaultTimeout(1000);
    await load(page, PAGE);
  });

  afterEach(async () => {
    await page?.close();
    jest.restoreAllMocks();
  });

  describe('observePage', () => {
    it('includes the url, title and semantic roles', async () => {
      const digest = await observePage(page);

      expect(digest).toContain('URL: data:text/html');
      expect(digest).toContain('TITLE: Checkout');
      // Roles and accessible names are what an instruction actually refers to.
      expect(digest).toMatch(/button/);
      expect(digest).toContain('Pay now');
      expect(digest).toContain('Your cart');
    });

    it('caps the digest and marks the truncation', async () => {
      const huge = `<!doctype html><html lang="en"><head><title>t</title></head><body>${Array.from(
        { length: 3000 },
        (_, i) => `<button>Button number ${i}</button>`,
      ).join('')}</body></html>`;
      await load(page, huge);

      const digest = await observePage(page);

      expect(digest).toContain('[truncated');
      // Header plus cap plus the marker — bounded, not unbounded.
      expect(digest.length).toBeLessThan(MAX_DIGEST_CHARS + 500);
    });

    // The body cap alone is not enough: page.url() on a data: URL carries the
    // entire encoded document, so an uncapped header blew the whole budget.
    it('caps the URL so the header cannot blow the budget', async () => {
      const digest = await observePage(page);
      const urlLine = digest.split('\n')[0];

      expect(urlLine.length).toBeLessThanOrEqual(MAX_URL_CHARS + 40);
      expect(urlLine).toContain('…[+');
    });

    it('degrades to a header rather than throwing on an empty document', async () => {
      await load(
        page,
        '<!doctype html><html lang="en"><head><title>t</title></head><body></body></html>',
      );

      const digest = await observePage(page);

      expect(digest).toContain('URL:');
      expect(digest).toContain('TITLE: t');
    });
  });

  describe('runAgentLoop', () => {
    const executor = new ActionExecutor({ timeout: 1000, retryAttempts: 0, trackContext: false });

    /** Stub the AI client with a scripted sequence of plans, one per turn. */
    const scriptAI = (plans: Action[][]) => {
      const translateInstruction = jest.fn();
      for (const actions of plans) {
        translateInstruction.mockResolvedValueOnce({ actions, confidence: 0.9 });
      }
      // Anything past the script: no actions.
      translateInstruction.mockResolvedValue({ actions: [], confidence: 0 });
      jest
        .spyOn(aiClient, 'createResolvedAIClient')
        .mockResolvedValue({ translateInstruction, isAvailable: async () => true } as never);
      return translateInstruction;
    };

    it('threads the observed page and prior actions into the next turn', async () => {
      const translateInstruction = scriptAI([
        [{ type: 'click', selector: '#pay' }],
        [{ type: 'assert', kind: 'text_visible', target: 'Your cart' }],
      ]);

      await runAgentLoop({ instruction: 'pay for the cart', executor, page, maxTurns: 3 });

      // Turn 1 already carries an observation — the model is never blind.
      const first = translateInstruction.mock.calls[0][0];
      expect(first.context.currentPage).toContain('TITLE: Checkout');
      expect(first.context.previousActions).toEqual([]);

      // Turn 2 carries what actually happened. This scaffolding existed in the
      // request type but no caller had ever populated it.
      const second = translateInstruction.mock.calls[1][0];
      expect(second.context.previousActions).toEqual([{ type: 'click', selector: '#pay' }]);
      expect(second.context.currentPage).toContain('URL:');
    });

    // Capping the digest is not enough on its own: context.url is interpolated
    // into every provider prompt verbatim, so an uncapped value there smuggles
    // the whole encoded data: URL back into the request.
    it('caps context.url as well as the digest', async () => {
      const translateInstruction = scriptAI([
        [{ type: 'assert', kind: 'text_visible', target: 'Your cart' }],
      ]);

      await runAgentLoop({ instruction: 'check', executor, page, maxTurns: 1 });

      const { url } = translateInstruction.mock.calls[0][0].context;
      expect(url.length).toBeLessThanOrEqual(MAX_URL_CHARS + 40);
      expect(url).toContain('…[+');
    });

    it('stops with goal_met when a turn only confirms', async () => {
      scriptAI([[{ type: 'assert', kind: 'text_visible', target: 'Your cart' }]]);

      const result = await runAgentLoop({
        instruction: 'make sure the cart is shown',
        executor,
        page,
        maxTurns: 5,
      });

      expect(result.terminationReason).toBe('goal_met');
      expect(result.goalMet).toBe(true);
      expect(result.turns).toBe(1);
    });

    // An assert alongside further actions means the model is still working, so
    // a passing assertion must not be mistaken for completion.
    it('keeps going when an assertion accompanies more work', async () => {
      scriptAI([
        [
          { type: 'assert', kind: 'text_visible', target: 'Your cart' },
          { type: 'click', selector: '#pay' },
        ],
        [{ type: 'assert', kind: 'text_visible', target: 'Your cart' }],
      ]);

      const result = await runAgentLoop({ instruction: 'pay', executor, page, maxTurns: 5 });

      expect(result.turns).toBe(2);
      expect(result.terminationReason).toBe('goal_met');
    });

    it('stops at maxTurns rather than looping forever', async () => {
      scriptAI([
        [{ type: 'click', selector: '#pay' }],
        [{ type: 'click', selector: '#pay' }],
        [{ type: 'click', selector: '#pay' }],
      ]);

      const result = await runAgentLoop({
        instruction: 'click a lot',
        executor,
        page,
        maxTurns: 3,
      });

      expect(result.terminationReason).toBe('max_turns');
      expect(result.turns).toBe(3);
    });

    // One empty plan can mean "thinking"; two means re-asking will not help.
    it('stops after two consecutive empty plans', async () => {
      scriptAI([[], []]);

      const result = await runAgentLoop({ instruction: 'do nothing', executor, page, maxTurns: 8 });

      expect(result.terminationReason).toBe('no_actions');
      expect(result.turns).toBe(2);
    });

    it('stops after three consecutive action failures', async () => {
      scriptAI([
        [
          { type: 'click', selector: '#ghost-a' },
          { type: 'click', selector: '#ghost-b' },
          { type: 'click', selector: '#ghost-c' },
        ],
      ]);

      const result = await runAgentLoop({
        instruction: 'click ghosts',
        executor,
        page,
        maxTurns: 8,
      });

      expect(result.terminationReason).toBe('consecutive_failures');
      expect(result.results).toHaveLength(3);
    });

    // The consecutive-failures return jumps out from inside the action loop, so
    // an assertion earlier in that same turn must still be reflected — goalMet
    // null is reserved for "nothing ever asserted".
    it('reports the turn verdict even when it exits on consecutive failures', async () => {
      scriptAI([
        [
          { type: 'assert', kind: 'text_visible', target: 'Your cart' }, // passes
          { type: 'click', selector: '#ghost-a' },
          { type: 'click', selector: '#ghost-b' },
          { type: 'click', selector: '#ghost-c' },
        ],
      ]);

      const result = await runAgentLoop({ instruction: 'try', executor, page, maxTurns: 2 });

      expect(result.terminationReason).toBe('consecutive_failures');
      expect(result.goalMet).toBe(true); // not null — an assertion did run
    });

    it('reports goalMet null when nothing was ever asserted', async () => {
      scriptAI([[{ type: 'click', selector: '#pay' }]]);

      const result = await runAgentLoop({ instruction: 'click pay', executor, page, maxTurns: 1 });

      // No assertion ran, so there is no verdict — distinct from "goal failed".
      expect(result.goalMet).toBeNull();
    });

    it('reports goalMet false when an assertion fails', async () => {
      scriptAI([[{ type: 'assert', kind: 'text_visible', target: 'Order complete' }]]);

      const result = await runAgentLoop({
        instruction: 'verify order',
        executor,
        page,
        maxTurns: 1,
      });

      expect(result.goalMet).toBe(false);
      expect(result.terminationReason).toBe('max_turns');
    });

    // Review catch: goalMet used to AND across every assertion ever run, so a
    // failed check could never be redeemed — and the loop could return
    // terminationReason 'goal_met' while goalMet was false. Recovering after a
    // failed check is the entire reason the loop exists.
    it('lets a later turn redeem an earlier failed assertion', async () => {
      scriptAI([
        [{ type: 'assert', kind: 'text_visible', target: 'Order complete' }], // fails
        [{ type: 'click', selector: '#pay' }],
        [{ type: 'assert', kind: 'text_visible', target: 'Your cart' }], // passes
      ]);

      const result = await runAgentLoop({
        instruction: 'complete order',
        executor,
        page,
        maxTurns: 5,
      });

      expect(result.terminationReason).toBe('goal_met');
      expect(result.goalMet).toBe(true);
    });

    it('never reports goal_met while a check in that turn failed', async () => {
      scriptAI([
        [
          { type: 'assert', kind: 'text_visible', target: 'Your cart' }, // passes
          { type: 'assert', kind: 'text_visible', target: 'Order complete' }, // fails
        ],
      ]);

      const result = await runAgentLoop({ instruction: 'check both', executor, page, maxTurns: 1 });

      expect(result.goalMet).toBe(false);
      expect(result.terminationReason).not.toBe('goal_met');
    });

    describe('capability policy (issue #151)', () => {
      // These assume a prompt injection already succeeded and the model is
      // proposing exactly what the page told it to. What is under test is that
      // the action never reaches the browser.
      it('refuses a destructive action without executing it', async () => {
        scriptAI([[{ type: 'click', selector: 'button:has-text("Delete account")' }]]);
        const execute = jest.spyOn(executor, 'executeAction');

        const result = await runAgentLoop({
          instruction: 'tidy up my account',
          executor,
          page,
          maxTurns: 1,
        });

        expect(execute).not.toHaveBeenCalled();
        expect(result.results).toHaveLength(1);
        expect(result.results[0].success).toBe(false);
        expect(result.results[0].error).toMatch(/Refused by agent policy.*looks destructive/);
      });

      it('shows the refusal AND its reason to the model on the next turn', async () => {
        // previousActions alone says what was tried, never how it went — so a
        // model would re-propose the same blocked action every turn until the
        // failure cutoff ended the run. It has to see the refusal itself.
        const translateInstruction = scriptAI([
          [{ type: 'click', selector: '#delete-everything' }],
          [{ type: 'assert', kind: 'text_visible', target: 'Your cart' }],
        ]);

        await runAgentLoop({ instruction: 'clean up', executor, page, maxTurns: 2 });

        const secondTurn = translateInstruction.mock.calls[1][0];
        expect(secondTurn.context.previousActions).toContainEqual({
          type: 'click',
          selector: '#delete-everything',
        });
        expect(secondTurn.context.recentFailures).toEqual([
          expect.stringMatching(/Refused by agent policy.*looks destructive/),
        ]);
      });

      it('reports an ordinary action failure back too, not only policy refusals', async () => {
        // Pre-existing gap this closes: a click that simply timed out was just
        // as invisible to the model as a refused one.
        const translateInstruction = scriptAI([
          [{ type: 'click', selector: '#does-not-exist' }],
          [{ type: 'assert', kind: 'text_visible', target: 'Your cart' }],
        ]);

        await runAgentLoop({ instruction: 'click it', executor, page, maxTurns: 2 });

        const secondTurn = translateInstruction.mock.calls[1][0];
        expect(secondTurn.context.recentFailures).toHaveLength(1);
        expect(secondTurn.context.recentFailures[0]).toContain('#does-not-exist');
      });

      it('bounds how many failures are reported so the prompt cannot grow forever', async () => {
        const translateInstruction = scriptAI([
          [{ type: 'click', selector: '#miss-1' }],
          [{ type: 'click', selector: '#miss-2' }],
          [{ type: 'click', selector: '#miss-3' }],
          [{ type: 'click', selector: '#miss-4' }],
          [{ type: 'click', selector: '#miss-5' }],
          [{ type: 'click', selector: '#miss-6' }],
          [{ type: 'click', selector: '#miss-7' }],
        ]);

        await runAgentLoop({
          instruction: 'click things',
          executor,
          page,
          maxTurns: 7,
          // Each miss is a failure; without a cap the run would end on the
          // consecutive-failure rule long before the list grew, so raise it.
          policy: {},
        });

        const lastCall = translateInstruction.mock.calls.at(-1)![0];
        expect(lastCall.context.recentFailures.length).toBeLessThanOrEqual(5);
      });

      it('honours an allowlist, so a read-only run cannot click', async () => {
        scriptAI([[{ type: 'click', selector: '#pay' }]]);
        const execute = jest.spyOn(executor, 'executeAction');

        const result = await runAgentLoop({
          instruction: 'check the cart',
          executor,
          page,
          maxTurns: 1,
          policy: { allow: ['assert'] },
        });

        expect(execute).not.toHaveBeenCalled();
        expect(result.results[0].error).toMatch(/"click" is not permitted/);
      });

      it('still executes an allowed action, so the policy is not just a wall', async () => {
        scriptAI([[{ type: 'click', selector: '#pay' }]]);
        const execute = jest.spyOn(executor, 'executeAction');

        const result = await runAgentLoop({
          instruction: 'pay',
          executor,
          page,
          // The fixture is a data: URL, which has no origin, so pinning is
          // inert here — asserted directly in agent-policy.test.ts instead.
          maxTurns: 1,
        });

        expect(execute).toHaveBeenCalled();
        expect(result.results[0].success).toBe(true);
      });

      it('pins to the requested URL, not to where a redirect landed', async () => {
        // The CLI navigates before handing the page over, so reading the page's
        // current URL would pin to the redirect's destination — meaning a start
        // URL that redirects to an attacker origin would make that origin the
        // trusted one. Exactly backwards, so the caller's intent wins.
        scriptAI([[{ type: 'click', selector: '#pay' }]]);
        const execute = jest.spyOn(executor, 'executeAction');

        const result = await runAgentLoop({
          instruction: 'pay',
          executor,
          page,
          maxTurns: 1,
          // The page is a data: URL; claim it was meant to be example.com.
          startUrl: 'https://trusted.example/start',
        });

        expect(execute).not.toHaveBeenCalled();
        expect(result.results[0].error).toMatch(
          /not the starting origin https:\/\/trusted\.example/,
        );
      });

      it('installs request-layer origin pinning itself, not trusting the caller', async () => {
        // A library caller gets the same guarantee the CLI does. Without this
        // the loop would only refuse on the NEXT turn, after a same-origin click
        // had already made the cross-origin request.
        scriptAI([[{ type: 'assert', kind: 'text_visible', target: 'Your cart' }]]);
        // The guard vets requests through a CDP Fetch session, so its creation
        // is the observable sign that the loop installed one.
        const newCDPSession = jest.spyOn(page.context(), 'newCDPSession');

        await runAgentLoop({
          instruction: 'check the cart',
          executor,
          page,
          maxTurns: 1,
          startUrl: 'https://trusted.example/start',
        });

        expect(newCDPSession).toHaveBeenCalledWith(page);
      });

      it('does not install a pin when the caller opted out', async () => {
        scriptAI([[{ type: 'assert', kind: 'text_visible', target: 'Your cart' }]]);
        const newCDPSession = jest.spyOn(page.context(), 'newCDPSession');

        await runAgentLoop({
          instruction: 'check the cart',
          executor,
          page,
          maxTurns: 1,
          startUrl: 'https://trusted.example/start',
          policy: { pinOrigin: false },
        });

        expect(newCDPSession).not.toHaveBeenCalled();
      });

      it('stops after three refusals instead of burning the turn budget', async () => {
        // A model that keeps proposing a blocked action must not loop forever.
        scriptAI([
          [
            { type: 'click', selector: '#delete-a' },
            { type: 'click', selector: '#delete-b' },
            { type: 'click', selector: '#delete-c' },
            { type: 'click', selector: '#delete-d' },
          ],
        ]);

        const result = await runAgentLoop({
          instruction: 'clean up',
          executor,
          page,
          maxTurns: 5,
        });

        expect(result.terminationReason).toBe('consecutive_failures');
        expect(result.results).toHaveLength(3);
      });
    });

    it('returns error instead of rejecting when the AI client cannot be built', async () => {
      jest.spyOn(aiClient, 'createResolvedAIClient').mockImplementation(() => {
        throw new Error('unsupported provider');
      });

      const result = await runAgentLoop({ instruction: 'anything', executor, page, maxTurns: 3 });

      expect(result.terminationReason).toBe('error');
      expect(result.turns).toBe(0);
    });

    it('returns error rather than throwing when translation fails', async () => {
      jest.spyOn(aiClient, 'createResolvedAIClient').mockResolvedValue({
        translateInstruction: jest.fn().mockRejectedValue(new Error('provider down')),
        isAvailable: async () => true,
      } as never);

      const result = await runAgentLoop({ instruction: 'anything', executor, page, maxTurns: 3 });

      expect(result.terminationReason).toBe('error');
      expect(result.results).toEqual([]);
    });

    it('stays silent unless a log sink is supplied', async () => {
      scriptAI([[{ type: 'assert', kind: 'text_visible', target: 'Your cart' }]]);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await runAgentLoop({ instruction: 'check', executor, page, maxTurns: 1 });

      // A library writing to stdout would corrupt `iris run --json`.
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
