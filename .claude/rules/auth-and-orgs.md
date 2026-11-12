---
paths:
  - "apps/portal/**"
  - "src/auth/**"
  - "src/legal/**"
  - "src/byok/**"
  - "src/org-suspension.ts"
  - "src/member-keys.ts"
  - "src/api-key-auth.ts"
  - "package.json"
  - "__tests__/{auth-,byok,admin-cli}*"
---

### Workspaces and the Portal (issue #247)

The root `package.json` declares `"workspaces": ["apps/*"]`. The IRIS package stays
at the root and publishes exactly as before; `apps/portal` (`@iris/portal`) is
private. Things that are easy to break:

- **Root Jest ignores `apps/`** (`testPathIgnorePatterns` and
  `modulePathIgnorePatterns`). The portal has its own `next/jest` config.
- **The portal's ESLint config pins `settings.react.version`.** `eslint-config-next`
  sets it to `"detect"`, and detection is the one path in `eslint-plugin-react`
  (peer range stops at ESLint ^9.7) that calls `getFilename()`, removed in ESLint 10.
  Remove the pin and ESLint 10 crashes (`getFilename is not a function`).
- **`gray` is gone from the shadcn preset API** (400). The portal was scaffolded
  with `neutral` and its tokens replaced with shadcn's registry gray
  (`/r/colors/gray.json`). Adding components with `npx shadcn add` is unaffected.
- **`better-auth` is ESM-only**, and `src/auth/config.ts` loads it from the
  CommonJS build through `require(esm)`. `tsc` resolves its subpaths through the
  package's `typesVersions`. Jest cannot load it in-process: test through a spawned
  Node (see `auth-config.test.ts`), or add the whole dependency tree to
  `transformIgnorePatterns`. `createAuth()` requires `secret` and `baseURL`, because
  otherwise better-auth falls back to `BETTER_AUTH_*` or, outside production, to a
  built-in secret. Those variables are on the `jest.setup.ts` scrub list.
- **`.dockerignore` excludes `apps/`**, so the image never carries portal packages.
- **The root `package.json` pins `overrides.next`.** better-auth lists `next` as an
  optional peer, and npm installed a separate root copy for it that stayed on a
  vulnerable version after the portal moved (GHSA-vcvr-r3jv-pc5j). Bump the override
  together with `apps/portal`'s `next` and `eslint-config-next`: npm refuses
  (`EOVERRIDE`) when they disagree. Do not "fix" a stray copy with `npm dedupe`, which
  rewrote 4,000 lockfile lines and pulled a 12-hour-old release. `overrides.react-dom` is
  the same fix (better-auth's optional `react-dom` peer): a Dependabot group left the root copy
  on 19.2.8 beside the portal's 19.3.1, and portal Jest refused to load ("Incompatible React
  versions"). Bump it with the portal's `react-dom`.

### Portal Accounts (issue #249)

Sign-up, verification, login and password reset run through BetterAuth in
`apps/portal`, over the shared `createAuth()`.

- **The account policy is in `createAuth()` and is merged key by key into the caller's
  `emailAndPassword` / `emailVerification` / `rateLimit`, policy last.** Neither the
  portal nor the API can relax a pinned key, and a caller's other keys survive (e.g.
  `rateLimit.storage` for #316). A whole-object spread would silently drop them. The
  policy does not lock `advanced` or `trustedOrigins`.
  - Verification is required, and verification mail goes out on sign-up **and on each
    correct-password sign-in of an unverified account**. BetterAuth only logs a failed
    send, so the re-send on sign-in is the recovery path for a lost or failed mail.
  - **No sign-in on verification** (login CSRF: a mailed link must not sign a browser
    into the sender's account).
  - Sessions are revoked on reset.
  - Rate limits are on in every environment (BetterAuth's defaults turn them on only in
    production).
  - `sendEmail` is required. Secure/httpOnly/SameSite=Lax cookies are BetterAuth's defaults *given* an
  https `baseURL`. The policy pins `advanced.ipAddress.ipAddressHeaders` only (#347),
  merged two levels deep: spreading a whole `advanced` would replace a caller's
  (e.g. `trustedProxies`, cookie options).
- **The portal imports `../../../src/...` directly.** Turbopack finds the workspace
  root from the root lockfile, and `pg` is on Next's default server-external list. No
  `transpilePackages` or workspace package is needed.
- **`getAuth()` is lazy, and a server page must `await headers()` before calling it.**
  If `getAuth()` runs first, Next prerenders the page at build time and the build
  fails for want of `SMTP_URL`.
- **Submit buttons stay disabled until hydration** (`useSyncExternalStore`). Before
  hydration, a native submit is a GET with the password in the query string. The E2E
  test pins this with JavaScript disabled.
- **Rate limits are per client IP from `X-Real-IP`** (#347), stored in memory (one
  portal process). The ingress overwrites it with the peer address. Served without
  the ingress (no header), production falls back to one shared bucket per path.
- **E2E** (`apps/portal/e2e`, `npm run e2e -w @iris/portal` after a build): real
  Postgres plus Mailpit, from docker-compose.dev.yml or the CI services. Things that bit:
  - The global setup runs `src/db/migrate.ts` as a child process, because Playwright's
    loader cannot link the ESM `kysely/migration`.
  - Each test sends a random `X-Real-IP`, not a counter: Playwright restarts
    the worker after a failure, which resets module state.
  - After a client-side link click, wait for the URL before `getByLabel(...)`. The old
    page may have a field with the same label.
  - Next's route announcer is also `role="alert"`. Match an alert by its text.
- **WSL: a connect to a closed 127.0.0.1 port hangs** (no RST, ~2 min) instead of being
  refused. `[::1]` refuses at once. It is the same blackhole as #382, and Playwright's
  already-running check pays it before every local E2E run.

### Terms and AUP (issue #276)

Drafts in `apps/portal/content/legal/{terms,acceptable-use}.md` (front matter `title`,
`version`, `draft`), public at `/terms` and `/acceptable-use`. `draft: true` shows the
"Draft — pending review; not yet in effect" banner; the owner removes it by deleting that
line once counsel approves. Placeholders are `[square brackets]`: no company name,
jurisdiction or address is invented. `lib/legal.ts` + `components/legal-document.tsx` are a
tiny renderer (headings, `-` lists, bold, links; React escapes text, links limited to site
paths and https).

- **The enforced versions live in `src/legal/versions.ts`** (`LEGAL_VERSIONS`,
  `ACCEPTED_TERMS` = `<terms>:<aup>`). A test fails if a file's front-matter `version`
  differs. Publishing a new version: see docs/runbook-production.md.
- **`terms_acceptances`** (migration 0006): one row per user, document and version, with
  `accepted_at` and `ip`; keyed by user, so it is the one IRIS table without `org_id`
  (`USER_SCOPED_TABLES` in the catalog test is the documented exemption; add to it only
  for a person-scoped table). `on delete cascade` from `"user"`.
- **Sign-up is enforced in `createAuth()`**: a `hooks.before` on `/sign-up/email` refuses
  with `400 TERMS_NOT_ACCEPTED` unless the body's `acceptedTerms` equals `ACCEPTED_TERMS`
  (so every caller, tests included, must send it), and `hooks.after` records the rows
  with the client IP. It is clickwrap: the server refuses a sign-up without the
  current-versions token, but a scripted client can still send it. `createAuth()` takes
  no `hooks` from its caller, and needs a `pg` Pool or `{ db }` Kysely as `database`.
  `socialProviders` is omitted from its options type (a test pins that): OAuth callbacks
  create users without passing `/sign-up/email`, so enforce acceptance there first.
  The rows are inserted only for a user row that exists: with email verification on,
  BetterAuth answers a duplicate-email sign-up with a made-up user, and that must neither
  log an error nor reveal that the address exists. The after-hook cannot undo the user: a failed
  write is logged and the user meets `/accept-terms` at the next page.
- **Re-acceptance**: `requireOrg()` redirects a user missing a current version to
  `/accept-terms` (server page + server action; the form carries the versions it was
  rendered for) which also needs the `agree` field (`on`), else it records nothing and
  returns to the page with an error; the IP is `getIP()`'s validated value. The gate covers
  portal pages (`requireOrg()`) only, by design for now: server actions on `/api-keys` and
  `/provider-keys`, BetterAuth's endpoints and invitation acceptance stay usable for a user
  who has not re-accepted. API keys and the RPC are unaffected.
- E2E uses a version bump simulated by aging the user's rows (`terms.spec.ts`).

### Abuse Handling and Contacts (issue #348)

Operator suspension of an org, and the published contacts. Ops side: runbook "Abuse handling".

- **`org_suspensions`** (migration 0007) is an append-only history (`action` suspend /
  unsuspend, `reason`, `actor`); an org's state is its latest row, none means active.
  `orgSuspensions(db)` (src/org-suspension.ts) is idempotent and refuses an unknown org;
  `suspendedSql(orgId)` is the one predicate, usable inside other statements.
- **The reason is for operators only.** Tenants see "Organization suspended" (403 on the
  WS upgrade and on REST, `ORGANIZATION_SUSPENDED` from BetterAuth, the job's error),
  never the reason.
- **Enforcement points**: `apiKeyAuthenticator.verify` returns `'suspended'` for a valid key
  of a suspended org (403, not 401: the key is fine); `recheck` does too, so live
  connections close with 1008 within `authRecheckMs`. `claim` reads the org's state in the
  same statement, and the worker fails such a job unrun, no usage, counted `refused`
  (not `error`: the watchdog's rate is server faults only). The portal: `requireOrg()`
  exposes `suspended` (banner with the support contact); a BetterAuth `hooks.before`
  refuses `/api-key/create|update|delete` for a member of a suspended org (a non-member
  still gets the plugin's own refusal, so another tenant's state does not leak); the
  provider-key server actions refuse too. **Not instant, and not everything**: an open
  connection keeps working until its next re-check (up to `authRecheckMs`, 60 s), and a
  job already running finishes and is billed. Invitations, accepting one and switching
  orgs stay open (membership is not abuse; keys and jobs are what act on the world).
  A member of a suspended org cannot create a new org (`/organization/create` hook): a
  fresh org would carry new keys past the suspension. The api-key hook takes the org from the key for update/delete (the plugin acts on the
  key's own org whatever the body names) and from the body for create only.
- **Rows are stamped in lock order**, not by `now()`: a transaction that began first can
  take the per-org lock second, so each row is dated strictly after the org's latest
  row. Otherwise two operators acting at once can leave the earlier action current.
- **`iris admin suspend-org|unsuspend-org <orgId> --reason … [--actor …]`** and
  `org-status`: hosted only (exit 2), exit 3 when the database is unreachable, 1 for an
  unknown org. Actor defaults to `$SUDO_USER`/`$USER`.
- **User bans (#457)** reuse the same history code: `org-suspension.ts` is one core over a
  `Subject` (table, id column, resolve, optional `onSuspend` in the same transaction);
  `orgSuspensions` and `userSuspensions` (by id or email, `user_suspensions`, migration 0016,
  user-scoped and cascading) are its two instances, with the same `suspend`/`unsuspend`
  actions. A ban deletes the user's sessions and revokes the keys they created (#408's
  `revokeKeysCreatedBy`) in that transaction; `createAuth()`'s `session.create.before`
  refuses a banned user (`403 USER_BANNED`). Every session is made there, so invitations
  (which need one) are covered too. There is no cookie cache: deleting the session rows
  signs them out at once. `iris admin ban-user|unban-user|user-status`.
  **Races (codex review)**: a sign-in or key creation can pass the check while a ban is
  committing, so both recheck after their write under the ban's advisory lock
  (`userBannedLocked`): `session.create.after` deletes the new session and refuses, and the
  post-create key check (`revokeIfCreatorBanned`, after #408's `revokeIfCreatorLeft`)
  revokes. Either the ban sees the committed row or the recheck sees the ban.
- **Contacts are operator configuration**, never invented: `IRIS_SECURITY_CONTACT`,
  `IRIS_ABUSE_CONTACT`, `IRIS_SUPPORT_CONTACT` (`mailto:` or `https:`, validated;
  malformed throws). Unset shows a `[placeholder]` on `/contact`, and
  `/.well-known/security.txt` answers 404 without a security contact (RFC 9116 requires
  `Contact`). `Expires` counts from when the portal process first serves it
  (`IRIS_SECURITY_TXT_EXPIRES_DAYS`, 1-365, default 365): a deploy renews it, a portal
  left running a year lets it lapse. The production job passes the contacts from
  environment variables (optional).

### Portal Organizations (issue #250)

The org is the tenant (ADR 0001 §4). The organization plugin's options live in
`createAuth()`; its tables were already in migration 0001.

- **The personal org is made when a session is created, not at sign-up.** A
  `databaseHooks.session.create.before` hook sets `activeOrganizationId` to one of the
  user's orgs, creating one they own if they have none. Sessions need a verified
  address, so an abandoned sign-up leaves no org, and a failed creation is retried at
  the next sign-in. BetterAuth sets no active org on sign-in by itself. `createAuth()`
  therefore takes no `databaseHooks` from its caller.
- **A new session starts in the org the user last made active (#409)**: `user_active_orgs`
  (migration 0019, one row per user) is written by a `hooks.after` on set-active,
  accept-invitation and create, and read by `activeOrgFor` only while the user is still a
  member. Sessions cannot hold it: sign-out deletes the row. Org purge deletes its rows.
- **`/org` pages its members (#409)** with `listMembers` (100 a page, `?page=N`): `org.members`
  from `requireOrg()` is `getFullOrganization`'s first 100 only. The sole-owner count is one
  query over the whole org. `/login` redirects a signed-in visitor to `next` (or
  `/dashboard`), and `/signup?next=` carries it into the verification `callbackURL`, so an
  invitee who signs up from the invitation lands back on it after verifying and logging in.
- **Portal pages get their org from `requireOrg()`** (`apps/portal/lib/org.ts`), which
  calls BetterAuth with the session headers and no org id. Never read an org id from
  the request. A form rendered for that org sends its id back (`InviteForm`), because
  another tab may switch the session's active org between render and submit.
  BetterAuth still checks the caller's role in that org.
- **A session can end between two reads of one request (#685).** `requireOrg()` makes
  several BetterAuth calls; when another request ends the session in between (logout in a
  second tab, or a `<Link>` prefetch that found the user in no org and signed them out),
  every read after `getSession` throws the session middleware's bare 401
  (`body.code === "UNAUTHORIZED"`), which rendered Next's error page. `requireOrg()` and
  the reads `/org` and `/api-keys` make after it go through `logInIfSignedOut`
  (`lib/org.ts`): that one code redirects to `/login`, everything else is thrown on (a
  plugin's own 401s, such as `USER_BANNED`, carry other codes). A new page that calls
  `auth.api.*` after `requireOrg()` adds `.catch(logInIfSignedOut)`. Server actions do
  not: they read the session themselves and answer with a message.
- **A refused org read clears the session's active org** (BetterAuth,
  `crud-org.mjs`). A request that names another tenant's org id therefore leaves the
  session with none, and `requireOrg()` moves it back to an org the user belongs to.
- **Refusals have different codes.** A non-member inviting into an org gets
  `400 MEMBER_NOT_FOUND`, not 403. Tests assert the error code, so a call refused for
  another reason (a missing `Origin` on a cookie POST, a validation error) cannot pass
  as a membership refusal.
- **BetterAuth's client follows `signIn`'s `callbackURL` after a successful sign-in.**
  The login form passes `?next=` (checked by `safeNext()`) as that URL. `new URL()`
  collapses dot-segments, so `/.//host` parses to the path `//host`, and `safeNext()`
  checks the parsed path as well as the origin.
- **Members are managed on `/org` (#408)**: owners and admins change a role (select) and
  remove a member (two-step button, the count of keys it revokes shown); everyone else can
  leave. Each call sends the rendered org's id. BetterAuth refuses the last owner's removal,
  demotion or leave and an admin acting on an owner; the page does not offer those and says
  why. No `window.confirm`: Playwright dismisses dialogs, so E2E would cancel it.
  `afterMemberWrite` (createAuth after hook) audits `member.remove|leave|role` and revokes
  keys; it reads the member from the response (`{ member }` for remove, the row for leave
  and role).
- Tenants cannot delete orgs (`disableOrganizationDeletion`): `runs`, `usage_events` and the
  other tenant tables reference the org with no cascade. Operators do it with
  `iris admin delete-org` (#349, below).

### Portal API Keys (issue #340)

The api-key plugin (`@better-auth/api-key`, its own ESM-only package since 1.7) issues
**org-owned** keys: `references: 'organization'`, so a key's `referenceId` is the org id.
The portal page is `/api-keys`.

- **The org roles carry an `apiKey` resource** (`ac` / `roles` in `createAuth()`). The
  plugin checks it for every org-key operation, and BetterAuth's default roles do not
  have it, so without it only the org's creator could manage keys. Owners and admins
  create, update and delete; members only read. The roles are BetterAuth's defaults
  plus that resource, so the org permissions from #250 are unchanged.
- **Hashed at rest, shown once.** Only `create` returns the plaintext. List and get
  strip it, and the portal keeps it in component state only. Keys start `iris_` by
  default; an owner or admin may pass another prefix to create, so treat the prefix as
  a convention, not a guarantee. The list shows the first 11 characters (prefix plus 6
  random), set by `startingCharactersConfig`: the default 6 is the prefix plus one.
- **The plugin's own limiter is off.** Its default is 10 verifications per day, and
  `create` copies the setting onto each key row (`rateLimitEnabled`, `rateLimitMax`).
  Per-key limits are #342's. Rows created now carry `rateLimitEnabled = false`.
- **Revoke deletes the row.** The key stops verifying at once; the audit log keeps
  `api_key.delete` with the user who did it (#361).
- **A key goes with its creator's membership (#408).** The row records no creator, but
  #361's audit log does (`api_key.create`, actor user): when a member is removed or leaves,
  a BetterAuth after hook deletes the org's live keys they created and audits each
  (`api_key.delete`, `reason`). Keys made before #361 have no creator on record and stay;
  a role change revokes nothing. Other members may have copied a key, so rotate anyway
  after an admin leaves on bad terms. `src/member-keys.ts` holds both halves: the
  removal's `revokeKeysCreatedBy`, and `revokeIfCreatorLeft`, run after each create's
  audit row is committed (codex review): a removal racing a create either sees that row
  or leaves no membership for the re-check to find.
- **Rename and disable on `/api-keys` (#412)**: owners and admins get Rename and a
  Disable/Enable toggle (`authClient.apiKey.update`, `name` / `enabled`); everyone sees a
  "disabled" marker. Disabling is the reversible kill switch, revoking the final one. A
  disabled key fails verification (`KEY_DISABLED`, a 401 at the API, `api-key-auth.test.ts`);
  BetterAuth refuses members (`INSUFFICIENT_API_KEY_PERMISSIONS`), and #361's hook audits
  each update with the fields it changed.
- `enableSessionForAPIKeys` stays off: a key must never become a portal session.
- **Do not let `npm install -w @iris/portal` pick the package's latest version.** It
  nested a second `better-auth` under `apps/portal`. Pin the range the root uses and
  check the lockfile diff.

### BYOK Provider Keys (issue #344)

- **Envelope encryption** (src/byok/crypto.ts): each stored key gets a fresh AES-256-GCM
  data key, wrapped by a master key from `IRIS_KEY_ENCRYPTION_KEY(_FILE)`
  (`id:base64` entries, the first seals; generate with
  `echo "k1:$(openssl rand -base64 32)"`). Both layers take `(key id, org, provider)` as
  AAD, so a row copied to another org or relabelled does not open. Each blob names its
  master key: rotate by listing the new key first, running `node dist/byok/rewrap.js`
  (`rewrapAll()`), then dropping the old key. Opening requires the full 16-byte tag and a
  minimum blob length (GCM otherwise accepts 4-byte tags), and the master key's base64
  is parsed strictly (Node skips invalid characters, so a typo could decode to 32 bytes
  of a different key).
- **`providerKeyStore(db, keyring)`** (src/byok/store.ts): `set`/`remove`/`list` per org
  (format-checked, OpenAI and Anthropic only, per #258), and `credentialsFor(orgId)`,
  the only way the plaintext leaves. With both vendors stored, the one saved most
  recently is used, until #346 adds an org AI setting.
- **Hosted `iris connect`** resolves `aiCredentials` from the store, and refuses to start
  without the master key (exit 3, ADR 0001 §5).
- **Roles**: `createAuth()` has a `providerKey` resource; owners and admins create and
  delete, members read.
- **Portal `/provider-keys`**: server actions (`app/provider-keys/actions.ts`) ask
  BetterAuth `hasPermission` for the org the form names (it checks the caller's own
  membership in that org, not the active org), then call the store. An empty org id
  is refused first: BetterAuth would read it as the active org. `lib/provider-keys.ts`
  imports `server-only`, since it holds the master keyring. The forms
  POST even before hydration, so a key never lands in a URL. The portal needs the same
  master key as `iris connect` (`IRIS_KEY_ENCRYPTION_KEY`, set by `playwright.config.ts`
  for E2E).
- **E2E forgery needs the server-rendered form.** A hydrated client form's DOM drops the
  server-action fields, so re-submitting its `outerHTML` never reaches the action. Take
  the hidden `$ACTION_*` fields from the SSR HTML and POST them as multipart, with a
  positive control from an authorised session.
