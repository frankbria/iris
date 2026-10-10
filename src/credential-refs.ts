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
const REFERENCE_LIKE = /\{\{\s*secret\s*:/;

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
    if (REFERENCE_LIKE.test(text)) {
      throw new CredentialReferenceError(
        'A credential reference must be the whole fill value: {{secret:NAME}}',
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

/** `text` with every occurrence of each (non-empty) value replaced by `<redacted>`. */
export function scrubValues(text: string, values: Iterable<string>): string {
  let out = text;
  for (const value of values) {
    if (value) out = out.split(value).join('<redacted>');
  }
  return out;
}
