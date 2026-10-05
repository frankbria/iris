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

/**
 * Published documents nobody has to accept (#277): the privacy policy, the subprocessor
 * list and the DPA template. Kept apart from `LEGAL_VERSIONS` on purpose: every key there
 * is one a user must accept before using the portal. A test keeps each equal to its
 * file's front-matter `version`.
 */
export const PUBLISHED_VERSIONS = {
  privacy: '2026-10-04',
  subprocessors: '2026-10-02',
  dpa: '2026-10-02',
} as const;

export type PublishedDocument = keyof typeof PUBLISHED_VERSIONS;

/** What a sign-up sends as `acceptedTerms`: the exact versions the person agreed to. */
export const ACCEPTED_TERMS = `${LEGAL_VERSIONS.terms}:${LEGAL_VERSIONS['acceptable-use']}`;
