import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AIVisionCache } from '../src/ai-client/cache';
import { CostTracker } from '../src/ai-client/cost-tracker';
import { purgeOrgAiState } from '../src/offboarding';

/**
 * A purged org's AI state (#349): its rows in the SQLite cost ledger and vision cache,
 * written through the real classes, go; other orgs' and local rows stay.
 */
describe('purgeOrgAiState', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ai-state-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("removes only the purged orgs' ledger and cache rows", () => {
    const ledgerPath = path.join(dir, 'cost-tracking.db');
    for (const orgId of ['org_1', 'orgX1', undefined]) {
      const t = new CostTracker(ledgerPath, {}, orgId ? { orgId } : {});
      t.trackOperation('openai', 'gpt-4o', false);
      t.close();
    }
    const cache = new AIVisionCache({ dbPath: path.join(dir, 'vision-cache.db') });
    const verdict = { classification: 'intentional' } as never;
    for (const orgId of ['org_1', 'orgX1', '']) {
      cache.set(
        cache.generateKey('b', 'c', 'openai', 'gpt-4o', '', '', orgId),
        verdict,
        'openai',
        'gpt-4o',
      );
    }
    cache.close();

    // `org_1`: the `_` must not match `orgX1` as a LIKE wildcard would.
    expect(purgeOrgAiState(['org_1'], dir)).toEqual({ ledgerRows: 1, cacheRows: 1 });
    expect(purgeOrgAiState(['org_1'], dir)).toEqual({ ledgerRows: 0, cacheRows: 0 });

    const ledger = new Database(ledgerPath, { readonly: true });
    const orgs = ledger.prepare('select org_id from cost_tracking order by org_id').all();
    ledger.close();
    expect(orgs).toEqual([{ org_id: null }, { org_id: 'orgX1' }]);
    const vision = new Database(path.join(dir, 'vision-cache.db'), { readonly: true });
    const keys = (vision.prepare('select key from ai_vision_cache').all() as { key: string }[]).map(
      (r) => r.key,
    );
    vision.close();
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.startsWith('org=orgX1:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('org=org_1:'))).toBe(false);
  });

  it('does nothing when the files do not exist', () => {
    expect(purgeOrgAiState(['org_1'], path.join(dir, 'none'))).toEqual({
      ledgerRows: 0,
      cacheRows: 0,
    });
  });
});
