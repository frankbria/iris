import * as fs from 'fs';
import * as path from 'path';
import { BaselineManager } from '../../src/visual/baseline';

/**
 * Real-filesystem tests for issue #65: caller-supplied branch names must not
 * escape baselineDir on save/load/delete/list/cleanup. baseline.test.ts mocks
 * fs and path entirely, so traversal has to be proven here with real paths.
 */
describe('BaselineManager path traversal hardening', () => {
  const rootDir = path.join(__dirname, '../../.test-baseline-security');
  const baselineDir = path.join(rootDir, 'nested', 'baselines');
  const outsideDir = path.join(rootDir, 'outside');
  // Traverses from baselineDir up to rootDir/outside
  const evilBranch = '../../outside';
  let manager: BaselineManager;

  const metadata = {
    url: 'https://example.com',
    title: 'Test Page',
    timestamp: 1,
    viewport: { width: 800, height: 600 },
    gitBranch: 'main',
    gitCommit: 'abc123',
  };

  beforeEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    manager = new BaselineManager(baselineDir);
  });

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('saveBaseline keeps a malicious branch inside the baseline directory', async () => {
    const result = await manager.saveBaseline('victim', Buffer.from('img'), metadata, evilBranch);

    expect(result.success).toBe(true);
    const base = path.resolve(baselineDir) + path.sep;
    expect(path.resolve(result.path!).startsWith(base)).toBe(true);
    expect(fs.existsSync(path.join(outsideDir, 'victim.png'))).toBe(false);
  });

  it('loadBaseline does not read files outside the baseline directory', async () => {
    fs.writeFileSync(path.join(outsideDir, 'leak.png'), 'secret');
    fs.writeFileSync(path.join(outsideDir, 'leak.json'), JSON.stringify(metadata));

    const result = await manager.loadBaseline('leak', evilBranch);

    expect(result.success).toBe(false);
  });

  it('deleteBaseline does not unlink files outside the baseline directory', async () => {
    const sentinel = path.join(outsideDir, 'sentinel.png');
    fs.writeFileSync(sentinel, 'keep me');

    const result = await manager.deleteBaseline('sentinel', evilBranch);

    expect(result.success).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('listBaselines does not enumerate directories outside the baseline directory', async () => {
    fs.writeFileSync(path.join(outsideDir, 'other.png'), 'x');

    await expect(manager.listBaselines(evilBranch)).resolves.toEqual([]);
  });

  it('cleanupOldBaselines does not delete outside the baseline directory', async () => {
    const sentinel = path.join(outsideDir, 'old.png');
    fs.writeFileSync(sentinel, 'x');

    // maxAgeDays -1 puts the cutoff in the future so any reachable file would be deleted
    const result = await manager.cleanupOldBaselines(-1, evilBranch);

    expect(result.success).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('generateBaselinePath contains hostile branch names within the baseline directory', () => {
    const base = path.resolve(baselineDir) + path.sep;
    for (const branch of ['../../outside', '..', '/etc', 'a/../../b', '....//']) {
      const resolved = path.resolve(manager.generateBaselinePath('t', branch));
      expect(resolved.startsWith(base)).toBe(true);
    }
  });
});
