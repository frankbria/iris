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
#   4. rolling (#316; the proxy runs): start new iris, worker and portal containers next
#      to the serving ones; wait for their healthchecks; probe from the new iris and worker
#      that the metadata address is refused (#376); switch the proxy (shared/proxy) to them
#      and point `current` here; then drain the old ones (the worker finishes its job,
#      iris and the portal keep their open connections, up to DEPLOY_DRAIN_TIMEOUT) and
#      remove them. Unhealthy or not refused: remove the new containers, exit 1; the
#      serving ones were never touched.
#   5. cold (the first deploy behind the proxy, or of the stack): recreate the apps in
#      place (an outage, as before #316), probe, start the proxy on them, point `current`
#      here; on failure recreate them from the previous release's directory (its compose
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
#      DEPLOY_DRAIN_TIMEOUT (seconds the old containers get to finish, default 300),
#      DEPLOY_KEEP_RELEASES (release directories kept after a success, default 5).
set -euo pipefail

: "${IRIS_IMAGE:?set IRIS_IMAGE to the iris image by digest}"
: "${PORTAL_IMAGE:?set PORTAL_IMAGE to the portal image by digest}"
wait_timeout=${DEPLOY_WAIT_TIMEOUT:-300}
drain_timeout=${DEPLOY_DRAIN_TIMEOUT:-300}
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
mapfile -t data_services < <(printf '%s\n' "$services" | grep -vxF -e iris -e worker -e portal -e egress -e proxy || :)
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

# The proxy (#316) is the only holder of the host ports. Its nginx.conf and the upstreams
# it forwards to live in shared/proxy, not in a release: the proxy outlives releases and
# reloads in place. Written here, so production gets them through this script.
proxy_dir="$root/shared/proxy"
# Read by the proxy's nginx user (uid 101).
install -d -m 755 "$proxy_dir"
cat > "$proxy_dir/nginx.conf.new" <<'NGINX'
# Written by deploy.sh (#316). TCP proxying, so WebSocket sessions, X-Real-IP and every
# other header pass through untouched. A reload starts new workers on the new upstreams
# and leaves the old ones to finish the connections they hold.
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr notice;
worker_shutdown_timeout 1h;
events { worker_connections 4096; }
stream {
  resolver 127.0.0.11 valid=5s ipv6=off;
  include /etc/iris-proxy/upstreams.conf;
  server { listen 4000; proxy_pass iris_api; proxy_connect_timeout 2s; proxy_timeout 1h; }
  server { listen 3000; proxy_pass portal; proxy_connect_timeout 2s; proxy_timeout 1h; }
}
NGINX
chmod 644 "$proxy_dir/nginx.conf.new"
mv -f "$proxy_dir/nginx.conf.new" "$proxy_dir/nginx.conf"

name_of() { docker inspect -f '{{.Name}}' "$1" | tr -d /; }
service_of() { docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$1"; }

# Points the proxy at the given iris and portal containers (by name: Docker's DNS follows
# a restart's new address) and reloads it.
switch_proxy() {
  [ ! -s "$proxy_dir/upstreams.conf" ] || cp -f "$proxy_dir/upstreams.conf" "$proxy_dir/upstreams.conf.prev"
  printf 'upstream iris_api { zone iris_api 64k; server %s:4000 resolve; }\nupstream portal { zone portal 64k; server %s:3000 resolve; }\n' \
    "$(name_of "$1")" "$(name_of "$2")" > "$proxy_dir/upstreams.conf.new"
  chmod 644 "$proxy_dir/upstreams.conf.new"
  mv -f "$proxy_dir/upstreams.conf.new" "$proxy_dir/upstreams.conf"
  # Also drops a service this release no longer has (staging's store without its file).
  docker compose up -d --no-deps --remove-orphans --wait --wait-timeout "$wait_timeout" proxy
  docker compose exec -T proxy nginx -t -q -c /etc/iris-proxy/nginx.conf
  docker compose exec -T proxy nginx -s reload -c /etc/iris-proxy/nginx.conf
}

# From inside the running iris and worker containers given, the metadata address must be
# refused by the egress firewall (#376).
egress_probe() {
  local id
  for id in "$@"; do
    case "$(service_of "$id")" in iris | worker) ;; *) continue ;; esac
    docker exec "$id" node docker/egress-probe.js || {
      log "egress probe failed in $(service_of "$id"): the metadata address is not refused"
      return 1
    }
  done
}

# Waits until every given container is healthy; fails on one that exited or is unhealthy.
wait_healthy() {
  local deadline=$((SECONDS + wait_timeout)) id state pending
  while :; do
    pending=0
    for id in "$@"; do
      state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
      case "$state" in
        'running healthy') ;;
        *unhealthy | exited* | dead*) log "$(name_of "$id") is $state"; return 1 ;;
        *) pending=1 ;;
      esac
    done
    [ "$pending" = 0 ] && return 0
    [ "$SECONDS" -lt "$deadline" ] || { log 'timed out waiting for health'; return 1; }
    sleep 2
  done
}

# Connections a container is still serving: established TCP on its service port, from
# anything but its own loopback (its healthcheck).
open_connections() {
  local port
  case "$(service_of "$1")" in iris) port=0FA0 ;; portal) port=0BB8 ;; *) echo 0; return ;; esac
  docker exec "$1" cat /proc/net/tcp /proc/net/tcp6 2>/dev/null \
    | awk -v p=":$port" '$4 == "01" && substr($2, length($2) - 4) == p && $3 !~ /^(0100007F|0000000000000000FFFF00000100007F|00000000000000000000000001000000):/' \
    | wc -l
}

prune_releases() {
  # Old releases hold secrets: keep the newest few, never the serving one.
  find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn \
    | tail -n +"$((keep + 1))" | cut -d' ' -f2- | while read -r dir; do
      [ "$dir" = "$release" ] || rm -rf -- "$dir"
    done
}

# A rollback to a release from before #316 removes the proxy (an orphan there) and puts the
# ports back on the apps: then the next deploy is a cold one again.
if [ -s "$proxy_dir/upstreams.conf" ] && [ -n "$(docker compose ps -aq proxy)" ]; then
  # Rolling (#316): the new containers start next to the serving ones, the proxy moves to
  # them once they are healthy, and the old ones drain before they stop. Nothing the
  # serving release runs is touched until the switch.
  mapfile -t old < <(docker compose ps -aq "${app_services[@]}")
  scale=()
  for service in "${app_services[@]}"; do
    scale+=(--scale "$service=$(($(docker compose ps -aq "$service" | wc -l) + 1))")
  done
  new=()
  if docker compose up -d --no-deps --no-recreate "${scale[@]}" "${app_services[@]}"; then
    mapfile -t new < <(docker compose ps -aq "${app_services[@]}" | grep -vxF -f <(printf '%s\n' "${old[@]}") || :)
  fi
  new_of() { for id in "${new[@]}"; do [ "$(service_of "$id")" != "$1" ] || echo "$id"; done; }
  if [ "${#new[@]}" = "${#app_services[@]}" ] && wait_healthy "${new[@]}" && egress_probe "${new[@]}" \
    && switch_proxy "$(new_of iris)" "$(new_of portal)"; then
    point_current "$release"
    log "rolling: switched to $(name_of "$(new_of iris)") and $(name_of "$(new_of portal)")"
    # Drain: the old worker finishes its job; the old iris and portal keep the sessions and
    # requests they hold until those end, at most DEPLOY_DRAIN_TIMEOUT, then stop with
    # their own drain (#309).
    deadline=$((SECONDS + drain_timeout))
    for id in "${old[@]}"; do
      [ "$(service_of "$id")" = worker ] && docker stop -t "$drain_timeout" "$id" >/dev/null &
    done
    for id in "${old[@]}"; do
      [ "$(service_of "$id")" = worker ] && continue
      while [ "$(open_connections "$id")" != 0 ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 2; done
      log "drained $(name_of "$id"): $(open_connections "$id") connections left"
      docker stop "$id" >/dev/null || :
    done
    wait
    docker rm -f "${old[@]}" >/dev/null || :
    log 'healthy'
    prune_releases
    exit 0
  fi
  log 'new containers did not become healthy, or the egress probe or the switch failed'
  for id in "${new[@]}"; do docker logs --tail 30 "$id" || :; done
  if [ -s "$proxy_dir/upstreams.conf.prev" ]; then
    mv -f "$proxy_dir/upstreams.conf.prev" "$proxy_dir/upstreams.conf"
    docker compose exec -T proxy nginx -s reload -c /etc/iris-proxy/nginx.conf || :
  fi
  [ "${#new[@]}" = 0 ] || docker rm -f "${new[@]}" >/dev/null || :
  log 'removed them: the serving release kept serving throughout'
  exit 1
fi

# The first deploy behind the proxy (or of the stack): recreate in place, an outage as
# before #316, then start the proxy on the new containers.
# `current` moves only once the release is healthy: a deploy cut off before then (job
# cancelled, host rebooted) leaves it on the last good release, the next rollback target.
if docker compose up -d --force-recreate --no-deps --remove-orphans \
  --wait --wait-timeout "$wait_timeout" "${app_services[@]}" \
  && mapfile -t serving < <(docker compose ps -q "${app_services[@]}") \
  && egress_probe "${serving[@]}" \
  && switch_proxy "$(docker compose ps -q iris)" "$(docker compose ps -q portal)"; then
  point_current "$release"
  log 'healthy'
  prune_releases
  exit 0
fi

log 'new containers did not become healthy, or the egress probe or the proxy failed'
docker compose ps -a || :
for service in "${app_services[@]}" proxy; do docker compose logs --tail 30 "$service" || :; done
# The proxy holds the host ports the previous release's containers publish.
rm -f "$proxy_dir/upstreams.conf"
docker compose rm -sf proxy || :
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
