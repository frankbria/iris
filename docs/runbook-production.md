# Production runbook (issue #273)

Production runs four containers from `docker-compose.production.yml` (ADR 0001 §1):

| Service    | Image                         | What it is                                   | Host port        |
| ---------- | ----------------------------- | -------------------------------------------- | ---------------- |
| `iris`     | `ghcr.io/<repo>`              | iris-api: hosted `iris connect` (REST + WSS) | `127.0.0.1:4000` |
| `worker`   | `ghcr.io/<repo>`              | iris-worker: `iris worker`, runs queued jobs | none             |
| `portal`   | `ghcr.io/<repo>-portal`       | the portal (Next.js standalone)              | `127.0.0.1:3000` |
| `postgres` | `postgres:17-alpine@<digest>` | tenant data                                  | none             |

The host's nginx (`deploy/nginx/iris.conf`, #347) is the only public listener. A
deploy never builds anything: it promotes the image digests staging already deployed.
This file holds no host details. Those stay in the operator's private notes.

## One-time setup

### 1. Who may deploy (mandatory)

The `production` environment holds the production secrets. Whatever may run a job in
it can read them, so these three settings are the security boundary. Set them before
adding any secret:

1. **A tag ruleset for `v*`** (Settings → Rules → Rulesets → New tag ruleset): target
   `v*`, restrict creation, update and deletion to the maintainers allowed to release.
2. **The environment's deployment rule** (Settings → Environments → `production` →
   Deployment branches and tags): "Selected branches and tags", with only the tag
   pattern `v*`. No branch may deploy.
3. **A required reviewer** on the same environment, so a deploy waits for a human
   approval even from a valid tag.

Without them, any collaborator who can push a branch could add a workflow that runs in
`production` and reads its secrets. The workflow's own `if:` (a `v*` tag ref) only
stops this repository's job, not a workflow someone else writes.

**`staged-<sha>` is a record, not a security boundary.** It shows that
`deploy-staging` deployed that commit, and stops an accidental promotion of something
staging never ran. Any workflow with `packages: write` can create or move such a tag.
What protects production is the protected tag plus the environment rule and reviewer.

### 2. GitHub environment `production`

**Secrets:**

| Name                 | Value                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| `HOST`               | the box's tailnet name or address (as for staging)                          |
| `USER`               | the ssh user; must be able to `chown` (it hands files to uids 1001 and 70)  |
| `SSH_KEY`            | that user's private key                                                     |
| `SSH_KNOWN_HOSTS`    | the box's host key line, labelled with `HOST`. **Required** here (no TOFU)  |
| `TS_AUTHKEY`         | a reusable, ephemeral, tagged tailnet auth key, **or** the two below        |
| `TS_OAUTH_CLIENT_ID` | tailnet OAuth client                                                        |
| `TS_OAUTH_SECRET`    | tailnet OAuth secret                                                        |
| `BETTER_AUTH_SECRET` | 32+ random bytes, e.g. `openssl rand -hex 32`. Signs portal sessions        |
| `SMTP_URL`           | `smtps://user:pass@smtp.provider:465` (it carries the SMTP password)        |

**Variables** (not secret):

| Name                           | Value                                                                       |
| ------------------------------ | --------------------------------------------------------------------------- |
| `PORTAL_URL`                   | the portal's public `https://` origin (BetterAuth's `baseURL`; secure cookies) |
| `SMTP_FROM`                    | the sender, e.g. `IRIS <no-reply@your-domain>`                              |
| `TS_TAGS`                      | with OAuth only: the client's **full** tag set, comma-separated (default `tag:ci`) |
| `IRIS_API_PORT`, `PORTAL_PORT` | optional host ports (default `4000`, `3000`); see "Ports" below             |

Use a different `BETTER_AUTH_SECRET` from any other environment. Missing values fail
the job by name; they never skip it.

### 3. The box

- Docker with the compose plugin, and the tailnet ACL allowing `tag:ci` to reach the
  box on port 22 (as for staging).
- The job deploys under `/opt/iris-production` and creates what it needs:
  - `releases/<tag>-<run>-<attempt>/`: one directory per deploy run, holding the
    compose file, `docker/seccomp-chromium.json`, `deploy.sh`, `settings.env`, `.env`
    (written by `deploy.sh`) and `secrets/` (`better_auth_secret`, `smtp_url`).
    `deploy.sh` keeps the newest five after a success.
  - `shared/secrets/`: `pg_password`, `master_key` and `database_url`, used by every
    release.
  - `current`: a link to the release that is serving. To run compose by hand,
    `cd "$(readlink -f current)"` first. Always work from the real path: containers
    created through the `current` link would mount files through it.
- **Ports.** iris-api publishes on `127.0.0.1:4000` and the portal on `127.0.0.1:3000`.
  The staging compose also takes `127.0.0.1:4000`, so on a box that runs both, set
  the `IRIS_API_PORT` / `PORTAL_PORT` variables and use the same ports in the nginx
  site. Never publish either on a public interface: the portal's rate limits trust
  `X-Real-IP`, which only nginx may set.

### 4. Secrets generated on the box

The first deploy generates two values in `shared/secrets/`. They never leave the box,
and later deploys never overwrite them:

- `pg_password`: Postgres reads it only when it first initialises its volume, so a
  new value would lock the server out of its own database. `database_url` is derived
  from it.
- `master_key`: the BYOK master key (`k1:<base64 of 32 bytes>`). It seals every org's
  stored provider key. **Losing it loses those keys.** The portal and iris-api read
  the same file. To rotate it, put the new entry first (`k2:…,k1:…`), run
  `docker compose run --rm --entrypoint node iris dist/byok/rewrap.js` in the current
  release, then drop the old entry.

**Back both up right after the first deploy**, apart from the database backups
(#274). A database backup without the master key cannot open the stored provider
keys, and a lost `pg_password` means resetting it inside the container.

### 5. The nginx site

Install `deploy/nginx/iris.conf` as the README's "TLS ingress" section describes:
server name, certificate paths, upstreams `127.0.0.1:4000` (iris-api) and
`127.0.0.1:3000` (portal), then `nginx -t` and a reload. On a shared 443, check that
the `default_server` allows only TLS 1.2+ with ECDHE AEAD ciphers. Do not put a CDN in
front: the site overwrites `X-Forwarded-For` with the peer address.

### 6. Mail

`SMTP_URL` must name a real relay. Mailpit (`docker-compose.dev.yml`) is for
development and E2E only: it accepts everything and delivers nothing. The deploy
runs `transporter.verify()` from the new portal image, with the new release's
`SMTP_URL`, before it changes anything (connect, and authenticate if the URL has
credentials). A wrong host, port or password fails the deploy while the serving
release keeps serving.

## Promote a release

1. Merge to `main`. `deploy-staging` deploys it, boots the portal image, and then tags
   both images `staged-<sha>`. If staging fails, no tag is written.
2. Tag that commit and push the tag:

   ```bash
   git tag -a v1.2.3 <sha> -m "v1.2.3"
   git push origin v1.2.3
   ```

   Or run the CI workflow by hand from the tag (Actions → CI → Run workflow → "Use
   workflow from" → Tags → `v1.2.3`). A run from a branch does not deploy.
3. After the reviewer approves, `deploy-production`:
   - refuses the run if `ghcr.io/<repo>:staged-<sha>` or `ghcr.io/<repo>-portal:staged-<sha>`
     is missing, where `<sha>` is the tag's commit: staging never deployed it;
   - resolves both tags to `@sha256:` digests and deploys those;
   - stages a new release directory with the compose file, the seccomp profile and
     `deploy.sh` from the tagged commit, `settings.env`, and the release's secrets;
   - runs `deploy.sh` there.

**What staging proves.** Staging runs the iris image in token mode, without the worker
or the portal. So `staged-<sha>` proves that the iris image deployed and booted, with a
real Chromium launch, and that the portal image serves `/login`. It does not prove the
hosted stack (hosted connect, worker, portal against Postgres and SMTP). A follow-up
issue moves staging to the hosted stack. Until then, production's own gates and
health checks are the first run of that combination.

### What `deploy.sh` does

1. It pulls the new images and starts `postgres`. Compose recreates postgres only
   when its definition changed, which in practice means you bumped its pinned digest
   (a security release). That restart happens before the gates and is not rolled back.
2. It runs the SMTP check from the new portal image.
3. It runs the migrations from the new iris image.
4. It recreates `iris`, `worker` and `portal` and waits for their healthchecks. Only
   once they are healthy does it point `current` at the new release, so a deploy that
   is cut off (job cancelled, host rebooted) leaves `current` on the last good one.
5. If they stay unhealthy, it recreates them from the previous release's directory
   (its compose file, settings, secrets and images), leaves `current` where it was,
   and exits non-zero.

A job the recreated worker was running is not lost (#435): its claim stops heartbeating,
and about 3 minutes later any worker's reaper requeues it (up to 3 attempts, then it is
failed with "The job was interrupted too many times"). A scan restarts from the
beginning, so a tenant sees a longer run, not an error.

If step 1, 2 or 3 fails, the script exits non-zero and nothing has changed: the serving
release's files and containers are untouched. The first deploy has no previous
release, so it says so and exits non-zero without a rollback. `current` only ever
names a release that became healthy, so it is always a valid rollback target. A rerun
of the same tag stages a new release directory and is an ordinary deploy, which also
picks up rotated secrets.

**Health signals:**

- iris-api: `GET /` must return 404. The job API answers that before any
  authentication, so it means the listener is up and hosted startup (key store,
  database probe) succeeded. The token healthcheck (`docker/healthcheck.js`) cannot
  authenticate in hosted mode (#309).
- portal: the image's `HEALTHCHECK` calls `GET /api/health`. It returns 200 only when
  BetterAuth builds from its settings, the master key loads, and the database answers
  `select 1`. Otherwise it returns 503, and the reason goes to the portal log only.
- worker: it refuses to start (exit 3) if the database does not answer. Its loop writes
  `/tmp/iris-worker-heartbeat` at every poll, and every 30s while a job runs. The
  healthcheck fails when the file is 180s old: three times the longest gap, which is
  the 60s ceiling of `--poll-ms`.

## Roll back

Run the workflow by hand from the previous release tag. Its `staged-<sha>` tags still
exist, so it deploys the previous digests through the same gates.

**Migrations are forward-only.** A rollback runs the previous code on the current
schema. Every migration must therefore keep the previous release working: add columns
and tables in one release ("expand"), and drop or rename them only in a later release,
once nothing running reads them ("contract").

The migration gate allows this. When the database has migrations the older release
does not know, and every migration that release knows is already applied, it logs
"schema is ahead of this release" and succeeds without applying anything. When the
older release also has migrations the database has not applied, it was branched off
before the newer release. The gate then refuses, because interleaving the two is not
safe. Deploy a release that contains both.

A migration that cannot follow expand/contract needs a planned outage and a restore
from backup (#274, "Backups and restore" below) instead of a rollback.

## Backups and restore (issue #274)

`deploy/backup.sh` runs daily on the box from a systemd timer. It writes two files to
`/opt/iris-production/backups/`, both encrypted with `age` to public keys only:

- `iris-<UTC time>.dump.age`: `pg_dump -Fc` of the `iris` database, taken from the
  serving release's `postgres` service.
- `master_key-<UTC time>.age`: `shared/secrets/master_key`. Without it, every org's
  stored provider keys are lost (#344), even with a good dump. Keep both.

Each file is written to a temp file and renamed only when it is complete, with mode
0600. A failed run leaves no partial file, deletes nothing and exits non-zero. Files
older than `BACKUP_KEEP_DAYS` (default 14) are deleted only after a new backup
succeeds. Without a recipients file the script refuses to run: it never writes an
unencrypted dump.

Pending: object-storage versioning and replication, #445 (blocked by #257).

### Setup (once)

1. **Make the key pair off the box**, on the operator's machine:
   `age-keygen -o iris-backup-identity.txt`. The file holds the private key, which
   opens every backup. Keep it offline, in two places (a password manager and an
   offline copy). It must never be on the box: a box compromise would then expose the
   backups too.
2. **Put the public key on the box** (the `age1…` line that `age-keygen` printed). One
   line per recipient. Add a second key to allow a second operator:
   ```bash
   echo 'age1...' | sudo tee /opt/iris-production/shared/backup-recipients.txt
   ```
3. **Install the tools**: `sudo apt-get install age rclone`. `rclone` is needed only
   for the off-box copy.
4. **Off-box copy (strongly recommended)**: configure an rclone remote for root
   (`sudo rclone config`), then set it for the timer:
   ```bash
   echo 'BACKUP_RCLONE_REMOTE=offsite:iris-backups' | sudo tee /opt/iris-production/shared/backup.env
   ```
   Pick the destination's retention and versioning rules there. Without a remote,
   each run logs a warning: the backups share a disk with the database.
5. **Install the schedule.** The deploy ships the units with every release, so this
   works once a release with #274 is serving:
   ```bash
   sudo install -m 644 /opt/iris-production/current/systemd/iris-backup.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now iris-backup.timer
   sudo systemctl start iris-backup.service   # one run now
   journalctl -u iris-backup.service -n 20    # "wrote ..." and no error
   ```
   The service runs as root, because the master key is readable only by uid 1001. It
   runs daily at 03:15 UTC plus up to 30 minutes of random delay. `Persistent=true`
   catches up a run missed while the box was down. Monitor a failed unit
   (`systemctl --failed`, or `OnFailure=` to your alerting).

Optional settings in `shared/backup.env`: `BACKUP_KEEP_DAYS`, `BACKUP_DIR`,
`BACKUP_RECIPIENTS`, `BACKUP_RCLONE_REMOTE`.

### Restore

`deploy/restore.sh` decrypts a dump with the identity file and runs `pg_restore
--no-owner --no-acl --clean --if-exists --single-transaction` in a disposable
container of the pinned postgres image. The host needs `age` and Docker, no Postgres
client. One transaction: a failed restore leaves the target as it was. The target
database must exist. The script refuses the serving database (same host, port and
database as `shared/secrets/database_url`) unless `--force` is given. Pass the target
URL in `RESTORE_TARGET_URL`, not `--target`: a command line is visible in `ps`.

**Into a scratch database on the production server** (a drill, or recovering a few
rows). Bring the identity file to the box for the restore only, and remove it after:

```bash
sudo -i   # a root shell: an exported variable is on no command line
cd "$(readlink -f /opt/iris-production/current)"
docker compose exec -T postgres createdb -U iris iris_restore
export RESTORE_TARGET_URL="postgres://iris:$(cat ../../shared/secrets/pg_password)@postgres:5432/iris_restore"
./restore.sh ../../backups/iris-<time>.dump.age --identity /path/to/iris-backup-identity.txt \
  --network iris-production_default
# compare, then: docker compose exec -T postgres dropdb -U iris iris_restore
shred -u /path/to/iris-backup-identity.txt
```

`--network` is the docker network the restore container joins to reach the target:
`iris-production_default` for the production `postgres` service, the default `host`
for a server reachable from the host.

**Over the production database** (disaster recovery):

1. Stop the writers: `docker compose stop iris worker portal` (from the serving release).
2. Restore with the serving URL and `--force`.
3. If the master key was lost too, restore it first:
   `age -d -i iris-backup-identity.txt master_key-<time>.age > shared/secrets/master_key`,
   then `chown 1001:1001` and `chmod 400` it.
4. `docker compose up -d --wait iris worker portal`. If the dump is from an older
   release, the next deploy applies the pending migrations (expand/contract, above).

**Onto a new box**: run the first deploy as usual (it creates the database and
generates a new `pg_password`). Restore `master_key` before that deploy, because the
deploy generates a new one only when the file is missing. Then restore the dump with
`--force` as above.

### Drill log

Each drill restores a fresh backup into a scratch database and compares the row counts
of every table with the source. Record each one here.

| Date       | Where                              | Data                                                                                         | Dump (encrypted) | Backup | Restore | Result                                                     |
| ---------- | ---------------------------------- | -------------------------------------------------------------------------------------------- | ---------------- | ------ | ------- | ---------------------------------------------------------- |
| 2026-10-02 | local, pinned `postgres:17-alpine` | 96 MB: 100 orgs, 50,000 runs, 200,000 run results, 100,000 usage rows, migrations 0001-0005 | 13.3 MB          | 1.3 s  | 18.1 s  | Row counts of all 15 tables match, `usage_events` checksum too |

The restore time includes starting the disposable container, about 9 s on that host
(an empty database took 9.0 s).

## Troubleshooting

Run these from the serving release: `cd "$(readlink -f /opt/iris-production/current)"`.
For a release that failed its gates, use its own directory under `releases/`.

- **"staged-… does not exist"**: staging did not deploy that commit, or its deploy
  failed. Deploy it to staging first, or tag a commit that staging deployed.
- **The SMTP check failed**: check `SMTP_URL` (host, port, `smtp://` vs `smtps://`,
  credentials) from the box:
  `docker compose run --rm --no-deps portal node verify/apps/portal/scripts/verify-smtp.js`.
- **The migration failed**:
  `docker compose run --rm --no-deps --entrypoint node iris dist/db/migrate.js`. The
  serving release is untouched.
- **Unhealthy after the switch**: the job log has `docker compose ps` and the last log
  lines of each service. iris-api and the worker exit 3 when the hosted environment is
  incomplete (master key, database, `BETTER_AUTH_*`). The portal logs why
  `/api/health` is 503.
