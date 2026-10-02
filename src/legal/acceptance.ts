import { sql, type Kysely } from 'kysely';
import { LEGAL_VERSIONS, type LegalDocument } from './versions';

const DOCUMENTS = Object.keys(LEGAL_VERSIONS) as LegalDocument[];

/**
 * Records that a user accepted the current version of both documents (#276). Idempotent:
 * a repeat is skipped, so the first acceptance's time and address stay. A user id with no
 * row is skipped too, quietly: with email verification required BetterAuth answers a
 * duplicate-email sign-up with a made-up user, and an error here would be noise and a
 * signal that the address exists.
 */
export async function recordCurrentAcceptance(
  db: Kysely<unknown>,
  userId: string,
  ip: string | null,
): Promise<void> {
  for (const document of DOCUMENTS) {
    await sql`
      insert into terms_acceptances (user_id, document, version, ip)
      select ${userId}, ${document}, ${LEGAL_VERSIONS[document]}, ${ip}
      where exists (select 1 from "user" where id = ${userId})
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
