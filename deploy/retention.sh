#!/usr/bin/env bash
# IRIS daily retention (issue #349). Runs from deploy/systemd/iris-retention.timer, as
# root, as a root-owned copy the operator installs (like the backup and the watchdog:
# root never runs a file the deploy user can write):
#
#   install -o root -g root -m 0755 deploy/retention.sh /usr/local/sbin/iris-retention
#
# Runs `iris admin retention` inside each RETENTION_SERVICES container, found by its
# compose labels (project RETENTION_COMPOSE_PROJECT). The Postgres part (orgs past their
# 30-day grace, runs after 90 days, expired sessions and tokens, records after 7 years)
# is idempotent, so running it in both containers is harmless; the AI ledger and vision
# cache are per container (each has its own /data volume), which is why both run it.
#
# A service with no running container, or a failed run, alerts (a critical journal
# entry plus RETENTION_ALERT_HOOK `<key> <message>` if executable) and makes the unit
# fail; the other services still run.
#
# Env: RETENTION_COMPOSE_PROJECT (default iris-production), RETENTION_SERVICES (default
#      "iris worker"), RETENTION_ALERT_HOOK (default /etc/iris/alert-hook).
set -euo pipefail
umask 077

project=${RETENTION_COMPOSE_PROJECT:-iris-production}
services=${RETENTION_SERVICES:-iris worker}
hook=${RETENTION_ALERT_HOOK:-/etc/iris/alert-hook}

alert() {
  logger -p crit -t iris-retention -- "$2" || true
  if [ -x "$hook" ]; then "$hook" "$1" "$2" || true; fi
  echo "iris-retention: $2" >&2
}

failed=0
for service in $services; do
  if ! container=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" 2>&1); then
    alert "retention-$service" "docker ps failed: $(tr -cd '[:print:]' <<<"$container" | cut -c1-300)"
    failed=1
    continue
  fi
  if [ -z "$container" ]; then
    alert "retention-$service" "no running $service container in compose project $project"
    failed=1
    continue
  fi
  if [ "$(wc -l <<<"$container")" != 1 ]; then
    alert "retention-$service" "more than one $service container in $project"
    failed=1
    continue
  fi
  if out=$(docker exec "$container" node dist/cli.js admin retention 2>&1); then
    # The report is one JSON line on stdout; logs go to stderr (#275), both captured here.
    logger -t iris-retention -- "$service: $(tail -n 1 <<<"$out" | tr -cd '[:print:]' | cut -c1-500)" || true
  else
    alert "retention-$service" \
      "retention failed in $service: $(tail -n 1 <<<"$out" | tr -cd '[:print:]' | cut -c1-300)"
    failed=1
  fi
done
exit "$failed"
