import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveArtifactStore, S3ArtifactStore } from '../src/artifact-store';

/** The hosted artifact store's configuration (#460): all or nothing, secrets via _FILE. */
describe('resolveArtifactStore', () => {
  const NAMES = [
    'IRIS_S3_ENDPOINT',
    'IRIS_S3_BUCKET',
    'IRIS_S3_REGION',
    'IRIS_S3_ACCESS_KEY_ID',
    'IRIS_S3_SECRET_ACCESS_KEY',
    'IRIS_S3_SECRET_ACCESS_KEY_FILE',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const n of NAMES) {
      saved[n] = process.env[n];
      delete process.env[n];
    }
  });
  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('is null when no endpoint is configured (run detail then has no artifacts)', () => {
    expect(resolveArtifactStore()).toBeNull();
  });

  it('builds an S3 store from a full configuration, the secret from a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-s3-'));
    const secret = path.join(dir, 'secret');
    fs.writeFileSync(secret, 'from-file\n');
    Object.assign(process.env, {
      IRIS_S3_ENDPOINT: 'http://127.0.0.1:58333',
      IRIS_S3_BUCKET: 'iris',
      IRIS_S3_ACCESS_KEY_ID: 'id',
      IRIS_S3_SECRET_ACCESS_KEY_FILE: secret,
    });
    try {
      const store = resolveArtifactStore();
      expect(store).toBeInstanceOf(S3ArtifactStore);
      store!.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['IRIS_S3_BUCKET', 'IRIS_S3_ACCESS_KEY_ID', 'IRIS_S3_SECRET_ACCESS_KEY'])(
    'refuses a partial configuration (missing %s), naming what is missing',
    (missing) => {
      Object.assign(process.env, {
        IRIS_S3_ENDPOINT: 'http://127.0.0.1:58333',
        IRIS_S3_BUCKET: 'iris',
        IRIS_S3_ACCESS_KEY_ID: 'id',
        IRIS_S3_SECRET_ACCESS_KEY: 'secret',
      });
      delete process.env[missing];
      expect(() => resolveArtifactStore()).toThrow(missing);
    },
  );

  it('refuses an endpoint that is not http(s)', () => {
    Object.assign(process.env, {
      IRIS_S3_ENDPOINT: 'file:///etc',
      IRIS_S3_BUCKET: 'iris',
      IRIS_S3_ACCESS_KEY_ID: 'id',
      IRIS_S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(() => resolveArtifactStore()).toThrow(/IRIS_S3_ENDPOINT/);
  });
});
