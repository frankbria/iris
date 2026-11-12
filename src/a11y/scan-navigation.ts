import type { Page } from 'playwright';
import { withPageTimeout } from '../page-timeout';

/**
 * A scan's checks stay on the document they were started on (#669).
 *
 * The a11y runner navigates, waits for the network to go idle and reads the document's URL
 * once (#662). A page can still move on afterwards: a `setTimeout` that calls
 * `location.replace`, a meta refresh of a few seconds, an auth check that redirects after a
 * slow call. A check that ran across such a move either died on a destroyed execution
 * context or reported the second document under the first one's URL.
 */

/** Thrown in place of a check's result, or its error, when the page moved on under it. */
export class NavigatedDuringScanError extends Error {
  /**
   * @param reloaded the page holds another document at the same origin and path (#675).
   * @param cause the error of the check the move destroyed, when it destroyed one.
   */
  constructor(scannedUrl: string, reloaded: boolean, cause?: unknown) {
    // The scanned URL only: where the page went is text the page chose, with its query string.
    super(
      `The page navigated during the scan: it was at ${scannedUrl} when the scan began and ` +
        `${reloaded ? RELOADED : 'moved to another page'} before its checks finished`,
      { cause },
    );
    this.name = 'NavigatedDuringScanError';
  }
}

const RELOADED = 'loaded again';

/** Whether `message` is a {@link NavigatedDuringScanError}'s for a page that loaded again. */
export const saysReloaded = (message: string): boolean =>
  message.endsWith(` and ${RELOADED} before its checks finished`);

/**
 * A URL as far as a move is judged by it: scheme, host and path. A single-page app
 * rewrites its query string and fragment at any time, and the runner reports neither
 * change as a redirect (#662).
 */
export function documentKey(url: string): string {
  if (!URL.canParse(url)) return url;
  const { protocol, host, pathname } = new URL(url);
  return `${protocol}//${host}${pathname}`;
}

/** A navigation that is committing rejects a page call or two before the new document answers. */
const SETTLE_ATTEMPTS = 5;

/** Whether a page call answered; one that hangs on a spinning page counts as answered. */
const answers = (call: Promise<unknown>): Promise<boolean> =>
  withPageTimeout(
    call.then(
      () => true,
      () => false,
    ),
    true,
  );

/**
 * Whether the page answers from the document it holds now.
 *
 * `page.url()` changes when Playwright has processed a navigation's commit, and a check
 * that failed on a destroyed execution context can reach its `catch` before that. A page
 * call that answers was made in the document the page holds now, so what is read after it
 * is that document's. A closed page never answers.
 */
async function settled(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    if (await answers(page.evaluate('0'))) return true;
  }
  return false;
}

/** The document a page held at one moment, to ask later whether the page still holds it. */
export interface HeldDocument {
  /** The URL the document was read under. */
  readonly url: string;
  /**
   * Whether the page holds another document now, whatever its URL: a reload and a load of
   * the same path under another query string replace it, `history.pushState` and a
   * fragment change do not. False for a page that was closed.
   */
  replaced(): Promise<boolean>;
  /** Lets go of the document: a caller that holds one per key press must not keep them all. */
  release(): Promise<void>;
}

/**
 * Holds the document `page` has now (#675).
 *
 * By a handle to it, not by its URL: a cross-document navigation destroys the document's
 * execution context and every handle into it, and a same-document one leaves both alone.
 *
 * @param url the URL the caller read the document under.
 */
export async function holdDocument(page: Page, url: string): Promise<HeldDocument> {
  // A navigation committing right now rejects the first call; the document it leaves is the
  // one to hold, and a move away from `url` is then seen by its URL.
  const document = await page.evaluateHandle('document').catch(async () => {
    await settled(page);
    return page.evaluateHandle('document');
  });
  return {
    url,
    replaced: async () => !(await answers(document.evaluate('0'))) && (await settled(page)),
    release: () => document.dispose().catch(() => undefined),
  };
}

/**
 * Runs `check` and holds it to the `scanned` document: when the page's origin or path is
 * another one once the check has settled, or the page holds another document under the
 * same ones (#675), the outcome is a {@link NavigatedDuringScanError}, whether the check
 * failed or returned a result.
 *
 * A change of the query string or the fragment within the document is not a move: a check
 * that fails after one keeps its own error.
 *
 * @param scanned the document the runner read before its checks.
 * @param moveIsTheChecksOwn asked once the check has settled: true when the check moved the
 * page itself (a key it pressed), which is then no fault of the page's.
 * @param reloadedInto asked likewise: the document the check loaded itself, when it loaded
 * the page again (the keyboard checks do, #286). The page is then held to that one, since
 * the scanned one is gone by the check's doing.
 */
export async function onScannedDocument<T>(
  page: Page,
  scanned: HeldDocument,
  check: () => Promise<T>,
  moveIsTheChecksOwn: () => boolean = () => false,
  reloadedInto: () => HeldDocument | undefined = () => undefined,
): Promise<T> {
  /** The error for the move the page made under the check, when it made one. */
  const move = async (cause?: unknown): Promise<NavigatedDuringScanError | undefined> => {
    if (moveIsTheChecksOwn()) return undefined;
    await settled(page);
    if (documentKey(page.url()) !== documentKey(scanned.url)) {
      return new NavigatedDuringScanError(scanned.url, false, cause);
    }
    return (await (reloadedInto() ?? scanned).replaced())
      ? new NavigatedDuringScanError(scanned.url, true, cause)
      : undefined;
  };

  let result: T;
  try {
    result = await check();
  } catch (error) {
    throw (await move(error)) ?? error;
  }
  const moved = await move();
  if (moved) throw moved;
  return result;
}
