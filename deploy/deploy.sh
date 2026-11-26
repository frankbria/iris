#!/usr/bin/env bash
# Deploy one IRIS release by image digest (issue #273). Run from the release's own
# directory, <deploy dir>/releases/<id>/, which the deploy job filled with
# docker-compose.yml, docker/seccomp-chromium.json, settings.env (non-secret compose
# settings: PORTAL_URL, SMTP_FROM, ports) and secrets/ (this release's secrets).
# Secrets generated once live in <deploy dir>/shared/secrets.
#
#   cd releases/<id> && IRIS_IMAGE=...@sha256:... PORTAL_IMAGE=...@sha256:... ./deploy.sh
#
# <deploy dir>/current points at the release that is serving, and only ever at one
# that became healthy. Steps, each gating the next:
#   1. pull the new images; start the data services (postgres; staging's object store),
#      recreating one only if its pinned image or definition changed; then the egress
#      firewall (#376) on the stack's bridge, so the gates already run behind it
#   2. SMTP readiness check from the new portal image      } on failure: exit 1; the
#   3. migrations from the new iris image                  } serving release is untouched
#   4. recreate iris, worker, portal; wait for their healthchecks; probe from iris and
#      the worker that the metadata address is refused; healthy and refused: point
#      `current` here (only now, so an interrupted deploy keeps its rollback target)
#   5. unhealthy or not refused: recreate them from the previous release's directory (its compose
#      file, settings, secrets and images), `current` unchanged, exit 1
#
# Compose always runs from a release's real path, so each container's bind mounts name
# its own release's files: a restart never picks up an ungated file from a newer one.
# A rerun of the same tag gets a new release directory and is an ordinary deploy.
#
# Migrations are forward-only. A rollback after a migration has applied runs the
# previous code on the new schema, so every migration must keep the previous release
# working (expand now, contract in a later release).
#
# Env: DEPLOY_WAIT_TIMEOUT (seconds per wait, default 300),
#      DEPLOY_KEEP_RELEASES (release directories kept after a success, default 5).
set -euo pipefail

: "${IRIS_IMAGE:?set IRIS_IMAGE to the iris image by digest}"
: "${PORTAL_IMAGE:?set PORTAL_IMAGE to the portal image by digest}"
wait_timeout=${DEPLOY_WAIT_TIMEOUT:-300}
keep=${DEPLOY_KEEP_RELEASES:-5}
app_services=(iris worker portal)

log() { printf 'deploy: %s\n' "$*"; }

release=$(pwd -P)
releases=$(dirname "$release")
root=$(dirname "$releases")
if [ "$(basename "$releases")" != releases ]; then
  log "run me from <deploy dir>/releases/<id>, not $release"
  exit 2
fi
previous=''
if [ -L "$root/current" ]; then previous=$(readlink -f "$root/current"); fi
if [ "$previous" = "$release" ]; then
  log 'this release is already current; stage a new release directory to redeploy'
  exit 2
fi

point_current() {
  ln -sfn "$1" "$root/current.tmp"
  mv -Tf "$root/current.tmp" "$root/current"
}

# This release's compose settings. The previous release keeps its own .env.
{ cat settings.env 2>/dev/null || :; printf 'IRIS_IMAGE=%s\nPORTAL_IMAGE=%s\n' "$IRIS_IMAGE" "$PORTAL_IMAGE"; } > .env
# From here on compose reads .env, not the caller's variables.
unset IRIS_IMAGE PORTAL_IMAGE
log "serving: ${previous:-nothing}"
log "deploying: $release"

docker compose pull --quiet
# The data services: every service but the app ones, i.e. postgres, plus staging's object
# store when settings.env names its compose file in COMPOSE_FILE (#514). Recreated only
# when a definition changed, i.e. a deliberately bumped digest (a security release):
# compose leaves an unchanged one alone. Not rolled back.
# A plain assignment, so a failing `config` stops the script (set -e); an empty list
# would make `up` start every service, the app ones included, before the gates.
services=$(docker compose config --services)
mapfile -t data_services < <(printf '%s\n' "$services" | grep -vxF -e iris -e worker -e portal -e egress || :)
if [ "${#data_services[@]}" = 0 ]; then
  log 'no data services in the compose file'
  exit 2
fi
docker compose up -d --wait --wait-timeout "$wait_timeout" "${data_services[@]}"

# The egress firewall (#376) keys its host rules on the stack's bridge, which exists now
# that the data services are up: compose's default network, `br-<id>` unless named.
# Host rules, so like postgres they are not rolled back.
project=$(docker compose config | sed -n 's/^name: //p')
network="${project}_default"
if [ "$(docker network inspect -f '{{.EnableIPv6}}' "$network")" != false ]; then
  log "$network has IPv6: the egress firewall's rules are IPv4 only"
  exit 1
fi
bridge=$(docker network inspect -f \
  '{{with index .Options "com.docker.network.bridge.name"}}{{.}}{{else}}br-{{printf "%.12s" $.Id}}{{end}}' \
  "$network")
printf 'IRIS_EGRESS_BRIDGE=%s\n' "$bridge" >> .env
if ! docker compose up -d --wait --wait-timeout "$wait_timeout" egress; then
  docker compose logs --tail 30 egress || :
  log "the egress firewall did not come up on $bridge: the serving release keeps serving"
  exit 1
fi
log "egress firewall: $bridge"

if ! docker compose run --rm --no-deps portal node verify/apps/portal/scripts/verify-smtp.js; then
  log 'SMTP check failed: nothing changed, the serving release keeps serving'
  exit 1
fi
if ! docker compose run --rm --no-deps --entrypoint node iris dist/db/migrate.js; then
  log 'migration failed: nothing changed, the serving release keeps serving'
  exit 1
fi

# From inside the running containers, the metadata address must be refused by the firewall.
egress_probe() {
  local service
  for service in iris worker; do
    docker compose exec -T "$service" node docker/egress-probe.js || {
      log "egress probe failed in $service: the metadata address is not refused"
      return 1
    }
  done
}

# `current` moves only once the release is healthy: a deploy cut off before then (job
# cancelled, host rebooted) leaves it on the last good release, the next rollback target.
if docker compose up -d --force-recreate --no-deps --remove-orphans \
  --wait --wait-timeout "$wait_timeout" "${app_services[@]}" && egress_probe; then
  point_current "$release"
  log 'healthy'
  # Old releases hold secrets: keep the newest few, never the serving one.
  find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn \
    | tail -n +"$((keep + 1))" | cut -d' ' -f2- | while read -r dir; do
      [ "$dir" = "$release" ] || rm -rf -- "$dir"
    done
  exit 0
fi

log 'new containers did not become healthy, or the egress probe failed'
docker compose ps -a || :
for service in "${app_services[@]}"; do docker compose logs --tail 30 "$service" || :; done
if [ -z "$previous" ]; then
  log 'first deploy: no previous release to roll back to'
  exit 1
fi
log "rolling back to $previous"
if (cd "$previous" && docker compose up -d --force-recreate --no-deps --remove-orphans \
  --wait --wait-timeout "$wait_timeout" "${app_services[@]}"); then
  log 'rolled back; the previous release is serving'
else
  log 'ROLLBACK ALSO FAILED: the previous release is not healthy either'
fi
exit 1
