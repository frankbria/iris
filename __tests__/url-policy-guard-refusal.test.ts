/**
 * Whose refusal the guard quotes as the reason a navigation failed (#668), and of which
 * navigation (#673).
 *
 * On a stand-in CDP session, so the events can be given a frame id and a navigation id
 * directly. That a top-level frame's id is the page's target id and a subframe's is not,
 * and that an error page's commit carries the `loaderId` its document request was paused
 * with as `networkId`, which this takes for granted, is what the real-Chromium cases
 * marked #668 and #673 in `url-policy-guard.test.ts` show.
 */

import type { Page } from 'playwright';
import { guardedDocumentUrl, guardedGoto, installUrlPolicyGuard } from '../src/url-policy-guard';

const METADATA = 'http://169.254.169.254/latest/meta-data/';
const REQUESTED = 'https://example.com/start';
const MAIN_FRAME = 'main-frame-and-target-id';
const CHILD_FRAME = 'child-frame-id';
const ERROR_PAGE = 'chrome-error://chromewebdata/';
const GENERIC = new Error(`${REQUESTED} moved on to a page that could not be loaded`);
const REFUSED =
  /^https:\/\/example\.com\/start redirects to http:\/\/169\.254\.169\.254\/latest\/meta-data\/, which is blocked by navigation policy: .*link-local\/metadata/;

interface PausedRequest {
  requestId: string;
  /** The navigation's id: what its commit carries as `loaderId`. */
  networkId?: string;
  frameId: string;
  resourceType: string;
  request: { url: string };
}

interface FrameNavigated {
  frame: { id: string; loaderId: string; url: string; parentId?: string };
}

interface GuardedStandIn {
  page: Page;
  goto: jest.Mock;
  url: jest.Mock;
  send: jest.Mock;
  /** Deliver one paused request to the guard, as Chromium would. */
  pause(event: PausedRequest): Promise<void>;
  /** Tell the guard a frame committed a document, as Chromium would. */
  commit(event: FrameNavigated): void;
  /** Deliver one paused document to the browser net (#337), when the page has a browser. */
  pauseOnBrowserNet?: (event: PausedRequest) => Promise<void>;
}

async function guardedStandIn(withBrowser = false): Promise<GuardedStandIn> {
  let paused: ((event: PausedRequest) => Promise<void>) | undefined;
  let committed: ((event: FrameNavigated) => void) | undefined;
  const send = jest.fn(async (method: string) =>
    method === 'Target.getTargetInfo' ? { targetInfo: { targetId: MAIN_FRAME } } : undefined,
  );
  const session = {
    send,
    on: (name: string, handler: (event: never) => unknown) => {
      if (name === 'Fetch.requestPaused') paused = handler as typeof paused;
      if (name === 'Page.frameNavigated') committed = handler as typeof committed;
    },
  };
  let pausedOnNet: ((event: PausedRequest) => Promise<void>) | undefined;
  const browser = {
    newBrowserCDPSession: async () => ({
      send: jest.fn().mockResolvedValue(undefined),
      on: (name: string, handler: (event: never) => unknown) => {
        if (name === 'Fetch.requestPaused') pausedOnNet = handler as typeof pausedOnNet;
      },
    }),
  };
  const context = {
    newCDPSession: jest.fn().mockResolvedValue(session),
    route: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    // Without a browser the browser net (#337) is skipped and only the page session records.
    browser: jest.fn().mockReturnValue(withBrowser ? browser : null),
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
  if (!paused) throw new Error('the guard registered no Fetch.requestPaused handler');
  if (!committed) throw new Error('the guard registered no Page.frameNavigated handler');
  return {
    page,
    goto,
    url,
    send,
    pause: paused,
    commit: committed,
    pauseOnBrowserNet: pausedOnNet,
  };
}

const refusedDocument = (frameId: string, navigation = 'refused-navigation'): PausedRequest => ({
  requestId: `request-in-${frameId}`,
  networkId: navigation,
  frameId,
  resourceType: 'Document',
  request: { url: METADATA },
});

/** The commit of the error page a failed navigation leaves in a frame. */
const errorPage = (navigation: string, frameId = MAIN_FRAME): FrameNavigated => ({
  frame: {
    id: frameId,
    loaderId: navigation,
    url: ERROR_PAGE,
    ...(frameId === MAIN_FRAME ? {} : { parentId: MAIN_FRAME }),
  },
});

/** A guarded page that loaded REQUESTED and then, by itself, went through `moves`. */
async function afterMoves(
  moves: (guarded: GuardedStandIn) => Promise<void>,
): Promise<GuardedStandIn> {
  const guarded = await guardedStandIn();
  guarded.goto.mockResolvedValue(null);
  await guardedGoto(guarded.page, REQUESTED);
  guarded.commit({ frame: { id: MAIN_FRAME, loaderId: 'first-document', url: REQUESTED } });
  await moves(guarded);
  guarded.url.mockReturnValue(ERROR_PAGE);
  return guarded;
}

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
    guarded.commit(errorPage('refused-navigation', CHILD_FRAME));
    guarded.commit(errorPage('failed-otherwise'));
    guarded.url.mockReturnValue(ERROR_PAGE);

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(GENERIC);
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
    guarded.commit(errorPage('refused-navigation'));
    guarded.url.mockReturnValue(ERROR_PAGE);

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(REFUSED);
  });

  it('asks for the target id before any request can be paused', async () => {
    const guarded = await guardedStandIn();

    const methods = guarded.send.mock.calls.map(([method]) => method);
    expect(methods.indexOf('Target.getTargetInfo')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('Target.getTargetInfo')).toBeLessThan(methods.indexOf('Fetch.enable'));
  });
});

describe('the navigation an error page is explained by (#673)', () => {
  it('a refused move, then a move that failed otherwise: not the refusal', async () => {
    const guarded = await afterMoves(async ({ pause, commit }) => {
      await pause(refusedDocument(MAIN_FRAME));
      commit(errorPage('refused-navigation'));
      commit(errorPage('failed-otherwise'));
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(GENERIC);
  });

  it('a move that failed otherwise, then a refused move: the refusal', async () => {
    const guarded = await afterMoves(async ({ pause, commit }) => {
      commit(errorPage('failed-otherwise'));
      await pause(refusedDocument(MAIN_FRAME));
      commit(errorPage('refused-navigation'));
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(REFUSED);
  });

  it('a refused move that another move replaced before its error page: not the refusal', async () => {
    const guarded = await afterMoves(async ({ pause, commit }) => {
      await pause(refusedDocument(MAIN_FRAME));
      commit(errorPage('failed-otherwise'));
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(GENERIC);
  });

  it('a redirect hop refused later in the same navigation: the refusal', async () => {
    const guarded = await afterMoves(async ({ pause, commit }) => {
      await pause({
        ...refusedDocument(MAIN_FRAME, 'redirected-navigation'),
        request: { url: 'https://example.com/hop' },
      });
      await pause(refusedDocument(MAIN_FRAME, 'redirected-navigation'));
      commit(errorPage('redirected-navigation'));
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(REFUSED);
  });

  it('a refusal the browser net answered first explains its error page too', async () => {
    const guarded = await guardedStandIn(true);
    guarded.goto.mockResolvedValue(null);
    await guardedGoto(guarded.page, REQUESTED);
    if (!guarded.pauseOnBrowserNet) throw new Error('the guard started no browser net');

    await guarded.pauseOnBrowserNet(refusedDocument(MAIN_FRAME));
    guarded.commit(errorPage('refused-navigation'));
    guarded.url.mockReturnValue(ERROR_PAGE);

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(REFUSED);
  });

  it("a frame's commit neither explains the main frame's error page nor forgets why", async () => {
    const guarded = await afterMoves(async ({ pause, commit }) => {
      await pause(refusedDocument(MAIN_FRAME));
      commit(errorPage('refused-navigation'));
      commit(errorPage('failed-otherwise', CHILD_FRAME));
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(REFUSED);
  });

  it('a refused request with no navigation id explains no error page', async () => {
    const guarded = await afterMoves(async ({ pause, commit }) => {
      const { networkId: _none, ...anonymous } = refusedDocument(MAIN_FRAME);
      await pause(anonymous);
      commit(errorPage('failed-otherwise'));
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(GENERIC);
  });

  it('an error page whose commit has not been heard yet: the pending refusal', async () => {
    const guarded = await afterMoves(async ({ pause }) => {
      await pause(refusedDocument(MAIN_FRAME));
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(REFUSED);
  });

  it('a document committed after an error page forgets why that one was', async () => {
    const guarded = await afterMoves(async ({ page, pause, commit }) => {
      await pause(refusedDocument(MAIN_FRAME));
      commit(errorPage('refused-navigation'));
      // A new navigation asked for and committed; its own later failure is not heard yet.
      await guardedGoto(page, REQUESTED);
      commit({ frame: { id: MAIN_FRAME, loaderId: 'second-document', url: REQUESTED } });
    });

    expect(() => guardedDocumentUrl(guarded.page, REQUESTED)).toThrow(GENERIC);
  });

  it('listens for commits before any request can be paused', async () => {
    const guarded = await guardedStandIn();

    const methods = guarded.send.mock.calls.map(([method]) => method);
    expect(methods.indexOf('Page.enable')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('Page.enable')).toBeLessThan(methods.indexOf('Fetch.enable'));
  });
});
