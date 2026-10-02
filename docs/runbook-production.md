# Production runbook (issue #273)

Production runs four containers from `docker-compose.production.yml` (ADR 0001 §1):

| Service    | Image                   | What it is                                      | Host port         |
| ---------- | ----------------------- | ----------------------------------------------- | ----------------- |
| `iris`     | `ghcr.io/<repo>`        | iris-api: hosted `iris connect` (REST + WSS)    | `127.0.0.1:4000`  |
| `worker`   | `ghcr.io/<repo>`        | iris-worker: `iris worker`, runs queued jobs    | none              |
| `portal`   | `ghcr.io/<repo>-portal` | the portal (Next.js standalone)                 | `127.0.0.1:3000`  |
| `postgres` | `postgres:17-alpine`    | tenant data                                     | none              |

The host's nginx (`deploy/nginx/iris.conf`, #347) is the only public listener. A
deploy never builds anything: it promotes the image digests staging already deployed.
This file holds no host details. Those stay in the operator's private notes.

## One-time setup

### 1. GitHub environment `production`

Create the environment (Settings → Environments). Add required reviewers or a
tag-only deployment rule if you want a human gate. The job reads these.

**Secrets:**

| Name                   | Value                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| `HOST`                 | the box's tailnet name or address (as for staging)                          |
| `USER`                 | the ssh user; must be able to `chown` (it hands files to uids 1001 and 70)   |
| `SSH_KEY`              | that user's private key                                                     |
| `SSH_KNOWN_HOSTS`      | the box's host key line, labelled with `HOST`. **Required** here (no TOFU)   |
| `TS_AUTHKEY`           | a reusable, ephemeral, tagged tailnet auth key, **or** the two below        |
| `TS_OAUTH_CLIENT_ID`   | tailnet OAuth client                                                        |
| `TS_OAUTH_SECRET`      | tailnet OAuth secret                                                        |
| `BETTER_AUTH_SECRET`   | 32+ random bytes, e.g. `openssl rand -hex 32`. Signs portal sessions        |
| `SMTP_URL`             | `smtps://user:pass@smtp.provider:465` (it carries the SMTP password)        |

**Variables** (not secret):

| Name         | Value                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| `PORTAL_URL` | the portal's public `https://` origin (BetterAuth's `baseURL`; secure cookies) |
| `SMTP_FROM`  | the sender, e.g. `IRIS <no-reply@your-domain>`                              |
| `TS_TAGS`    | with OAuth only: the client's **full** tag set, comma-separated (default `tag:ci`) |
| `IRIS_API_PORT`, `PORTAL_PORT` | optional host ports (default `4000`, `3000`); see "Ports" below |

Use a different `BETTER_AUTH_SECRET` from any other environment. Missing values fail
the job by name; they never skip it.

### 2. The box

- Docker with the compose plugin, and the tailnet ACL allowing `tag:ci` to reach the
  box on port 22 (as for staging).
- The job deploys into `/opt/iris-production` and creates it. It holds
  `docker-compose.yml`, `docker/seccomp-chromium.json`, `deploy.sh`, `settings.env`,
  `.env` (written by `deploy.sh`), `deploy-state/` and `secrets/` (0700).
- **Ports.** iris-api publishes on `127.0.0.1:4000` and the portal on `127.0.0.1:3000`.
  The staging compose also takes `127.0.0.1:4000`, so on a box that runs both, set
  the `IRIS_API_PORT` / `PORTAL_PORT` variables and use the same ports in the nginx
  site. `settings.env` is rewritten on every deploy, so do not edit it by hand. Never publish either on a public interface: the portal's rate limits
  trust `X-Real-IP`, which only nginx may set.

### 3. Secrets generated on the box

The first deploy generates two values on the box. They never leave it, and later
deploys never overwrite them:

- `secrets/pg_password`: Postgres reads it only when it first initialises its volume,
  so a new value would lock the server out of its own database. `database_url` is
  rebuilt from it on every deploy.
- `secrets/master_key`: the BYOK master key (`k1:<base64 of 32 bytes>`). It seals
  every org's stored provider key. **Losing it loses those keys.** The portal and
  iris-api read the same file. To rotate it, put the new entry first
  (`k2:…,k1:…`), run `docker compose run --rm --entrypoint node iris dist/byok/rewrap.js`,
  then drop the old entry.

**Back both up right after the first deploy**, apart from the database backups
(#274). A database backup without the master key cannot open the stored provider
keys, and a lost `pg_password` means resetting it inside the container.

### 4. The nginx site

Install `deploy/nginx/iris.conf` as the README's "TLS ingress" section describes:
server name, certificate paths, upstreams `127.0.0.1:4000` (iris-api) and
`127.0.0.1:3000` (portal), then `nginx -t` and a reload. On a shared 443, check that
the `default_server` allows only TLS 1.2+ with ECDHE AEAD ciphers. Do not put a CDN in
front: the site overwrites `X-Forwarded-For` with the peer address.

### 5. Mail

`SMTP_URL` must name a real relay. Mailpit (`docker-compose.dev.yml`) is for
development and E2E only: it accepts everything and delivers nothing. The deploy
runs `transporter.verify()` from the new portal image before it changes anything
(connect, and authenticate if the URL has credentials). A wrong host, port or
password fails the deploy while the running containers keep serving.

## Promote a release

1. Merge to `main`. `deploy-staging` deploys it, boots the portal image, and then tags
   both images `staged-<sha>`. If staging fails, no tag is written.
2. Tag that commit and push the tag:

   ```bash
   git tag -a v1.2.3 <sha> -m "v1.2.3"
   git push origin v1.2.3
   ```

   Or run the CI workflow by hand (Actions → CI → Run workflow) with `tag: v1.2.3`.
3. `deploy-production` runs. It:
   - refuses the run if `ghcr.io/<repo>:staged-<sha>` or `ghcr.io/<repo>-portal:staged-<sha>`
     is missing, where `<sha>` is the tag's commit: staging never deployed it;
   - resolves both tags to `@sha256:` digests and deploys those;
   - copies the compose file, the seccomp profile and `deploy.sh` from the tagged
     commit, writes `settings.env` and the secret files;
   - runs `deploy.sh` on the box.

### What `deploy.sh` does

1. It records the image refs the running `iris` and `portal` containers use, in
   `deploy-state/previous`. These are the rollback target.
2. It pulls the new images and starts `postgres` (`up --wait`).
3. It runs the SMTP check from the new portal image.
4. It runs the migrations from the new iris image.
5. It recreates `iris`, `worker` and `portal`, and waits for their healthchecks.
6. On success it writes `deploy-state/current`.

If step 3 or 4 fails, the script exits non-zero and nothing has changed: the old
containers keep serving. If step 5 is unhealthy, the script recreates the services
on the recorded refs, waits for them, and exits non-zero either way. The first deploy
has no previous refs, so it says so and exits non-zero without a rollback.

`.env` always names the images that are running when the script exits, so
`docker compose ps`, `logs` and `up -d` in the deploy directory work by hand. Running
the same tag again is safe. It recreates the same containers, which also picks up
rotated secret files.

**Health signals:**

- iris-api: `GET /` must return 404. The job API answers that before any
  authentication, so it means the listener is up and hosted startup (key store,
  database probe) succeeded. The token healthcheck (`docker/healthcheck.js`) cannot
  authenticate in hosted mode (#309).
- portal: the image's `HEALTHCHECK` (`GET /login` returns 200).
- worker: running, since it has no listener.

## Roll back

Run the workflow by hand with the previous release tag. Its `staged-<sha>` tags still
exist, so it deploys the previous digests through the same gates.

**Migrations are forward-only.** A rollback runs the previous code on the current
schema. Every migration must therefore keep the previous release working: add
columns and tables in one release ("expand"), and drop or rename them only in a later
release, once nothing running reads them ("contract"). A migration that cannot
follow this rule needs a planned outage and a restore from backup (#274) instead of a
rollback.

## Troubleshooting

- **"staged-… does not exist"**: staging did not deploy that commit (or its deploy
  failed). Deploy it to staging first, or tag a commit that staging deployed.
- **The SMTP check failed**: check `SMTP_URL` (host, port, `smtp://` vs `smtps://`,
  credentials) from the box: `docker compose run --rm --no-deps portal node verify/apps/portal/scripts/verify-smtp.js`.
- **The migration failed**: run `docker compose run --rm --no-deps --entrypoint node iris dist/db/migrate.js`
  in the deploy directory. The old containers are still serving.
- **Unhealthy after the switch**: the job log has `docker compose ps` and the last
  log lines of each service. iris-api exits 3 when the hosted environment is
  incomplete (master key, database, `BETTER_AUTH_*`).
