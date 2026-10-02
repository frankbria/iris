import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import * as fs from 'fs';

/**
 * Envelope encryption for organisations' AI provider keys (#344, ADR 0001 §6).
 *
 * Each stored key gets its own random data key (AES-256-GCM); the data key is
 * wrapped by a master key (key-encryption key) that lives outside the database, in
 * a mounted secret. A database dump alone opens nothing. Both layers take the org
 * and provider as additional authenticated data, so a row copied into another org,
 * or relabelled as another provider, fails to open instead of serving the wrong
 * tenant's key. Each blob names the master key that sealed it, so the master key
 * can be rotated: list the new key first and keep the old one until every row has
 * been re-saved.
 *
 * Blob, version 1:
 *   1 version | 1 id length | id | 12 wrap iv | 16 wrap tag | 32 wrapped data key
 *   | 12 iv | 16 tag | ciphertext
 */

export type StoredProvider = 'openai' | 'anthropic';

export interface MasterKey {
  id: string;
  key: Buffer;
}

export interface Keyring {
  /** Seals new values. */
  current: MasterKey;
  /** Opens values sealed by any listed key, the current one included. */
  keys: Map<string, MasterKey>;
}

const VERSION = 1;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The master keyring from `IRIS_KEY_ENCRYPTION_KEY` or `IRIS_KEY_ENCRYPTION_KEY_FILE`
 * (the deployed form): comma-separated `id:base64` entries of 32 random bytes, the
 * first being the key that seals. Generate one with
 * `echo "k1:$(openssl rand -base64 32)"`.
 *
 * @throws when unset, set twice, or malformed: hosted mode must not start without it
 */
export function resolveKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const { IRIS_KEY_ENCRYPTION_KEY: inline, IRIS_KEY_ENCRYPTION_KEY_FILE: file } = env;
  if (inline && file) {
    throw new Error(
      'Set IRIS_KEY_ENCRYPTION_KEY and IRIS_KEY_ENCRYPTION_KEY_FILE one at a time, not both',
    );
  }
  const raw = (file ? fs.readFileSync(file, 'utf8') : (inline ?? '')).trim();
  if (!raw) {
    throw new Error(
      'Set IRIS_KEY_ENCRYPTION_KEY (or IRIS_KEY_ENCRYPTION_KEY_FILE) to encrypt provider keys',
    );
  }
  const keys = new Map<string, MasterKey>();
  for (const entry of raw.split(',').map((e) => e.trim())) {
    const sep = entry.indexOf(':');
    const id = entry.slice(0, sep);
    if (sep < 1 || !KEY_ID.test(id)) {
      throw new Error('Each IRIS_KEY_ENCRYPTION_KEY entry must be id:base64');
    }
    const key = Buffer.from(entry.slice(sep + 1), 'base64');
    if (key.length !== 32) throw new Error(`Master key ${id} must be 32 bytes (base64)`);
    if (keys.has(id)) throw new Error(`Master key id ${id} is listed twice`);
    keys.set(id, { id, key });
  }
  return { current: keys.values().next().value as MasterKey, keys };
}

const aad = (layer: string, keyId: string, { orgId, provider }: KeyOwner) =>
  Buffer.from(`iris/${layer}/v1\0${keyId}\0${orgId}\0${provider}`);

interface KeyOwner {
  orgId: string;
  provider: StoredProvider;
}

function seal(key: Buffer, plaintext: Buffer, additional: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, sealed: Buffer, additional: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAAD(additional);
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}

/** Encrypt one org's provider key for storage. */
export function sealProviderKey(apiKey: string, owner: KeyOwner, keyring: Keyring): Buffer {
  const { id, key } = keyring.current;
  const dataKey = randomBytes(32);
  try {
    const wrapped = seal(key, dataKey, aad('data-key', id, owner));
    const body = seal(dataKey, Buffer.from(apiKey, 'utf8'), aad('provider-key', id, owner));
    const idBytes = Buffer.from(id, 'ascii');
    return Buffer.concat([Buffer.from([VERSION, idBytes.length]), idBytes, wrapped, body]);
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Decrypt a stored provider key for the org and provider it was sealed for.
 *
 * @throws on any other org or provider, any changed byte, or an unknown master key
 */
export function openProviderKey(sealed: Buffer, owner: KeyOwner, keyring: Keyring): string {
  if (sealed[0] !== VERSION) throw new Error(`Unsupported provider key format ${sealed[0]}`);
  const idLength = sealed[1];
  const id = sealed.subarray(2, 2 + idLength).toString('ascii');
  const master = keyring.keys.get(id);
  if (!master)
    throw new Error(`Provider key was sealed by master key ${id}, which is not configured`);
  const wrappedStart = 2 + idLength;
  const bodyStart = wrappedStart + 12 + 16 + 32;
  const dataKey = open(
    master.key,
    sealed.subarray(wrappedStart, bodyStart),
    aad('data-key', id, owner),
  );
  try {
    return open(dataKey, sealed.subarray(bodyStart), aad('provider-key', id, owner)).toString(
      'utf8',
    );
  } finally {
    dataKey.fill(0);
  }
}
