/**
 * The current version of each legal document (#276). One place: `createAuth()` refuses
 * a sign-up that does not name these, and the portal checks signed-in users against
 * them. Each is the `version` in the front matter of the matching file in
 * `apps/portal/content/legal/` (a test keeps them equal). To publish a new version,
 * change the file's `version` and the constant here together; everyone re-accepts.
 */
export const LEGAL_VERSIONS = {
  terms: '2026-10-02',
  'acceptable-use': '2026-10-02',
} as const;

export type LegalDocument = keyof typeof LEGAL_VERSIONS;

/** What a sign-up sends as `acceptedTerms`: the exact versions the person agreed to. */
export const ACCEPTED_TERMS = `${LEGAL_VERSIONS.terms}:${LEGAL_VERSIONS['acceptable-use']}`;
