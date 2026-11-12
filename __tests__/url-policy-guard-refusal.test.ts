/**
 * Whose refusal the guard quotes as the reason a navigation failed (#668).
 *
 * On a stand-in CDP session, so the events can be given a frame id directly. That a
 * top-level frame's id is the page's target id, which this takes for granted, is what the
 * real-Chromium case in `url-policy-guard.test.ts` shows.
 */

import type { Page } from 'playwright';
import { guardedDocumentUrl, guardedGoto, installUrlPolicyGuard } from '../src/url-policy-guard';

const METADATA = 'http://169.254.169.254/latest/meta-data/';
const REQUESTED = 'https://example.com/start';
const MAIN_FRAME = 'main-frame-and-target-id';
const CHILD_FRAME = 'child-frame-id';

interface PausedRequest {
  requestId: string;
  frameId: string;
  resourceType: string;
  request: { url: string };
}

interface GuardedStandIn {
  page: Page;
  goto: jest.Mock;
  url: jest.Mock;
  send: jest.Mock;
  /** Deliver one paused request to the guard, as Chromium would. */
  pause(event: PausedRequest): Promise<void>;
}

async function guardedStandIn(): Promise<GuardedStandIn> {
  const handlers = new Map<string, (event: PausedRequest) => Promise<void>>();
  const send = jest.fn(async (method: string) =>
    method === 'Target.getTargetInfo' ? { targetInfo: { targetId: MAIN_FRAME } } : undefined,
  );
  const session = {
    send,
    on: (name: string, handler: (event: PausedRequest) => Promise<void>) =>
      handlers.set(name, handler),
  };
  const context = {
    newCDPSession: jest.fn().mockResolvedValue(session),
    route: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    // No browser, so the browser net (#337) is skipped and only the page session records.
    browser: jest.fn().mockReturnValue(null),
  };
  const goto = jest.fn();
  const url = jest.fn();
  const page = {
    context: () => context,
    once: jest.fn(),
    routeWebSocket: jest.fn().mockResolvedValue(undefined),
    goto,
    url,
  } as unknown as Page;

  await installUrlPolicyGuard(page, {});
  const paused = handlers.get('Fetch.requestPaused');
  if (!paused) throw new Error('the guard registered no Fetch.requestPaused handler');
  return { page, goto, url, send, pause: paused };
}

const refusedDocument = (frameId: string): PausedRequest => ({
  requestId: `request-in-${frameId}`,
  frameId,
  resourceType: 'Document',
  request: { url: METADATA },
});

describe('the refusal a failed navigation is explained by (#668)', () => {
  it("guardedGoto: a frame's refused document is not why the navigation failed", async () => {
    const guarded = await guardedStandIn();
    const unresolved = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED');
    guarded.goto.mockImplementation(async () => {
      await guarded.pause(refusedDocument(CHILD_FRAME));
      throw unresolved;
    });

    await expect(guardedGoto(guarded.page, REQUESTED)).rejects.toBe(unresolved);
    // The frame's request is refused all the same.
    expect(guarded.send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: `request-in-${CHILD_FRAME}`,
      errorReason: 'BlockedByClient',
    });
  });

  it("guardedGoto: the main frame's refused document is", async () => {
    const guarded = await guardedStandIn();
    guarded.goto.mockImplementation(async () => {
      await guarded.pause(refusedDocument(MAIN_FRAME));
      throw new Error('page.goto: net::ERR_BLOCKED_BY_CLIENT');
    });

    await expect(guardedGoto(guarded.page, REQUESTED)).rejects.toThrow(
      `${REQUESTED} redirects to ${METADATA}, which is blocked by navigation policy: `,
    );
  });

  it("guardedDocumentUrl: an error page is not explained by a frame's refusal", async () => {
    const guarded = await guardedStandIn();
    guarded.goto.mockImplementation(async () => {
      await guarded.pause(refusedDocument(CHILD_FRAME));
      return null;
    });
    await guardedGoto(guarded.page, REQUESTED);
    guarded.url.mockReturnValue('chrome-error://chromewebdata/');

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(
      new Error(`${REQUESTED} moved on to a page that could not be loaded`),
    );
  });

  it("guardedDocumentUrl: an error page is explained by the main frame's refusal", async () => {
    const guarded = await guardedStandIn();
    guarded.goto.mockImplementation(async () => {
      // A frame's refusal before and after must neither stand in for it nor replace it.
      await guarded.pause({ ...refusedDocument(CHILD_FRAME), request: { url: 'ftp://frame/' } });
      await guarded.pause(refusedDocument(MAIN_FRAME));
      await guarded.pause({ ...refusedDocument(CHILD_FRAME), request: { url: 'ftp://frame/' } });
      return null;
    });
    await guardedGoto(guarded.page, REQUESTED);
    guarded.url.mockReturnValue('chrome-error://chromewebdata/');

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(
      /^https:\/\/example\.com\/start redirects to http:\/\/169\.254\.169\.254\/latest\/meta-data\/, which is blocked by navigation policy: .*link-local\/metadata/,
    );
  });

  it('asks for the target id before any request can be paused', async () => {
    const guarded = await guardedStandIn();

    const methods = guarded.send.mock.calls.map(([method]) => method);
    expect(methods.indexOf('Target.getTargetInfo')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('Target.getTargetInfo')).toBeLessThan(methods.indexOf('Fetch.enable'));
  });
});
