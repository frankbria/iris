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
  /** @param cause the error of the check the move destroyed, when it destroyed one. */
  constructor(scannedUrl: string, cause?: unknown) {
    // The scanned URL only: where the page went is text the page chose, with its query string.
    super(
      `The page navigated during the scan: it was at ${scannedUrl} when the scan began and ` +
        'moved to another page before its checks finished',
      { cause },
    );
    this.name = 'NavigatedDuringScanError';
  }
}

/**
 * A URL as far as a move is judged by it: scheme, host and path. A single-page app
 * rewrites its query string and fragment at any time, and the runner reports neither
 * change as a redirect (#662).
 */
function documentKey(url: string): string {
  if (!URL.canParse(url)) return url;
  const { protocol, host, pathname } = new URL(url);
  return `${protocol}//${host}${pathname}`;
}

/** A navigation that is committing rejects a page call or two before the new document answers. */
const SETTLE_ATTEMPTS = 5;

/**
 * Whether the page holds another document than the one at `scannedUrl`.
 *
 * `page.url()` changes when Playwright has processed the navigation's commit, and a check
 * that failed on a destroyed execution context can reach its `catch` before that. A page
 * call that answers was made in the document the page holds now, so the URL read after it
 * is that document's.
 */
async function movedOn(page: Page, scannedUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const answered = await withPageTimeout(
      page.evaluate('0').then(
        () => true,
        () => false,
      ),
      true,
    );
    if (answered) break;
  }
  return documentKey(page.url()) !== documentKey(scannedUrl);
}

/**
 * Runs `check` and holds it to the document at `scannedUrl`: when the page's origin or path
 * is another one once the check has settled, the outcome is a
 * {@link NavigatedDuringScanError}, whether the check failed or returned a result.
 *
 * A reload and a move that only changes the query string or the fragment are not seen:
 * a check that fails on one keeps its own error.
 *
 * @param scannedUrl the document URL the runner read before its checks.
 * @param moveIsTheChecksOwn asked once the check has settled: true when the check moved the
 * page itself (a key it pressed), which is then no fault of the page's.
 */
export async function onScannedDocument<T>(
  page: Page,
  scannedUrl: string,
  check: () => Promise<T>,
  moveIsTheChecksOwn: () => boolean = () => false,
): Promise<T> {
  let result: T;
  try {
    result = await check();
  } catch (error) {
    if (moveIsTheChecksOwn()) throw error;
    throw (await movedOn(page, scannedUrl))
      ? new NavigatedDuringScanError(scannedUrl, error)
      : error;
  }
  if (!moveIsTheChecksOwn() && (await movedOn(page, scannedUrl))) {
    throw new NavigatedDuringScanError(scannedUrl);
  }
  return result;
}
