# Deploying IRIS

What runs where, and what each environment needs. The design is
[ADR 0001](docs/adr/0001-hosted-architecture.md); the step-by-step operations (first
setup, promoting a release, rolling back, backups, monitoring, retention) are in
[docs/runbook-production.md](docs/runbook-production.md). Host names, addresses and
paths of a real deployment belong to the operator's own notes, never to this repository.

## What is deployed

The hosted service is this package plus the portal, as containers:

| Service | Image | What it does |
|---|---|---|
| `iris` (iris-api) | `Dockerfile` | `iris connect` with `IRIS_HOSTED=1`: REST `/v1/…` (a11y and visual-diff jobs, results) and JSON-RPC over WSS, behind org API keys |
| `worker` | same image | `iris worker`: runs queued a11y and visual-diff jobs in hardened Chromium |
| `portal` | `Dockerfile.portal` | Next.js: sign-up, orgs, API keys, BYOK provider keys, runs |
| `postgres` | pinned by digest | Tenant data; the job queue is its `runs` table |

Screenshots go to private S3-compatible object storage (`IRIS_S3_*`). The host's nginx
is the only public listener ([`deploy/nginx/iris.conf`](deploy/nginx/iris.conf)); the
services publish on loopback only. Every image is pinned by digest.

## Environments

| | Staging | Production |
|---|---|---|
| Trigger | merge to `main` (`deploy-staging` in `.github/workflows/ci.yml`) | a protected `v*` tag on a commit staging deployed (`deploy-production`) |
| Compose file | `docker-compose.production.yml` (project `iris-staging`) | `docker-compose.production.yml` |
| Deploy directory | `/opt/iris-staging` | `/opt/iris-production` |
| What runs | the hosted stack above (#440) | the hosted stack above |
| Host ports | `127.0.0.1:14000` (iris-api), `127.0.0.1:13000` (portal) | `127.0.0.1:4000`, `127.0.0.1:3000` |
| Builds | yes, deploys those digests, then tags both images `staged-<sha>` | never: promotes the digests staging ran |
| Gates | `deploy.sh` (SMTP check, migrations, health, rollback), then Chromium in iris and the worker and both host ports | `deploy.sh`: SMTP check, migrations, health; rollback to the previous release on failure |

Both run `deploy/deploy.sh` from a release directory, so `staged-<sha>` is written only
after the same stack production runs became healthy on the staging box.
`docker-compose.staging.yml` is now the token-mode reference only (self-hosting, and the
image test on every PR).

## Secrets and variables

Both GitHub environments need the connection secrets: `HOST`, `USER` (able to `chown`),
`SSH_KEY`, `SSH_KNOWN_HOSTS`, and either `TS_AUTHKEY` or `TS_OAUTH_CLIENT_ID` +
`TS_OAUTH_SECRET` (with `TS_TAGS`) for the tailnet.

**Both** also need the hosted settings below, each environment its own values (staging's
`SMTP_URL` may be a test relay). The ports default per environment: staging 14000 / 13000,
production 4000 / 3000. Staging skips its deploy when the connection secrets are absent (a
fork), but once they are set, a missing hosted setting fails the job by name.
`IRIS_CONNECT_TOKEN` is no longer read by either deploy.

| Name | Kind | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | secret | Signs portal sessions; 32+ random bytes, distinct per environment |
| `SMTP_URL` | secret | Mail relay for verification and reset mail (carries its password) |
| `PORTAL_URL` | variable | The portal's public `https://` origin |
| `SMTP_FROM` | variable | Sender address |
| `IRIS_API_PORT`, `PORTAL_PORT` | variable | Optional loopback ports (default 4000, 3000; staging 14000, 13000) |
| `IRIS_SECURITY_CONTACT`, `IRIS_ABUSE_CONTACT`, `IRIS_SUPPORT_CONTACT`, `IRIS_SECURITY_TXT_EXPIRES_DAYS` | variable | Optional published contacts (`mailto:` or `https:`) |

Generated on the box at the first deploy and never overwritten: `pg_password`,
`database_url`, and `master_key` (the BYOK master key that seals every org's stored
provider keys). **Back up `master_key` and `pg_password` right after the first deploy**:
a database backup cannot open the stored provider keys without the master key.

Every secret is read from a file (`NAME_FILE`) where the service supports it, never from
a plain environment variable `docker inspect` would show.

**Optional, from the same environment** (#549): object storage as variables
`IRIS_S3_ENDPOINT`, `IRIS_S3_BUCKET`, `IRIS_S3_REGION`, `IRIS_S3_ACCESS_KEY_ID` and the
secret `IRIS_S3_SECRET_ACCESS_KEY` (passed to iris, worker and portal); managed AI credits
as the variable `IRIS_MANAGED_AI_PROVIDER` and the secret `IRIS_MANAGED_AI_KEY` (passed to
iris). Unset, production's visual-diff jobs answer 503 (the worker runs a11y only), run
detail shows no screenshots, and an org on IRIS credits uses its own key. A partial S3
setting stops the services (exit 3), so the deploy rolls back. Staging runs its own store
instead (SeaweedFS, `docker-compose.staging-s3.yml`, key generated on the box, #514) and
takes only `IRIS_S3_ENDPOINT` from its environment; see the runbook's "Artifact storage".

## Who may deploy

The `v*` tag ruleset, the `production` environment's tag-only deployment rule and its
required reviewer are the security boundary, not the workflow file. Set them before
adding any production secret; the runbook's "One-time setup" lists them.

## Local development

`docker-compose.dev.yml` runs Postgres, SeaweedFS (object storage) and Mailpit for the
test suites and the portal's E2E; see the README's "Development" section.
