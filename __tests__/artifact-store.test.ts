import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { removeBucket } from './utils/s3-bucket';
import {
  baselineKey,
  FilesystemArtifactStore,
  orgArtifacts,
  runArtifactKey,
  signRunArtifacts,
  S3ArtifactStore,
} from '../src/artifact-store';

/**
 * Artifact storage (#257). Keys are tenant-prefixed and built from validated segments;
 * the S3 store runs against a real S3-compatible server (SeaweedFS, owner decision),
 * no fakes: `IRIS_TEST_S3_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`, as in
 * docker-compose.dev.yml. Required under CI, skipped with a notice locally.
 */

describe('artifact keys', () => {
  const ids = { orgId: 'org_A1', projectId: 'proj-1' };

  it('puts every run artifact under its org, project and run', () => {
    expect(
      runArtifactKey({
        ...ids,
        runId: '20261003T120000Z-ab12cd34',
        kind: 'diff',
        name: 'home_desktop-0123456789',
      }),
    ).toBe(
      'org/org_A1/project/proj-1/run/20261003T120000Z-ab12cd34/diff/home_desktop-0123456789.png',
    );
  });

  it('puts baselines under the project, outside any run', () => {
    expect(baselineKey({ ...ids, name: 'home_desktop-0123456789' })).toBe(
      'org/org_A1/project/proj-1/baselines/home_desktop-0123456789.png',
    );
  });

  it.each([
    ['an org id with a slash', { orgId: 'a/b' }],
    ['a dot-dot org id', { orgId: '..' }],
    ['an empty project id', { projectId: '' }],
    ['a run id with a dot', { runId: 'r.1' }],
    ['a name with a slash', { name: '../x' }],
    ['an unknown kind', { kind: 'secrets' }],
  ])('refuses %s', (_label, bad) => {
    const args = { ...ids, runId: 'r1', kind: 'current', name: 'n', ...bad };

    expect(() => runArtifactKey(args as any)).toThrow(/Invalid/);
  });
});

describe('FilesystemArtifactStore', () => {
  let root: string;
  let store: FilesystemArtifactStore;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-artifacts-'));
    store = new FilesystemArtifactStore(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('stores and reads back an artifact under its key', async () => {
    const key = baselineKey({ orgId: 'o1', projectId: 'p1', name: 'n1' });
    await store.put(key, Buffer.from('png-bytes'), 'image/png');
    expect(fs.readFileSync(path.join(root, key), 'utf8')).toBe('png-bytes');
    expect((await store.get(key))?.toString()).toBe('png-bytes');
  });

  it('answers null for a missing artifact', async () => {
    expect(await store.get('org/o1/project/p1/baselines/none.png')).toBeNull();
  });

  it('refuses a key that would leave its root', async () => {
    await expect(store.put('org/../../escape.png', Buffer.from('x'), 'image/png')).rejects.toThrow(
      /Invalid/,
    );
    await expect(store.get('/etc/passwd')).rejects.toThrow(/Invalid/);
  });

  it("an org's view refuses another org's keys for every operation", async () => {
    const theirs = baselineKey({ orgId: 'orgB', projectId: 'p1', name: 'n1' });
    await store.put(theirs, Buffer.from('org B'), 'image/png');
    const mine = orgArtifacts(store, 'orgA');
    await expect(mine.get(theirs)).rejects.toThrow(/Invalid artifact key for org/);
    await expect(mine.signedUrl(theirs)).rejects.toThrow(/Invalid artifact key for org/);
    await expect(mine.put(theirs, Buffer.from('x'), 'image/png')).rejects.toThrow(/Invalid/);
    // A prefix that only starts like the org id is another org too.
    await expect(mine.get('org/orgAB/project/p1/baselines/n1.png')).rejects.toThrow(/Invalid/);
    // Positive control: its own keys work.
    const own = baselineKey({ orgId: 'orgA', projectId: 'p1', name: 'n1' });
    await mine.put(own, Buffer.from('org A'), 'image/png');
    expect((await mine.get(own))?.toString()).toBe('org A');
    expect(fs.readFileSync(path.join(root, theirs), 'utf8')).toBe('org B');
  });

  // #460: what run detail signs from a stored `artifacts` value.
  it("signs only this run's keys and same-org baselines, nothing malformed", async () => {
    const scope = { orgId: 'orgA', runId: 'run1' };
    expect(await signRunArtifacts(store, scope, null)).toEqual({ signed: {}, dropped: [] });
    expect(await signRunArtifacts(store, scope, ['x'])).toEqual({ signed: {}, dropped: [] });
    const { signed, dropped } = await signRunArtifacts(store, scope, {
      diff: runArtifactKey({
        orgId: 'orgA',
        projectId: 'p',
        runId: 'run1',
        kind: 'diff',
        name: 'n',
      }),
      baseline: baselineKey({ orgId: 'orgA', projectId: 'p', name: 'n' }),
      otherRun: runArtifactKey({
        orgId: 'orgA',
        projectId: 'p',
        runId: 'run2',
        kind: 'diff',
        name: 'n',
      }),
      otherOrg: runArtifactKey({
        orgId: 'orgB',
        projectId: 'p',
        runId: 'run1',
        kind: 'diff',
        name: 'n',
      }),
      lookalike: 'org/orgAB/project/p/run/run1/diff/n.png',
      malformed: 'org/orgA/project/p/run/run1/diff/a b.png',
      notAString: 42,
    });
    // A name like `__proto__` is just a name: no prototype assignment, still signed.
    const proto = await signRunArtifacts(
      store,
      scope,
      JSON.parse(`{"__proto__": "${baselineKey({ orgId: 'orgA', projectId: 'p', name: 'n' })}"}`),
    );
    expect(Object.keys(proto.signed)).toEqual(['__proto__']);
    expect(Object.keys(signed).sort()).toEqual(['baseline', 'diff']);
    expect(dropped.sort()).toEqual([
      'lookalike',
      'malformed',
      'notAString',
      'otherOrg',
      'otherRun',
    ]);
  });

  // #472: what retention deletes, and nothing beside it.
  it('deletes everything under a prefix and nothing else; refuses an unsafe prefix', async () => {
    const run1 = runArtifactKey({
      orgId: 'o1',
      projectId: 'p',
      runId: 'r1',
      kind: 'current',
      name: 'a',
    });
    const run1diff = runArtifactKey({
      orgId: 'o1',
      projectId: 'p',
      runId: 'r1',
      kind: 'diff',
      name: 'a',
    });
    const run2 = runArtifactKey({
      orgId: 'o1',
      projectId: 'p',
      runId: 'r2',
      kind: 'current',
      name: 'a',
    });
    const base = baselineKey({ orgId: 'o1', projectId: 'p', name: 'a' });
    for (const k of [run1, run1diff, run2, base]) await store.put(k, Buffer.from('x'), 'image/png');
    expect(await store.deletePrefix('org/o1/project/p/run/r1/')).toBe(2);
    expect(await store.get(run1)).toBeNull();
    expect(await store.get(run2)).not.toBeNull();
    expect(await store.get(base)).not.toBeNull();
    expect(await store.deletePrefix('org/o1/project/p/run/none/')).toBe(0);
    for (const bad of ['', '/', 'org/o1', '../', 'org/../', 'org//']) {
      await expect(store.deletePrefix(bad)).rejects.toThrow(/Invalid artifact prefix/);
    }
    // An org's view cannot delete another org's prefix.
    await expect(orgArtifacts(store, 'o2').deletePrefix('org/o1/')).rejects.toThrow(/Invalid/);
  });

  it('deletes one artifact; a missing one is no error (#475)', async () => {
    const key = baselineKey({ orgId: 'o1', projectId: 'p', name: 'gone--abc' });
    await store.put(key, Buffer.from('x'), 'image/png');
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.delete(key);
    await expect(store.delete('../x.png')).rejects.toThrow(/Invalid artifact key/);
    await expect(orgArtifacts(store, 'o2').delete(key)).rejects.toThrow(/Invalid/);
  });

  it('gives the local file as the retrieval URL', async () => {
    const key = baselineKey({ orgId: 'o1', projectId: 'p1', name: 'n1' });
    await store.put(key, Buffer.from('x'), 'image/png');
    expect(fileURLToPath(await store.signedUrl(key))).toBe(path.join(root, key));
  });
});

const endpoint = process.env.IRIS_TEST_S3_ENDPOINT;
const accessKeyId = process.env.IRIS_TEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.IRIS_TEST_S3_SECRET_ACCESS_KEY;
const s3Configured = Boolean(endpoint && accessKeyId && secretAccessKey);
if (!s3Configured) {
  if (process.env.CI) throw new Error('IRIS_TEST_S3_* is required in CI');
  console.warn('Skipping S3 artifact tests: set IRIS_TEST_S3_* (see docker-compose.dev.yml)');
}

(s3Configured ? describe : describe.skip)('S3ArtifactStore (SeaweedFS)', () => {
  const bucket = `iris-test-${randomBytes(4).toString('hex')}`;
  const credentials = { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! };
  const admin = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials });
  const store = new S3ArtifactStore({
    endpoint: endpoint!,
    region: 'us-east-1',
    bucket,
    credentials,
  });
  const key = runArtifactKey({
    orgId: 'orgA',
    projectId: 'p1',
    runId: 'run1',
    kind: 'current',
    name: 'home',
  });
  const other = runArtifactKey({
    orgId: 'orgB',
    projectId: 'p1',
    runId: 'run1',
    kind: 'current',
    name: 'home',
  });

  beforeAll(async () => {
    // The S3 port answers (403 to anonymous) before the storage layers behind it are
    // ready, so the first bucket creation may fail on a slow runner: retry it briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await store.put(key, Buffer.from('org A screenshot'), 'image/png');
    await store.put(other, Buffer.from('org B screenshot'), 'image/png');
  });

  afterAll(async () => {
    await removeBucket(admin, bucket);
    admin.destroy();
    store.close();
  });

  it('stores and reads back an artifact', async () => {
    expect((await store.get(key))?.toString()).toBe('org A screenshot');
  });

  it('answers null for a missing artifact', async () => {
    expect(
      await store.get(baselineKey({ orgId: 'orgA', projectId: 'p1', name: 'none' })),
    ).toBeNull();
  });

  it('serves an artifact through a signed URL', async () => {
    const res = await fetch(await store.signedUrl(key));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('org A screenshot');
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  // The bucket is private: the positive control above uses the same object.
  it('refuses an unsigned GET', async () => {
    const res = await fetch(`${endpoint}/${bucket}/${key}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('screenshot');
  });

  it("refuses a signed URL edited to point at another org's artifact", async () => {
    const signed = new URL(await store.signedUrl(key));
    signed.pathname = `/${bucket}/${other}`;
    const res = await fetch(signed);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('org B');
  });

  it('refuses a signed URL once it has expired', async () => {
    const url = await store.signedUrl(key, 1);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(url)).status).toBe(403);
  });

  it('deletes a prefix across listing pages (over 1000 objects)', async () => {
    const keys = Array.from({ length: 1005 }, (_, i) =>
      runArtifactKey({
        orgId: 'orgA',
        projectId: 'p',
        runId: 'many',
        kind: 'current',
        name: `n${i}`,
      }),
    );
    for (let i = 0; i < keys.length; i += 50)
      await Promise.all(
        keys.slice(i, i + 50).map((k) => store.put(k, Buffer.from('x'), 'image/png')),
      );
    expect(await store.deletePrefix('org/orgA/project/p/run/many/')).toBe(1005);
    expect(await store.get(keys[1004])).toBeNull();
    expect((await store.get(key))?.toString()).toBe('org A screenshot');
  }, 120_000);

  it('deletes one object; a missing one is no error (#475)', async () => {
    const one = baselineKey({ orgId: 'orgA', projectId: 'p', name: 'old--abc' });
    await store.put(one, Buffer.from('x'), 'image/png');
    await store.delete(one);
    expect(await store.get(one)).toBeNull();
    await store.delete(one);
    expect((await store.get(key))?.toString()).toBe('org A screenshot');
  });

  it('caps a signed URL at 15 minutes', async () => {
    expect(new URL(await store.signedUrl(key, 3600)).searchParams.get('X-Amz-Expires')).toBe('900');
    expect(new URL(await store.signedUrl(key)).searchParams.get('X-Amz-Expires')).toBe('300');
    // Not a number is the default, not `X-Amz-Expires=NaN`.
    expect(new URL(await store.signedUrl(key, NaN)).searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('refuses an unsafe key for every operation', async () => {
    for (const bad of ['../escape.png', '/org/a.png', 'org/a/../b.png', 'org/a b.png']) {
      await expect(store.put(bad, Buffer.from('x'), 'image/png')).rejects.toThrow(/Invalid/);
      await expect(store.get(bad)).rejects.toThrow(/Invalid/);
      await expect(store.signedUrl(bad)).rejects.toThrow(/Invalid/);
    }
  });
});

/**
 * Bucket versioning (#445): what a delete or an overwrite leaves behind, how it comes
 * back, and when it is gone for good. One bucket; the cases run in order.
 */
(s3Configured ? describe : describe.skip)('S3ArtifactStore versioning (SeaweedFS)', () => {
  const bucket = `iris-test-${randomBytes(4).toString('hex')}`;
  const credentials = { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! };
  const admin = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials });
  const store = new S3ArtifactStore({
    endpoint: endpoint!,
    region: 'us-east-1',
    bucket,
    credentials,
  });
  const baseline = baselineKey({ orgId: 'orgA', projectId: 'p1', name: 'home' });
  const shot = (name: string) =>
    runArtifactKey({ orgId: 'orgA', projectId: 'p1', runId: 'run1', kind: 'current', name });
  const text = async (key: string) => (await store.get(key))?.toString();
  const future = () => new Date(Date.now() + 60_000);

  beforeAll(async () => {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    await removeBucket(admin, bucket);
    admin.destroy();
    store.close();
  });

  it('is off on a new bucket, where pruning does nothing, and turns on idempotently', async () => {
    await store.put(shot('before'), Buffer.from('stored before versioning'), 'image/png');
    expect(await store.versioningEnabled()).toBe(false);
    expect(await store.pruneVersions(future())).toBe(0);
    await store.enableVersioning();
    await store.enableVersioning();
    expect(await store.versioningEnabled()).toBe(true);
    expect(await text(shot('before'))).toBe('stored before versioning');
  });

  it('lists the versions of one key, current first, and no other key', async () => {
    await store.put(baseline, Buffer.from('approved look'), 'image/png');
    await store.put(baseline, Buffer.from('wrong look'), 'image/png');
    await store.put(`${baseline.slice(0, -4)}2.png`, Buffer.from('neighbour'), 'image/png');
    const versions = await store.versions(baseline);
    expect(versions.map((v) => [v.latest, v.deleteMarker, v.size])).toEqual([
      [true, false, 10],
      [false, false, 13],
    ]);
    expect(await store.versions(shot('never-stored'))).toEqual([]);
  });

  it('restores an overwritten object from a chosen version, content type included', async () => {
    const [, approved] = await store.versions(baseline);
    await store.restoreVersion(baseline, approved.versionId);
    expect(await text(baseline)).toBe('approved look');
    const res = await fetch(await store.signedUrl(baseline));
    expect(res.headers.get('content-type')).toBe('image/png');
    await res.arrayBuffer();
    await expect(store.restoreVersion(baseline, 'no-such-version')).rejects.toThrow();
    expect(await text(baseline)).toBe('approved look');
  });

  it('undeletes one key, and leaves a key that was not deleted alone', async () => {
    await store.delete(baseline);
    expect(await store.get(baseline)).toBeNull();
    expect((await store.versions(baseline))[0]).toMatchObject({ latest: true, deleteMarker: true });
    expect(await store.undelete(baseline)).toBe(1);
    expect(await text(baseline)).toBe('approved look');
    expect(await store.undelete(baseline)).toBe(0);
    expect(await text(baseline)).toBe('approved look');
  });

  // Written within one second, a version and two delete markers cannot be ordered by time.
  it('undeletes a key deleted twice in the same second as it was written', async () => {
    const key = shot('twice');
    await store.put(key, Buffer.from('still here'), 'image/png');
    await store.delete(key);
    await store.delete(key);
    expect(await store.undelete(key)).toBe(1);
    expect(await text(key)).toBe('still here');
    expect(await store.versions(key)).toHaveLength(1);
  });

  it('undeletes a purged prefix across listing pages, and only that prefix', async () => {
    const keys = Array.from({ length: 1005 }, (_, i) =>
      runArtifactKey({
        orgId: 'orgA',
        projectId: 'p',
        runId: 'many',
        kind: 'current',
        name: `n${i}`,
      }),
    );
    for (let i = 0; i < keys.length; i += 50)
      await Promise.all(
        keys.slice(i, i + 50).map((k) => store.put(k, Buffer.from(k), 'image/png')),
      );
    const elsewhere = runArtifactKey({
      orgId: 'orgB',
      projectId: 'p',
      runId: 'many',
      kind: 'current',
      name: 'n0',
    });
    await store.put(elsewhere, Buffer.from('org B'), 'image/png');
    await store.delete(elsewhere);
    // Deleted twice: two delete markers in front of the object.
    await store.put(keys[0], Buffer.from('second'), 'image/png');
    await store.deletePrefix('org/orgA/project/p/run/many/');
    await store.deletePrefix('org/orgA/project/p/run/many/');
    expect(await store.get(keys[1004])).toBeNull();

    expect(await store.undelete('org/orgA/project/p/run/many/')).toBe(1005);
    expect(await text(keys[1004])).toBe(keys[1004]);
    expect(await text(keys[0])).toBe('second');
    expect(await store.get(elsewhere)).toBeNull();
    await expect(store.undelete('org/orgA/../orgB/')).rejects.toThrow(/Invalid artifact prefix/);
    await expect(store.undelete('../x.png')).rejects.toThrow(/Invalid artifact key/);
  }, 180_000);

  it('prunes by when a version stopped being current, not by its own age', async () => {
    const key = shot('aged');
    await store.put(key, Buffer.from('old'), 'image/png');
    // Timestamps have one-second resolution: the cutoff sits between the two writes.
    await new Promise((r) => setTimeout(r, 1100));
    const between = new Date();
    await new Promise((r) => setTimeout(r, 1100));
    await store.put(key, Buffer.from('new'), 'image/png');
    const count = async () => (await store.versions(key)).length;

    // "old" was written before the cutoff but replaced after it: still recoverable.
    await store.pruneVersions(between);
    expect(await count()).toBe(2);

    await store.pruneVersions(future());
    expect(await count()).toBe(1);
    expect(await text(key)).toBe('new');
  });

  it('pruning removes old versions and spent delete markers, never a current object', async () => {
    const gone = shot('gone');
    await store.put(gone, Buffer.from('deleted for good'), 'image/png');
    await store.delete(gone);
    await store.delete(shot('before'));

    expect(await store.pruneVersions(new Date(Date.now() - 3_600_000))).toBe(0);
    expect(await store.versions(gone)).toHaveLength(2);

    expect(await store.pruneVersions(future())).toBeGreaterThan(0);
    expect(await store.versions(gone)).toEqual([]);
    // The object stored before versioning was on went the same way.
    expect(await store.versions(shot('before'))).toEqual([]);
    expect(await store.undelete(gone)).toBe(0);
    // Current objects, restored or never touched, are all still there.
    expect(await text(baseline)).toBe('approved look');
    expect(await store.versions(baseline)).toHaveLength(1);
    const last = 'org/orgA/project/p/run/many/current/n1004.png';
    expect(await text(last)).toBe(last);
    expect(await store.pruneVersions(future())).toBe(0);
  }, 120_000);
});
