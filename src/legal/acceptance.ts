import { sql, type Kysely } from 'kysely';
import { LEGAL_VERSIONS, type LegalDocument } from './versions';

const DOCUMENTS = Object.keys(LEGAL_VERSIONS) as LegalDocument[];

/**
 * Records that a user accepted the current version of both documents (#276). Idempotent:
 * a repeat is skipped, so the first acceptance's time and address stay.
 */
export async function recordCurrentAcceptance(
  db: Kysely<unknown>,
  userId: string,
  ip: string | null,
): Promise<void> {
  for (const document of DOCUMENTS) {
    await sql`
      insert into terms_acceptances (user_id, document, version, ip)
      values (${userId}, ${document}, ${LEGAL_VERSIONS[document]}, ${ip})
      on conflict (user_id, document, version) do nothing`.execute(db);
  }
}

/** True when the user has accepted the current version of every document. */
export async function hasAcceptedCurrent(db: Kysely<unknown>, userId: string): Promise<boolean> {
  const { rows } = await sql<{ document: string; version: string }>`
    select document, version from terms_acceptances where user_id = ${userId}`.execute(db);
  return DOCUMENTS.every((d) =>
    rows.some((r) => r.document === d && r.version === LEGAL_VERSIONS[d]),
  );
}
