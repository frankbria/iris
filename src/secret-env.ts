import * as fs from 'fs';

/**
 * A secret from `NAME`, or from the file `NAME_FILE` names (trimmed). The file is the
 * deployed form: a compose secret is a mounted file, while an environment variable
 * shows in `docker inspect` and `/proc/<pid>/environ` (#273).
 *
 * @returns the value, or `undefined` when neither is set
 * @throws when both are set, or the file is unreadable or empty
 */
export function readSecretEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const inline = env[name];
  const file = env[`${name}_FILE`];
  if (inline && file) throw new Error(`Set ${name} and ${name}_FILE one at a time, not both`);
  if (!file) return inline || undefined;
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`${name}_FILE ${file} is empty`);
  return value;
}
