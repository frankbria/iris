#!/usr/bin/env bash
# IRIS production watchdog (issue #275). Runs every minute from
# deploy/systemd/iris-watchdog.timer, as root, as a root-owned copy the operator installs
# (like the backup, #274: root never runs a file the deploy user can write):
#
#   install -o root -g root -m 0755 deploy/watchdog.sh /usr/local/sbin/iris-watchdog
#
# Containers are found by their compose labels (project WATCHDOG_COMPOSE_PROJECT), never
# through a release directory. Each run:
#
# 1. Restarts every container Docker reports `unhealthy`. Docker itself never does:
#    `restart: unless-stopped` acts on an exit, not on a failing healthcheck. At most
#    WATCHDOG_MAX_RESTARTS per service per hour; past that it alerts and leaves the
#    container alone (a restart loop hides the cause and still serves nothing).
# 2. Alerts when Docker restarted a container on its own (it exited: a crash, an OOM kill).
# 3. Scrapes each WATCHDOG_METRICS target (`service:port`) inside its container with
#    `docker exec ... node`, since the metrics listener binds the container's loopback
#    and no port is published. A failed scrape alerts: it is the uptime signal.
# 4. From the scraped counters, error / (ok + error) of requests (iris_requests_total)
#    or jobs (iris_jobs_total, `finished` for ok) over the last WATCHDOG_ERROR_WINDOW
#    seconds; client errors and rate-limited requests count in neither part. At or above
#    WATCHDOG_ERROR_PERCENT with at least WATCHDOG_MIN_REQUESTS (ok + error) in the
#    window, it alerts. Samples are kept in the state directory between runs; a new
#    iris_start_time_seconds or counters below the latest sample (the process restarted)
#    start the window again. Times after now (the clock stepped back) are dropped.
#
# An alert is a critical journal entry (`logger -p crit -t iris-watchdog`) plus the
# operator's hook, if WATCHDOG_ALERT_HOOK is executable: `<hook> <key> <message>`, where
# key names the condition (e.g. `error-rate-iris`). A condition that stays true alerts
# again only after WATCHDOG_ALERT_REPEAT seconds; once it clears, the next one alerts at
# once. Restarts always alert.
#
# Env: WATCHDOG_COMPOSE_PROJECT (default iris-production), WATCHDOG_STATE_DIR (default
#      /var/lib/iris-watchdog), WATCHDOG_ALERT_HOOK (default /etc/iris/alert-hook),
#      WATCHDOG_METRICS (default "iris:9464 worker:9465"; empty: no scrapes),
#      WATCHDOG_MAX_RESTARTS (3), WATCHDOG_ERROR_WINDOW (300), WATCHDOG_ERROR_PERCENT (5),
#      WATCHDOG_MIN_REQUESTS (20), WATCHDOG_ALERT_REPEAT (3600, 0 = every run).
set -euo pipefail
umask 077

log() { printf 'watchdog: %s\n' "$*"; }
fail() {
  log "$*" >&2
  exit 1
}
# A whole number >= $3, read in base 10 (so 08 is 8, not an octal error).
number() {
  if ! [[ "$2" =~ ^[0-9]+$ ]] || ((10#$2 < $3)); then fail "$1 must be a whole number >= $3, not '$2'"; fi
  printf '%d' "$((10#$2))"
}

project=${WATCHDOG_COMPOSE_PROJECT:-iris-production}
state=${WATCHDOG_STATE_DIR:-/var/lib/iris-watchdog}
hook=${WATCHDOG_ALERT_HOOK:-/etc/iris/alert-hook}
targets=${WATCHDOG_METRICS-iris:9464 worker:9465}
max_restarts=$(number WATCHDOG_MAX_RESTARTS "${WATCHDOG_MAX_RESTARTS:-3}" 1)
window=$(number WATCHDOG_ERROR_WINDOW "${WATCHDOG_ERROR_WINDOW:-300}" 1)
percent=$(number WATCHDOG_ERROR_PERCENT "${WATCHDOG_ERROR_PERCENT:-5}" 1)
min_requests=$(number WATCHDOG_MIN_REQUESTS "${WATCHDOG_MIN_REQUESTS:-20}" 1)
repeat=$(number WATCHDOG_ALERT_REPEAT "${WATCHDOG_ALERT_REPEAT:-3600}" 0)
for target in $targets; do
  [[ "$target" =~ ^[A-Za-z0-9_.-]+:[0-9]+$ ]] || fail "WATCHDOG_METRICS entries are service:port, not '$target'"
done

install -d -m 700 "$state"
now=$(date +%s)

# alert <key> <message> [always]: journal + hook, at most once per $repeat s per key.
# The message can carry container text (a label, a scrape error): it goes out as one
# line of printable characters, at most 300.
alert() {
  local key=${1//[^A-Za-z0-9_.-]/_} msg stamp age
  msg=$(printf '%s' "$2" | tr '\n\r\t' '   ' | LC_ALL=C tr -cd '[:print:]' | cut -c1-300)
  stamp=$state/alert.$key
  age=$((now - $(stat -c %Y "$stamp" 2>/dev/null || echo 0)))
  # A stamp from the future (the clock stepped back) holds nothing back.
  if [ -z "${3:-}" ] && [ -e "$stamp" ] && ((age >= 0 && age < repeat)); then
    log "still: $msg"
    return 0
  fi
  touch "$stamp"
  log "ALERT: $msg"
  logger -p crit -t iris-watchdog -- "IRIS ALERT: $msg" || log 'could not write the journal entry'
  if [ -x "$hook" ]; then
    timeout 60 "$hook" "$key" "$msg" || log "alert hook failed (exit $?)"
  fi
}
# The condition is over: its next occurrence alerts at once.
resolved() { rm -f -- "$state/alert.${1//[^A-Za-z0-9_.-]/_}"; }

docker info >/dev/null 2>&1 || {
  alert docker "the Docker daemon does not answer: no container is watched"
  exit 1
}
resolved docker

project_filter=(--filter "label=com.docker.compose.project=$project")
service_of() { docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$1"; }

# 1. Unhealthy containers: restart, within the hourly cap. Times after now (a clock that
# stepped back) are dropped, not counted for an hour of skew.
unhealthy=' '
for cid in $(docker ps -q "${project_filter[@]}" --filter health=unhealthy); do
  # Gone since `ps` (removed, recreated by a deploy): nothing to restart.
  svc=$(service_of "$cid") || continue
  unhealthy+="$svc "
  file=$state/restarts.${svc//[^A-Za-z0-9_.-]/_}
  if [ -f "$file" ]; then
    awk -v t=$((now - 3600)) -v now="$now" '$1 > t && $1 <= now' "$file" >"$file.tmp"
  else : >"$file.tmp"; fi
  mv -- "$file.tmp" "$file"
  n=$(wc -l <"$file")
  if ((n >= max_restarts)); then
    alert "restart-cap-$svc" "$svc ($cid) is unhealthy; restarted $n times in the last hour already, so not again: investigate"
  elif docker restart --time 30 "$cid" >/dev/null; then
    echo "$now" >>"$file"
    alert "restarted-$svc" "$svc ($cid) was unhealthy: restarted ($((n + 1))/$max_restarts this hour)" always
  else
    alert "restart-failed-$svc" "$svc ($cid) is unhealthy and could not be restarted"
  fi
done
# A service healthy again: its failed-restart and cap alerts are over.
for stamp in "$state"/alert.restart-failed-* "$state"/alert.restart-cap-*; do
  [ -e "$stamp" ] || continue
  svc=${stamp#"$state"/alert.restart-failed-}
  svc=${svc#"$state"/alert.restart-cap-}
  [[ "$unhealthy" == *" $svc "* ]] || rm -f -- "$stamp"
done

# 2. Restarts Docker made itself: the restart count went up since the last run.
counts=$state/restart-counts
docker ps -aq "${project_filter[@]}" | while read -r cid; do
  # || : a container removed since `ps` is simply gone.
  docker inspect -f '{{.Id}} {{.RestartCount}} {{index .Config.Labels "com.docker.compose.service"}}' "$cid" || :
done >"$counts.new"
while read -r id count svc; do
  old=$(awk -v id="$id" '$1 == id { print $2 }' "$counts" 2>/dev/null || :)
  if [ -n "$old" ] && ((count > old)); then
    alert "exited-$svc" "$svc (${id:0:12}) exited and Docker restarted it (restart count $old -> $count)" always
  fi
done <"$counts.new"
mv -- "$counts.new" "$counts"

# 3 and 4. Scrape each target; error rate over the window.
# shellcheck disable=SC2016 # JavaScript, not shell: nothing to expand.
scrape='fetch("http://127.0.0.1:" + process.argv[1] + "/metrics", { signal: AbortSignal.timeout(10000) })
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
  .then((t) => process.stdout.write(t), (e) => { console.error(e.message); process.exit(1); })'
for target in $targets; do
  svc=${target%%:*}
  port=${target##*:}
  cid=$(docker ps -q "${project_filter[@]}" --filter "label=com.docker.compose.service=$svc" | head -n 1)
  if [ -z "$cid" ]; then
    alert "scrape-$svc" "no running $svc container in $project: metrics scrape failed"
    continue
  fi
  if ! text=$(timeout 30 docker exec "$cid" node -e "$scrape" "$port" 2>&1); then
    alert "scrape-$svc" "metrics scrape of $svc failed: ${text:0:200}"
    continue
  fi
  resolved "scrape-$svc"

  # Server-side answers only: ok (or a finished job) and error. Client errors and
  # rate-limited requests are tenant-caused, so a tenant cannot raise the rate, nor
  # dilute it, by sending bad requests.
  read -r total errors start < <(awk '
    /^iris_(requests|jobs)_total[{ ]/ {
      if ($0 ~ /outcome="error"/) e += $NF; else if ($0 ~ /outcome="(ok|finished)"/) o += $NF }
    /^iris_start_time_seconds / { s = $NF }
    END { printf "%d %d %s\n", o + e, e, (s == "" ? "-" : s) }' <<<"$text")
  file=$state/rate.${svc//[^A-Za-z0-9_.-]/_}
  if [ -f "$file" ]; then
    awk -v t=$((now - window)) -v now="$now" '$1 >= t && $1 <= now' "$file" >"$file.tmp"
  else : >"$file.tmp"; fi
  t0='' total0=0 errors0=0
  read -r t0 total0 errors0 _ <"$file.tmp" || :
  # The process restarted (a new start time, or counters below the latest sample): its
  # counters began again, so the window does too.
  read -r _ last_total last_errors last_start < <(tail -n 1 "$file.tmp") || :
  if [ -n "$t0" ] && { [ "$start" != "$last_start" ] || ((total < last_total || errors < last_errors)); }; then
    : >"$file.tmp"
    t0=''
  fi
  echo "$now $total $errors $start" >>"$file.tmp"
  mv -- "$file.tmp" "$file"
  [ -n "$t0" ] || continue
  requests=$((total - total0))
  failed=$((errors - errors0))
  if ((requests >= min_requests && failed * 100 >= percent * requests)); then
    alert "error-rate-$svc" "$svc: $failed of $requests requests or jobs ended in error in the last $((now - t0))s (threshold $percent%)"
  else
    resolved "error-rate-$svc"
  fi
done
log "checked project $project"
