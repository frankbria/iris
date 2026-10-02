import { isHostedMode } from './hosted';
import { metrics } from './metrics';

/**
 * Structured logging (#275), with no dependency. Hosted mode writes one JSON object
 * per line (`ts`, `level`, `msg`, then the fields); local mode writes `[iris] msg
 * key=value`, as the CLI always has. Everything goes to stderr: stdout carries
 * program output (CLI results, the `listening` line, probe output a test parses).
 *
 * The level comes from `IRIS_LOG_LEVEL` (debug, info, warn, error), read per call;
 * the default is `info` hosted and `warn` locally, so a local `iris connect` prints no
 * request lines.
 *
 * The rule is to never pass a secret: log a key's id, never the key; an action's type,
 * never what a fill typed. `redact()` is the safety net under that rule: fields whose
 * name looks secret are replaced, URL userinfo and bearer tokens in strings are cut.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const errorsLogged = metrics.counter('iris_errors_total', 'Lines logged at level error');

function threshold(): LogLevel {
  const v = (process.env.IRIS_LOG_LEVEL ?? '').trim().toLowerCase();
  if (Object.hasOwn(RANK, v)) return v as LogLevel;
  return isHostedMode() ? 'info' : 'warn';
}

/**
 * Field names never logged: credentials, connection URLs, and `text` / `value`, which
 * is what a fill types (src/actions.ts).
 */
const SECRET_FIELD =
  /authorization|cookie|token|secret|passw(or)?d|api[-_]?key|^key$|credential|(database|smtp)[-_]?url|^(text|value)$/i;
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;
const BEARER = /\bBearer\s+\S+/gi;
const MAX_DEPTH = 4;

/** A copy of `value` with secret-named fields replaced and credentials cut from strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.replace(USERINFO, '$1[redacted]@').replace(BEARER, 'Bearer [redacted]');
  }
  if (value instanceof Error) return redact(value.message, depth);
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'bigint' ? String(value) : value;
  }
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELD.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Logs one line. Never throws, never awaits: safe ahead of the SessionGate (#128). */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (level === 'error') errorsLogged.inc();
  if (RANK[level] < RANK[threshold()]) return;
  const clean = redact(fields) as Record<string, unknown>;
  const text = redact(msg) as string;
  let line: string;
  try {
    if (isHostedMode()) {
      line = JSON.stringify({ ts: new Date().toISOString(), level, msg: text, ...clean });
    } else {
      const extras = Object.entries(clean)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      line = [`[iris] ${text}`, ...extras].join(' ');
    }
  } catch {
    line = `[iris] ${level} ${text}`;
  }
  console.error(line);
}

/** An error's message, for a log field (never its stack or attached objects). */
export const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
