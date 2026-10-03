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
 * name looks secret are replaced; in strings (error messages too), URL userinfo,
 * `Bearer`/`Basic` credentials, secret-looking query parameters and `iris_…` keys are cut.
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
 * Field names never logged: credentials, connection URLs, and request payloads: `text` /
 * `value` (what a fill types, src/actions.ts), `instruction`, `params`, `body`.
 */
const SECRET_FIELD =
  /authorization|cookie|token|secret|passw(or)?d|api[-_]?key|^key$|credential|(database|smtp)[-_]?url|^(text|value|instruction|params|body)$/i;
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+\S+/gi;
/** Every query or fragment parameter: `$1` separator and name, `$2` the name, `$3` the value. */
const QUERY_PARAM = /([?&;#]([^=&;#\s]*)=)([^&;#\s]*)/g;
/** A parameter name that looks secret: its value is cut. */
const SECRET_NAME = /token|key|passw(?:or)?d|secret|sig|auth|session|credential/i;

/** The name as a URL parser reads it (`%74oken` is `token`); a malformed escape stays. */
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
/** An API key's shape: the `iris_` prefix plus random letters and digits (no underscore). */
const API_KEY = /\biris_[A-Za-z0-9]{16,}\b/g;
const MAX_DEPTH = 4;

/** `text` with URL userinfo, `Bearer`/`Basic` credentials, secret query values and keys cut. */
export function redactString(text: string): string {
  return text
    .replace(USERINFO, '$1[redacted]@')
    .replace(AUTH_SCHEME, '$1 [redacted]')
    .replace(QUERY_PARAM, (all, head: string, name: string) =>
      SECRET_NAME.test(decodedName(name)) ? `${head}[redacted]` : all,
    )
    .replace(API_KEY, 'iris_[redacted]');
}

/** A copy of `value` with secret-named fields replaced and credentials cut from strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
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

/**
 * For modules shared with the local CLI: in hosted mode a JSON line through `log()`, so
 * the server's output stays one object per line; locally, the module's own console
 * output, unchanged.
 */
export function hostedLog(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown>,
  local: () => void,
): void {
  if (isHostedMode()) log(level, msg, fields);
  else local();
}
