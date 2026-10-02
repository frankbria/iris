/**
 * deploy/backup.sh and deploy/restore.sh (#274) against the local Docker.
 *
 * Test strategy: a box laid out as the deploy job leaves it (<root>/current ->
 * releases/r1 with its compose file, shared/secrets/{master_key,database_url}), whose
 * compose file runs one real Postgres, the image production pins. It is migrated and
 * seeded through the real code (an org, a run with its results, a usage row). Backups
 * use a real age key pair; restores go through restore.sh's disposable container into
 * a scratch database on the same server, joined over the compose network as on the box.
 *
 * Cases run in order and share the database; the last one stops it. Container starts
 * are the slow part on a loaded daemon, so there are two: the database, one restore.
 *
 * `age` comes from PATH (CI installs the Ubuntu package) or, locally, the pinned
 * release tarball. Docker is required under CI and skipped locally without it.
 */

import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { sql } from 'kysely';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { postgresHistory } from '../src/history-store';

const ROOT = path.resolve(__dirname, '..');
const BACKUP = path.join(ROOT, 'deploy', 'backup.sh');
const RESTORE = path.join(ROOT, 'deploy', 'restore.sh');
const PROJECT = `iris-backup-test-${process.pid}`;
const MARKER = 'backup-plaintext-marker-7f3a';
const PG_IMAGE = (() => {
  const m = fs
    .readFileSync(path.join(ROOT, 'docker-compose.production.yml'), 'utf8')
    .match(/postgres:[\w.-]+@sha256:[0-9a-f]{64}/);
  if (!m) throw new Error('pinned postgres image not found in docker-compose.production.yml');
  return m[0];
})();

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerAvailable();
if (!DOCKER) {
  if (process.env.CI) throw new Error('Docker is required in CI for the backup script test');
  console.warn('Skipping backup script tests: Docker or docker compose is not available');
}

/** The pinned age release, for machines without the package (checksum-verified). */
const AGE_VERSION = 'v1.3.2';
const AGE_SHA256 = 'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10';

/** A directory holding `age` and `age-keygen`, or '' when they are already on PATH. */
function ageDir(): string {
  if (spawnSync('age', ['--version']).status === 0) return '';
  if (process.env.CI) throw new Error('age is required in CI (apt-get install age)');
  const dir = path.join(os.tmpdir(), `iris-age-${AGE_VERSION}`);
  if (fs.existsSync(path.join(dir, 'age', 'age'))) return path.join(dir, 'age');
  fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, 'age.tgz');
  execFileSync('curl', [
    '-fsSL',
    '-o',
    tgz,
    `https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-amd64.tar.gz`,
  ]);
  const sum = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  if (sum !== AGE_SHA256) throw new Error(`age tarball checksum mismatch: ${sum}`);
  execFileSync('tar', ['xzf', tgz, '-C', dir]);
  return path.join(dir, 'age');
}

(DOCKER ? describe : describe.skip)('deploy/backup.sh and deploy/restore.sh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-backup-'));
  const root = path.join(dir, 'box');
  const release = path.join(root, 'releases', 'r1');
  const masterKey = 'k1:bWFzdGVyLWtleS1mb3ItdGhlLWJhY2t1cC10ZXN0IQ==';
  const identity = path.join(dir, 'identity.txt');
  const recipients = path.join(dir, 'recipients.txt');
  const bin = path.join(dir, 'bin');
  let PATH = '';
  let port = '';

  const compose = (...args: string[]) =>
    execFileSync('docker', ['compose', ...args], {
      cwd: release,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    }).trim();

  const url = (db: string) => `postgres://iris:iris@127.0.0.1:${port}/${db}`;

  async function query(db: string, text: string) {
    const client = new Client({ connectionString: url(db) });
    await client.connect();
    try {
      return (await client.query(text)).rows;
    } finally {
      await client.end();
    }
  }

  function run(script: string, args: string[], env: Record<string, string>) {
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, PATH, DEPLOY_DIR: root, ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  /** A fresh backup dir per case: two runs in one second would share a name. */
  function backup(name: string, env: Record<string, string> = {}) {
    const backupDir = path.join(dir, name);
    const r = run(BACKUP, [], {
      BACKUP_DIR: backupDir,
      BACKUP_RECIPIENTS: recipients,
      BACKUP_RCLONE_REMOTE: '',
      ...env,
    });
    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
    return { ...r, backupDir, files };
  }

  const decrypt = (file: string) =>
    execFileSync('age', ['-d', '-i', identity, file], { env: { ...process.env, PATH } });

  beforeAll(async () => {
    const age = ageDir();
    fs.mkdirSync(bin);
    // rclone stub: records what it was asked to copy.
    fs.writeFileSync(
      path.join(bin, 'rclone'),
      `#!/bin/sh\necho "$@" >> ${path.join(dir, 'rclone.log')}\n`,
      { mode: 0o755 },
    );
    PATH = [bin, age, process.env.PATH].filter(Boolean).join(':');
    execFileSync('age-keygen', ['-o', identity], {
      env: { ...process.env, PATH },
      stdio: 'ignore',
    });
    fs.writeFileSync(
      recipients,
      execFileSync('age-keygen', ['-y', identity], { env: { ...process.env, PATH } }),
    );

    fs.mkdirSync(path.join(root, 'shared', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared', 'secrets', 'master_key'), masterKey);
    fs.writeFileSync(
      path.join(root, 'shared', 'secrets', 'database_url'),
      ['postgres://iris', 'iris@postgres:5432/iris'].join(':'),
    );
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(
      path.join(release, 'docker-compose.yml'),
      `name: ${PROJECT}
services:
  postgres:
    image: ${PG_IMAGE}
    environment:
      POSTGRES_USER: iris
      POSTGRES_PASSWORD: iris
      POSTGRES_DB: iris
    ports: ['127.0.0.1::5432']
    healthcheck:
      # TCP: the init-time server listens on the socket only, then restarts.
      test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U iris -d iris']
      interval: 5s
      start_period: 300s
      start_interval: 1s
`,
    );
    fs.symlinkSync(release, path.join(root, 'current'));
    compose('up', '-d', '--wait', '--wait-timeout', '300', '--quiet-pull');
    port = compose('port', 'postgres', '5432').split(':').pop()!;

    const db = createPostgresDb(url('iris'));
    try {
      await migrateToLatest(db);
      await sql`insert into organization (id, name, slug, "createdAt")
        values ('org-a', ${MARKER}, 'org-a', now())`.execute(db);
      const at = new Date('2026-10-01T10:00:00Z');
      await postgresHistory(db)
        .forOrg({ orgId: 'org-a' })
        .record(
          {
            kind: 'rpc',
            startedAt: at,
            finishedAt: at,
            success: true,
            results: [{ success: true, action: { type: 'navigate', url: 'https://a.example/' } }],
          },
          { usage: [{ kind: 'browser_minutes', quantity: 3, idempotencyKey: 'seed-1' }] },
        );
    } finally {
      await db.destroy();
    }
    await query('iris', 'create database restored');
  }, 600_000);

  afterAll(() => {
    spawnSync('docker', ['compose', 'down', '-v', '-t', '1'], { cwd: release });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to run without recipients, writing nothing', () => {
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    for (const file of [path.join(dir, 'missing.txt'), path.join(dir, 'empty.txt')]) {
      const r = backup('none', { BACKUP_RECIPIENTS: file });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/refusing to write an unencrypted backup/);
      expect(r.files).toEqual([]);
    }
  });

  let dumpFile = '';

  it('writes an age-encrypted dump and master key, mode 0600, and warns without a remote', () => {
    const r = backup('daily');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/same box as the database/);
    expect(r.files).toHaveLength(2);
    const [dump, key] = r.files.map((f) => path.join(r.backupDir, f));
    expect(path.basename(dump)).toMatch(/^iris-\d{8}T\d{6}Z\.dump\.age$/);
    expect(path.basename(key)).toMatch(/^master_key-\d{8}T\d{6}Z\.age$/);
    for (const f of [dump, key]) {
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      const bytes = fs.readFileSync(f);
      expect(bytes.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    }
    // pg_dump's custom format compresses, so the plaintext check is its magic header:
    // in the decrypted stream, nowhere in the file. The restore below checks content.
    expect(decrypt(dump).subarray(0, 5).toString()).toBe('PGDMP');
    expect(fs.readFileSync(dump).includes('PGDMP')).toBe(false);
    expect(fs.readFileSync(key).includes(masterKey)).toBe(false);
    expect(decrypt(key).toString()).toBe(masterKey);
    dumpFile = dump;
  }, 120_000);

  it('restore refuses the serving database without --force', () => {
    // Same host, port and database, spelled with other credentials and case.
    const r = run(RESTORE, [dumpFile, '--identity', identity], {
      RESTORE_TARGET_URL: ['postgresql://someone', 'pw@POSTGRES/iris?sslmode=disable'].join(':'),
    });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/is the serving database; pass --force/);
  });

  it('restores into a scratch database with the same rows', async () => {
    const r = run(RESTORE, [dumpFile, '--identity', identity, '--network', `${PROJECT}_default`], {
      RESTORE_TARGET_URL: ['postgres://iris', 'iris@postgres:5432/restored'].join(':'),
    });
    expect(r.out).toMatch(/restored in \d+\.\d s/);
    expect(r.status).toBe(0);
    const snapshot = async (db: string) => ({
      orgs: await query(db, 'select id, name from organization order by id'),
      runs: await query(db, 'select * from runs order by id'),
      results: await query(db, 'select * from run_results order by id'),
      usage: await query(db, 'select * from usage_events order by id'),
      migrations: await query(db, 'select name from kysely_migration order by name'),
    });
    const [served, restored] = [await snapshot('iris'), await snapshot('restored')];
    expect(served.orgs).toEqual([{ id: 'org-a', name: MARKER }]);
    expect([served.runs.length, served.results.length, served.usage.length]).toEqual([1, 1, 1]);
    expect(restored).toEqual(served);
  }, 300_000);

  it('retention deletes only old backups, after a success, and copies off-box', () => {
    const backupDir = path.join(dir, 'retention');
    fs.mkdirSync(backupDir);
    const old = ['iris-20260901T000000Z.dump.age', 'master_key-20260901T000000Z.age'];
    const recent = ['iris-20260930T000000Z.dump.age', 'master_key-20260930T000000Z.age'];
    const other = 'notes.txt';
    for (const f of [...old, ...recent, other]) fs.writeFileSync(path.join(backupDir, f), 'x');
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    for (const f of [...old, other]) fs.utimesSync(path.join(backupDir, f), ago(20), ago(20));
    for (const f of recent) fs.utimesSync(path.join(backupDir, f), ago(2), ago(2));

    const r = backup('retention', { BACKUP_RCLONE_REMOTE: 'offsite:iris' });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/same box/);
    const fresh = r.files.filter((f) => ![...recent, other].includes(f));
    expect(fresh).toHaveLength(2);
    expect(r.files).toEqual([...fresh, ...recent, other].sort());
    expect(fs.readFileSync(path.join(dir, 'rclone.log'), 'utf8').trim().split('\n')).toEqual(
      fresh.map((f) => `copy ${path.join(backupDir, f)} offsite:iris`),
    );
  }, 120_000);

  it('a failing pg_dump exits non-zero, leaves no partial file and deletes nothing', () => {
    const backupDir = path.join(dir, 'failing');
    fs.mkdirSync(backupDir);
    const old = path.join(backupDir, 'iris-20260901T000000Z.dump.age');
    fs.writeFileSync(old, 'x');
    const ago = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(old, ago, ago);
    compose('stop', '-t', '1', 'postgres');
    const r = backup('failing', { BACKUP_KEEP_DAYS: '0' });
    expect(r.status).not.toBe(0);
    expect(r.files).toEqual([path.basename(old)]);
  }, 120_000);
});
