import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ArtifactKind } from './visual/artifacts';
import { readSecretEnv } from './secret-env';

/**
 * Where visual artifacts live (#257): the local file system for the CLI, an
 * S3-compatible bucket for the hosted service (SeaweedFS in dev, CI and staging; the
 * production vendor is chosen separately). Keys carry the tenant first, so one org's
 * prefix never contains another's, and are built only from validated segments.
 */
export interface ArtifactStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** `null` when there is no such artifact. */
  get(key: string): Promise<Buffer | null>;
  /** A short-lived URL for reading one artifact (at most 15 minutes for S3). */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
  /**
   * Deletes every artifact under `prefix` (safe segments ending in `/`, #472); returns
   * how many went. Nothing there is not an error.
   */
  deletePrefix(prefix: string): Promise<number>;
  /** Deletes one artifact (#475). Nothing there is not an error. */
  delete(key: string): Promise<void>;
  /**
   * On a store that keeps old versions (#445): permanently deletes those that stopped
   * being current before `olderThan`; returns how many went.
   */
  pruneVersions?(olderThan: Date): Promise<number>;
}

/** One stored version of a key (#445). A delete marker is the "version" a delete leaves. */
export interface ArtifactVersion {
  versionId: string;
  lastModified: Date;
  size: number;
  latest: boolean;
  deleteMarker: boolean;
}

/** Safe segments ending in `/`: what may be bulk-deleted. Never empty, never the root. */
const PREFIX = /^(?:[A-Za-z0-9_-]+\/)+$/;

function assertPrefix(prefix: string): string {
  if (typeof prefix !== 'string' || prefix.length > 1024 || !PREFIX.test(prefix)) {
    throw new Error(`Invalid artifact prefix: ${JSON.stringify(prefix)}`);
  }
  return prefix;
}

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS: readonly ArtifactKind[] = ['current', 'diff', 'baseline'];
/** Slash-separated safe segments, the last with an optional extension: no `..`, no leading `/`. */
const KEY = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[a-z0-9]{1,8})?$/;

function segment(label: string, value: string): string {
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertKey(key: string): string {
  if (typeof key !== 'string' || key.length > 1024 || !KEY.test(key)) {
    throw new Error(`Invalid artifact key: ${JSON.stringify(key)}`);
  }
  return key;
}

interface ProjectScope {
  orgId: string;
  projectId: string;
}

const projectPrefix = ({ orgId, projectId }: ProjectScope) =>
  `org/${segment('org id', orgId)}/project/${segment('project id', projectId)}`;

/** `org/<org>/project/<project>/run/<runId>/<kind>/<name>.png`: #343's run id and name. */
export function runArtifactKey(
  args: ProjectScope & { runId: string; kind: ArtifactKind; name: string },
): string {
  if (!KINDS.includes(args.kind))
    throw new Error(`Invalid artifact kind: ${JSON.stringify(args.kind)}`);
  return `${projectPrefix(args)}/run/${segment('run id', args.runId)}/${args.kind}/${segment('artifact name', args.name)}.png`;
}

/** `org/<org>/project/<project>/baselines/<name>.png`: outlives any one run. */
export function baselineKey(args: ProjectScope & { name: string }): string {
  return `${projectPrefix(args)}/baselines/${segment('artifact name', args.name)}.png`;
}

/**
 * A baseline image's key: per (project, page/device) **and run**, so an image is never
 * replaced in place. A seeding job cannot overwrite another's, and an old run's link to
 * the baseline it was compared with keeps showing that image after a later approval.
 */
export function baselineObjectKey(
  orgId: string,
  project: string,
  name: string,
  runId: string,
): string {
  return baselineKey({
    orgId,
    projectId: project,
    name: `${name}--${runId.replace(/-/g, '').slice(0, 12)}`,
  });
}

/** Local mode: artifacts are files under `root`; the "signed" URL is the file's URL. */
export class FilesystemArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private file(key: string): string {
    return path.join(this.root, assertKey(key));
  }

  // The file system keeps no content type: the extension says what it is.
  async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const file = this.file(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this.file(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async signedUrl(key: string): Promise<string> {
    return pathToFileURL(this.file(key)).href;
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const dir = path.join(this.root, assertPrefix(prefix));
    let count = 0;
    const walk = async (d: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(d, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else count++;
      }
    };
    await walk(dir);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return count;
  }
}

export interface S3ArtifactStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

/** Signed URLs are short-lived: a leaked one stops working within minutes. */
const MAX_TTL_SECONDS = 15 * 60;
const DEFAULT_TTL_SECONDS = 5 * 60;

interface VersionRef {
  Key: string;
  VersionId: string;
}

/** The current version first, then by time written. */
const newestFirst = (a: ArtifactVersion, b: ArtifactVersion) =>
  Number(b.latest) - Number(a.latest) || b.lastModified.getTime() - a.lastModified.getTime();

/**
 * Hosted mode: a private bucket on an S3-compatible server, path-style addressing
 * (SeaweedFS and most self-hosted servers have no per-bucket DNS). Reads by tenants go
 * through `signedUrl`; nothing makes an object public.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  readonly bucket: string;

  constructor({ endpoint, region, bucket, credentials }: S3ArtifactStoreConfig) {
    this.client = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
    this.bucket = bucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: assertKey(key),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: assertKey(key) }),
      );
      if (!res.Body) throw new Error(`Artifact ${key} came back with no body`);
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (error) {
      // By name too: a second copy of the SDK in node_modules breaks `instanceof`.
      if (error instanceof NoSuchKey || (error as Error).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async signedUrl(key: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
    const ttl = Number.isFinite(ttlSeconds) ? Math.trunc(ttlSeconds) : DEFAULT_TTL_SECONDS;
    const expiresIn = Math.min(Math.max(ttl, 1), MAX_TTL_SECONDS);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: assertKey(key) }),
      {
        expiresIn,
      },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: assertKey(key) }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    const Prefix = assertPrefix(prefix);
    let count = 0;
    let ContinuationToken: string | undefined;
    // List a page (at most 1000 keys), delete it in one call, until the listing ends.
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix, ContinuationToken }),
      );
      const Objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (Objects.length) {
        const res = await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects, Quiet: true } }),
        );
        if (res.Errors?.length)
          throw new Error(`Could not delete ${res.Errors.length} artifact(s) under ${Prefix}`);
        count += Objects.length;
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return count;
  }

  /** Whether the bucket keeps old versions of overwritten and deleted objects (#445). */
  async versioningEnabled(): Promise<boolean> {
    const res = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
    return res.Status === 'Enabled';
  }

  /** From now on an overwrite or a delete keeps the old object as a version. Idempotent. */
  async enableVersioning(): Promise<void> {
    await this.client.send(
      new PutBucketVersioningCommand({
        Bucket: this.bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
  }

  /**
   * Every key under `Prefix` with all its versions, current first. A key's versions can
   * straddle listing pages, and only the page's last key (`NextKeyMarker`) can, so that
   * one is carried into the next page rather than yielded half-read.
   */
  private async *keyVersions(Prefix?: string): AsyncGenerator<[string, ArtifactVersion[]]> {
    let carried: [string, ArtifactVersion[]] | undefined;
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix, KeyMarker, VersionIdMarker }),
      );
      const byKey = new Map<string, ArtifactVersion[]>(carried ? [carried] : []);
      const listed = [
        ...(page.Versions ?? []).map((v) => ({ ...v, deleteMarker: false })),
        ...(page.DeleteMarkers ?? []).map((v) => ({ ...v, Size: 0, deleteMarker: true })),
      ];
      for (const v of listed) {
        if (!v.Key || !v.VersionId || !v.LastModified) continue;
        const versions = byKey.get(v.Key) ?? [];
        versions.push({
          versionId: v.VersionId,
          lastModified: v.LastModified,
          size: v.Size ?? 0,
          latest: v.IsLatest === true,
          deleteMarker: v.deleteMarker,
        });
        byKey.set(v.Key, versions);
      }
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      carried = undefined;
      for (const [key, versions] of byKey) {
        if (key === KeyMarker) carried = [key, versions];
        else yield [key, versions.sort(newestFirst)];
      }
    } while (KeyMarker);
  }

  /** The versions of one key, current first; empty when the key never existed. */
  async versions(key: string): Promise<ArtifactVersion[]> {
    for await (const [found, versions] of this.keyVersions(assertKey(key)))
      if (found === key) return versions;
    return [];
  }

  /** Makes an older version of `key` current again by copying it over the key. */
  async restoreVersion(key: string, versionId: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: assertKey(key),
        CopySource: `${this.bucket}/${key}?versionId=${encodeURIComponent(versionId)}`,
      }),
    );
  }

  /**
   * Brings back deleted objects, one key or everything under a prefix ending in `/`, by
   * removing their delete markers, which makes the newest version current. A key with no
   * version left is skipped. Returns how many keys came back.
   */
  async undelete(target: string): Promise<number> {
    const one = !target.endsWith('/');
    const doomed: VersionRef[] = [];
    let restored = 0;
    for await (const [key, versions] of this.keyVersions(
      one ? assertKey(target) : assertPrefix(target),
    )) {
      if (one && key !== target) continue;
      if (!versions[0].deleteMarker || versions.every((v) => v.deleteMarker)) continue;
      // Every marker, not only those listed in front: two written within one second of the
      // object cannot be ordered by time, and a marker behind a version hides nothing.
      const markers = versions.filter((v) => v.deleteMarker);
      doomed.push(...markers.map((v) => ({ Key: key, VersionId: v.versionId })));
      restored++;
    }
    await this.deleteVersions(doomed);
    return restored;
  }

  async pruneVersions(olderThan: Date): Promise<number> {
    if (!(await this.versioningEnabled())) return 0;
    const doomed: VersionRef[] = [];
    const spentMarkers: VersionRef[] = [];
    for await (const [key, versions] of this.keyVersions()) {
      // A version stopped being current when the one in front of it was written.
      const expired = versions.filter((_, i) => i > 0 && versions[i - 1].lastModified < olderThan);
      doomed.push(...expired.map((v) => ({ Key: key, VersionId: v.versionId })));
      // A delete marker with nothing left behind it hides nothing.
      const [head] = versions;
      if (head.deleteMarker && expired.length === versions.length - 1)
        spentMarkers.push({ Key: key, VersionId: head.versionId });
    }
    // Markers last, and only once what they hide is gone: a marker deleted while its
    // version survived a failed delete would make a purged image readable again.
    await this.deleteVersions(doomed);
    await this.deleteVersions(spentMarkers);
    return doomed.length + spentMarkers.length;
  }

  private async deleteVersions(refs: VersionRef[]): Promise<void> {
    for (let i = 0; i < refs.length; i += 1000) {
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: refs.slice(i, i + 1000), Quiet: true },
        }),
      );
      if (res.Errors?.length)
        throw new Error(`Could not delete ${res.Errors.length} artifact version(s)`);
    }
  }

  /** Releases the client's sockets (long-lived processes keep one store). */
  close(): void {
    this.client.destroy();
  }
}

/**
 * One org's view of a store: every key must lie under `org/<orgId>/`. Hosted callers take
 * this, not the store, so a stored or client-influenced key can never reach another
 * tenant's objects (the `postgresHistory().forOrg()` pattern).
 */
export function orgArtifacts(store: ArtifactStore, orgId: string): ArtifactStore {
  const prefix = `org/${segment('org id', orgId)}/`;
  const own = (key: string) => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) {
      throw new Error(`Invalid artifact key for org ${orgId}: ${JSON.stringify(key)}`);
    }
    return key;
  };
  return {
    put: async (key, body, contentType) => store.put(own(key), body, contentType),
    get: async (key) => store.get(own(key)),
    signedUrl: async (key, ttlSeconds) => store.signedUrl(own(key), ttlSeconds),
    deletePrefix: async (prefix) => store.deletePrefix(own(prefix)),
    delete: async (key) => store.delete(own(key)),
  };
}

/**
 * The hosted artifact store from the environment (#460): `IRIS_S3_ENDPOINT` (http or
 * https), `IRIS_S3_BUCKET`, `IRIS_S3_REGION` (default `us-east-1`),
 * `IRIS_S3_ACCESS_KEY_ID` and `IRIS_S3_SECRET_ACCESS_KEY(_FILE)`. No endpoint: `null`
 * (run detail then shows no artifacts). A partial configuration throws, naming what is
 * missing, so a typo cannot quietly turn artifacts off.
 */
export function resolveArtifactStore(env: NodeJS.ProcessEnv = process.env): S3ArtifactStore | null {
  const endpoint = env.IRIS_S3_ENDPOINT;
  if (!endpoint) {
    // The rest set without an endpoint is a typo, not "no artifacts".
    const stray = Object.keys(env).filter((k) => k.startsWith('IRIS_S3_') && env[k]);
    if (stray.length) throw new Error(`${stray.join(', ')} set but IRIS_S3_ENDPOINT is not`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('IRIS_S3_ENDPOINT must be an http(s) URL');
  }
  // Clients receive URLs on this host: credentials in it would be handed out, and plain
  // http would carry the capability URLs in the clear (loopback, i.e. dev, excepted).
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password) throw new Error('IRIS_S3_ENDPOINT must not carry credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('IRIS_S3_ENDPOINT must be https (http only for a loopback host)');
  const bucket = env.IRIS_S3_BUCKET;
  const accessKeyId = env.IRIS_S3_ACCESS_KEY_ID;
  const secretAccessKey = readSecretEnv('IRIS_S3_SECRET_ACCESS_KEY', env);
  const missing = Object.entries({
    IRIS_S3_BUCKET: bucket,
    IRIS_S3_ACCESS_KEY_ID: accessKeyId,
    IRIS_S3_SECRET_ACCESS_KEY: secretAccessKey,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`IRIS_S3_ENDPOINT is set but ${missing.join(', ')} is not`);
  return new S3ArtifactStore({
    endpoint,
    region: env.IRIS_S3_REGION || 'us-east-1',
    bucket: bucket!,
    credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
  });
}

export interface SignedArtifact {
  url: string;
  expiresAt: string;
}

/**
 * A run's recorded artifact keys (`result.artifacts`, written by the hosted visual job,
 * #268) as signed URLs for one reader (#460). A key is signed only when it is this run's
 * artifact (`org/<org>/project/<p>/run/<runId>/…`) or a baseline of the same org
 * (`org/<org>/project/<p>/baselines/…`); anything else (another org's, another run's, a
 * malformed value) is dropped, so a stored key never widens what a reader can fetch.
 */
export async function signRunArtifacts(
  store: ArtifactStore,
  { orgId, runId }: { orgId: string; runId: string },
  artifacts: unknown,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<{ signed: Record<string, SignedArtifact>; dropped: string[] }> {
  // No prototype: a stored name like `__proto__` is an ordinary key here, not a setter.
  const signed: Record<string, SignedArtifact> = Object.create(null);
  const dropped: string[] = [];
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts))
    return { signed, dropped };
  const org = orgArtifacts(store, orgId);
  const prefix = `org/${segment('org id', orgId)}/project/`;
  const ttl = Math.min(
    Math.max(Number.isFinite(ttlSeconds) ? Math.trunc(ttlSeconds) : DEFAULT_TTL_SECONDS, 1),
    MAX_TTL_SECONDS,
  );
  for (const [name, key] of Object.entries(artifacts)) {
    const rest =
      typeof key === 'string' && key.startsWith(prefix) ? key.slice(prefix.length).split('/') : [];
    // <project>/run/<runId>/<kind>/<name>.png, or <project>/baselines/<name>.png
    const ours =
      (rest.length === 5 && rest[1] === 'run' && rest[2] === runId) ||
      (rest.length === 3 && rest[1] === 'baselines');
    if (!ours || typeof key !== 'string') {
      dropped.push(name);
      continue;
    }
    try {
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      signed[name] = { url: await org.signedUrl(key, ttl), expiresAt };
    } catch {
      dropped.push(name); // an invalid key: assertKey refused it
    }
  }
  return { signed, dropped };
}
