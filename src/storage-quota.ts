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
 *
 * The row is recorded before the object is written, as a reservation, and removed if the
 * write fails (codex review): a crash between the two then overcounts, never undercounts.
 * ponytail: the check and the reservation are one statement, but writes running at once can
 * each see the others' rows uncommitted, so the overshoot is at most their total. A per-org
 * lock would close it if that ever matters.
 */
export function quotaArtifacts(
  store: ArtifactStore,
  db: Kysely<unknown>,
  orgId: string,
  limitBytes: number,
): ArtifactStore {
  return {
    async put(key, body, contentType) {
      // Reserve: the row goes in only while the org's other objects leave room for it.
      const { rows } = await sql<{ reserved: boolean; used: string; replaced: boolean }>`
        with prior as (
          select coalesce(sum(bytes), 0) as total,
            coalesce(sum(bytes) filter (where key = ${key}), 0) as existing,
            bool_or(key = ${key}) as replaced
          from artifact_objects where org_id = ${orgId}
        ), reserved as (
          insert into artifact_objects (org_id, key, bytes)
          select ${orgId}, ${key}, ${body.length} from prior
          where prior.total - prior.existing + ${body.length} <= ${limitBytes}
          on conflict (org_id, key) do update set bytes = excluded.bytes
          returning 1
        )
        select exists (select 1 from reserved) as reserved,
          prior.total - prior.existing as used, coalesce(prior.replaced, false) as replaced
        from prior`.execute(db);
      const { reserved, used, replaced } = rows[0];
      if (!reserved) throw new StorageQuotaExceededError(limitBytes, Number(used));
      try {
        await store.put(key, body, contentType);
      } catch (err) {
        // Nothing new was stored: give back a reservation this write made. A replaced
        // key keeps its new size (overcount: the safe side).
        if (!replaced) {
          await sql`delete from artifact_objects where org_id = ${orgId} and key = ${key}`
            .execute(db)
            .catch(() => undefined);
        }
        throw err;
      }
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
