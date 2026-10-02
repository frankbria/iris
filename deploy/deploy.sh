#!/usr/bin/env bash
# Deploy IRIS by image digest (issue #273). Runs on the box, from the deploy
# directory that holds docker-compose.yml, docker/seccomp-chromium.json,
# secrets/ and settings.env (the non-secret compose settings: PORTAL_URL, SMTP_FROM).
#
#   IRIS_IMAGE=ghcr.io/...@sha256:... PORTAL_IMAGE=ghcr.io/...@sha256:... ./deploy.sh
#
# Steps, each gating the next:
#   1. record the image refs the running containers use (the rollback target)
#   2. pull the new images
#   3. start postgres and wait for it
#   4. SMTP readiness check from the new portal image   } on failure: exit, the
#   5. migrations from the new iris image               } old containers keep serving
#   6. recreate iris, worker and portal; wait for their healthchecks
#   7. unhealthy: recreate them on the recorded refs, wait, exit non-zero
#
# Idempotent: a rerun with the running digests recreates the same containers (that
# picks up rotated secret files) and succeeds. .env always names the images that
# are running when the script exits, so a plain `docker compose ps|logs|up` works.
#
# Migrations are forward-only. A rollback after a migration has applied runs the
# previous code on the new schema, so every migration must keep the previous release
# working (expand now, contract in a later release).
#
# Env: DEPLOY_WAIT_TIMEOUT (seconds per wait, default 300),
#      DEPLOY_STATE_DIR (default deploy-state).
set -euo pipefail

: "${IRIS_IMAGE:?set IRIS_IMAGE to the iris image by digest}"
: "${PORTAL_IMAGE:?set PORTAL_IMAGE to the portal image by digest}"
new_iris=$IRIS_IMAGE
new_portal=$PORTAL_IMAGE
wait_timeout=${DEPLOY_WAIT_TIMEOUT:-300}
state_dir=${DEPLOY_STATE_DIR:-deploy-state}
app_services=(iris worker portal)

log() { printf 'deploy: %s\n' "$*"; }

# The image ref a service's container was created from, or nothing.
running_image() {
  local id
  id=$(docker compose ps -a -q "$1" | head -n1)
  [ -n "$id" ] && docker inspect -f '{{.Config.Image}}' "$id"
  return 0
}

# .env = settings.env + the image refs. Compose reads it on every command.
write_env() {
  { cat settings.env 2>/dev/null || :; printf 'IRIS_IMAGE=%s\nPORTAL_IMAGE=%s\n' "$1" "$2"; } > .env.tmp
  mv .env.tmp .env
}

# First, so compose interpolates with this deploy's settings even when reading
# what runs now. The EXIT trap below puts the running refs back on failure.
write_env "$new_iris" "$new_portal"

# Both refs or neither: a half-known previous state is no rollback target.
prev_iris=$(running_image iris || :)
prev_portal=$(running_image portal || :)
if [ -z "$prev_iris" ] || [ -z "$prev_portal" ]; then
  prev_iris=''
  prev_portal=''
fi
mkdir -p "$state_dir"
printf 'IRIS_IMAGE=%s\nPORTAL_IMAGE=%s\n' "$prev_iris" "$prev_portal" > "$state_dir/previous"
log "running: iris=${prev_iris:-none} portal=${prev_portal:-none}"
log "deploying: iris=$new_iris portal=$new_portal"

# Any failure from here on leaves .env naming what is actually running.
done_ok=0
# shellcheck disable=SC2329 # run by the EXIT trap
on_exit() {
  local rc=$?
  if [ "$done_ok" != 1 ] && [ -n "$prev_iris" ]; then write_env "$prev_iris" "$prev_portal"; fi
  exit "$rc"
}
trap on_exit EXIT

docker compose pull --quiet
docker compose up -d --wait --wait-timeout "$wait_timeout" postgres

if ! docker compose run --rm --no-deps portal node verify/apps/portal/scripts/verify-smtp.js; then
  log 'SMTP check failed: nothing changed, the running containers keep serving'
  exit 1
fi
if ! docker compose run --rm --no-deps --entrypoint node iris dist/db/migrate.js; then
  log 'migration failed: nothing changed, the running containers keep serving'
  exit 1
fi

if docker compose up -d --force-recreate --no-deps --remove-orphans \
  --wait --wait-timeout "$wait_timeout" "${app_services[@]}"; then
  printf 'IRIS_IMAGE=%s\nPORTAL_IMAGE=%s\n' "$new_iris" "$new_portal" > "$state_dir/current"
  done_ok=1
  log 'healthy'
  exit 0
fi

log 'new containers did not become healthy'
docker compose ps -a || :
for service in "${app_services[@]}"; do docker compose logs --tail 30 "$service" || :; done
if [ -z "$prev_iris" ]; then
  log 'first deploy: no previous images to roll back to'
  exit 1
fi
log "rolling back to iris=$prev_iris portal=$prev_portal"
write_env "$prev_iris" "$prev_portal"
if IRIS_IMAGE=$prev_iris PORTAL_IMAGE=$prev_portal docker compose up -d --force-recreate \
  --no-deps --remove-orphans --wait --wait-timeout "$wait_timeout" "${app_services[@]}"; then
  log 'rolled back; the previous images are serving'
else
  log 'ROLLBACK ALSO FAILED: the previous images are not healthy either'
fi
exit 1
