#!/usr/bin/env bash
# Encrypted backup of the production Postgres and the BYOK master key (issue #274).
# Runs on the box as root (the master key is readable by uid 1001 only), daily from
# deploy/systemd/iris-backup.timer, as a root-owned copy the operator installs:
#
#   install -o root -g root -m 0755 deploy/backup.sh /usr/local/sbin/iris-backup
#
# Root never runs or reads as configuration a file the deploy user can write: the
# script is that copy, settings and recipients are in /etc/iris, the backups go to
# /var/backups/iris, and the database is reached by its container's compose labels
# (`docker exec`), not through a release directory's compose file.
#
# 1. `pg_dump -Fc` in the postgres container, piped through `age -R <recipients>` into a
#    temp file, renamed to iris-<UTC time>.dump.age on success.
# 2. shared/secrets/master_key the same way, as master_key-<UTC time>.age: losing it
#    loses every org's stored provider keys (#344).
# 3. Only then, per kind: keep the newest BACKUP_KEEP_MIN files whatever their age (a
#    clock jump cannot empty the directory), delete the rest older than
#    BACKUP_KEEP_DAYS, never the files just written.
# 4. BACKUP_RCLONE_REMOTE set: `rclone copy` every backup in the directory there. It
#    skips files already copied, so a run after a failed copy catches up. Unset: warn,
#    since the backups then share a disk with the database they back up.
#
# The recipients file holds age public keys only; the identity that decrypts the
# backups is kept off the box. No recipients, no backup: it never writes plaintext.
# Any failure exits non-zero (the unit's OnFailure= alerts) and leaves no partial file.
#
# Env: DEPLOY_DIR (default /opt/iris-production; only shared/secrets/master_key is read
#      from it), BACKUP_DIR (default /var/backups/iris), BACKUP_RECIPIENTS (default
#      /etc/iris/backup-recipients.txt), BACKUP_COMPOSE_PROJECT (default
#      iris-production), BACKUP_KEEP_DAYS (default 14, >= 1), BACKUP_KEEP_MIN (default
#      7, >= 1), BACKUP_RCLONE_REMOTE (e.g. `offsite:iris-backups`, optional).
set -euo pipefail
umask 077

log() { printf 'backup: %s\n' "$*"; }
fail() {
  log "$*" >&2
  exit 1
}
# A whole number >= 1, read in base 10 (so 08 is 8, not an octal error).
count() {
  if ! [[ "$2" =~ ^[0-9]+$ ]] || ((10#$2 < 1)); then fail "$1 must be a whole number >= 1, not '$2'"; fi
  printf '%d' "$((10#$2))"
}

master_key=${DEPLOY_DIR:-/opt/iris-production}/shared/secrets/master_key
backup_dir=${BACKUP_DIR:-/var/backups/iris}
recipients=${BACKUP_RECIPIENTS:-/etc/iris/backup-recipients.txt}
project=${BACKUP_COMPOSE_PROJECT:-iris-production}
keep_days=$(count BACKUP_KEEP_DAYS "${BACKUP_KEEP_DAYS:-14}")
keep_min=$(count BACKUP_KEEP_MIN "${BACKUP_KEEP_MIN:-7}")

grep -q '^age1' "$recipients" 2>/dev/null \
  || fail "no age recipients in $recipients: refusing to write an unencrypted backup"
[ -r "$master_key" ] || fail "cannot read $master_key"
container=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.service=postgres)
[ -n "$container" ] || fail "no running postgres container in compose project $project"
[ "$(wc -l <<<"$container")" = 1 ] || fail "more than one postgres container in $project"

install -d -m 700 "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump=$backup_dir/iris-$stamp.dump.age
key=$backup_dir/master_key-$stamp.age
tmp_dump=$dump.tmp
tmp_key=$key.tmp
if [ -e "$dump" ] || [ -e "$key" ]; then fail "a backup named $stamp already exists"; fi
trap 'rm -f -- "$tmp_dump" "$tmp_key"' EXIT

# pipefail: the pipeline, and so the script, fails if pg_dump or age does.
docker exec "$container" pg_dump -Fc -U iris iris | age -R "$recipients" -o "$tmp_dump"
age -R "$recipients" -o "$tmp_key" "$master_key"
mv -- "$tmp_dump" "$dump"
mv -- "$tmp_key" "$key"
log "wrote $dump ($(stat -c %s "$dump") bytes) and $key"

# Retention, only now that a new backup exists. Names sort by time, newest first.
prune() {
  local file n=0
  while IFS= read -r file; do
    n=$((n + 1))
    if [ "$n" -le "$keep_min" ] || [ "$file" = "$dump" ] || [ "$file" = "$key" ]; then continue; fi
    if [ -n "$(find "$file" -maxdepth 0 -mmin +$((keep_days * 1440)))" ]; then
      rm -f -- "$file"
      log "deleted $file"
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type f -name "$1" | sort -r)
}
prune 'iris-*.dump.age'
prune 'master_key-*.age'

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$backup_dir" "$BACKUP_RCLONE_REMOTE" \
    --include 'iris-*.dump.age' --include 'master_key-*.age' \
    || fail "off-box copy to $BACKUP_RCLONE_REMOTE failed (the local backup is kept; the next run retries)"
  log "copied to $BACKUP_RCLONE_REMOTE"
else
  log 'WARNING: BACKUP_RCLONE_REMOTE is unset; the backups are on the same box as the database'
fi
