/**
 * Account-level bans (#457): an operator bans a user, not only an org (#348).
 *
 * Real Postgres and BetterAuth's own server API through the shared `createAuth()`, in one
 * spawned Node (BetterAuth is ESM-only; Jest's sandbox cannot `require(esm)`), as in
 * `auth-org.test.ts`. The probe bans through `userSuspensions()`, the module the
 * `iris admin ban-user` command calls.
 */

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { promisify } from 'util';
import { Client } from 'pg';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping user ban tests: set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)');
}

const PROBE = `
const { Pool } = require('pg');
const { Kysely, PostgresDialect } = require('kysely');
const { createAuth } = require('./src/auth/config.ts');
const { userSuspensions, UnknownUserError } = require('./src/org-suspension.ts');
const PASSWORD = 'correct-horse-battery-staple';
(async () => {
  const pool = new Pool({ connectionString: process.env.PROBE_URL });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const bans = userSuspensions(db);
  const auth = createAuth({
    secret: process.env.PROBE_SECRET,
    baseURL: 'https://portal.example.com',
    database: pool,
    sendEmail: async () => {},
  });
  const signIn = async (email) => {
    const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });
  };
  const user = async (name) => {
    const email = name + '@iris.test';
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name, acceptedTerms: require('./src/legal/versions.ts').ACCEPTED_TERMS } });
    await pool.query('update "user" set "emailVerified" = true where email = $1', [email]);
    return signIn(email);
  };
  const attempt = (fn) => fn().then(() => 'ok', (e) => (e.body && e.body.code) || e.status || String(e));
  const idOf = async (email) => (await pool.query('select id from "user" where email = $1', [email])).rows[0].id;
  const session = async (headers) => (await auth.api.getSession({ headers })) !== null;
  const active = async (headers) => (await auth.api.getSession({ headers })).session.activeOrganizationId;
  const by = { reason: 'spam from this account', actor: 'ops' };
  const r = {};

  const alice = await user('alice');
  const A = await active(alice);
  const bob = await user('bob');
  const bobId = await idOf('bob@iris.test');
  // Bob is an admin of Alice's org and made a key there; Alice made one too.
  const toBob = await auth.api.createInvitation({ headers: alice, body: { email: 'bob@iris.test', role: 'admin' } });
  await auth.api.acceptInvitation({ headers: bob, body: { invitationId: toBob.id } });
  await auth.api.setActiveOrganization({ headers: bob, body: { organizationId: A } });
  const bobsKey = await auth.api.createApiKey({ headers: bob, body: { organizationId: A, name: 'bobs' } });
  const alicesKey = await auth.api.createApiKey({ headers: alice, body: { organizationId: A, name: 'alices' } });
  // An invitation to Bob into another org, pending at the ban.
  const carol = await user('carol');
  const toBob2 = await auth.api.createInvitation({ headers: carol, body: { email: 'bob@iris.test', role: 'member' } });

  r.before = { session: await session(bob), banned: await bans.isSuspended(bobId) };
  const ban = await bans.suspend('bob@iris.test', by);
  r.ban = { suspended: ban.suspended, changed: ban.changed, actor: ban.last.actor, reason: ban.last.reason };
  r.again = (await bans.suspend(bobId, by)).changed;
  r.after = {
    banned: await bans.isSuspended(bobId),
    session: await session(bob),
    sessionRows: (await pool.query('select count(*)::int as n from session where "userId" = $1', [bobId])).rows[0].n,
    signIn: await attempt(() => signIn('bob@iris.test')),
    bobsKey: (await auth.api.verifyApiKey({ body: { key: bobsKey.key } })).valid,
    alicesKey: (await auth.api.verifyApiKey({ body: { key: alicesKey.key } })).valid,
    keyAudit: (await pool.query("select metadata from audit_log where action = 'api_key.delete' and target = $1", ['key:' + bobsKey.id])).rows.map((x) => x.metadata),
    aliceSession: await session(alice),
  };
  // A session cookie from before the ban cannot accept the pending invitation.
  r.acceptAfterBan = await attempt(() => auth.api.acceptInvitation({ headers: bob, body: { invitationId: toBob2.id } }));

  const unban = await bans.unsuspend(bobId, { reason: 'appeal granted', actor: 'ops' });
  r.unban = { suspended: unban.suspended, changed: unban.changed };
  r.signInAfterUnban = await attempt(() => signIn('bob@iris.test'));
  r.history = (await bans.history(bobId)).map((e) => e.action + ':' + e.actor + ':' + e.reason);
  r.status = (await bans.status('bob@iris.test')).suspended;
  // Races (codex review): a ban that commits while a sign-in or a key creation is under
  // way. The ban is held open, its lock taken, as the ban transaction holds it.
  const holdBan = async (userId) => {
    const c = await pool.connect();
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', ['user_suspensions:' + userId]);
    await c.query("insert into user_suspensions (user_id, action, reason, actor) values ($1, 'suspend', 'race', 'ops')", [userId]);
    await c.query('delete from session where "userId" = $1', [userId]);
    return async () => { await c.query('commit'); c.release(); };
  };
  const dave = await user('dave');
  const daveId = await idOf('dave@iris.test');
  const D = await active(dave);
  let commit = await holdBan(daveId);
  const racingSignIn = attempt(() => signIn('dave@iris.test'));
  await new Promise((res) => setTimeout(res, 1500));
  await commit();
  r.raceSignIn = await racingSignIn;
  r.raceSessions = (await pool.query('select count(*)::int as n from session where "userId" = $1', [daveId])).rows[0].n;
  await bans.unsuspend(daveId, { reason: 'race done', actor: 'ops' });
  const dave2 = await signIn('dave@iris.test');
  commit = await holdBan(daveId);
  const racingKey = auth.api.createApiKey({ headers: dave2, body: { organizationId: D, name: 'racer' } });
  await new Promise((res) => setTimeout(res, 1500));
  await commit();
  const racer = await racingKey.catch((e) => e);
  r.raceKey = racer && racer.key ? (await auth.api.verifyApiKey({ body: { key: racer.key } })).valid : 'not created';

  r.unknown = await bans.suspend('nobody@iris.test', by).then(() => 'ok', (e) => e instanceof UnknownUserError);
  r.blankReason = await bans.suspend(bobId, { reason: ' ', actor: 'ops' }).then(() => 'ok', (e) => e.message);
  // Deleting the user drops their history with them (user-scoped, cascade).
  await pool.query('delete from "user" where id = $1', [bobId]);
  r.rowsAfterDelete = (await pool.query('select count(*)::int as n from user_suspensions where user_id = $1', [bobId])).rows[0].n;

  await db.destroy();
  process.stdout.write(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
`;

(ADMIN_URL ? describe : describe.skip)('user bans (#457)', () => {
  const dbName = `iris_ban_${process.pid}_${randomBytes(4).toString('hex')}`;
  let r: any;

  async function admin(query: string): Promise<void> {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    const db = createPostgresDb(u.toString());
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-r', 'ts-node/register', '-e', PROBE],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: '1',
          BETTER_AUTH_TELEMETRY: '0',
          PROBE_URL: u.toString(),
          PROBE_SECRET: randomBytes(32).toString('hex'),
        },
      },
    );
    r = JSON.parse(stdout);
  }, 90_000);

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('bans by email or id, records actor and reason, and is idempotent', () => {
    expect(r.before).toEqual({ session: true, banned: false });
    expect(r.ban).toEqual({
      suspended: true,
      changed: true,
      actor: 'ops',
      reason: 'spam from this account',
    });
    expect(r.again).toBe(false);
    expect(r.after.banned).toBe(true);
  });

  it("revokes the user's sessions at once and refuses sign-in", () => {
    expect(r.after.session).toBe(false);
    expect(r.after.sessionRows).toBe(0);
    expect(r.after.signIn).toBe('USER_BANNED');
    expect(r.after.aliceSession).toBe(true);
  });

  it('revokes the keys the user created, audited, and leaves the others', () => {
    expect(r.after.bobsKey).toBe(false);
    expect(r.after.alicesKey).toBe(true);
    expect(r.after.keyAudit).toEqual([{ reason: 'user banned' }]);
  });

  it('a pending invitation cannot be accepted by the banned user', () => {
    expect(r.acceptAfterBan).not.toBe('ok');
  });

  it('unban restores sign-in; history keeps both actions', () => {
    expect(r.unban).toEqual({ suspended: false, changed: true });
    expect(r.signInAfterUnban).toBe('ok');
    expect(r.status).toBe(false);
    expect(r.history).toEqual([
      'suspend:ops:spam from this account',
      'unsuspend:ops:appeal granted',
    ]);
  });

  it('a ban committed during a sign-in leaves no session (codex review)', () => {
    expect(r.raceSignIn).toBe('USER_BANNED');
    expect(r.raceSessions).toBe(0);
  });

  it('a ban committed during a key creation revokes that key (codex review)', () => {
    expect(r.raceKey).not.toBe(true);
  });

  it('refuses an unknown user and a blank reason', () => {
    expect(r.unknown).toBe(true);
    expect(r.blankReason).toBe('A reason is required');
  });

  it('is user-scoped: deleting the user removes their history', () => {
    expect(r.rowsAfterDelete).toBe(0);
  });
});
