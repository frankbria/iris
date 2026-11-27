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
- Docker's iptables firewall (the default; not `firewall-backend: nftables`), so its
  `DOCKER-USER` chain exists: the deploy's egress firewall goes there ("Container egress
  firewall" below). Nothing to install by hand.
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
- **Ports.** The stack's `proxy` container (#316, "Zero-downtime deploys" below) publishes
  iris-api on `127.0.0.1:4000` and the portal on `127.0.0.1:3000`.
  Staging defaults to `127.0.0.1:14000` / `127.0.0.1:13000`, so the two stacks can
  share a box. Whatever you set in `IRIS_API_PORT` / `PORTAL_PORT`, use the same
  ports in the nginx site. Never publish either on a public interface: the portal's rate limits trust
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

1. Merge to `main`. `deploy-staging` builds both images, deploys those digests through
   `deploy.sh` on staging, smoke-tests them, and then tags both images `staged-<sha>`.
   If staging fails, no tag is written.
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

**What staging proves.** Staging runs the same hosted stack (#440):
`docker-compose.production.yml` through `deploy.sh`, under `/opt/iris-staging` and the
compose project `iris-staging`, with the `staging` environment's own secrets. So
`staged-<sha>` means those exact digests passed `deploy.sh`'s SMTP check, migrations and
healthchecks on a box, launched a sandboxed Chromium in iris and in the worker, and
answered on the host ports the nginx site uses. What it does not prove is production's
own configuration: its secrets, relay, ports and nginx site.

### What `deploy.sh` does

1. It pulls the new images and starts the data services: `postgres`, and on staging
   its object store (`seaweedfs`, "Artifact storage" below). Compose recreates one only
   when its definition changed, which in practice means you bumped its pinned digest
   (a security release). That restart happens before the gates and is not rolled back.
   Then it starts the egress firewall on the stack's bridge ("Container egress
   firewall" below), so the gates already run behind it.
2. It runs the SMTP check from the new portal image.
3. It runs the migrations from the new iris image.
4. It starts new `iris`, `worker` and `portal` containers next to the serving ones and
   waits for their healthchecks, then runs the egress probe in the new `iris` and
   worker. Only once they are healthy and the probe passed does it switch the proxy to
   them and point `current` at the new release, so a deploy that is cut off (job
   cancelled, host rebooted) leaves `current` on the last good one. Then it drains and
   removes the old containers ("Zero-downtime deploys" below).
5. If they stay unhealthy or the probe fails, it removes the new containers, leaves
   `current` where it was, and exits non-zero. The serving containers were never touched.

The first deploy behind the proxy (and the first of a new box) is **cold**: it recreates
the three in place, an outage as before #316, then starts the proxy on them. If that
fails, it removes the proxy and recreates them from the previous release's directory
(its compose file, settings, secrets and images).

If step 1, 2 or 3 fails, the script exits non-zero and nothing has changed: the serving
release's files and containers are untouched (the egress firewall, once applied, stays).
A cold first deploy has no previous release, so it says so and exits non-zero without
a rollback. `current` only ever
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

## Zero-downtime deploys (issue #316)

A deploy drops nothing that ends within the drain window: no refused connection, no
failed request, no WebSocket session cut by the switch.

**How.** The `proxy` service (nginx, digest-pinned) is the only holder of the host ports.
It proxies **TCP**, so WebSocket sessions, `X-Real-IP` and every other header the host's
nginx sets pass through unchanged. Its `nginx.conf` and `upstreams.conf` live in
`shared/proxy/`, written by `deploy.sh`; `upstreams.conf` names the one iris and one
portal container that get new connections. A deploy:

1. starts a second container of each app service with the new release
   (`up --no-recreate --scale <service>=2`) and waits for their healthchecks and the
   egress probe;
2. rewrites `upstreams.conf` and reloads nginx: new connections go to the new containers,
   while nginx's old workers keep the connections they hold, to the old ones;
3. points `current` at the release (`deploy: rolling: switched to …`);
4. drains: the old worker gets SIGTERM at once and finishes its current job (it is given
   the whole window); the old iris and portal keep serving what they hold until no
   connection from outside their own loopback is left on their port (`deploy: drained
   … 0 connections left`), at most `DEPLOY_DRAIN_TIMEOUT` (300 s), then stop with their
   own drain (#309: in-flight requests answered, then sessions closed);
5. removes the old containers.

A session still open after the window is ended by step 4, as every session was before.
A job still running is stopped by the same timeout and requeued by the reaper (#435): its
claim stops heartbeating, and about 3 minutes later any worker requeues it (up to 3
attempts). A change to the proxy's own definition (its image digest, the ports) recreates
it, which drops its connections once.

**While the two run side by side**, both iris processes share the database and the
volumes (`/data` SQLite: the ledger and vision cache take SQLite's locks), and each keeps
its own in-memory RPC rate buckets (#342): a tenant with sessions on both can use up to
twice its per-key and per-org rate until the old one stops. New connections all go to the
new one, so only sessions already open count on the old side. Shared buckets are #714. The
portal's auth rate limits are in the database (`rateLimit` table, migration 0023), so the
two portals share them.

**Check it by hand** (in the current release's real path):

```bash
cat ../../shared/proxy/upstreams.conf       # the containers that get new connections
docker compose ps                           # one of each app service after a deploy
docker compose logs proxy                   # nginx: reloads, upstream errors
```

**Staging proves it on every deploy.** `deploy-staging` runs `scripts/rollout-watch.js`
on the box during `deploy.sh`: one keep-alive session to iris-api held across the switch
(one request a second) and fresh requests to both ports every second, ending 15 s after
the switch. The job prints `rollout watch: {…}` and fails a rolling deploy whose held
session used more than one socket or saw a failure, or where a fresh request failed.

## Container egress firewall (issue #376)

The hosted containers run tenant pages and call AI providers, Stripe and the mail relay.
Beneath the browser's own resolve-and-pin proxy (#374), the host refuses every new
connection from the stack's containers to a private, CGNAT (`100.64.0.0/10`), link-local
(`169.254.0.0/16`, the cloud metadata address), loopback, documentation, benchmarking,
multicast or reserved IPv4 range. Public destinations are untouched.

**How.** The compose service `egress` runs `docker/egress-firewall.sh` from the iris image,
on the host's network with `NET_ADMIN` (and `NET_RAW`, for a host on the legacy iptables
backend) and nothing else. It writes a chain `IRIS-EGRESS-<bridge>` and two jumps to it:
from `DOCKER-USER` for traffic routed out of the stack's bridge, and from `INPUT` for
traffic to the host's own addresses. `deploy.sh` finds the bridge (compose's default
network for the project; it refuses a network with IPv6, as the rules are IPv4 only) and
starts the service before the gates. The rules key on that one bridge, so other stacks on
the box are unaffected.

**What stays allowed.** Replies on connections the ingress opened to a published port;
DNS (port 53) to the host's own non-loopback nameservers in `/etc/resolv.conf`, which may
be private (Docker's resolver forwards to those from inside the container; to a loopback
one such as systemd-resolved's it forwards from the host); the two global anycast
addresses inside `192.0.0.0/24` (`192.0.0.9`, `192.0.0.10`); everything between the stack's own containers (Postgres, and on
staging the object store); every public address, which includes the host's own public
address and so the nginx ingress and an object-store name it serves. A service the
containers must reach on a **private** address (a relay or object store on the LAN or
the tailnet) is refused: give it a public address, or put it on the stack's network.

A daemon `dns` setting in `/etc/docker/daemon.json` replaces those nameservers for the
containers and is not read: with one, lookups from the containers fail (the SMTP check
fails the deploy). Use the host's resolver configuration instead.

**Fail closed.** The rules stay when the container stops or is removed. The container
checks them every 30 seconds and re-applies what is missing, and `restart: unless-stopped`
brings it back after a reboot, which flushes the host's rules. Both jumps must be the
first rule of their chain: a firewall manager that puts its own rules above them (`ufw`
reloading puts its jumps at the top of `INPUT`) fails the check, and the repair moves
them back. Its healthcheck fails while a rule is missing or moved, so the watchdog
restarts and alerts on it (#275). Rolling back a release does not remove them.

Two limits, both accepted for now:

- **After a reboot** Docker starts every container at once, so for the second or so before
  the `egress` container has applied its rules the others run without them. Nothing
  reaches out in that window (the apps are still starting and serve no tenant yet). To
  close it, persist the rules so they load before Docker (for example the
  `iptables-persistent` package, saved while the stack runs): a host step for the operator.
- **Rolling back to a release from before #376** removes the `egress` container (an
  orphan to that release's compose file). The rules stay until the next reboot, and the
  next deploy of a current release brings the container back.

**The probe.** After the new containers are healthy, `deploy.sh` runs
`node docker/egress-probe.js` in `iris` and in the worker: a TCP connection to
`169.254.169.254:80` must be refused at once (the firewall's reset). A connection, or a
timeout (what a host with no metadata service shows with no firewall at all), fails the
deploy and rolls it back. The log line is `egress probe: 169.254.169.254:80 refused, as
the egress firewall does`.

**Check it by hand** (in the current release's real path):

```bash
docker compose ps egress                    # healthy
docker compose logs egress                  # "applied (iptables-nft): ..."
docker compose exec -T iris node docker/egress-probe.js
docker compose exec -T iris node docker/egress-probe.js 10.0.0.1 443
```

**Remove the rules** (only to retire the stack; any deploy puts them back). As root,
with `<bridge>` from `IRIS_EGRESS_BRIDGE` in the release's `.env`:

```bash
iptables -D DOCKER-USER -i <bridge> ! -o <bridge> -j IRIS-EGRESS-<bridge>
iptables -D INPUT -i <bridge> -j IRIS-EGRESS-<bridge>
iptables -F IRIS-EGRESS-<bridge> && iptables -X IRIS-EGRESS-<bridge>
```

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

The artifact bucket is not in these files: see "Artifact bucket backups" below (#445).

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
`BACKUP_RCLONE_REMOTE`, `BACKUP_COMPOSE_PROJECT`, and `BACKUP_ARTIFACTS_SOURCE` with
`BACKUP_ARTIFACTS_REMOTE` (the artifact bucket's off-site copy, #445, below).

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

## Artifact bucket backups (issue #445)

Screenshots, diffs and baselines live in the artifact bucket, not in Postgres, so the
dump does not hold them. Two things protect them, and both work on any S3-compatible
bucket (the same steps on staging and production):

- **Versions in the bucket**, against a delete or an overwrite (a bug, an operator
  mistake, a bad approval). With versioning on, the old object stays as a version.
- **A copy somewhere else**, against losing the bucket or its provider.

Neither keeps data longer than the retention policy allows: a deleted or replaced image
is gone from the bucket 14 days after it stopped being current, and from the copy after
`BACKUP_KEEP_DAYS` (default 14). That is the window the Postgres backups keep, so a
restored dump still finds the images its rows name.

### Turn versioning on (once per bucket)

```bash
cd "$(readlink -f /opt/iris-production/current)"
docker compose exec iris node dist/cli.js admin artifact-versioning            # prints the state
docker compose exec iris node dist/cli.js admin artifact-versioning --enable
```

The access key needs the bucket's versioning permissions (`s3:GetBucketVersioning`,
`s3:PutBucketVersioning`, `s3:ListBucketVersions`, `s3:GetObjectVersion`,
`s3:DeleteObjectVersion` in AWS terms), or enable versioning in the provider's console
and give the key the last three. **Whether or not you turn versioning on, the key must be
allowed to read the bucket's versioning state** (`s3:GetBucketVersioning`): the daily
retention pass asks, and a refusal fails its `versions` step (exit 3, the retention
alert) every day. Do not add a provider lifecycle rule for old versions:
the daily retention pass (`iris admin retention`, "The daily pass" below) removes
versions that stopped being current more than 14 days ago, and delete markers with
nothing left behind them, and reports the count as `artifactVersionsPruned`. Objects
stored before versioning was on are covered from their next overwrite or delete.

### Restore an object

Object keys are in run detail's artifact URLs and in `visual_baselines.object_key`:
`org/<org>/project/<project>/run/<run>/{current,diff}/<name>.png` and
`org/<org>/project/<project>/baselines/<name>.png`.

```bash
# Deleted: one key, or everything under a prefix (it must end in /)
docker compose exec iris node dist/cli.js admin artifact-undelete org/<org>/project/<project>/run/<run>/

# Overwritten: list the versions (current first), then restore the one you want
docker compose exec iris node dist/cli.js admin artifact-versions org/<org>/project/<project>/baselines/<name>.png
docker compose exec iris node dist/cli.js admin artifact-restore org/<org>/project/<project>/baselines/<name>.png --version-id <id>
```

`artifact-undelete` removes the delete markers in front of each key's newest version;
`artifact-restore` copies the chosen version over the key (the replaced one stays a
version). Both exit 1 when there was nothing to bring back and 3 when the store refuses.
They restore objects, not rows: use them for objects whose rows still exist (deleted or
overwritten by mistake), or together with a database restore of the same period. An
image undeleted after its run was purged has no row, is not counted against the org's
storage, and stays until the org is purged.

### The off-site copy

`deploy/backup.sh` syncs the bucket to a second remote after the Postgres backup, when
both settings are in `/etc/iris/backup.env`:

```bash
BACKUP_ARTIFACTS_SOURCE=artifacts:<bucket>          # an rclone remote for the artifact bucket (read)
BACKUP_ARTIFACTS_REMOTE=offsite:<bucket-or-path>    # another provider or region (read, write, delete)
```

Define both remotes in `/etc/iris/rclone.conf` (`sudo RCLONE_CONFIG=/etc/iris/rclone.conf
rclone config`). The images are stored as they are, so wrap the destination in an rclone
`crypt` remote unless its provider is one you would trust with the bucket itself, and
keep the crypt passwords off the box as well. **Leave versioning off on the destination
bucket**: the sync moves and deletes files there, a versioned destination would keep a
hidden version of each one, nothing here removes those, and a lifecycle rule there
would only add its own delay on top of `BACKUP_KEEP_DAYS`. Each run:

1. `rclone sync <source> <remote>/current --backup-dir <remote>/replaced/<UTC time>`:
   what the sync would delete or overwrite in the copy is moved aside, not deleted. An
   emptied or recreated bucket therefore cannot empty the copy.
2. Removes `<remote>/replaced/<UTC time>` directories older than `BACKUP_KEEP_DAYS`.

A failure exits non-zero (the backup alert) and the next run retries. One setting
without the other refuses to run. To restore from the copy:
`rclone copy offsite:<bucket-or-path>/current/<prefix> artifacts:<bucket>/<prefix>`
(add files from `replaced/<UTC time>/` for something deleted since).

### Drill log

Each drill deletes and overwrites objects in a versioned bucket, restores them with the
commands above and compares checksums. Record each one here.

| Date       | Where                                                    | Data                                              | Damage                                             | Restore                                                                  | Result                                    |
| ---------- | -------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| 2026-11-11 | local, pinned `chrislusf/seaweedfs:4.48` (not staging) | 201 objects, 100 kB each: 200 run images, 1 baseline | run prefix purged (200 deletes), baseline overwritten | `artifact-undelete` 1.8 s, `artifact-versions` + `artifact-restore` 3.2 s | SHA-256 over all 201 objects equals the one taken before the damage |
| 2026-11-26 | **staging** bucket (#514's SeaweedFS), deployed image of #642 | 303 objects: a hosted visual job's 3 images (run screenshot, seeded and approved baselines) + 300 scratch objects of 100 kB | approved baseline overwritten, the other 302 deleted (12:10:32 UTC) | `artifact-undelete` on both prefixes 2.0 s (302 objects), `artifact-versions` + `artifact-restore` 1.5 s | 303/303 SHA-256 equal to before the damage (12:10:38 UTC) |

**Off-site copy, staging smoke test (2026-11-26).** `deploy/backup.sh` ran twice on the
staging box with real rclone (`rclone/rclone:1.76.0`, pinned by digest) from the bucket
into a directory remote on the same box (a smoke test, not the production destination).
Run 1 copied all 303 objects to `current/`. One object was then overwritten and another
deleted. Run 2 left 302 files in `current/`, the overwritten one with its new content, and
moved both old copies to `replaced/<UTC time>/`, where the overwritten one's SHA-256 equals
its original. Each run took about 1 s. On the first run, rclone logs "directory not found"
for `replaced/` before anything has been replaced; the script treats that as nothing to
prune (exit 3) and goes on.

**On staging** the deployed services have the store since #711, so the `admin artifact-*`
commands run with `docker compose exec iris` in the current release, as above. (The
#445 drill ran before that, in a one-off container of the deployed image sharing the
store's network namespace, with `IRIS_S3_ENDPOINT=http://127.0.0.1:8333`; `artifact-store.ts`
accepts http only on loopback.) Staging runs no daily retention pass, so an org purge there
leaves its noncurrent versions and delete markers until a pass runs 14 days later.

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
| `rest request`              | `requestId` (also the `X-Request-Id` response header), `clientRequestId` (the client's own `X-Request-Id`, if it sent a plain one), `method` (`POST /v1/a11y/jobs`, `GET /v1/jobs/:id`, `POST /v1/mcp`), `status`, `latencyMs`, `outcome`, `orgId`, `keyId` |
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
  `iris_job_queue_depth`, `iris_stripe_meter_events_total{outcome}` (`sent`, `rejected`; #264), plus `iris_errors_total`, `iris_up`, `iris_start_time_seconds`.

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

### Status page (issue #317)

`.github/workflows/status.yml` runs those two probes from a GitHub-hosted runner every five
minutes (`scripts/status-probe.js`, one retry per failed probe) and publishes a static page
on GitHub Pages: overall state, each component's state and since when, and its uptime over
the last 288 checks (about a day). A run where a probe is down publishes the page and then
fails, so GitHub notifies you of the failed workflow. Until it is configured, every run
succeeds doing nothing ("Status page not configured").

To turn it on (repository admin, in this order: the publish job calls Pages):

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** (Optionally a
   custom domain there, e.g. `status.<domain>`, with its DNS record.)
2. **Settings → Secrets and variables → Actions → Secrets → New repository secret**:
   `STATUS_PROBE_URL` = the portal's https URL, the staging portal first. A secret, not a
   variable, so it is masked in the public Actions log (#329).
3. **Actions → status → Run workflow** once, and open the URL the `publish` job shows.
4. Link it from the portal: set the `IRIS_STATUS_URL` variable (the page's https URL) in
   the `staging` environment (**Settings → Environments → staging → Environment variables**)
   and deploy; `/contact` then shows "Service status". `IRIS_STATUS_URL` must be an https
   URL: anything else fails the portal's health check, so a deploy rolls back.
5. For production, change `STATUS_PROBE_URL` to the production portal (#515), and add
   `IRIS_STATUS_URL` to the `deploy-production` job the way #639 added
   `IRIS_BILLING_GRACE_DAYS` (its `env` and the `for name in …` loop), then set the variable
   in the `production` environment. The compose file already passes it to the portal.

GitHub runs schedules late under load and disables the schedule of a public repo after 60
days without activity; the page says when it last checked.

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

The privacy policy, subprocessor list and DPA (`privacy.md`, `subprocessors.md`, `dpa.md`)
are published, not accepted: set the new `version:` in the file and the same value in
`PUBLISHED_VERSIONS` (`src/legal/versions.ts`; a portal test fails if they differ), then
deploy. Nobody is sent to re-accept. Section 12 of the privacy policy promises customers 30
days' notice of a material change, by email and in the portal: decide whether the change is
material and send that notice yourself before it takes effect; nothing in IRIS sends it.

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
- The portal shows a banner with the support contact (for a failed payment, #266, one that
  says so and points to Billing instead); creating, changing or revoking API
  keys and saving or removing provider keys is refused.

Not instant, and not everything:

- An open connection keeps working until its next re-check, up to 60 s after the
  suspension. A job already running when you suspend finishes and is billed.
- Members can still invite people, accept invitations and switch orgs. Membership is
  not what does harm; keys and jobs are. They cannot create a new org, which would carry
  fresh keys past the suspension. To stop a person, ban the user (below).

Unsuspending restores all of it at once. The org's data is untouched either way.

### Ban or unban a user (issue #457)

```bash
docker compose exec iris node dist/cli.js admin ban-user <userId or email> --reason "AUP 3.1: phishing (ticket 124)"
docker compose exec iris node dist/cli.js admin user-status <userId or email>
docker compose exec iris node dist/cli.js admin unban-user <userId or email> --reason "Appeal granted (ticket 124)"
```

Kept in `user_suspensions`, with actor and reason, as for orgs. A ban, at once:

- deletes the user's portal sessions (signed out on the next request) and refuses every
  new sign-in with `USER_BANNED`; without a session they cannot accept an invitation;
- revokes the API keys they created in every org they belong to (audited as
  `api_key.delete`, reason `user banned`). Keys made before #361 have no creator on record:
  check the org's keys and suspend the org if needed. A live RPC connection on a revoked key
  closes at its next re-check (60 s).

Not covered: their orgs and memberships stay (suspend the org too if it is theirs), and a
new sign-up under another address is a new user. Unbanning restores sign-in only; revoked
keys stay revoked.

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

## Artifact storage (issues #257, #460)

Run detail (`GET /v1/runs/:id`) returns visual artifacts as signed URLs (5 minutes) when
the services have an S3-compatible store; hosted visual jobs need one. Set them in the
`production` GitHub environment, and the next deploy passes them to iris, worker and
portal (#549):

| Name | Kind | Value |
| --- | --- | --- |
| `IRIS_S3_ENDPOINT` | variable | `https://…` of the bucket's S3 API (unset: no artifacts, visual jobs answer 503) |
| `IRIS_S3_BUCKET` | variable | a private bucket |
| `IRIS_S3_REGION` | variable | default `us-east-1` |
| `IRIS_S3_ACCESS_KEY_ID` | variable | read and write on the bucket |
| `IRIS_S3_SECRET_ACCESS_KEY` | secret | the deploy writes it to `secrets/s3_secret_access_key` and sets `IRIS_S3_SECRET_ACCESS_KEY_FILE` |

The worker (visual jobs, #268) and the portal (screenshots and approval on run detail,
#463) take the same variables. The worker and the portal need **write** access (the
worker stores screenshots; approving in the portal copies an image to a new baseline
key); `iris connect` needs read and write too, as API approval does the same copy.
A partial configuration stops `iris connect` (exit 3) rather than serving without
artifacts, so the health gate rolls the deploy back. The vendor is the operator's choice
(#273); the repository names none.

### Staging's store (issue #514)

Staging runs its own S3-compatible store, so the paths above run on a box before
production: SeaweedFS from `docker-compose.staging-s3.yml` (pinned like CI's, identities
from `-s3.config`, so an unsigned request is a 403; data in the `iris-staging_seaweedfs-data`
volume; S3 API on `127.0.0.1:18333`). Only `deploy-staging` copies that file into the
release and names it in `COMPOSE_FILE` (settings.env), so every compose command of a
staging release runs both files and `deploy.sh` starts the store with postgres.
`deploy-production` never copies it.

- **Credentials**: the first deploy generates the secret key in
  `shared/secrets/s3_secret_access_key`, never overwritten and never leaving the box. The
  store's identity file (`shared/secrets/seaweedfs_s3.json`, access key `iris-staging`) and
  each release's `secrets/s3_secret_access_key` are built from it. No GitHub secret.
- **Bucket**: `iris-staging`, created by the first deploy's smoke step, which also checks
  that an unsigned request is refused.
- **Endpoint**: signed URLs are loaded by the user's browser, so `IRIS_S3_ENDPOINT` must be
  an https origin the browser reaches and SeaweedFS sees unchanged (SigV4 signs the host
  and the path, so no path prefix). On staging that is a name of its own, e.g.
  `https://s3.<staging portal host>`: an A record to the box, a host nginx site for it
  proxying `/` to `http://127.0.0.1:18333` with `proxy_set_header Host $host;`, no body
  size limit below the largest screenshot (`client_max_body_size 64m;`), and a Let's
  Encrypt certificate issued the way the box's other sites have theirs. Then set the
  **variable** `IRIS_S3_ENDPOINT` in the `staging` environment; the next deploy sets
  `IRIS_S3_BUCKET`, `IRIS_S3_ACCESS_KEY_ID` and `IRIS_S3_SECRET_ACCESS_KEY_FILE` with it.
  Without it the store runs and the services are not pointed at it (no artifacts, visual
  jobs 503). Do not set the other `IRIS_S3_*` in the `staging` environment: the job uses
  the box's. **Done on 2026-11-27 (#711)**: the site also streams uploads
  (`proxy_request_buffering off;`, `proxy_http_version 1.1;`) and adds no `X-Forwarded-*`
  header. The worker and the API use the same public name, so their uploads leave the
  stack's bridge for the box's own public address; the egress firewall (#376) allows it,
  because that address is global.

## Managed AI credits (issue #479)

Orgs that choose **IRIS credits** on `/provider-keys` make AI calls on IRIS's own vendor
key, up to their plan's monthly credit; then their own key, if they stored one. Set them in
the `production` GitHub environment; the deploy passes them to the `iris` service only
(#549, #514). The worker runs tenant pages and makes no AI call yet, so it does not hold
IRIS's vendor key; give it the key when a hosted job first makes one. The `staging`
environment passes them the same way; staging leaves them unset (the wiring is pinned by
`container-config.test.ts`):

| Name | Kind | Value |
| --- | --- | --- |
| `IRIS_MANAGED_AI_PROVIDER` | variable | `openai` or `anthropic` |
| `IRIS_MANAGED_AI_KEY` | secret | IRIS's key for that vendor; written to `secrets/managed_ai_key`, read through `IRIS_MANAGED_AI_KEY_FILE` |

Unset, managed mode falls through to each org's own key. One without the other stops
`iris connect` (exit 3). The vendor is then IRIS's subprocessor for those orgs (the
subprocessor page says so). Managed spend is `usage_events` with `billing_mode = managed`;
the worker reports it to a Stripe meter ("Stripe billing", below).

## Stripe billing (issues #261, #345)

Off until all four settings are set; then owners and admins see **Upgrade** (Checkout) and
**Manage billing** (Customer Portal) on `/org` and `/usage`. Subscription state comes only from the
signed webhook. Set up once per Stripe mode (test first, then live):

1. **Products and prices**: a *Pro* product with a recurring monthly price of $49, and a
   *Team* product at $199/month. Note each price id (`price_…`).
2. **Customer Portal** (Settings → Billing → Customer portal): allow cancelling, updating
   the payment method and switching between the Pro and Team prices; save it. Upgrades
   and cancellations go through the Portal: Checkout is refused while a subscription is live.
   IRIS enforces one subscription per org itself (#688): before each Checkout it lists the
   customer's subscriptions from Stripe and sends an org that has one to the Customer
   Portal, and it expires the customer's older open Checkout Sessions, so two Upgrade
   clicks or two tabs cannot end in two subscriptions. Checkout's "limit customers to one
   subscription" setting, if your account offers it, is optional extra protection.
3. **Webhook endpoint** (Developers → Webhooks): `https://<public host>/v1/stripe/webhook`,
   API version `2026-11-18.endive` (`STRIPE_API_VERSION` in `src/billing/stripe.ts`), events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its
   signing secret (`whsec_…`).
4. **Meter** (Billing → Meters; #264): one meter with the event name
   `iris_managed_ai_micro_usd` (`METER_EVENT_NAME` in `src/billing/stripe-meter.ts`),
   aggregation **sum**, and the default payload keys (`stripe_customer_id`, `value`). Its
   unit is one millionth of a US dollar of provider cost. The meter records usage whether or
   not a price uses it. No price is needed today: managed usage stops at the plan's included
   credit. Charging for usage beyond it would be a metered price on this meter (for example
   $1 per 1,000,000 units), which is an owner decision.
5. **The `production` GitHub environment** (the deploy passes them to `iris` and the portal;
   the worker gets the API key only, for the meter report):

| Name | Kind | Value |
| --- | --- | --- |
| `IRIS_STRIPE_SECRET_KEY` | secret | a restricted or secret API key; written to `secrets/stripe_secret_key`, read through `IRIS_STRIPE_SECRET_KEY_FILE` |
| `IRIS_STRIPE_WEBHOOK_SECRET` | secret | the endpoint's signing secret; written to `secrets/stripe_webhook_secret` |
| `IRIS_STRIPE_PRICE_PRO` | variable | the Pro price id |
| `IRIS_STRIPE_PRICE_TEAM` | variable | the Team price id |
| `IRIS_BILLING_GRACE_DAYS` | variable | optional: days from a failed payment to suspension, 0-90 (unset: 7) |

Some but not all of them stop `iris connect` (exit 3, so the deploy rolls back) and make
the portal's `/org` fail. Check from the Stripe dashboard that a test event is answered
200; a 400 means the signing secret does not match. Locally, `stripe listen --forward-to
localhost:4000/v1/stripe/webhook` prints a secret to use as `IRIS_STRIPE_WEBHOOK_SECRET`.
Each event makes `iris connect` read the customer's subscriptions from the Stripe API (10 s
timeout, no retries); when Stripe is unreachable it answers 500 and Stripe redelivers, so
the API key needs read access to subscriptions, and for the meter: write access to meter
events and read access to meters and their event summaries. At most two deliveries are
applied at once (they share the database pool with tenant traffic); more are answered 503
and Stripe redelivers them, so a burst of `503` in the endpoint's delivery log is the cap
working, not an outage.
Purging an org does not cancel its Stripe
subscription: cancel it in the dashboard first.

### Usage reporting and reconciliation (issue #264)

With Stripe configured, the worker sends every unreported `managed` usage row to the meter
every 5 minutes: one meter event per row, at the time the usage happened, with the row's id
as identifier and idempotency key, so a resend is not a second charge (Stripe promises that
for 24 hours). Only one worker reports at a time (a Postgres advisory lock). BYOK and
platform usage are never sent. The worker is given `IRIS_STRIPE_SECRET_KEY` alone; without
it, it reports nothing.

Not sent, and left unreported: rows of an org with no Stripe customer (a support grant on a
free org; if the org later subscribes, its rows of the last 34 days are sent then, dated
before the subscription began), rows older than 34 days (Stripe refuses a timestamp past
35), and rows Stripe
rejects (logged as `stripe meter report` with `firstRejection`; counted in
`iris_stripe_meter_events_total{outcome="rejected"}` on the worker's metrics port). Stripe
checks the customer asynchronously: an event for a customer deleted in Stripe is accepted
and then dropped there, which only the reconciliation shows. One loss never reaches the
ledger, so no report can show it: an AI call whose usage row failed to write (its credit
stays held for the month, #482). Browser minutes are not billed through the meter.

After a billing period closes, compare the ledger with Stripe:

```bash
docker compose exec iris node dist/cli.js admin billing-reconcile \
  --from 2026-11-01T00:00:00Z --to 2026-12-01T00:00:00Z
```

It prints one JSON row per org with managed usage in the period, in micro-USD:
`ledgerMicroUsd`, `estimatedMicroUsd` (the part priced at an estimated rate because the
model had no price row, #243; it is reported to Stripe as it is, the same amount the org's
credit was charged), `unreportedMicroUsd`, `stripeMicroUsd` (`null` without a customer) and
`differenceMicroUsd` (ledger minus Stripe). When Stripe could not be asked about one org,
its row carries `stripeError` and the rest are still reported. Exit 0 when every difference
is 0 and there is no error, else 3. The
period must be on whole minutes. Stripe aggregates asynchronously, so run it some minutes
after the worker's last pass. A positive difference with `unreportedMicroUsd` equal to it is
usage waiting or unsendable; any other difference needs a look at the Stripe meter's events.

**After restoring the database from a backup**, stop the worker before the restored stack
starts and mark what the backup's rows had already sent, or it sends them again: Stripe
only recognises a repeated identifier for about 24 hours.

```sql
update usage_events set stripe_reported_at = now()
where billing_mode = 'managed' and stripe_reported_at is null
  and created_at < '<the time of the last worker pass before the failure>';
```

Then run `billing-reconcile` for the period and start the worker.

### Failed payments (issue #266)

When a renewal fails, Stripe marks the subscription `past_due` and IRIS starts a grace
period: `IRIS_BILLING_GRACE_DAYS` whole days (0-90, default 7), counted from the first
event that shows the failure. The deadline is stored then, so changing the setting affects
later failures only. The org keeps its plan and its members see a warning with the date on
every portal page.

- **Past the deadline** `iris connect` suspends the org within a minute, as an
  `org_suspensions` row by actor `billing` (`org-status` shows it). The effect is the one
  described under "Abuse handling": keys 403, live connections closed within 60 s, jobs
  refused. The portal says the suspension is for a failed payment, and owners and admins can
  still open **Manage billing** to pay.
- **When the payment is settled** (`invoice.paid`, or any event after which Stripe shows the
  subscription paid) the suspension is lifted in the same transaction. If Stripe gives up
  and cancels the subscription, the org drops to Free and the suspension is lifted too.
- **To give a customer more time**: `admin unsuspend-org <orgId> --reason "…"`. IRIS
  suspends once per failed payment, so your unsuspend stays until the payment is settled
  (a later failure, after that, starts a new grace period).
- **An abuse suspension is separate.** A paid invoice lifts only a suspension by `billing`.
  `suspend-org` on a billing-suspended org records yours over it, so the org stays
  suspended when the invoice is paid. `delete-org` does the same; if you `restore-org`
  while the payment is still failing, the org is suspended for it again within a minute.
- Each step is in the org's audit log: `billing.grace_start`, `billing.suspend`,
  `billing.restore`.
- Align Stripe's own retry schedule (Settings → Billing → Subscriptions and emails →
  Manage failed payments) with the grace period: if Stripe cancels the subscription before
  the deadline, the org simply becomes Free and is never suspended.
- **To change the period**, set the `IRIS_BILLING_GRACE_DAYS` variable in the `production`
  environment (Settings → Environments → production → Environment variables) and deploy.
  The deploy job writes it to the release's `settings.env` (#639); unset keeps 7 days. A
  value that is not a whole number from 0 to 90 stops `iris connect` (exit 3), so the new
  containers never turn healthy and `deploy.sh` rolls back to the previous release. Check
  it after a deploy: `docker compose exec iris printenv IRIS_BILLING_GRACE_DAYS`.

## Retention and offboarding (issue #349)

Periods (owner decisions, 2026-10-03; the 7 years await counsel's confirmation, #450):
deleted orgs are kept 30 days before purge; their billing records 7 years; finished runs
90 days; audit entries 90 days (decided 2026-11-08, #541; the entry for an API key's
creation stays while the key exists, since it is how a departing member's keys are found); expired sessions and tokens are purged daily; terms evidence is kept 7 years
after the user is deleted. `docs/data-flows.md` has the per-store detail.

### Delete or restore an org, delete a user

Customers ask through the support contact; there is no self-serve deletion yet.

```bash
cd "$(readlink -f /opt/iris-production/current)"
docker compose exec iris node dist/cli.js admin delete-org <orgId> --reason "Customer request (ticket 123)"
docker compose exec iris node dist/cli.js admin restore-org <orgId>      # within the 30 days
docker compose exec iris node dist/cli.js admin delete-user <userId>
```

- `delete-org` suspends the org at once (everything in "Abuse handling" applies) and
  prints the purge date. `restore-org` cancels it and lifts that suspension only: an
  operator's own suspension (abuse) stays. After the purge, restore refuses.
- The purge deletes runs, results, API keys, provider keys, members, invitations, the
  plan and audit rows. The org row stays as a tombstone ("Deleted organization",
  suspended) holding its billing records for 7 years. The members' accounts stay.
- `delete-user` refuses while the user is the only owner of an org that is not being
  deleted: delete that org first, or have them add another owner. Their memberships,
  sessions and logins go with them; their terms acceptances are kept under a hash.
- Artifacts in object storage are not purged yet: nothing writes them until #268.

### The daily pass

`deploy/retention.sh` runs `iris admin retention` in the `iris` and `worker` containers
(found by compose labels). The Postgres part is idempotent, so it runs in both; each
container also deletes purged orgs' rows from its own AI ledger and vision cache.
Install it like the watchdog, as root-owned copies:

```bash
r="$(readlink -f /opt/iris-production/current)"
install -o root -g root -m 0755 "$r/retention.sh" /usr/local/sbin/iris-retention
install -o root -g root -m 0644 "$r/systemd/iris-retention.service" "$r/systemd/iris-retention.timer" /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now iris-retention.timer
systemctl start iris-retention.service && journalctl -t iris-retention -n 5
```

It runs at 04:30 UTC, after the backup, so a purge never precedes that day's backup.
Each container's report is a journal line (`orgsPurged`, `runsDeleted`,
`auditEntriesDeleted`, …). A missing
container or a failed run alerts through `/etc/iris/alert-hook retention-<service> …`
and fails the unit; the next day's run picks up whatever was left. Settings
(`RETENTION_COMPOSE_PROJECT`, `RETENTION_SERVICES`) go in `/etc/iris/retention.env`.

A purged org's data stays in backups until they age out (14 days on the host; the
off-box copy of the dumps follows its remote's policy). Its images stay 14 days as
versions in a versioned bucket, and `BACKUP_KEEP_DAYS` in the bucket's off-site copy
(#445, "Artifact bucket backups").

## When the dependency audit fails (issue #363)

The last step of CI's `build` job is `npm audit --omit=dev --audit-level=high`. It fails
the build, and so holds back both deploys, when a production dependency of the root
package or of the portal has a known high or critical advisory. It can start failing on
an unchanged `main`: the advisory is new, the code is not. The log names the package, the
advisory and the path to it.

1. **"audit endpoint returned an error"** is the registry not answering, not a finding.
   Re-run the job.
2. **A fixed release exists inside the declared range**: `npm audit fix --omit=dev`
   (never `--force`), commit `package-lock.json`, open a PR. Dependabot usually opens the
   same PR on its own (the `security-updates` group).
3. **A fixed release exists, but a package in between pins the vulnerable one**: add the
   fixed version under `overrides` in the root `package.json`, run `npm install`, and say
   in the PR which package holds it back, so the override can be removed later.
4. **No fixed release exists**: read the advisory against how IRIS uses the package, then
   replace or drop the dependency, or wait for the fix. Deploys stay held meanwhile; that
   is the gate working. Do not raise `--audit-level` to `critical`, add `|| true` or
   mark the step `continue-on-error` (a test fails on each): an exception to the gate is
   the owner's decision, made in a PR that says which advisory and until when.

Advisories in development dependencies do not fail the build. They show under the
repository's Dependabot alerts, and Dependabot's security updates fix them. For some,
`npm audit` proposes a major downgrade of the test tooling as the "fix": ignore that and
wait for the upstream release.

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
