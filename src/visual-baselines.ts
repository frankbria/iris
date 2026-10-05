import { sql, type Kysely } from 'kysely';
import { baselineObjectKey, orgArtifacts, type ArtifactStore } from './artifact-store';
import { artifactName } from './visual/artifacts';
import { redactString } from './log';

/**
 * Hosted visual baselines (#268) and their approval (#268 API, #463 portal), with no
 * dependency beyond Kysely and the artifact store: the portal imports this, and must not
 * pull in the runners that `history-store`'s write side needs (#270's lesson).
 */

/** A project's approved screenshot of one page on one device (#268). */
export interface VisualBaseline {
  project: string;
  /** `artifactName(page, device)`. */
  name: string;
  page: string;
  device: string;
  objectKey: string;
  /** The run the image came from; null once that run is pruned. */
  runId: string | null;
  /** Who approved it: `key:<api key id>`, `user:<user id>`, or `first-run`. */
  approvedBy: string;
  updatedAt: Date;
}

/** One org's baselines: the worker reads and seeds them, approval replaces them. */
export interface OrgBaselines {
  get(project: string, name: string): Promise<VisualBaseline | null>;
  /** Replaces the baseline: approval only. */
  set(b: Omit<VisualBaseline, 'updatedAt'>): Promise<void>;
  /** A project's first baseline of a page: `false` when one exists (it is not touched). */
  insertIfAbsent(b: Omit<VisualBaseline, 'updatedAt'>): Promise<boolean>;
}

export type ApproveResult =
  | { status: 'approved'; baseline: VisualBaseline }
  | { status: 'not-found' }
  | { status: 'conflict'; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function orgBaselines(db: Kysely<unknown>, orgId: string): OrgBaselines {
  return {
    async get(project, name) {
      const { rows } = await sql<{
        project: string;
        name: string;
        page: string;
        device: string;
        object_key: string;
        run_id: string | null;
        approved_by: string;
        updated_at: Date;
      }>`select project, name, page, device, object_key, run_id, approved_by, updated_at
         from visual_baselines where org_id = ${orgId} and project = ${project} and name = ${name}`.execute(
        db,
      );
      const r = rows[0];
      return r
        ? {
            project: r.project,
            name: r.name,
            page: r.page,
            device: r.device,
            objectKey: r.object_key,
            runId: r.run_id,
            approvedBy: r.approved_by,
            updatedAt: r.updated_at,
          }
        : null;
    },
    async insertIfAbsent(b) {
      const res = await sql`insert into visual_baselines
          (org_id, project, name, page, device, object_key, run_id, approved_by)
        values (${orgId}, ${b.project}, ${b.name}, ${b.page}, ${b.device}, ${b.objectKey},
          ${b.runId}, ${b.approvedBy})
        on conflict (org_id, project, name) do nothing`.execute(db);
      return Boolean(res.numAffectedRows);
    },
    async set(b) {
      await sql`insert into visual_baselines
          (org_id, project, name, page, device, object_key, run_id, approved_by)
        values (${orgId}, ${b.project}, ${b.name}, ${b.page}, ${b.device}, ${b.objectKey},
          ${b.runId}, ${b.approvedBy})
        on conflict (org_id, project, name) do update set page = excluded.page,
          device = excluded.device, object_key = excluded.object_key, run_id = excluded.run_id,
          approved_by = excluded.approved_by, updated_at = now()`.execute(db);
    },
  };
}

/** Who approves: an API key (the API) or a signed-in user (the portal). */
export interface Approver {
  apiKeyId?: string | null;
  userId?: string | null;
}

/**
 * Makes one visual result's screenshot its project's baseline: the image is copied to a
 * new, immutable baseline key, then the baseline row is replaced and the action audited
 * (`audit_log`, `visual_baseline.approve`) in one transaction. `not-found` for another
 * org's run, an unknown run or position; `conflict` for a result that is not a hosted
 * visual comparison with a screenshot.
 */
export async function approveVisualResult(
  db: Kysely<unknown>,
  artifacts: ArtifactStore,
  {
    orgId,
    runId,
    position,
    actor,
  }: { orgId: string; runId: string; position: number; actor: Approver },
): Promise<ApproveResult> {
  if (!UUID.test(runId) || !Number.isSafeInteger(position) || position < 0)
    return { status: 'not-found' };
  const { rows } = await sql<{ kind: string; url: string | null; result: Record<string, unknown> }>`
    select r.kind, x.url, x.result from runs r
    join run_results x on x.org_id = r.org_id and x.run_id = r.id
    where r.org_id = ${orgId} and r.id = ${runId} and x.position = ${position}`.execute(db);
  const row = rows[0];
  if (!row) return { status: 'not-found' };
  const result = row.result ?? {};
  const current = (result.artifacts as { current?: unknown } | undefined)?.current;
  const { project, device } = result;
  if (
    row.kind !== 'visual' ||
    typeof current !== 'string' ||
    typeof project !== 'string' ||
    typeof device !== 'string' ||
    !row.url
  )
    return { status: 'conflict', reason: 'Not a visual comparison with a screenshot' };
  const name = artifactName(row.url, device);
  const objectKey = baselineObjectKey(orgId, project, name, runId);
  const image = await orgArtifacts(artifacts, orgId).get(current);
  if (!image) return { status: 'conflict', reason: 'The screenshot is no longer stored' };
  await orgArtifacts(artifacts, orgId).put(objectKey, image, 'image/png');
  const approvedBy = actor.apiKeyId
    ? `key:${actor.apiKeyId}`
    : actor.userId
      ? `user:${actor.userId}`
      : 'unknown';
  await db.transaction().execute(async (tx) => {
    await orgBaselines(tx, orgId).set({
      project,
      name,
      page: row.url!,
      device,
      objectKey,
      runId,
      approvedBy,
    });
    await sql`insert into audit_log (org_id, actor_user_id, actor_api_key_id, action, target, metadata)
      values (${orgId}, ${actor.userId ?? null}, ${actor.apiKeyId ?? null}, 'visual_baseline.approve',
        ${`run:${runId}#${position}`}, ${JSON.stringify({ project, page: redactString(row.url!), device })}::jsonb)`.execute(
      tx,
    );
  });
  return { status: 'approved', baseline: (await orgBaselines(db, orgId).get(project, name))! };
}
