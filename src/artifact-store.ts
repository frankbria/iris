import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ArtifactKind } from './visual/artifacts';

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

/**
 * Hosted mode: a private bucket on an S3-compatible server, path-style addressing
 * (SeaweedFS and most self-hosted servers have no per-bucket DNS). Reads by tenants go
 * through `signedUrl`; nothing makes an object public.
 */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;

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
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async signedUrl(key: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
    const expiresIn = Math.min(Math.max(Math.trunc(ttlSeconds), 1), MAX_TTL_SECONDS);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: assertKey(key) }),
      {
        expiresIn,
      },
    );
  }

  /** Releases the client's sockets (long-lived processes keep one store). */
  close(): void {
    this.client.destroy();
  }
}
