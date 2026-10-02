import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Visual artifact names and the per-run layout (#343).
 *
 * A run writes its screenshots, diffs and a copy of each baseline it compared
 * against into its own directory, `<root>/runs/<runId>/<kind>/<name>.png`, so a
 * later or concurrent run never overwrites what an earlier report points at. The
 * hosted object-storage keys (#257) use the same run id and names under
 * `org/<org>/project/<project>/run/<runId>/`.
 */

export type ArtifactKind = 'current' | 'diff' | 'baseline';

const SAFE_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * A file-system-safe name for one (page, device) comparison: a readable slug of the
 * page, then the device, then a hash of the exact pair. The hash is what makes it
 * collision-free (`/a/b` and `/a_b` used to be one file, and one baseline); the
 * slug is only for people. Only `[A-Za-z0-9_-]`, at most 100 characters.
 */
export function artifactName(page: string, device: string): string {
  const slug =
    page
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'page';
  const deviceSlug = device.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 20) || 'device';
  const hash = createHash('sha256')
    .update(JSON.stringify([page, device]))
    .digest('hex');
  return `${slug}_${deviceSlug}-${hash.slice(0, 10)}`;
}

/**
 * The name used before #343, kept only to find a baseline saved under it. Distinct
 * pages could share it, which is why it is no longer written.
 */
export function legacyArtifactName(page: string, device: string): string {
  return `${page.replace(/\//g, '_')}_${device}`;
}

/** A run id that sorts by start time (UTC, to the second) and never collides. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

/**
 * Where one artifact of a run goes. Creates the directory.
 *
 * @throws when the run id or name could leave the run's directory: both reach the
 *   file system, and a run id may come from a caller
 */
export function runArtifactPath(
  root: string,
  runId: string,
  kind: ArtifactKind,
  name: string,
): string {
  if (!SAFE_NAME.test(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid artifact name: ${JSON.stringify(name)}`);
  const dir = path.join(path.resolve(root), 'runs', runId, kind);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}
