/**
 * Baseline lookup across names and branches (#343).
 *
 * Test strategy: a real BaselineManager over a temp directory (baseline.test.ts
 * mocks fs). The order that matters: every name on the branch first, and only then
 * the fallback branch, so a feature branch's own baseline saved under the pre-#343
 * name wins over main's baseline under the new name.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaselineManager } from '../../src/visual/baseline';

const META = { url: 'http://x/', title: 't', timestamp: 0, viewport: { width: 1, height: 1 } };

describe('BaselineManager.loadBaseline with several names', () => {
  let dir: string;
  let manager: BaselineManager;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-baselines-'));
    manager = new BaselineManager(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("prefers the branch's own baseline under either name over main's", async () => {
    await manager.saveBaseline('legacy_name', Buffer.from('feature-legacy'), META, 'feature');
    await manager.saveBaseline('new-name', Buffer.from('main-new'), META, 'main');

    const found = await manager.loadBaseline(['new-name', 'legacy_name'], 'feature');
    expect(found.buffer?.toString()).toBe('feature-legacy');
  });

  it('tries the names in order on a branch', async () => {
    await manager.saveBaseline('legacy_name', Buffer.from('legacy'), META, 'main');
    await manager.saveBaseline('new-name', Buffer.from('new'), META, 'main');
    expect(
      (await manager.loadBaseline(['new-name', 'legacy_name'], 'main')).buffer?.toString(),
    ).toBe('new');
  });

  it("falls back to main's baseline when the branch has none", async () => {
    await manager.saveBaseline('legacy_name', Buffer.from('main-legacy'), META, 'main');
    const found = await manager.loadBaseline(['new-name', 'legacy_name'], 'feature');
    expect(found.buffer?.toString()).toBe('main-legacy');
  });

  it('still takes a single name', async () => {
    await manager.saveBaseline('only', Buffer.from('x'), META, 'main');
    expect((await manager.loadBaseline('only', 'main')).success).toBe(true);
    expect((await manager.loadBaseline('missing', 'main')).success).toBe(false);
  });
});
