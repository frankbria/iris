---
paths:
  - "deploy/**"
  - "docker-compose*.yml"
  - "Dockerfile*"
  - ".github/workflows/**"
  - "docs/runbook-production.md"
  - "__tests__/{ingress,deploy-script,backup-script,portal-image}.test.ts"
  - "package.json"
  - "scripts/check-pack.js"
  - "scripts/third-party-notices.js"
  - "__tests__/{container-config,iris-image,check-pack}.test.ts"
---

### TLS Ingress (issue #347)

`deploy/nginx/iris.conf` is a site file for the host's existing nginx (it already owns
443), not a proxy container. The operator fills in `server_name`, the certificate
paths and the two upstream ports (iris-api `127.0.0.1:4000`, portal `127.0.0.1:3000`),
then `nginx -t` and reloads. `/v1/` (REST and WSS) goes to iris-api, the rest to the
portal. No host details in the repo (`repo-hygiene.test.ts`).

- **Overwrite, never append.** `X-Real-IP` and `X-Forwarded-For` are set to
  `$remote_addr`. `$proxy_add_x_forwarded_for` appends to the client's value, and
  BetterAuth (no `trustedProxies`) then trusts nothing and puts everyone in one
  bucket. `createAuth()` pins `ipAddressHeaders: ['x-real-ip']`, so a client-sent
  `X-Forwarded-For` never picks a counter, and pins `disableIpTracking: false` (no IP
  means no rate limit at all). Portal E2E therefore picks its counter with `X-Real-IP`.
  `X-Forwarded-Host` is overwritten too (Next checks server actions against it) and
  `Forwarded` cleared.
- **The portal must be reachable only through the ingress** (loopback bind, never a
  published or public port). In production a request without `X-Real-IP` lands in
  BetterAuth's shared `no-trusted-ip|<path>` bucket (sign-in: 3 per 10s for everyone
  at once), and any local process that reaches the port can name any `X-Real-IP`.
- **`X-Iris-Probe` is cleared.** Behind the proxy every peer is loopback, so a
  forwarded header would claim the healthcheck's extra slot (#342).
- **`add_header` and `proxy_set_header` inherit only into a location with none of
  its own.** The security headers live at server level only; `/v1/` needs
  `Upgrade`/`Connection`, so it repeats every `proxy_set_header`. A test checks each
  location, and nginx's own 429 (`always`).
- **`limit_req_zone` and `map` must be in `http {}`.** A site file is included there,
  so they sit at its top. Their names are global to the host's nginx: everything is
  prefixed `iris_` (a second `$connection_upgrade` fails `nginx -t`).
- **Throttle key is `$iris_client_key`**: IPv4 whole, IPv6 by its /64 (a map over
  the first 8 bytes of `$binary_remote_addr`; nginx's PCRE matches bytes). Keyed on the
  full address, one /64 holder rotates into 2^64 fresh budgets. The test feeds IPv6
  addresses through a test-only realip header (`X-Test-Client`, trusted from `::1`).
- **TLS 1.2 is ECDHE + AEAD only** (`ssl_ciphers`). On a shared 443 the handshake may
  be settled by the host's `default_server` before SNI picks this block, so the
  operator checks that server's `ssl_protocols`/`ssl_ciphers` too.
- **`/v1` (no slash) is a 301 to `/v1/`** from nginx, never proxied. Locations match
  the decoded path, so `/api/%61uth/` gets the auth throttle.
- **Throttles**: `/v1/` 5 r/s per client, burst 20 (an org's 300/min; counts upgrades,
  not messages); `/api/auth/` 10 r/s, burst 20 (BetterAuth's general 100/10s; its
  per-route rules still apply behind it). Reads 75s, above the 30s heartbeat.
- **Test** (`ingress.test.ts`): the template with only ports, upstreams and a
  self-signed cert substituted, in `nginx:1.29-alpine` on `--network host`. Required
  under `CI`, skipped locally without Docker. "Per IP" is shown with `127.0.0.1` vs
  `::1`. The image's OpenSSL refuses TLS 1.1 on its own too, so the TLS check pins the
  outcome, not the `ssl_protocols` line.

### Production Deploy (issue #273)

`deploy-production` (ci.yml) promotes digests; it never builds. Runbook:
`docs/runbook-production.md`. Compose: `docker-compose.production.yml` (iris-api, worker,
portal, postgres; every image pinned by digest, app images only from `${IRIS_IMAGE:?}` /
`${PORTAL_IMAGE:?}`).

- **The security boundary is the protected `v*` tag + the `production` environment's
  tag-only rule and required reviewer**, not the workflow. Without them a collaborator's
  branch workflow could run in `production` and read its secrets. The job runs only on
  a `v*` ref, for a dispatch too (no tag input: an input would let a branch run deploy).
- **`staged-<sha>` is a record, not a boundary**: deploy-staging tags both images
  (`imagetools create`, no rebuild) as its *last* step; anything with `packages: write`
  could move it. Staging runs token mode without worker/portal, so it proves the iris
  image boots (plus the portal digest serving `/terms` on the runner), not the hosted stack.
- **One directory per release** (`releases/<tag>-<run>-<attempt>/`: compose, settings.env,
  per-release secrets); `shared/secrets/` holds pg_password, master_key, database_url
  (rewritten only if it differs: serving containers mount it). `current` is switched only
  once the new release is healthy (after the gates and the health wait), so a deploy cut
  off mid-way keeps its rollback target. Postgres is recreated only when its pinned digest
  changed (a deliberate upgrade, before the gates, not rolled back);
  rollback runs compose from the previous release's directory (its files, settings,
  images). Compose always runs from a release's **real path**, so bind mounts name that
  release's files; via the `current` link a restart would follow the link.
- **Migrations are forward-only; rollback relies on expand/contract.** `migrateToLatest()`
  succeeds as a no-op when the database has migrations the release does not know and all
  of its own are applied (an older release on a newer schema), and refuses when it also
  has pending ones (branched off before the newer release). Kysely alone throws
  "corrupted migrations" for both.
- **Health**: iris-api `GET /health/ready` -> 200 (unauthenticated, 503 while draining;
  #309). Portal `/api/health` (dynamic, `no-store`): 200 only
  when getAuth() builds, the master key loads and `select 1` answers; 503 with no detail.
  Worker: `probeDatabase()` at startup (exit 3), heartbeat file written per poll and every
  30s during a job (`IRIS_WORKER_HEARTBEAT_FILE`), compose fails it at 180s.
- **Portal image** (`Dockerfile.portal`, context = repo root): Next `output:
  'standalone'` traced from the repo root (`outputFileTracingRoot`), server at
  `apps/portal/server.js`. Its ignore file is `Dockerfile.portal.dockerignore`, which
  only BuildKit reads (the legacy builder ignores it and fails on `apps/`). Keep
  `apps/portal/e2e` and `__tests__` in the context: `next build` type-checks them.
  `next start` (portal E2E) still works with standalone output.
- **The SMTP check is compiled separately**: `scripts/verify-smtp.ts` → tsc CommonJS
  into `/app/verify` (own `{"type":"commonjs"}`), plus `node_modules/nodemailer`
  copied in, since Next bundles nodemailer into chunks and does not trace it. It
  shares `lib/mail.ts` with the portal and has its own 15s timer (nodemailer waits 2
  min on a blackhole).
- **uid 1001 everywhere.** The portal image runs as `portal` (1001) like pwuser, so the
  deploy writes every app secret file once, owned by 1001. `pg_password` is 70.
- **Optional settings reach the containers through the deploy job (#549)**: object storage
  (`IRIS_S3_*` to iris, worker and portal) and managed AI (`IRIS_MANAGED_AI_*` to iris) come
  from the `production` environment. Compose passes each as `${NAME:-}` (empty is unset to
  the services' own readers), the two secret files are always written (empty when unused,
  so the mounts exist), and `settings.env` names a `_FILE` path only when its secret was
  given: a `_FILE` var set without the rest would be a partial config (exit 3).
- **`_FILE` secrets go through `readSecretEnv()`** (src/secret-env.ts): `resolveDatabaseUrl`,
  `resolveKeyring`, `hostedServices`' `BETTER_AUTH_SECRET`, and the portal's
  `BETTER_AUTH_SECRET` / `SMTP_URL`. Do not add another reader.
- **`deploy-script.test.ts`** pushes busybox images to a `registry:2` on a loopback port
  so refs are real digests, and stages release directories as the job does. COPY-only
  Dockerfiles (each RUN is a container: tens of seconds on a loaded WSL daemon) and
  `BUILDX_BUILDER=default` (CI's setup-buildx-action makes a docker-container builder
  current, which would not load the image). The worker uses the production compose
  file's own heartbeat check. Bash reads a script while running it: do not edit
  `deploy.sh` during a run.
- **Every action is pinned to a commit SHA (#359)**, version in a trailing comment;
  Dependabot's github-actions entry updates both. The one floating ref is
  `frankbria/glm-review/.../review.yml@main`, deliberately (check-workflow-calls.yml says
  why); `container-config.test.ts` fails on any other. Staging, like production, refuses to
  deploy without `SSH_KNOWN_HOSTS` (no ssh-keyscan trust-on-first-use), and both deploy jobs
  have `timeout-minutes`. Staging's OAuth client carries only `tag:ci` (#535), and the
  workflow's `tags:` must equal the client's full tag set exactly.
- **Tag pushes already ran `build`** (`on: push` has no filter); adding
  `workflow_dispatch` leaves push/PR behaviour unchanged.

### Backups (issue #274)

`deploy/backup.sh` (daily, `deploy/systemd/iris-backup.timer`, as root) and
`deploy/restore.sh`; setup, restore and the drill log are in `docs/runbook-production.md`.
The deploy job ships both scripts and the units into each release directory; it never
runs or installs them. The artifact bucket is the next section.

- **Root runs only root-owned files outside the deploy tree.** The unit runs
  `/usr/local/sbin/iris-backup`, a reviewed copy the operator installs; settings,
  recipients, rclone config and the failure hook are in `/etc/iris`, backups in
  `/var/backups/iris`. The deploy user owns `/opt/iris-production`, so a root timer
  running `current/backup.sh` would be a root code path for the deploy key. The script
  finds postgres by compose labels (`docker exec`), not via a release's compose file, and
  checks `State.Running` before the dump and again if it fails, so a container stopping in
  between gets the script's own "no running postgres container" (#570).
- **`age` to public keys only**; the identity stays off the box. No recipients: it
  refuses, it never writes plaintext. The master key is backed up as its own file.
- **Atomic and fail-closed**: `pg_dump | age` into `<name>.tmp` under pipefail, renamed on
  success, the temp file removed by an EXIT trap. Retention runs only after a success:
  per kind the newest `BACKUP_KEEP_MIN` stay whatever their age (clock jumps), the rest
  go once older than `BACKUP_KEEP_DAYS`; both validated (`10#`, >= 1) before anything.
  rclone copies the whole directory (`--include` the two patterns), so a failed copy is
  retried by the next run.
- **Restore replaces the `public` schema in one transaction**: `begin; drop schema public
  cascade; create schema public;` then `pg_restore -f -` (SQL) into `psql`, and `commit`
  only if pg_restore succeeded (`psql --single-transaction` would commit at EOF even
  after pg_restore died). So a dump older than the schema leaves no later tables and the
  dump's `kysely_migration`. The file is decrypted to /dev/null first.
- **The serving-database check compares server identity, not URL text**:
  `system_identifier` from `pg_control_system()` plus `current_database()`, queried on
  both connections inside the container (libpq honours `%69ris`, `?dbname=`, addresses).
  An unreadable `database_url` or an unidentifiable database refuses without `--force`.
  URLs reach the container as files in a 0700 temp dir mounted read-only (`-e` would
  show in `docker inspect`); the password moves to `PGPASSWORD` inside.
- **`pg_dump -Fc` compresses**, so a plaintext marker is absent from an unencrypted dump
  too. The test checks the `PGDMP` magic instead, and the restore checks content.
- **`backup-script.test.ts`**: the Postgres healthcheck uses `-h 127.0.0.1`: the image's
  init-time server listens on the socket only and then restarts, so a socket check goes
  healthy early and the first connection is cut. `age` comes from PATH (CI installs the
  apt package) or the pinned, checksummed release tarball cached in the temp dir. Each
  restore is one container start (~30 s on a loaded WSL daemon).

### Artifact bucket backups (issue #445)

Versions in the bucket plus an off-site copy; runbook "Artifact bucket backups".

- **Everything runs from what the deploy already ships**: `iris admin artifact-versioning
  [--enable]`, `artifact-versions <key>`, `artifact-restore <key> --version-id <id>`,
  `artifact-undelete <key|prefix/>` in the image (they need `IRIS_S3_*` only, no
  database), and the copy in `backup.sh`. A new script would need a deploy-job change.
- **`--version` is taken**: commander gives the program's version for it on any
  subcommand, with exit 0. Hence `--version-id`.
- **Old versions are pruned in code, not by a lifecycle rule**: `pruneVersions()` in the
  daily retention pass (`ARTIFACT_VERSION_DAYS` = 14, the backups' default window). A
  rule's enforcement differs by vendor and cannot be tested; this is the same everywhere.
  A version's age counts from when it **stopped being current** (the write time of the
  version in front of it), not from its own write time: a 60-day-old baseline replaced
  yesterday is one day into its 14.
- **A key's versions can straddle `ListObjectVersions` pages**, and versions and delete
  markers come as two lists. `keyVersions()` carries the page's last key
  (`NextKeyMarker`) into the next page. SeaweedFS timestamps have one-second resolution.
- **Undelete removes delete markers** (no copy, history kept); restoring an overwrite is a
  `CopyObject` from the version. A purge on a versioned bucket only adds delete markers,
  so "purged" means unreadable at once and gone after the prune.
- **`removeBucket()` (tests) deletes versions first**: a versioned bucket is not empty
  while versions or markers remain.
- **The off-site copy is `rclone sync --backup-dir <remote>/replaced/<stamp>`**: a plain
  sync would empty the copy when the bucket is emptied, a plain copy would keep purged
  images for ever. `replaced/` directories are pruned by their name (a UTC stamp), not by
  `--min-age`: moved files keep their original modification time. `rclone lsf` exits 3
  when `replaced/` does not exist yet. The test's rclone is a stub; the sync has not run
  against a real rclone or bucket.

### npm Package (issue #320)

- **Not published yet; install from source.** The npm name `iris-suite` is reserved by the
  owner; its 0.0.1 is an empty placeholder. `version` stays 0.0.1 until the first real release.
- **`npm run build` cleans `dist/` first**, and npm's `prepare` runs it before every pack and
  publish (it ran even with `--ignore-scripts` in npm 10.9 here), so deleted code cannot ship
  as stale output.
- **CI runs `npm run check:pack`** (`scripts/check-pack.js`, rules unit-tested): the
  `npm pack --dry-run` listing must hold every `bin`/`main` target, nothing outside `files`,
  and no `dist/*.js|.d.ts|.js.map` without a `src/*.ts`.
- `better-auth` (and the hosted server code) ships in the CLI package; a CLI-only install pays
  for it. Accepted until the package is published; a split server package is the option then.

### Container Deployment (issue #192)

`Dockerfile`, `.dockerignore`, `docker-compose.staging.yml` and
`docker/healthcheck.js` ship IRIS as a container. These constraints are easy to
break and expensive to rediscover:

- **Base image is `mcr.microsoft.com/playwright:v<version>-noble`**, tracking the
  `playwright` version in package.json. It carries Chromium *and* its system
  libraries, so no `playwright install --with-deps` at build time. Verified to
  ship Node v24.18.1, satisfying the `engines` floor. Keep the tag in step with
  the library — they are matched pairs.
- **Three stages, deliberately.** `better-sqlite3` has no prebuilt binary here
  and needs node-gyp, which the Playwright image has no `make` for; the compiler
  goes in a `deps` stage and never reaches the shipped image. That stage runs
  `npm ci --omit=dev --ignore-scripts` then `npm rebuild better-sqlite3`, because
  the full lifecycle fails: `"prepare": "npm run build"` needs TypeScript, which
  `--omit=dev` has just removed.
- **The container binds `0.0.0.0`, the host publishes on `127.0.0.1`.** Docker
  forwards a published port to the container's network interface, not its
  loopback, so a loopback bind inside the container refuses every connection
  while looking healthy. The security boundary is the host-side mapping.
- **`shm_size: 1gb`.** Chromium exhausts Docker's 64 MB default and the crash
  reads as an opaque browser disconnect.
- **Sandboxed Chromium needs `docker/seccomp-chromium.json`.** Every launch goes
  through `launchBrowser()` / `newHardenedContext()` in `src/browser.ts` (#331):
  sandbox on, Playwright's signal handlers off, downloads and service workers
  blocked. A guard test fails on any other `chromium.launch` / `browser.newContext`
  in `src/`. Docker's default seccomp allows `unshare`/`setns`/`clone`-with-namespace
  flags and `chroot` only to a container holding `CAP_SYS_ADMIN` / `CAP_SYS_CHROOT`,
  and compose drops every capability (#332). The profile is Docker's default
  (moby/profiles v0.2.3) plus one rule allowing those four. Do not swap in
  Playwright's published profile: it predates `clone3`, which then gets EPERM, and
  glibc falls back to `clone` only on ENOSYS. The deploy probe launches through the
  factory, so it proves the sandbox on the real host.
- **Runtime hardening lives in `docker-compose.staging.yml` (#332)**: `init`,
  `cap_drop: ALL`, `no-new-privileges`, `read_only` with tmpfs for `/tmp` and
  `/home/pwuser`, memory/CPU/pids limits, `stop_grace_period` above the server's
  5s force-exit. `__tests__/container-config.test.ts` pins each one. Measured in
  this image: ~20 pids for the idle server, ~60 more per browser session.
- **The token is a compose secret file**, `IRIS_CONNECT_TOKEN_FILE`, not an env
  var (`docker inspect` shows env). It is a bind mount, so the host file's owner
  and mode apply: readable by uid 1001, inside a 0700 directory.

- **The image is built and run on every push and PR (#306)**, not only by the staging
  deploy. CI's `build` job builds `iris:ci` and `__tests__/iris-image.test.ts`
  (`IRIS_TEST_IMAGE`, required under CI) runs it from `docker-compose.staging.yml`
  **unchanged** (copied with the seccomp profile and throwaway secrets into a temp project
  directory, image tagged `ghcr.io/frankbria/iris:ci-<pid>` via `IRIS_TAG`): `healthy`,
  sandboxed `launchBrowser()` via `docker exec`, the negative control (Docker's default
  seccomp must fail with "Chromium could not start its sandbox"), `touch /data/probe` as uid
  1001, and no `next`/`react`/`@hugeicons` in the image. The compose file fixes
  `container_name: iris-staging` and `127.0.0.1:4000`, so both must be free.
  `container-config.test.ts` fails when a Dockerfile Playwright tag differs from the
  lockfile's `playwright`, and Dependabot has a `docker` entry: a bump of either alone stays
  red until the other is in the same PR. Locally, without the buildx plugin, build with
  `DOCKER_BUILDKIT=0 docker build -t iris:local .` (BuildKit without buildx fails, and a
  docker-container builder does not load the image).

- **Supply chain (#360).** Every `FROM` in `Dockerfile` and `Dockerfile.portal` is pinned by
  digest (`tag@sha256:…`; Dependabot's docker entry bumps both). CI writes a CycloneDX SBOM per
  image with a digest-pinned Trivy (one image copy, `--timeout 15m`; the default timed out on
  this host), scans the SBOM, fails on a fixable CRITICAL, lists fixable HIGH, and uploads the
  SBOMs as the `image-sboms` artifact. The runtime image has no npm (`rm -rf
  /usr/lib/node_modules/npm …`: nothing uses it at runtime, and the base image's global npm
  carried all the Node.js findings). `/app/THIRD_PARTY_NOTICES.txt` is generated in the deps
  stage by `scripts/third-party-notices.js` from what `npm ci --omit=dev` installed (the root
  lockfile also lists the portal's packages, which are not installed, so it reads installed
  `package.json`s, not lockfile entries).

The healthcheck completes an authenticated JSON-RPC round trip rather than a TCP
open — the socket listens long before the browser layer is usable. It lives in a
file because compose interprets `${...}` in an inline script as its own syntax.
