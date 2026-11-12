/**
 * Whose refusal the guard quotes as the reason a navigation failed (#668), and of which
 * navigation (#673).
 *
 * On a stand-in CDP session, so the events can be given a frame id and a navigation id
 * directly, and the browser's answer about the document it holds (`Page.getFrameTree`,
 * #677) can be set apart from what the guard heard. That a top-level frame's id is the
 * page's target id and a subframe's is not, and that an error page's frame carries the
 * `loaderId` its document request was paused with as `networkId`, which this takes for
 * granted, is what the real-Chromium cases marked #668 and #673 in
 * `url-policy-guard.test.ts` show.
 */

import type { Page } from 'playwright';
import {
  guardedDocumentUrl,
  guardedGoto,
  installUrlPolicyGuard,
  MAX_REMEMBERED_REFUSALS,
} from '../src/url-policy-guard';

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

/** The main frame as `Page.getFrameTree` describes it. */
interface HeldFrame {
  id: string;
  loaderId: string;
  url: string;
  urlFragment?: string;
  unreachableUrl?: string;
}

interface GuardedStandIn {
  page: Page;
  goto: jest.Mock;
  url: jest.Mock;
  send: jest.Mock;
  /** Deliver one paused request to the guard, as Chromium would. */
  pause(event: PausedRequest): Promise<void>;
  /** Set the document the browser says the main frame holds when it is asked. */
  holds(frame: HeldFrame): void;
  /** Deliver one paused document to the browser net (#337), when the page has a browser. */
  pauseOnBrowserNet?: (event: PausedRequest) => Promise<void>;
}

async function guardedStandIn(withBrowser = false): Promise<GuardedStandIn> {
  let paused: ((event: PausedRequest) => Promise<void>) | undefined;
  let held: HeldFrame = { id: MAIN_FRAME, loaderId: 'first-document', url: REQUESTED };
  const send = jest.fn(async (method: string) => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: MAIN_FRAME } };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: held } };
    return undefined;
  });
  const session = {
    send,
    on: (name: string, handler: (event: never) => unknown) => {
      if (name === 'Fetch.requestPaused') paused = handler as typeof paused;
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
  return {
    page,
    goto,
    url,
    send,
    pause: paused,
    holds: (frame) => {
      held = frame;
    },
    pauseOnBrowserNet: pausedOnNet,
  };
}

const refusedDocument = (
  frameId: string,
  navigation = 'refused-navigation',
  url = METADATA,
): PausedRequest => ({
  requestId: `request-in-${frameId}`,
  networkId: navigation,
  frameId,
  resourceType: 'Document',
  request: { url },
});

/** The error page a failed navigation leaves in the main frame. */
const errorPage = (navigation: string): HeldFrame => ({
  id: MAIN_FRAME,
  loaderId: navigation,
  url: ERROR_PAGE,
  unreachableUrl: 'http://unreachable.example/',
});

/** A guarded page that loaded REQUESTED and then, by itself, went through `moves`. */
async function afterMoves(
  moves: (guarded: GuardedStandIn) => Promise<void>,
): Promise<GuardedStandIn> {
  const guarded = await guardedStandIn();
  guarded.goto.mockResolvedValue(null);
  await guardedGoto(guarded.page, REQUESTED);
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
    guarded.holds(errorPage('failed-otherwise'));
    guarded.url.mockReturnValue(ERROR_PAGE);

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(GENERIC);
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
    guarded.holds(errorPage('refused-navigation'));
    guarded.url.mockReturnValue(ERROR_PAGE);

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);
  });

  it('asks for the target id before any request can be paused', async () => {
    const guarded = await guardedStandIn();

    const methods = guarded.send.mock.calls.map(([method]) => method);
    expect(methods.indexOf('Target.getTargetInfo')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('Target.getTargetInfo')).toBeLessThan(methods.indexOf('Fetch.enable'));
  });
});

describe('the navigation an error page is explained by (#673, #677)', () => {
  const OTHER = 'http://169.254.169.254/other';
  const REFUSED_OTHER =
    /^https:\/\/example\.com\/start redirects to http:\/\/169\.254\.169\.254\/other, which is blocked by navigation policy: /;

  it('a refused move, then a move that failed otherwise: not the refusal', async () => {
    const guarded = await afterMoves(async ({ pause, holds }) => {
      await pause(refusedDocument(MAIN_FRAME));
      holds(errorPage('failed-otherwise'));
    });

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(GENERIC);
  });

  it('a move that failed otherwise, then a refused move: the refusal', async () => {
    const guarded = await afterMoves(async ({ pause, holds }) => {
      holds(errorPage('failed-otherwise'));
      await pause(refusedDocument(MAIN_FRAME));
      holds(errorPage('refused-navigation'));
    });

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);
  });

  it('a redirect hop refused later in the same navigation: the refusal', async () => {
    const guarded = await afterMoves(async ({ pause, holds }) => {
      await pause(refusedDocument(MAIN_FRAME, 'redirected-navigation', 'https://example.com/hop'));
      await pause(refusedDocument(MAIN_FRAME, 'redirected-navigation'));
      holds(errorPage('redirected-navigation'));
    });

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);
  });

  it('a refusal the browser net answered first explains its error page too', async () => {
    const guarded = await guardedStandIn(true);
    guarded.goto.mockResolvedValue(null);
    await guardedGoto(guarded.page, REQUESTED);
    if (!guarded.pauseOnBrowserNet) throw new Error('the guard started no browser net');

    await guarded.pauseOnBrowserNet(refusedDocument(MAIN_FRAME));
    guarded.holds(errorPage('refused-navigation'));
    guarded.url.mockReturnValue(ERROR_PAGE);

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);
  });

  it('a refused request with no navigation id explains no error page', async () => {
    const guarded = await afterMoves(async ({ pause, holds }) => {
      const { networkId: _none, ...anonymous } = refusedDocument(MAIN_FRAME);
      await pause(anonymous);
      holds(errorPage('undefined'));
    });

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(GENERIC);
  });

  it('a refused move a second refused move overtook: each error page has its own reason', async () => {
    const guarded = await afterMoves(async ({ pause }) => {
      await pause(refusedDocument(MAIN_FRAME, 'first-refused'));
      await pause(refusedDocument(MAIN_FRAME, 'second-refused', OTHER));
    });

    // The first one's error page is the document although the second was refused since.
    guarded.holds(errorPage('first-refused'));
    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);

    guarded.holds(errorPage('second-refused'));
    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED_OTHER);

    // And back: what was heard last decides nothing.
    guarded.holds(errorPage('first-refused'));
    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);
  });

  it('remembers a bounded number of refused navigations, the newest', async () => {
    const guarded = await afterMoves(async ({ pause }) => {
      await pause(refusedDocument(MAIN_FRAME, 'oldest', OTHER));
      for (let n = 1; n <= MAX_REMEMBERED_REFUSALS; n++) {
        await pause(refusedDocument(MAIN_FRAME, `refused-${n}`));
      }
    });

    guarded.holds(errorPage('oldest'));
    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(GENERIC);
    guarded.holds(errorPage('refused-1'));
    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);
  });

  it('a page that left the error page between the two reads: the document it holds', async () => {
    const guarded = await afterMoves(async ({ pause, holds }) => {
      await pause(refusedDocument(MAIN_FRAME));
      holds({
        id: MAIN_FRAME,
        loaderId: 'next-document',
        url: 'https://example.com/next?x=1',
        urlFragment: '#part',
      });
    });

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).resolves.toBe(
      'https://example.com/next?x=1#part',
    );
  });

  it('a document the policy refuses, found between the two reads, is refused as one', async () => {
    const guarded = await afterMoves(async ({ holds }) => {
      holds({ id: MAIN_FRAME, loaderId: 'next-document', url: METADATA });
    });

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).rejects.toThrow(REFUSED);
  });

  it('does not ask the browser about a document that is not an error page', async () => {
    const guarded = await afterMoves(async ({ pause }) => {
      await pause(refusedDocument(MAIN_FRAME));
    });
    guarded.url.mockReturnValue('https://example.com/landed');

    await expect(guardedDocumentUrl(guarded.page, REQUESTED)).resolves.toBe(
      'https://example.com/landed',
    );
    expect(guarded.send).not.toHaveBeenCalledWith('Page.getFrameTree');
  });

  it('an error page on a page with no guard has no reason to give', async () => {
    const unguarded = { url: () => ERROR_PAGE } as unknown as Page;

    await expect(guardedDocumentUrl(unguarded, REQUESTED)).rejects.toThrow(GENERIC);
  });

  it('listens to no page events: the guard session enables only Fetch', async () => {
    const guarded = await guardedStandIn();

    const methods = guarded.send.mock.calls.map(([method]) => method);
    expect(methods).toEqual(['Target.getTargetInfo', 'Fetch.enable']);
  });
});
