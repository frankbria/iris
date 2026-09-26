/**
 * The hosted-mode switch (ADR 0001 §5). Read once, on first use, then fixed for
 * the life of the process, so nothing that runs later (a CLI flag, a config file,
 * a client request, a stray `process.env` write) can relax it.
 */

let hosted: boolean | undefined;

/**
 * Whether this process runs as the hosted service (`IRIS_HOSTED=1`).
 *
 * Fails closed: anything other than unset, empty, `0` or `false` counts as on,
 * so a deploy that writes `IRIS_HOSTED=true` is not silently permissive.
 */
export function isHostedMode(): boolean {
  if (hosted === undefined) {
    const value = (process.env.IRIS_HOSTED ?? '').trim().toLowerCase();
    hosted = value !== '' && value !== '0' && value !== 'false';
  }
  return hosted;
}
