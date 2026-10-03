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
`/var/backups/iris/`, both encrypted with `age` to public keys only:

- `iris-<UTC time>.dump.age`: `pg_dump -Fc` of the `iris` database, taken in the
  `postgres` container of the `iris-production` compose project.
- `master_key-<UTC time>.age`: `/opt/iris-production/shared/secrets/master_key`.
  Without it, every org's stored provider keys are lost (#344), even with a good dump.
  Keep both.

Each file is written to a temp file and renamed only when it is complete, with mode
0600. A failed run leaves no partial file, deletes nothing and exits non-zero, which
triggers the failure alert. After a successful run, each kind keeps its newest
`BACKUP_KEEP_MIN` files (default 7) whatever their age, so a clock jump cannot empty the
directory, and deletes the rest once older than `BACKUP_KEEP_DAYS` (default 14). Both
must be whole numbers of at least 1, checked before anything runs. Without a
recipients file the script refuses to run: it never writes an unencrypted dump.

Pending: object-storage versioning and replication, #445 (blocked by #257).

### Why everything the backup runs is root-owned

The backup runs as root, because the master key is readable only by uid 1001. The
deploy user (the `USER` secret of the `production` environment) does not need to be
root, and should not be. It owns `/opt/iris-production`, so it can rewrite any file
there, including every release's `backup.sh`. A root timer running a file from that
tree would let anyone holding the deploy key run code as root at the next backup. So
the timer runs only root-owned files outside that tree:

| What               | Where                                               | Owner, mode     |
| ------------------ | --------------------------------------------------- | --------------- |
| The script         | `/usr/local/sbin/iris-backup` (a reviewed copy)     | root:root 0755  |
| Settings           | `/etc/iris/backup.env` (optional)                   | root:root 0600  |
| Recipients         | `/etc/iris/backup-recipients.txt` (public keys)     | root:root 0644  |
| rclone config      | `/etc/iris/rclone.conf` (optional)                  | root:root 0600  |
| Failure hook       | `/etc/iris/backup-failed-hook` (optional)           | root:root 0755  |
| Backups            | `/var/backups/iris/`                                | root:root 0700  |
| The units          | `/etc/systemd/system/iris-backup*.{service,timer}`  | root:root 0644  |

The script reaches the database by its container's compose labels (`docker exec`),
not through a release directory. It still reads the master key from
`/opt/iris-production/shared/secrets/`, but only to encrypt it to your offline key.

If the deploy user is in the `docker` group, it is root-equivalent on the box anyway
(docker can mount `/`). That is a separate exposure, still open; these rules keep the
backup from adding another path.

### Setup (once)

1. **Make the key pair off the box**, on the operator's machine:
   `age-keygen -o iris-backup-identity.txt`. The file holds the private key, which
   opens every backup. Keep it offline, in two places (a password manager and an
   offline copy). It must never stay on the box: a box compromise would then expose
   the backups too.
2. **Install the tools and directories**:
   ```bash
   sudo apt-get install age rclone        # rclone only for the off-box copy
   sudo install -d -o root -g root -m 0755 /etc/iris
   sudo install -d -o root -g root -m 0700 /var/backups/iris
   ```
3. **Put the public key on the box** (the `age1…` line that `age-keygen` printed). One
   line per recipient. Add a second key to allow a second operator:
   ```bash
   echo 'age1...' | sudo tee /etc/iris/backup-recipients.txt
   ```
4. **Off-box copy (strongly recommended)**: write an rclone remote to
   `/etc/iris/rclone.conf` (`sudo rclone config --config /etc/iris/rclone.conf`; then
   `sudo chmod 600 /etc/iris/rclone.conf`), and set it for the timer:
   ```bash
   echo 'BACKUP_RCLONE_REMOTE=offsite:iris-backups' | sudo install -o root -g root -m 0600 /dev/stdin /etc/iris/backup.env
   ```
   Each run copies every backup in the directory that the remote lacks, so a run after
   a failed copy catches up. The remote is never pruned by the script: set the
   destination's own retention and versioning rules. Without a remote, each run logs a
   warning: the backups share a disk with the database.
5. **Install the script and the units from a release you have reviewed.** The deploy
   ships them with every release (`releases/<id>/backup.sh`, `restore.sh`,
   `systemd/`) but never installs them. Compare the files with the tagged commit
   (`git show <tag>:deploy/backup.sh`), then:
   ```bash
   r=$(readlink -f /opt/iris-production/current)
   sudo install -o root -g root -m 0755 "$r/backup.sh" /usr/local/sbin/iris-backup
   sudo install -o root -g root -m 0644 "$r"/systemd/iris-backup.service "$r"/systemd/iris-backup.timer \
     "$r"/systemd/iris-backup-failed.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now iris-backup.timer
   sudo systemctl start iris-backup.service   # one run now
   journalctl -u iris-backup.service -n 20    # "wrote ..." and no error
   ```
   Repeat the install when a release changes `deploy/backup.sh` or `deploy/systemd/`.
6. **Alerting**: a failed run starts `iris-backup-failed.service`, which logs a `crit`
   journal entry ("IRIS BACKUP FAILED") and runs `/etc/iris/backup-failed-hook` if it
   exists and is executable. Put your mail or webhook call there (root:root 0755).
   Test it with `sudo systemctl start iris-backup-failed.service`.

The timer runs daily at 03:15 UTC plus up to 30 minutes of random delay.
`Persistent=true` catches up a run missed while the box was down. The service is
sandboxed (`ProtectSystem=strict`, writable only `/var/backups/iris` and `/etc/iris`;
`ProtectHome`, `PrivateTmp`, `NoNewPrivileges`), with a 2-hour limit. Optional
settings in `/etc/iris/backup.env`: `BACKUP_KEEP_DAYS`, `BACKUP_KEEP_MIN`,
`BACKUP_RCLONE_REMOTE`, `BACKUP_COMPOSE_PROJECT`.

### Restore

`deploy/restore.sh` decrypts a dump with the identity file and restores it in a
disposable container of the pinned postgres image. The host needs `age` and Docker,
no Postgres client.

- **It replaces the target's `public` schema** with the dump's, in one transaction:
  drop, create, then the dump (`pg_restore --no-owner --no-acl`). Tables a newer
  release added are gone and `kysely_migration` is the dump's, so the next deploy's
  migrations apply cleanly. The commit is sent only after the whole dump was read, and
  the file is decrypted once before anything connects, so a corrupt file or a failed
  restore leaves the target as it was. The target database must exist.
- **It refuses the serving database** unless `--force`: it asks both servers for
  their identity (`pg_control_system()`'s system identifier plus
  `current_database()`), so no spelling of the URL (another host name, an address, a
  percent-encoded name, `?dbname=`) gets past it. That query needs a superuser on
  both (the compose `iris` role is one); it refuses when it cannot run. Off the box,
  where `shared/secrets/database_url` is unreadable, it cannot check and refuses
  unless `--force`.
- **Pass the target URL in `RESTORE_TARGET_URL`**, not `--target`: a command line is
  visible in `ps`. The URLs reach the container as files in a private temp
  directory, so `docker inspect` does not show them either.
- `--network` is the docker network the container joins to reach the databases:
  `iris-production_default` for the production `postgres` service, the default `host`
  for a server reachable from the host.

**Into a scratch database on the production server** (a drill, or recovering a few
rows). Bring the identity file to the box for the restore only, and remove it after:

```bash
sudo -i   # a root shell: an exported variable is on no command line
cd "$(readlink -f /opt/iris-production/current)"
docker compose exec -T postgres createdb -U iris iris_restore
export RESTORE_TARGET_URL="postgres://iris:$(cat /opt/iris-production/shared/secrets/pg_password)@postgres:5432/iris_restore"
./restore.sh /var/backups/iris/iris-<time>.dump.age --identity /root/iris-backup-identity.txt \
  --network iris-production_default
# compare, then: docker compose exec -T postgres dropdb -U iris iris_restore
shred -u /root/iris-backup-identity.txt
```

**Over the production database** (disaster recovery), from a root shell:

1. `cd "$(readlink -f /opt/iris-production/current)"` and stop the writers:
   `docker compose stop iris worker portal`.
2. If the master key was lost too, restore it first:
   ```bash
   age -d -i /root/iris-backup-identity.txt /var/backups/iris/master_key-<time>.age \
     > /opt/iris-production/shared/secrets/master_key
   chown 1001:1001 /opt/iris-production/shared/secrets/master_key
   chmod 400 /opt/iris-production/shared/secrets/master_key
   ```
3. Restore with the serving URL and `--force`:
   ```bash
   export RESTORE_TARGET_URL="$(cat /opt/iris-production/shared/secrets/database_url)"
   ./restore.sh /var/backups/iris/iris-<time>.dump.age --identity /root/iris-backup-identity.txt \
     --network iris-production_default --force
   ```
4. A dump older than the serving release has fewer migrations; apply them, then start
   the services:
   ```bash
   docker compose run --rm --no-deps --entrypoint node iris dist/db/migrate.js
   docker compose up -d --wait iris worker portal
   ```
5. `shred -u /root/iris-backup-identity.txt`.

**Onto a new box**: restore `/opt/iris-production/shared/secrets/master_key` first
(step 2; create the directory with `install -d -m 700`), because the first deploy
generates a new key only when the file is missing. Run the first deploy as usual (it
creates the database and a new `pg_password`), then steps 1, 3 and 4 above.

### Drill log

Each drill restores a fresh backup into a scratch database and compares the row counts
of every table with the source. Record each one here.

| Date       | Where                              | Data                                                                                        | Dump (encrypted) | Backup | Restore | Result                                                          |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | ---------------- | ------ | ------- | --------------------------------------------------------------- |
| 2026-10-02 | local, pinned `postgres:17-alpine` | 96 MB: 100 orgs, 50,000 runs, 200,000 run results, 100,000 usage rows, migrations 0001-0005 | 13.3 MB          | 1.3 s  | 18.1 s  | Row counts of all 15 tables match, `usage_events` checksum too |
| 2026-10-02 | same, after the review fixes       | same data, reseeded                                                                         | 13.3 MB          | 1.3 s  | 15.0 s  | Row counts of all 15 tables match, `usage_events` checksum too |

Restore times include the decrypt check, the serving-database check and starting the
disposable container: about 9 s on the loaded host of the first drill (an empty
database took 9.0 s), about 4 s at the second.

## Monitoring and alerts (issue #275)

### Logs

iris-api and the worker run in hosted mode, so every log line is one JSON object on
stderr (`ts`, `level`, `msg`, then fields). Docker keeps them (json-file, 3 x 10 MB per
service):

```bash
cd "$(readlink -f /opt/iris-production/current)"
docker compose logs --since 1h iris worker
docker compose logs --no-log-prefix iris | jq -c 'select(.level == "error")'
docker compose logs --no-log-prefix iris | jq -c 'select(.requestId == "<id>")'
```

| Line (`msg`)                | Fields                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `rpc request`               | `requestId`, `orgId`, `keyId`, `method`, `latencyMs`, `outcome`, `code`; `actions` (types only) and `success` for `executeBrowserAction` |
| `rest request`              | `requestId` (also the `X-Request-Id` response header), `clientRequestId` (the client's own `X-Request-Id`, if it sent a plain one), `method` (`POST /v1/a11y/jobs`, `GET /v1/jobs/:id`), `status`, `latencyMs`, `outcome`, `orgId`, `keyId` |
| `connection refused`        | `reason` (`origin`, `invalid_key`, `connection_limit`, `org_connection_limit`, `auth_unavailable`), `status` |
| `session started` / `ended` | `sessionId`, `orgId`, `keyId`; `reason` (`closed`, `replaced`, `timeout`, `revoked`, `disconnect`, `socket_error`, `shutdown`) |
| `job claimed` / `job finished`, `job error`, `job lost` | `jobId`, `orgId`, `kind`, `attempts`, `latencyMs` |
| `better-auth: …`            | BetterAuth's own messages. A refused API key is `info` with its `code`; a database failure while checking one stays `error`. |

`outcome` is `ok`, `client_error` (bad request, unknown method, no session, a session
limit, 4xx), `rate_limited`, `aborted` (the client left before the answer) or `error` (a
server error, a 5xx, or a browser that would not start or died mid-request; an action
that simply failed, such as a missing selector, is `ok`). Rate-limited and malformed frames are logged once per 10 s per
connection, with a `suppressed` count (and a `rpc refusals suppressed` line on close);
the metrics count every one. The server always makes its own `requestId`; a client's
`X-Request-Id` (letters, digits, `._:-`, up to 64) is logged as `clientRequestId`. Logs never hold an API
key, an `Authorization` header, a fill value, a database or SMTP URL's password, or a
provider key: they carry key ids, and action types without their values.
`IRIS_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) sets the threshold.

### Metrics

Each process serves Prometheus metrics on its own container's loopback:
iris-api on port 9464, the worker on 9465 (`--metrics-port` in the compose file). No
port is published and nginx never routes to them. To read them on the box:

```bash
c=$(docker ps -q --filter label=com.docker.compose.project=iris-production --filter label=com.docker.compose.service=iris)
docker exec "$c" node -e 'fetch("http://127.0.0.1:9464/metrics").then(r => r.text()).then(console.log)'
```

- iris-api: `iris_requests_total{method,outcome}`, `iris_request_duration_seconds`
  (histogram), `iris_sessions_active`, `iris_browsers_active`,
  `iris_ai_spend_usd_total{provider,kind,billing_mode}` (settled AI calls),
  `iris_errors_total` (lines logged at `error`), `iris_up`, `iris_start_time_seconds`.
- worker: `iris_jobs_total{kind,outcome}` (`finished`, `error`, `lost`),
  `iris_job_duration_seconds`, `iris_jobs_reaped_total{result}`,
  `iris_job_queue_depth`, plus `iris_errors_total`, `iris_up`, `iris_start_time_seconds`.

No series carries an org id. Per-org usage is in the `usage_events` table (#263). A
Prometheus server is optional; if you run one, run it on the box and scrape through the
compose network or `docker exec`, never by publishing the ports.

### Watchdog

`restart: unless-stopped` restarts a container that exits. It does not restart one
whose healthcheck fails: Docker only marks it `unhealthy`. `deploy/watchdog.sh` runs
every minute from `iris-watchdog.timer`, as root, and:

- restarts each `iris-production` container that is `unhealthy`, at most
  `WATCHDOG_MAX_RESTARTS` (3) times per service per hour. Past that it alerts and
  leaves the container alone;
- alerts when Docker restarted a container that exited (a crash, an OOM kill);
- scrapes both metrics listeners (`docker exec … node`). A failed scrape alerts: it is
  the uptime signal from inside the box;
- alerts when, over the last `WATCHDOG_ERROR_WINDOW` seconds (300), at least
  `WATCHDOG_ERROR_PERCENT` (5) of at least `WATCHDOG_MIN_REQUESTS` (20) server-side
  answers ended with `outcome="error"`: error / (ok + error) for requests, error /
  (finished + error) for jobs. Client errors and rate-limited requests count in neither
  part, so a tenant cannot trigger or mask the alert. A restarted process starts the
  window again.

A condition that stays true alerts again after `WATCHDOG_ALERT_REPEAT` seconds (3600);
once it clears, the next occurrence alerts at once. Restarts always alert. State
(restart times, counter samples, alert stamps) is in `/var/lib/iris-watchdog`.

It is installed like the backup, and for the same reason: root runs only root-owned
files outside the deploy user's tree.

| What           | Where                                                  | Owner, mode    |
| -------------- | ------------------------------------------------------ | -------------- |
| The script     | `/usr/local/sbin/iris-watchdog` (a reviewed copy)      | root:root 0755 |
| Settings       | `/etc/iris/watchdog.env` (optional, `WATCHDOG_*`)      | root:root 0600 |
| Alert hook     | `/etc/iris/alert-hook` (optional)                      | root:root 0755 |
| State          | `/var/lib/iris-watchdog/` (systemd `StateDirectory`)   | root:root 0700 |
| The units      | `/etc/systemd/system/iris-watchdog.{service,timer}`    | root:root 0644 |

```bash
r=$(readlink -f /opt/iris-production/current)
git show <tag>:deploy/watchdog.sh | diff - "$r/watchdog.sh"   # review first
sudo install -o root -g root -m 0755 "$r/watchdog.sh" /usr/local/sbin/iris-watchdog
sudo install -o root -g root -m 0644 "$r"/systemd/iris-watchdog.service \
  "$r"/systemd/iris-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iris-watchdog.timer
sudo systemctl start iris-watchdog.service
journalctl -u iris-watchdog.service -n 20    # "checked project iris-production"
```

Repeat the install when a release changes `deploy/watchdog.sh` or its units.

### Alerts

Every alert is a `crit` journal entry tagged `iris-watchdog` ("IRIS ALERT: …";
`journalctl -t iris-watchdog -p crit`) and, if `/etc/iris/alert-hook` is executable, a
call to it:

```
/etc/iris/alert-hook <key> <message>
```

`key` names the condition (`restarted-iris`, `restart-cap-worker`, `exited-portal`,
`scrape-iris`, `error-rate-iris`, `docker`, `restart-failed-iris`); `message` is one line of
printable text, at most 300 characters (container output in it is cleaned). The hook
runs as root with a 60 s limit; its exit status is logged and otherwise ignored. Send
mail, a chat message or a page from it. Example:

```sh
#!/bin/sh
printf '%s\n' "$2" | mail -s "IRIS alert: $1" ops@example.com
```

Test it: `sudo /etc/iris/alert-hook test "IRIS alert hook test"`. The backup's failure
alert keeps its own hook (`/etc/iris/backup-failed-hook`, above); it may simply run this
one.

### Uptime from outside

The watchdog runs on the box it watches, so it cannot report the box itself being down
or unreachable. Add an external uptime monitor (any hosted service) on:

- `https://<portal host>/`: the portal (200 or a redirect to `/login`);
- `https://<portal host>/v1/jobs/x` without a key: iris-api through nginx answers
  **401**. Alert on anything else.

## Publishing a new version of the terms (issue #276)

The Terms of Service and Acceptable Use Policy are `apps/portal/content/legal/terms.md`
and `acceptable-use.md`. To publish a change:

1. Edit the text and set a new `version:` (a date) in its front matter.
2. Set the same value in `src/legal/versions.ts` (`LEGAL_VERSIONS`). A test fails if they differ.
3. Deploy. A new sign-up must carry the new versions (the server refuses one that does not), and
   every signed-in user is sent to `/accept-terms` before any portal page until they accept. API keys keep working.
   Earlier acceptances stay in `terms_acceptances` as history.

A changed file with an unchanged version is not re-accepted: bump it for any change that
needs consent. Removing the draft banner is deleting `draft: true` from the front matter.

## Abuse handling (issue #348)

### Suspend or unsuspend an org

Run from the serving release, so the command uses the release's image and database
secret:

```bash
cd "$(readlink -f /opt/iris-production/current)"
docker compose exec iris node dist/cli.js admin suspend-org <orgId> --reason "AUP 3.2: scanning targets without authorisation (ticket 123)"
docker compose exec iris node dist/cli.js admin org-status <orgId>
docker compose exec iris node dist/cli.js admin unsuspend-org <orgId> --reason "Resolved with the customer (ticket 123)"
```

`--actor <name>` records who did it (default: `$SUDO_USER` / `$USER`). Every action is
kept in `org_suspensions`; `org-status` prints the state and the history. The reason is
for operators and is never shown to the tenant.

What a suspension does:

- API keys of the org get **403** on new WebSocket upgrades and REST requests.
- Live RPC connections close (1008) at the next re-check, within `authRecheckMs`
  (60 s by default), and their browsers are reclaimed.
- Queued jobs are failed unrun ("Organization suspended", no usage); new jobs are refused.
- The portal shows a banner with the support contact; creating, changing or revoking API
  keys and saving or removing provider keys is refused.

Not instant, and not everything:

- An open connection keeps working until its next re-check, up to 60 s after the
  suspension. A job already running when you suspend finishes and is billed.
- Members can still invite people, accept invitations and switch orgs. Membership is
  not what does harm; keys and jobs are. They cannot create a new org, which would carry
  fresh keys past the suspension. Account-level bans are not built yet.

Unsuspending restores all of it at once. The org's data is untouched either way.

### Published contacts

Set as environment variables of the `production` environment (all optional), passed to
the portal:

| Variable | Shown at | Format |
| --- | --- | --- |
| `IRIS_SECURITY_CONTACT` | `/contact`, `/.well-known/security.txt` | `mailto:…` or `https://…` |
| `IRIS_ABUSE_CONTACT` | `/contact` | same |
| `IRIS_SUPPORT_CONTACT` | `/contact`, the suspension banner | same |
| `IRIS_SECURITY_TXT_EXPIRES_DAYS` | `/.well-known/security.txt` `Expires` | whole days, 1-365 (default 365) |

Unset contacts show a `[placeholder]` on `/contact`. Without `IRIS_SECURITY_CONTACT`,
`/.well-known/security.txt` answers 404 (RFC 9116 requires a `Contact` line). Its
`Expires` is one year (`IRIS_SECURITY_TXT_EXPIRES_DAYS`, at most 365) after the portal
process starts, so each deploy renews it; a portal left running for a year without a
deploy serves an expired file.

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
