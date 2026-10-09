/**
 * Bound for page calls that have no timeout of their own.
 *
 * `page.title()` and `page.evaluate()` wait for the page's main thread, and a page
 * spinning in `for (;;) {}` never gives it back: the call stays pending forever and
 * so does whatever awaited it (#293). Locator calls and screenshots take a
 * `timeout`; these two do not, so they are raced against a timer instead.
 */

/** Long enough for a busy page, short enough that a hung one costs little. */
export const PAGE_CALL_TIMEOUT_MS = 2_000;

/**
 * `call`, or `fallback` once `ms` pass without it settling. A rejection still
 * rejects. The abandoned call is left to settle (or not) on its own; its handlers
 * are attached, so a late rejection is not unhandled.
 */
export async function withPageTimeout<T, F>(
  call: Promise<T>,
  fallback: F,
  ms: number = PAGE_CALL_TIMEOUT_MS,
): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
