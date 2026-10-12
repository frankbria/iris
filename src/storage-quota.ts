/**
 * Per-plan artifact storage (#315): each org's stored bytes, kept in `artifact_objects`
 * beside every write, against its plan's `artifactStorageBytes`. Kysely only, so the portal
 * can show usage (as `visual-baselines`).
 */

import { sql, type Kysely } from 'kysely';
import type { ArtifactStore } from './artifact-store';

/** The org's stored artifacts would pass its plan's quota: the API answers 402. */
export class StorageQuotaExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super('Storage quota reached');
    this.name = 'StorageQuotaExceededError';
  }
}

/** Bytes the org has stored, as recorded by `quotaArtifacts`. */
export async function storageUsage(db: Kysely<unknown>, orgId: string): Promise<number> {
  const { rows } = await sql<{ bytes: string }>`
    select coalesce(sum(bytes), 0) as bytes from artifact_objects where org_id = ${orgId}`.execute(
    db,
  );
  return Number(rows[0].bytes);
}

/** Forgets the recorded objects under `prefix`, once the store has deleted them. */
export async function forgetArtifacts(
  db: Kysely<unknown>,
  orgId: string,
  prefix: string,
): Promise<void> {
  // A prefix comparison, not LIKE: `_` in a key is no wildcard (as #349's substr match).
  await sql`delete from artifact_objects
    where org_id = ${orgId} and left(key, ${prefix.length}) = ${prefix}`.execute(db);
}

/**
 * An org's store (`orgArtifacts`) that keeps its usage and refuses a write past
 * `limitBytes` with `StorageQuotaExceededError`; nothing of a refused write is stored.
 * Replacing a key counts its new size only.
 * ponytail: check, then write: writes running at once can each pass the check, so the
 * overshoot is at most their total. A per-org lock would close it if that ever matters.
 */
export function quotaArtifacts(
  store: ArtifactStore,
  db: Kysely<unknown>,
  orgId: string,
  limitBytes: number,
): ArtifactStore {
  return {
    async put(key, body, contentType) {
      const { rows } = await sql<{ used: string; existing: string }>`
        select coalesce(sum(bytes), 0) as used,
          coalesce(sum(bytes) filter (where key = ${key}), 0) as existing
        from artifact_objects where org_id = ${orgId}`.execute(db);
      const used = Number(rows[0].used) - Number(rows[0].existing);
      if (used + body.length > limitBytes) throw new StorageQuotaExceededError(limitBytes, used);
      await store.put(key, body, contentType);
      await sql`insert into artifact_objects (org_id, key, bytes)
        values (${orgId}, ${key}, ${body.length})
        on conflict (org_id, key) do update set bytes = excluded.bytes`.execute(db);
    },
    get: (key) => store.get(key),
    signedUrl: (key, ttlSeconds) => store.signedUrl(key, ttlSeconds),
    async deletePrefix(prefix) {
      const n = await store.deletePrefix(prefix);
      await forgetArtifacts(db, orgId, prefix);
      return n;
    },
  };
}
