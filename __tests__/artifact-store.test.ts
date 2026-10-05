import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
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
    expect(Object.keys(signed).sort()).toEqual(['baseline', 'diff']);
    expect(dropped.sort()).toEqual([
      'lookalike',
      'malformed',
      'notAString',
      'otherOrg',
      'otherRun',
    ]);
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
    const listed = await admin.send(new ListObjectsV2Command({ Bucket: bucket }));
    const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length)
      await admin.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
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
