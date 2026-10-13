/**
 * Credential references for fill values (issue #352).
 *
 * A fill's `text` may be `{{secret:NAME}}` instead of the value itself. The
 * instruction, the AI's plan, results and history then carry only the reference;
 * the executor resolves it at the moment it types, so the value never reaches a
 * model, a reply or a log. Where values come from is the caller's: a request's
 * `secrets` on the RPC, `IRIS_SECRET_<NAME>` for the local CLI.
 */

/** The whole fill value must be the reference; NAME as an env-var suffix. */
const REFERENCE = /^\{\{secret:([A-Za-z_][A-Za-z0-9_]{0,63})\}\}$/;
const REFERENCE_LIKE = /\{\{\s*secret\s*:/i;

/**
 * A credential's value, optionally bound to the origin it belongs to (#513): a fill on a
 * page or frame of another origin is refused. `origin` is as the source gave it; it is
 * checked when the reference is resolved.
 */
export interface SecretEntry {
  value: string;
  origin?: string;
}

/** A credential name -> its value (or entry), or `undefined` when there is none. */
export type SecretSource = (name: string) => string | SecretEntry | undefined;

/**
 * Shorter values are refused (#513): one or two characters cannot be cut from results
 * without cutting every match of them from errors and the agent's page digest. A value
 * that short is no secret; fill it literally.
 */
export const MIN_SECRET_LENGTH = 4;

export class CredentialReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialReferenceError';
  }
}

/**
 * `IRIS_SECRET_<NAME>` from the environment: the local CLI's source. `IRIS_SECRET_ORIGIN_<NAME>`
 * binds it to an origin (#513).
 */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretSource {
  return (name) => {
    const value = env[`IRIS_SECRET_${name}`];
    const origin = env[`IRIS_SECRET_ORIGIN_${name}`];
    // Set but empty is a malformed binding (PR bot), not an unbound value.
    if (value === undefined || origin === undefined) return value;
    const parsed = httpOrigin(origin);
    // A malformed binding fails the fill (in resolveFillText), never unbinds the value.
    return { value, origin: parsed ?? `invalid:IRIS_SECRET_ORIGIN_${name}` };
  };
}

/** A request's own map (own keys only, so `constructor` resolves to nothing). */
export function mapSecrets(map: Record<string, string | SecretEntry>): SecretSource {
  return (name) => (Object.hasOwn(map, name) ? map[name] : undefined);
}

/** `url`'s origin when it is an http(s) URL, else `null`. */
function httpOrigin(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
}

export const noSecrets: SecretSource = () => undefined;

/** Whether fill text is, or tries to be, a reference: a name, not a value. */
export function looksLikeReference(text: string): boolean {
  return REFERENCE_LIKE.test(text);
}

/**
 * The value a fill types. A reference that is unknown, or not the whole text,
 * throws (naming the reference, never a value): typed literally it would be a
 * silent wrong run.
 */
export function resolveFillText(
  text: string,
  source: SecretSource,
  /** The origin of the page or frame being filled; checked against a binding (#513). */
  pageOrigin?: string,
): { value: string; fromReference: boolean } {
  const match = REFERENCE.exec(text);
  if (!match) {
    if (looksLikeReference(text)) {
      throw new CredentialReferenceError(
        'Invalid credential reference: the whole fill value must be {{secret:NAME}}, NAME of letters, digits and _',
      );
    }
    return { value: text, fromReference: false };
  }
  return { value: resolveReference(match[1], source, pageOrigin), fromReference: true };
}

/** The value `{{secret:name}}` stands for, checked against its binding and length (#513). */
function resolveReference(name: string, source: SecretSource, pageOrigin?: string): string {
  const found = source(name);
  if (found === undefined) {
    throw new CredentialReferenceError(`Unknown credential reference {{secret:${name}}}`);
  }
  const { value, origin } = typeof found === 'string' ? { value: found, origin: undefined } : found;
  if (origin !== undefined) checkOrigin(name, origin, pageOrigin);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new CredentialReferenceError(
      `{{secret:${name}}} must be at least ${MIN_SECRET_LENGTH} characters: a shorter value cannot be kept out of results`,
    );
  }
  return value;
}

/** A bound reference resolves on its own origin only; an unknown page origin is refused. */
function checkOrigin(name: string, bound: string, pageOrigin: string | undefined): void {
  if (bound.startsWith('invalid:')) {
    throw new CredentialReferenceError(`${bound.slice(8)} is not an http(s) origin`);
  }
  const want = httpOrigin(bound);
  if (want === null) {
    throw new CredentialReferenceError(
      `{{secret:${name}}} is bound to an origin that is not http(s)`,
    );
  }
  if (pageOrigin !== want) {
    throw new CredentialReferenceError(
      `{{secret:${name}}} is bound to ${want}; this field is on ${pageOrigin ?? 'an unknown origin'}`,
    );
  }
}

/**
 * `text` with each (non-empty) value replaced by `<redacted>`. Also the forms a value
 * takes on the way out: whitespace-collapsed (an ARIA snapshot normalises it), line
 * by line (Playwright's call log wraps each line in ANSI codes, splitting the value)
 * and URL-encoded.
 */
export function scrubValues(text: string, values: Iterable<string>): string {
  const forms = new Set<string>();
  for (const value of values) {
    forms.add(value);
    forms.add(value.replace(/\s+/g, ' ').trim());
    for (const line of value.split(/\r?\n/)) forms.add(line.trim());
    // In a URL: as encodeURIComponent writes it, and as a GET form does, which also
    // escapes !'()~ and writes a space as +. A lone surrogate cannot be encoded (and
    // throws); the raw forms above still cover it.
    let encoded: string | undefined;
    try {
      encoded = encodeURIComponent(value);
    } catch {
      encoded = undefined;
    }
    if (encoded !== undefined) {
      forms.add(encoded);
      forms.add(
        encoded
          .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
          .replace(/%20/g, '+'),
      );
    }
  }
  forms.delete('');
  if (forms.size === 0) return text;
  // One pass, longest form first at each position: replacing form by form would let
  // a short line match inside an earlier `<redacted>`.
  const pattern = [...forms]
    .sort((a, b) => b.length - a.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), '<redacted>');
}
