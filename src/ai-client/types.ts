import { z } from 'zod';

// Zod schemas for runtime validation

/**
 * Allowed visual-change categories. Unrecognized entries are dropped rather
 * than rejecting the whole response.
 */
export const VISION_CATEGORIES = ['layout', 'text', 'color', 'spacing', 'content'] as const;
type VisionCategory = (typeof VISION_CATEGORIES)[number];

/**
 * Runtime schema for a provider vision response (issue #66).
 *
 * Guards the boundary where raw LLM JSON first enters the system:
 * - `severity`: strict enum, **no silent default** — an invalid or empty value
 *   throws instead of degrading to `'none'` (the false-clean bug).
 * - `confidence`: clamped to `[0,1]`; defaults to `0.5` only when genuinely
 *   absent, preserving a legitimate `0` (the `|| 0.5` bug).
 * - `categories`: filtered to the whitelist, dropping unknown entries.
 * - `reasoning`: defaults when absent; `suggestions`: optional.
 *
 * The inferred type is structurally compatible with `AIVisionResponse`, so
 * downstream consumers need no signature changes.
 */
export const AIVisionResponseSchema = z.object({
  severity: z.enum(['none', 'minor', 'moderate', 'breaking']),
  confidence: z
    .number()
    .default(0.5)
    .transform((n) => Math.max(0, Math.min(1, n))),
  reasoning: z.string().default('No reasoning provided'),
  categories: z
    .array(z.string())
    .default([])
    .transform((arr) =>
      arr.filter((c): c is VisionCategory =>
        (VISION_CATEGORIES as readonly string[]).includes(c),
      ),
    ),
  suggestions: z.array(z.string()).optional(),
});

// The inferred output type; structurally compatible with base's AIVisionResponse
// (enforced at the vision.ts return sites, which are typed as AIVisionResponse).
export type ValidatedAIVisionResponse = z.infer<typeof AIVisionResponseSchema>;
