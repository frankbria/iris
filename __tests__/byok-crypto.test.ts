/**
 * Envelope encryption for stored provider keys (#344).
 *
 * Test strategy: real AES-GCM through node:crypto. Each property the store relies
 * on gets a test that would pass if the property were missing: a wrong org, a wrong
 * provider, a flipped byte and a wrong master key must all fail to open, and a
 * rotated keyring must still open what the old key sealed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { openProviderKey, resolveKeyring, sealProviderKey } from '../src/byok/crypto';

const b64 = () => randomBytes(32).toString('base64');
const SECRET = ['sk', 'tenant', 'not-a-real-key'].join('-');
const A_OPENAI = { orgId: 'org-a', provider: 'openai' as const };

describe('resolveKeyring', () => {
  it('reads "id:base64" entries, the first being the one that seals', () => {
    const ring = resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: `k2:${b64()},k1:${b64()}` });
    expect(ring.current.id).toBe('k2');
    expect([...ring.keys.keys()]).toEqual(['k2', 'k1']);
  });

  it('reads the deployed form, a secret file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-kek-'));
    const file = path.join(dir, 'kek');
    fs.writeFileSync(file, `main:${b64()}\n`);
    try {
      expect(resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY_FILE: file }).current.id).toBe('main');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [{}, /IRIS_KEY_ENCRYPTION_KEY/],
    [{ IRIS_KEY_ENCRYPTION_KEY: 'x', IRIS_KEY_ENCRYPTION_KEY_FILE: '/f' }, /one at a time/],
    [{ IRIS_KEY_ENCRYPTION_KEY: 'nokeyid' }, /id:base64/],
    [{ IRIS_KEY_ENCRYPTION_KEY: `k1:${randomBytes(16).toString('base64')}` }, /32 bytes/],
    [{ IRIS_KEY_ENCRYPTION_KEY: `k1:${b64()},k1:${b64()}` }, /twice/],
  ])('refuses %p', (env, message) => {
    expect(() => resolveKeyring(env as NodeJS.ProcessEnv)).toThrow(message);
  });
});

describe('sealProviderKey / openProviderKey', () => {
  const ring = resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: `k1:${b64()}` });

  it('round-trips, and the sealed form contains no part of the key', () => {
    const sealed = sealProviderKey(SECRET, A_OPENAI, ring);
    expect(openProviderKey(sealed, A_OPENAI, ring)).toBe(SECRET);
    expect(sealed.toString('latin1')).not.toContain('tenant');
  });

  it('uses a fresh data key each time: sealing twice gives different bytes', () => {
    expect(
      sealProviderKey(SECRET, A_OPENAI, ring).equals(sealProviderKey(SECRET, A_OPENAI, ring)),
    ).toBe(false);
  });

  it("does not open as another org's or another provider's key", () => {
    const sealed = sealProviderKey(SECRET, A_OPENAI, ring);
    // A row copied into another org, or relabelled, must not decrypt.
    expect(() => openProviderKey(sealed, { orgId: 'org-b', provider: 'openai' }, ring)).toThrow();
    expect(() =>
      openProviderKey(sealed, { orgId: 'org-a', provider: 'anthropic' }, ring),
    ).toThrow();
  });

  it('detects a change to any byte', () => {
    const sealed = sealProviderKey(SECRET, A_OPENAI, ring);
    for (const i of [0, 5, 20, 40, 60, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[i] ^= 0x01;
      expect(() => openProviderKey(bad, A_OPENAI, ring)).toThrow();
    }
  });

  it('does not open under another master key', () => {
    const sealed = sealProviderKey(SECRET, A_OPENAI, ring);
    const other = resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: `k1:${b64()}` });
    expect(() => openProviderKey(sealed, A_OPENAI, other)).toThrow();
  });

  it('opens what a retired master key sealed, after rotation', () => {
    const old = `k1:${b64()}`;
    const sealed = sealProviderKey(
      SECRET,
      A_OPENAI,
      resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: old }),
    );
    const rotated = resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: `k2:${b64()},${old}` });
    expect(openProviderKey(sealed, A_OPENAI, rotated)).toBe(SECRET);
    // ...and seals new keys under the new one.
    expect(() =>
      openProviderKey(
        sealProviderKey(SECRET, A_OPENAI, rotated),
        A_OPENAI,
        resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: old }),
      ),
    ).toThrow(/k2/);
  });
});
