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

/** A credential name -> its value, or `undefined` when there is none. */
export type SecretSource = (name: string) => string | undefined;

export class CredentialReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialReferenceError';
  }
}

/** `IRIS_SECRET_<NAME>` from the environment: the local CLI's source. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretSource {
  return (name) => env[`IRIS_SECRET_${name}`];
}

/** A request's own map (own keys only, so `constructor` resolves to nothing). */
export function mapSecrets(map: Record<string, string>): SecretSource {
  return (name) => (Object.hasOwn(map, name) ? map[name] : undefined);
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
  const value = source(match[1]);
  if (value === undefined) {
    throw new CredentialReferenceError(`Unknown credential reference {{secret:${match[1]}}}`);
  }
  return { value, fromReference: true };
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
    // escapes !'()~ and writes a space as +.
    const encoded = encodeURIComponent(value);
    forms.add(encoded);
    forms.add(
      encoded
        .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%20/g, '+'),
    );
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
