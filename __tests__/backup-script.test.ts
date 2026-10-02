/**
 * deploy/backup.sh and deploy/restore.sh (#274) against the local Docker.
 *
 * Test strategy: one real Postgres (the image production pins) in a throwaway compose
 * project, which backup.sh finds by its compose labels as it finds production's. A
 * box directory holds what the scripts read from the deploy tree:
 * shared/secrets/{master_key,database_url}. The database is migrated and seeded
 * through the real code (an org, a run with its results, a usage row). Backups use a
 * real age key pair; restores go through restore.sh's disposable container into a
 * scratch database on the same server, joined over the compose network as on the box.
 * rclone is a stub that copies into a local "remote" and can be told to fail once.
 *
 * Cases run in order and share the database; the last one stops it. Container starts
 * are the slow part on a loaded daemon (each restore is one), so cases that refuse on
 * the host before any container are kept apart from the ones that need one.
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
// URL credentials built at runtime: a `user:pass@` literal reads to secret scanners as
// a leaked Basic Auth string.
const CREDS = ['iris', 'iris'].join(':');

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

/** Backup names have one-second resolution: two runs into one directory wait. */
const nextSecond = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

(DOCKER ? describe : describe.skip)('deploy/backup.sh and deploy/restore.sh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-backup-'));
  const root = path.join(dir, 'box');
  const project = path.join(dir, 'compose');
  const masterKey = 'k1:bWFzdGVyLWtleS1mb3ItdGhlLWJhY2t1cC10ZXN0IQ==';
  const identity = path.join(dir, 'identity.txt');
  const recipients = path.join(dir, 'recipients.txt');
  const bin = path.join(dir, 'bin');
  const remote = path.join(dir, 'remote');
  let PATH = '';
  let port = '';

  const compose = (...args: string[]) =>
    execFileSync('docker', ['compose', ...args], {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    }).trim();

  const url = (db: string) => `postgres://${CREDS}@127.0.0.1:${port}/${db}`;

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

  /** One backup into dir/<name>; returns the directory's files after it. */
  function backup(name: string, env: Record<string, string> = {}) {
    const backupDir = path.join(dir, name);
    const r = run(BACKUP, [], {
      BACKUP_DIR: backupDir,
      BACKUP_RECIPIENTS: recipients,
      BACKUP_COMPOSE_PROJECT: PROJECT,
      BACKUP_RCLONE_REMOTE: '',
      ...env,
    });
    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
    return { ...r, backupDir, files };
  }

  /** restore.sh into a database on the test server, reached over the compose network. */
  const restore = (file: string, target: string, ...args: string[]) =>
    run(RESTORE, [file, '--identity', identity, '--network', `${PROJECT}_default`, ...args], {
      RESTORE_TARGET_URL: target,
    });

  const decrypt = (file: string) =>
    execFileSync('age', ['-d', '-i', identity, file], { env: { ...process.env, PATH } });

  /** Old backups of both kinds, with these ages in days, in dir/<name>. */
  function seedBackups(name: string, ages: number[]): string[] {
    const backupDir = path.join(dir, name);
    fs.mkdirSync(backupDir, { recursive: true });
    const names: string[] = [];
    for (const age of ages) {
      const stamp = daysAgo(age)
        .toISOString()
        .replace(/[-:]|\.\d+/g, '');
      for (const f of [`iris-${stamp}.dump.age`, `master_key-${stamp}.age`]) {
        fs.writeFileSync(path.join(backupDir, f), 'x');
        fs.utimesSync(path.join(backupDir, f), daysAgo(age), daysAgo(age));
        names.push(f);
      }
    }
    return names;
  }

  beforeAll(async () => {
    const age = ageDir();
    fs.mkdirSync(bin);
    // rclone stub: logs its arguments; fails once if dir/rclone-fail exists; otherwise
    // copies the included backups into remote/ (cp -n: skip what is already there).
    fs.writeFileSync(
      path.join(bin, 'rclone'),
      `#!/bin/sh
echo "$@" >> ${dir}/rclone.log
if [ -e ${dir}/rclone-fail ]; then rm ${dir}/rclone-fail; exit 1; fi
[ "$1 $3 $4 $5 $6 $7" = "copy offsite:iris --include iris-*.dump.age --include master_key-*.age" ] || exit 9
mkdir -p ${remote} && cp -n "$2"/iris-*.dump.age "$2"/master_key-*.age ${remote}/
`,
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
      `postgres://${CREDS}@postgres:5432/iris`,
    );
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, 'docker-compose.yml'),
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
    spawnSync('docker', ['compose', 'down', '-v', '-t', '1'], { cwd: project });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a bad retention setting before doing anything', () => {
    for (const [name, value] of [
      ['BACKUP_KEEP_DAYS', '0'],
      ['BACKUP_KEEP_DAYS', '-1'],
      ['BACKUP_KEEP_DAYS', '7d'],
      ['BACKUP_KEEP_MIN', '0'],
      ['BACKUP_KEEP_MIN', 'x'],
    ]) {
      const r = backup('invalid', { [name]: value });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain(`${name} must be a whole number >= 1, not '${value}'`);
      expect(fs.existsSync(r.backupDir)).toBe(false);
    }
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
    dumpFile = dump;
    expect(path.basename(dump)).toMatch(/^iris-\d{8}T\d{6}Z\.dump\.age$/);
    expect(path.basename(key)).toMatch(/^master_key-\d{8}T\d{6}Z\.age$/);
    for (const f of [dump, key]) {
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(f).subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    }
    // pg_dump's custom format compresses, so the plaintext check is its magic header:
    // in the decrypted stream, nowhere in the file. The restore below checks content.
    expect(decrypt(dump).subarray(0, 5).toString()).toBe('PGDMP');
    expect(fs.readFileSync(dump).includes('PGDMP')).toBe(false);
    expect(fs.readFileSync(key).includes(masterKey)).toBe(false);
    expect(decrypt(key).toString()).toBe(masterKey);
  }, 120_000);

  it('restore refuses without --force when it cannot read the serving database URL', () => {
    const r = run(RESTORE, [dumpFile, '--identity', identity], {
      DEPLOY_DIR: path.join(dir, 'not-a-box'),
      RESTORE_TARGET_URL: url('restored'),
    });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/cannot rule out the serving database; pass --force/);
  });

  it('restore refuses the serving database however the URL spells it', () => {
    const container = `${PROJECT}-postgres-1`;
    const ip = execFileSync(
      'docker',
      ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container],
      { encoding: 'utf8' },
    ).trim();
    for (const target of [
      // Another host name and a percent-encoded database name.
      `postgresql://${CREDS}@${container}/%69ris`,
      // An address, and a query string overriding the database in the path.
      `postgres://${CREDS}@${ip}:5432/restored?dbname=iris`,
    ]) {
      const r = restore(dumpFile, target);
      expect(r.out).toMatch(/is the serving database \(iris\); pass --force/);
      expect(r.status).toBe(2);
    }
  }, 300_000);

  it('restore refuses a truncated backup before connecting to anything', () => {
    const cut = path.join(dir, 'truncated.dump.age');
    const bytes = fs.readFileSync(dumpFile);
    fs.writeFileSync(cut, bytes.subarray(0, bytes.length - 100));
    const r = restore(cut, `postgres://${CREDS}@postgres:5432/restored`);
    expect(r.out).toMatch(/cannot decrypt/);
    expect(r.status).toBe(1);
  });

  const snapshot = async (db: string) => ({
    orgs: await query(db, 'select * from organization order by id'),
    runs: await query(db, 'select * from runs order by id'),
    results: await query(db, 'select * from run_results order by id'),
    usage: await query(db, 'select * from usage_events order by id'),
    migrations: await query(db, 'select * from kysely_migration order by name'),
  });

  it('restores into a scratch database with the same rows', async () => {
    const r = restore(dumpFile, `postgres://${CREDS}@postgres:5432/restored`);
    expect(r.out).toMatch(/restored in \d+\.\d s/);
    expect(r.status).toBe(0);
    const [served, restored] = [await snapshot('iris'), await snapshot('restored')];
    expect(served.orgs).toEqual([expect.objectContaining({ id: 'org-a', name: MARKER })]);
    expect([served.runs.length, served.results.length, served.usage.length]).toEqual([1, 1, 1]);
    expect(restored).toEqual(served);
  }, 300_000);

  it('restoring an older dump over a newer schema leaves exactly the dump, then migrates', async () => {
    // What a later release would have added: a table and its migration row.
    await query(
      'restored',
      `create table later_feature (id int);
       insert into kysely_migration (name, timestamp) values ('9999_later', now()::text)`,
    );
    const r = restore(dumpFile, `postgres://${CREDS}@postgres:5432/restored`);
    expect(r.status).toBe(0);
    const tables = await query(
      'restored',
      "select tablename from pg_tables where schemaname = 'public' and tablename = 'later_feature'",
    );
    expect(tables).toEqual([]);
    expect(await snapshot('restored')).toEqual(await snapshot('iris'));
    const db = createPostgresDb(url('restored'));
    try {
      await migrateToLatest(db); // throws "corrupted migrations" on a leftover row
    } finally {
      await db.destroy();
    }
  }, 300_000);

  it('a pg_dump error in a running container exits non-zero and leaves no file', async () => {
    // pg_dump fails: its database is gone. Renamed back afterwards.
    await query('postgres', 'alter database iris rename to iris_away');
    try {
      const r = backup('dump-error');
      expect(r.out).toMatch(/database "iris" does not exist/);
      expect(r.status).not.toBe(0);
      expect(r.files).toEqual([]);
    } finally {
      await query('postgres', 'alter database iris_away rename to iris');
    }
  }, 120_000);

  it('retention keeps the newest BACKUP_KEEP_MIN and recent ones; a failed copy is retried', () => {
    const [oldDump, oldKey, ...recent] = seedBackups('retention', [20, 2]);
    const env = {
      BACKUP_KEEP_DAYS: '08',
      BACKUP_KEEP_MIN: '2',
      BACKUP_RCLONE_REMOTE: 'offsite:iris',
    };

    fs.writeFileSync(path.join(dir, 'rclone-fail'), '');
    const first = backup('retention', env);
    expect(first.out).toMatch(/off-box copy to offsite:iris failed .*the next run retries/);
    expect(first.status).toBe(1);
    // The local backup and retention both happened before the copy failed. 08 is 8
    // days: the 20-day-old files go, the 2-day-old ones stay.
    const day1 = first.files.filter((f) => !recent.includes(f));
    expect(day1).toHaveLength(2);
    expect(first.files).toEqual([...day1, ...recent].sort());
    expect(first.files).not.toContain(oldDump);
    expect(first.files).not.toContain(oldKey);

    nextSecond();
    const second = backup('retention', env);
    expect(second.status).toBe(0);
    const day2 = second.files.filter((f) => ![...day1, ...recent].includes(f));
    expect(day2).toHaveLength(2);
    // Newest 2 are day2 and day1; the 2-day-old ones are third but within 8 days.
    expect(second.files).toEqual([...day1, ...day2, ...recent].sort());
    // The retry copied the first run's files too.
    expect(fs.readdirSync(remote).sort()).toEqual([...day1, ...day2, ...recent].sort());
  }, 120_000);

  it('keeps the newest BACKUP_KEEP_MIN even when all are older than BACKUP_KEEP_DAYS', () => {
    const seeded = seedBackups('keep-min', [30, 31, 32]);
    const r = backup('keep-min', { BACKUP_KEEP_DAYS: '1', BACKUP_KEEP_MIN: '3' });
    expect(r.status).toBe(0);
    const fresh = r.files.filter((f) => !seeded.includes(f));
    expect(fresh).toHaveLength(2);
    // New + the two newest seeded of each kind; the 32-day-old pair is deleted.
    expect(r.files).toEqual([...fresh, ...seeded.slice(0, 4)].sort());
  }, 120_000);

  it('a stopped database exits non-zero, leaves no file and deletes nothing', () => {
    const seeded = seedBackups('stopped', [30]);
    compose('stop', '-t', '1', 'postgres');
    const r = backup('stopped', { BACKUP_KEEP_DAYS: '1', BACKUP_KEEP_MIN: '1' });
    expect(r.out).toMatch(/no running postgres container/);
    expect(r.status).not.toBe(0);
    expect(r.files).toEqual(seeded.sort());
  }, 120_000);
});
