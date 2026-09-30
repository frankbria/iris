/**
 * Organizations, membership and roles through the shared `createAuth()` (#250).
 *
 * Test strategy: a real Postgres (a throwaway database, as in `db/postgres.test.ts`)
 * and BetterAuth's own server API, no fakes. BetterAuth is ESM-only and Jest's
 * sandbox cannot `require(esm)`, so one spawned Node plays every scenario and
 * reports what each call returned; the tests below assert on that report. A
 * refused call reports BetterAuth's error status (e.g. `FORBIDDEN`), so a test
 * can tell "refused" from "crashed".
 *
 * Users are verified by a direct update rather than a mailed link: verification is
 * #249's subject, and sign-in is what creates the personal org.
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
  console.warn(
    'Skipping organization tests: set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)',
  );
}

const PROBE = `
const { Pool } = require('pg');
const { createAuth } = require('./src/auth/config.ts');
const PASSWORD = 'correct-horse-battery-staple';
(async () => {
  const pool = new Pool({ connectionString: process.env.PROBE_URL });
  const mails = [];
  const auth = createAuth({
    secret: process.env.PROBE_SECRET,
    baseURL: 'https://portal.example.com',
    database: pool,
    sendEmail: async (mail) => { mails.push(mail); },
  });
  const signIn = async (email) => {
    const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });
  };
  const user = async (name) => {
    const email = name + '@iris.test';
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
    await pool.query('update "user" set "emailVerified" = true where email = $1', [email]);
    return signIn(email);
  };
  // 'ok', or the code of the error BetterAuth refused the call with.
  const attempt = (fn) => fn().then(() => 'ok', (e) => (e.body && e.body.code) || e.status || String(e));
  const active = async (headers) => (await auth.api.getSession({ headers })).session.activeOrganizationId;
  const orgs = async (headers) => (await auth.api.listOrganizations({ headers })).map((o) => o.id);
  const role = async (headers, organizationId) =>
    (await auth.api.getActiveMemberRole({ headers, query: { organizationId } })).role;
  const invite = (headers, email, role, organizationId) =>
    auth.api.createInvitation({ headers, body: { email, role, organizationId } });
  const accept = (headers, invitationId) =>
    auth.api.acceptInvitation({ headers, body: { invitationId } });
  const r = {};

  // Signup + first sign-in: a personal org, owned by the user, active.
  const alice = await user('alice');
  const A = await active(alice);
  r.personal = { active: A, orgs: await orgs(alice), role: await role(alice, A) };
  // Signing in again reuses it.
  const alice2 = await signIn('alice@iris.test');
  r.again = { active: await active(alice2), orgs: await orgs(alice2) };

  const bob = await user('bob');
  const B = await active(bob);
  r.distinct = A !== B;

  // Invite by email: the mail links to the portal's accept page.
  const toCarol = await invite(alice, 'carol@iris.test', 'member');
  r.mail = mails.find((m) => m.to === 'carol@iris.test');
  r.invitationId = toCarol.id;
  const carol = await user('carol');
  // Someone else holding the link cannot accept it.
  r.bobAcceptsCarols = await attempt(() => accept(bob, toCarol.id));
  r.carolAccepts = await attempt(() => accept(carol, toCarol.id));
  r.carol = { orgs: await orgs(carol), role: await role(carol, A), active: await active(carol) };
  r.memberInvites = await attempt(() => invite(carol, 'x@iris.test', 'member', A));

  // An admin may invite; a member may not (above).
  const toDave = await invite(alice, 'dave@iris.test', 'admin');
  const dave = await user('dave');
  await accept(dave, toDave.id);
  r.dave = { role: await role(dave, A) };
  r.adminInvites = await attempt(() => invite(dave, 'erin@iris.test', 'member', A));

  // Tenant isolation: alice (owner of A) against bob's org B.
  r.readB = await attempt(async () => {
    const org = await auth.api.getFullOrganization({ headers: alice, query: { organizationId: B } });
    if (!org) throw { status: 'NULL' };
  });
  r.listMembersB = await attempt(() =>
    auth.api.listMembers({ headers: alice, query: { organizationId: B } }));
  r.listInvitationsB = await attempt(() =>
    auth.api.listInvitations({ headers: alice, query: { organizationId: B } }));
  r.switchToB = await attempt(() =>
    auth.api.setActiveOrganization({ headers: alice, body: { organizationId: B } }));
  r.inviteIntoB = await attempt(() => invite(alice, 'mallory@iris.test', 'owner', B));
  r.activeAfter = await active(alice);
  const full = await auth.api.getFullOrganization({ headers: alice, query: { organizationId: A } });
  r.aliceSees = full && { id: full.id, members: full.members.map((m) => m.user.email).sort() };

  // Deleting an org is off until offboarding (#349) handles its data.
  r.deleteA = await attempt(() =>
    auth.api.deleteOrganization({ headers: alice, body: { organizationId: A } }));

  r.A = A;
  r.B = B;
  await pool.end();
  process.stdout.write(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
`;

(ADMIN_URL ? describe : describe.skip)('organizations (BetterAuth organization plugin)', () => {
  const dbName = `iris_org_${process.pid}_${randomBytes(4).toString('hex')}`;
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

  it('creates a personal org at the first sign-in, owned by the user and active', () => {
    expect(r.personal.active).toEqual(expect.any(String));
    expect(r.personal.orgs).toEqual([r.personal.active]);
    expect(r.personal.role).toBe('owner');
    expect(r.distinct).toBe(true);
  });

  it('reuses that org on the next sign-in instead of making another', () => {
    expect(r.again).toEqual({ active: r.A, orgs: [r.A] });
  });

  it('invites by email with a link to the portal accept page', () => {
    expect(r.mail).toMatchObject({ to: 'carol@iris.test' });
    expect(r.mail.text).toContain(`https://portal.example.com/accept-invitation/${r.invitationId}`);
  });

  it('lets only the invited address accept, as the invited role', () => {
    expect(r.bobAcceptsCarols).toBe('YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION');
    expect(r.carolAccepts).toBe('ok');
    expect(r.carol.orgs).toEqual(expect.arrayContaining([r.A]));
    expect(r.carol.role).toBe('member');
    // Accepting switches the session to the org just joined.
    expect(r.carol.active).toBe(r.A);
  });

  it('lets owners and admins invite, and not members', () => {
    expect(r.memberInvites).toBe('YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION');
    expect(r.dave.role).toBe('admin');
    expect(r.adminInvites).toBe('ok');
  });

  it('a member of org A cannot read, list, switch to or invite into org B', () => {
    expect({
      readB: r.readB,
      listMembersB: r.listMembersB,
      listInvitationsB: r.listInvitationsB,
      switchToB: r.switchToB,
      inviteIntoB: r.inviteIntoB,
    }).toEqual({
      readB: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
      listMembersB: 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION',
      listInvitationsB: 'FORBIDDEN',
      switchToB: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
      inviteIntoB: 'MEMBER_NOT_FOUND',
    });
    // A refused read also clears the session's active org (BetterAuth), so the portal
    // must recover from none; it must never be left pointing at B.
    expect(r.activeAfter).toBeNull();
    expect(r.aliceSees).toEqual({
      id: r.A,
      members: ['alice@iris.test', 'carol@iris.test', 'dave@iris.test'],
    });
  });

  it('refuses to delete an org', () => {
    expect(r.deleteA).toBe('ORGANIZATION_DELETION_DISABLED');
  });
});
