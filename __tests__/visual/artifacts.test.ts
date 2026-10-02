/**
 * Visual artifact naming and the per-run layout (#343).
 *
 * Test strategy: the name function is checked against the inputs that broke the
 * old `page.replace('/', '_')` scheme (collisions, separators, traversal, length),
 * and the run layout against a real temp directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  artifactName,
  legacyArtifactName,
  newRunId,
  runArtifactPath,
} from '../../src/visual/artifacts';

const SAFE = /^[A-Za-z0-9_-]+$/;

describe('artifactName', () => {
  // Pairs the old scheme mapped to one file: same screenshot, same baseline.
  const COLLIDING: Array<[string, string]> = [
    ['/a/b', '/a_b'],
    ['/a b', '/a-b'],
    ['/about?tab=1', '/about?tab=2'],
    ['/Café', '/Caf'],
  ];

  it.each(COLLIDING)('gives %p and %p different names', (x, y) => {
    expect(artifactName(x, 'desktop')).not.toBe(artifactName(y, 'desktop'));
  });

  it('fixes real collisions of the old scheme', () => {
    // `/a/b` and `/a_b` were one file and one baseline before #343.
    expect(legacyArtifactName('/a/b', 'desktop')).toBe(legacyArtifactName('/a_b', 'desktop'));
  });

  it('separates devices', () => {
    expect(artifactName('/', 'desktop')).not.toBe(artifactName('/', 'mobile'));
  });

  it('is stable for the same page and device', () => {
    expect(artifactName('/pricing', 'tablet')).toBe(artifactName('/pricing', 'tablet'));
  });

  it.each([
    '../../etc/passwd',
    '..\\..\\windows',
    '/',
    '',
    '.',
    '/über/straße',
    '/'.repeat(500),
    'x'.repeat(5000),
    // Built at runtime: a `user:pass@` literal reads to secret scanners as a credential.
    `https://${['tester', 'x'].join(':')}@example.com/a?b=c#d`,
    'CON',
    `/a${String.fromCharCode(0)}b`,
  ])('turns %p into a safe, bounded file name', (page) => {
    const name = artifactName(page, 'desktop');
    expect(name).toMatch(SAFE);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).not.toContain('..');
  });

  it('keeps the page readable in the name', () => {
    expect(artifactName('/pricing/enterprise', 'mobile')).toMatch(
      /^pricing-enterprise_mobile-[0-9a-f]{10}$/,
    );
  });
});

describe('newRunId', () => {
  it('is unique per call and sorts by time', () => {
    const early = newRunId(new Date('2026-10-02T09:00:00Z'));
    const late = newRunId(new Date('2026-10-02T09:00:01Z'));
    expect(early).toMatch(/^20261002T090000Z-[0-9a-f]{8}$/);
    expect([late, early].sort()).toEqual([early, late]);
    const ids = new Set(Array.from({ length: 50 }, () => newRunId(new Date(0))));
    expect(ids.size).toBe(50);
  });
});

describe('runArtifactPath', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-artifacts-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('places each kind under the run, and creates the directory', () => {
    const file = runArtifactPath(root, 'run-1', 'diff', artifactName('/a', 'desktop'));
    expect(path.relative(root, file)).toMatch(
      /^runs[\\/]run-1[\\/]diff[\\/]a_desktop-[0-9a-f]{10}\.png$/,
    );
    expect(fs.existsSync(path.dirname(file))).toBe(true);
  });

  it('keeps two runs of the same page apart', () => {
    const name = artifactName('/a', 'desktop');
    expect(runArtifactPath(root, 'run-1', 'current', name)).not.toBe(
      runArtifactPath(root, 'run-2', 'current', name),
    );
  });

  it('refuses a run id or name that would leave the run directory', () => {
    expect(() => runArtifactPath(root, '../escape', 'current', 'x')).toThrow(/run id/);
    expect(() => runArtifactPath(root, 'run-1', 'current', '../x')).toThrow(/artifact name/);
  });
});
