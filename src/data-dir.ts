/**
 * Where IRIS keeps its state: run history, the AI cost ledger and the vision
 * cache (#241).
 *
 * The ledger and cache used to be cwd-relative, so the daily budget reset in
 * every directory a user ran from, and in the read-only container they resolved
 * under /app. The history path was resolved in three places. Everything now
 * asks here.
 */

import * as os from 'os';
import * as path from 'path';

/**
 * `IRIS_DATA_DIR`, else the directory of `IRIS_DB_PATH` (so a deployment that
 * only ever set that keeps its state together), else `~/.iris`. Always absolute:
 * a relative value would make the answer depend on the cwd again.
 */
export function resolveDataDir(): string {
  if (process.env.IRIS_DATA_DIR) return path.resolve(process.env.IRIS_DATA_DIR);
  if (process.env.IRIS_DB_PATH) return path.dirname(path.resolve(process.env.IRIS_DB_PATH));
  return path.join(os.homedir(), '.iris');
}

/** The history database: `IRIS_DB_PATH` names the file outright, else `<data dir>/iris.db`. */
export function resolveDbPath(): string {
  return process.env.IRIS_DB_PATH || path.join(resolveDataDir(), 'iris.db');
}
