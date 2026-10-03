/**
 * Org-owned API keys through the shared `createAuth()` (#340, ADR 0001 §4).
 *
 * Test strategy: the same harness as `auth-org.test.ts`. A throwaway Postgres
 * database, BetterAuth's own server API, and one spawned Node (BetterAuth is
 * ESM-only, and Jest's sandbox cannot `require(esm)`) that plays every scenario and
 * reports what each call returned. A refused call reports BetterAuth's error code,
 * so "refused for being in the wrong org" cannot pass as "refused for another reason".
 *
 * Cast: alice owns org A, bob owns org B, carol is a member of A, dave an admin of A.
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
  console.warn('Skipping API key tests: set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)');
}

const PROBE = `
const { Pool } = require('pg');
const { createAuth } = require('./src/auth/config.ts');
const PASSWORD = 'correct-horse-battery-staple';
(async () => {
  const pool = new Pool({ connectionString: process.env.PROBE_URL });
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
  const active = async (headers) => (await auth.api.getSession({ headers })).session.activeOrganizationId;
  const join = async (owner, name, role) => {
    const inv = await auth.api.createInvitation({ headers: owner, body: { email: name + '@iris.test', role } });
    const headers = await user(name);
    await auth.api.acceptInvitation({ headers, body: { invitationId: inv.id } });
    return headers;
  };
  const create = (headers, organizationId, name) =>
    auth.api.createApiKey({ headers, body: { organizationId, name } });
  const list = async (headers, organizationId) =>
    (await auth.api.listApiKeys({ headers, query: { organizationId } })).apiKeys;
  const revoke = (headers, keyId) => auth.api.deleteApiKey({ headers, body: { keyId } });
  const verify = (key) => auth.api.verifyApiKey({ body: { key } });
  const r = {};

  const alice = await user('alice');
  const A = await active(alice);
  const bob = await user('bob');
  const B = await active(bob);
  const carol = await join(alice, 'carol', 'member');
  const dave = await join(alice, 'dave', 'admin');

  // An owner creates a key for the org; the plaintext comes back once, here.
  const ka = await create(alice, A, 'ci');
  r.created = { key: ka.key, start: ka.start, referenceId: ka.referenceId, name: ka.name };
  const row = (await pool.query('select key from apikey where id = $1', [ka.id])).rows[0];
  r.stored = row.key;
  r.noName = await attempt(() => auth.api.createApiKey({ headers: alice, body: { organizationId: A } }));
  r.noOrg = await attempt(() => auth.api.createApiKey({ headers: alice, body: { name: 'mine' } }));

  // Listing never returns the key itself.
  const listed = await list(alice, A);
  r.listed = listed.map((k) => ({ id: k.id, hasKey: 'key' in k, start: k.start, name: k.name }));

  // Roles: admins manage keys, members only see them.
  r.memberList = await attempt(() => list(carol, A));
  r.memberCreate = await attempt(() => create(carol, A, 'nope'));
  r.memberRevoke = await attempt(() => revoke(carol, ka.id));
  // Disabling a key takes its clients down as surely as revoking it.
  r.memberDisable = await attempt(() =>
    auth.api.updateApiKey({ headers: carol, body: { keyId: ka.id, enabled: false } }));
  const kd = await create(dave, A, 'dave-ci');
  r.adminCreate = kd.referenceId;
  r.adminRevoke = await attempt(() => revoke(dave, kd.id));

  // Tenant isolation: alice (owner of A) against bob's org B and its key.
  const kb = await create(bob, B, 'bob-ci');
  r.listB = await attempt(() => list(alice, B));
  r.createInB = await attempt(() => create(alice, B, 'mallory'));
  r.revokeB = await attempt(() => revoke(alice, kb.id));
  r.getB = await attempt(() => auth.api.getApiKey({ headers: alice, query: { id: kb.id } }));
  r.disableB = await attempt(() =>
    auth.api.updateApiKey({ headers: alice, body: { keyId: kb.id, enabled: false } }));
  r.bInA = (await list(alice, A)).some((k) => k.id === kb.id);
  r.bStillValid = (await verify(kb.key)).valid;

  // Verification is what the API server (#341) builds on: the key resolves to its org.
  const v = await verify(ka.key);
  r.verify = { valid: v.valid, referenceId: v.key && v.key.referenceId };
  // The plugin's own limiter (10 a day, copied onto each row) is off; #342 owns limits.
  const many = [];
  for (let i = 0; i < 12; i++) many.push((await verify(ka.key)).valid);
  r.manyVerifies = many;
  // The portal shows when a key was last used.
  r.lastUsed = (await list(alice, A)).find((k) => k.id === ka.id).lastRequest;
  // A key is not a portal session.
  r.sessionFromKey = await auth.api.getSession({ headers: new Headers({ 'x-api-key': ka.key }) });

  // Revoking deletes the key: it no longer verifies, and the list no longer has it.
  r.ownerRevoke = await attempt(() => revoke(alice, ka.id));
  r.afterRevoke = (await verify(ka.key)).valid;
  r.listAfter = (await list(alice, A)).map((k) => k.id);

  // #344: provider keys use the same roles: owners and admins manage, members read.
  const can = async (headers, organizationId, action) =>
    (await auth.api.hasPermission({ headers, body: { organizationId, permissions: { providerKey: [action] } } })).success;
  r.providerKey = {
    ownerCreate: await can(alice, A, 'create'),
    adminDelete: await can(dave, A, 'delete'),
    memberRead: await can(carol, A, 'read'),
    memberCreate: await can(carol, A, 'create'),
    otherOrgRead: await attempt(() => can(alice, B, 'read')),
  };

  // #348: a suspended org's keys cannot be created, changed or revoked by its members;
  // a non-member still gets "not a member", learning nothing about the org's state.
  const susp = async (org, action) => pool.query(
    "insert into org_suspensions (org_id, action, reason, actor) values ($1, $2, 'test', 'probe')",
    [org, action]);
  const kk = await create(alice, A, 'kept');
  await susp(A, 'suspend');
  r.suspended = {
    create: await attempt(() => create(alice, A, 'during')),
    update: await attempt(() =>
      auth.api.updateApiKey({ headers: alice, body: { keyId: kk.id, enabled: false } })),
    revoke: await attempt(() => revoke(dave, kk.id)),
    // The plugin acts on the key's own org whatever the body names, so a spoofed
    // organizationId (another org) must not get past the suspension check.
    spoofRevoke: await attempt(() =>
      auth.api.deleteApiKey({ headers: alice, body: { keyId: kk.id, organizationId: B } })),
    spoofUpdate: await attempt(() =>
      auth.api.updateApiKey({ headers: alice, body: { keyId: kk.id, organizationId: B, enabled: false } })),
    nonMember: await attempt(() => create(bob, A, 'x')),
    nonMemberRevoke: await attempt(() => revoke(bob, kk.id)),
    list: await attempt(() => list(alice, A)),
    otherOrg: await attempt(() => create(bob, B, 'fine')),
  };
  await new Promise((res) => setTimeout(res, 5));
  await susp(A, 'unsuspend');
  r.suspended.afterUnsuspend = await attempt(() => revoke(alice, kk.id));

  r.A = A;
  r.B = B;
  r.ka = ka.id;
  await pool.end();
  process.stdout.write(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
`;

(ADMIN_URL ? describe : describe.skip)('org-owned API keys (BetterAuth api-key plugin)', () => {
  const dbName = `iris_apikey_${process.pid}_${randomBytes(4).toString('hex')}`;
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
  }, 60_000);

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('creates a named key owned by the org, with a recognisable prefix', () => {
    expect(r.created.referenceId).toBe(r.A);
    expect(r.created.name).toBe('ci');
    expect(r.created.key).toMatch(/^iris_[A-Za-z0-9]{32,}$/);
    // The prefix plus six random characters: enough to tell keys apart in the list.
    expect(r.created.start).toBe(r.created.key.slice(0, 11));
    expect(r.noName).toBe('NAME_REQUIRED');
    expect(r.noOrg).toBe('ORGANIZATION_ID_REQUIRED');
  });

  it('stores only a hash of the key and never lists the key itself', () => {
    expect(r.stored).not.toContain(r.created.key);
    expect(r.stored).not.toContain(r.created.key.slice(5));
    expect(r.listed).toEqual([{ id: r.ka, hasKey: false, start: r.created.start, name: 'ci' }]);
  });

  it('gives provider keys (#344) the same roles: owners and admins manage, members read', () => {
    expect(r.providerKey).toMatchObject({
      ownerCreate: true,
      adminDelete: true,
      memberRead: true,
      memberCreate: false,
    });
    // Not a member of org B at all.
    expect(r.providerKey.otherOrgRead).not.toBe('ok');
  });

  it('lets owners and admins create and revoke keys, and members only list them', () => {
    expect(r.memberList).toBe('ok');
    expect(r.memberCreate).toBe('INSUFFICIENT_API_KEY_PERMISSIONS');
    expect(r.memberRevoke).toBe('INSUFFICIENT_API_KEY_PERMISSIONS');
    expect(r.memberDisable).toBe('INSUFFICIENT_API_KEY_PERMISSIONS');
    expect(r.adminCreate).toBe(r.A);
    expect(r.adminRevoke).toBe('ok');
  });

  it("refuses to list, create in or revoke another org's keys", () => {
    expect(r.listB).toBe('USER_NOT_MEMBER_OF_ORGANIZATION');
    expect(r.createInB).toBe('USER_NOT_MEMBER_OF_ORGANIZATION');
    expect(r.revokeB).toBe('USER_NOT_MEMBER_OF_ORGANIZATION');
    expect(r.getB).toBe('USER_NOT_MEMBER_OF_ORGANIZATION');
    expect(r.disableB).toBe('USER_NOT_MEMBER_OF_ORGANIZATION');
    expect(r.bInA).toBe(false);
    expect(r.bStillValid).toBe(true);
  });

  it('verifies a key to its org, without a daily cap, and never as a portal session', () => {
    expect(r.verify).toEqual({ valid: true, referenceId: r.A });
    expect(r.manyVerifies).toEqual(Array(12).fill(true));
    expect(Number.isNaN(Date.parse(r.lastUsed))).toBe(false);
    expect(r.sessionFromKey).toBeNull();
  });

  it('refuses key writes for a suspended org to its members only (#348)', () => {
    expect(r.suspended).toEqual({
      create: 'ORGANIZATION_SUSPENDED',
      update: 'ORGANIZATION_SUSPENDED',
      revoke: 'ORGANIZATION_SUSPENDED',
      spoofRevoke: 'ORGANIZATION_SUSPENDED',
      spoofUpdate: 'ORGANIZATION_SUSPENDED',
      nonMember: 'USER_NOT_MEMBER_OF_ORGANIZATION',
      nonMemberRevoke: 'USER_NOT_MEMBER_OF_ORGANIZATION',
      list: 'ok',
      otherOrg: 'ok',
      afterUnsuspend: 'ok',
    });
  });

  it('a revoked key stops verifying and leaves the list', () => {
    expect(r.ownerRevoke).toBe('ok');
    expect(r.afterRevoke).toBe(false);
    expect(r.listAfter).toEqual([]);
  });
});
