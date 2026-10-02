#!/usr/bin/env bash
# Encrypted backup of the production Postgres and the BYOK master key (issue #274).
# Run on the box, as root (the master key is readable by uid 1001 only), daily from
# deploy/systemd/iris-backup.timer:
#
#   DEPLOY_DIR=/opt/iris-production /opt/iris-production/current/backup.sh
#
# 1. `pg_dump -Fc` from the serving release's postgres service (compose run from the
#    real path of <deploy dir>/current), piped through `age -R <recipients>` into a
#    temp file in the backup dir, renamed to iris-<UTC time>.dump.age on success.
# 2. shared/secrets/master_key the same way, as master_key-<UTC time>.age: losing it
#    loses every org's stored provider keys (#344).
# 3. Only then: delete backups older than BACKUP_KEEP_DAYS, never the ones just made.
# 4. BACKUP_RCLONE_REMOTE set: `rclone copy` both new files there. Unset: warn, since
#    the backups then share a disk with the database they back up.
#
# The recipients file holds age public keys only; the identity that decrypts the
# backups is kept off the box. No recipients, no backup: it never writes plaintext.
# Any failure exits non-zero (the systemd unit then fails) and leaves no partial file.
#
# Env: DEPLOY_DIR (default /opt/iris-production), BACKUP_DIR (default
#      $DEPLOY_DIR/backups), BACKUP_RECIPIENTS (default
#      $DEPLOY_DIR/shared/backup-recipients.txt), BACKUP_KEEP_DAYS (default 14),
#      BACKUP_RCLONE_REMOTE (e.g. `offsite:iris-backups`, optional).
set -euo pipefail
umask 077

deploy_dir=${DEPLOY_DIR:-/opt/iris-production}
backup_dir=${BACKUP_DIR:-$deploy_dir/backups}
recipients=${BACKUP_RECIPIENTS:-$deploy_dir/shared/backup-recipients.txt}
keep_days=${BACKUP_KEEP_DAYS:-14}
master_key=$deploy_dir/shared/secrets/master_key

log() { printf 'backup: %s\n' "$*"; }
fail() {
  log "$*" >&2
  exit 1
}

case "$keep_days" in '' | *[!0-9]*) fail "BACKUP_KEEP_DAYS must be a whole number of days" ;; esac
grep -q '^age1' "$recipients" 2>/dev/null \
  || fail "no age recipients in $recipients: refusing to write an unencrypted backup"
[ -L "$deploy_dir/current" ] || fail "$deploy_dir/current does not exist: nothing is serving"
release=$(readlink -f "$deploy_dir/current")
[ -r "$master_key" ] || fail "cannot read $master_key"

install -d -m 700 "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump=$backup_dir/iris-$stamp.dump.age
key=$backup_dir/master_key-$stamp.age
tmp_dump=$dump.tmp
tmp_key=$key.tmp
if [ -e "$dump" ] || [ -e "$key" ]; then fail "a backup named $stamp already exists"; fi
trap 'rm -f -- "$tmp_dump" "$tmp_key"' EXIT

# Commit only a complete, non-empty file: pipefail fails the pipeline if pg_dump does.
(cd "$release" && docker compose exec -T postgres pg_dump -Fc -U iris iris) \
  | age -R "$recipients" -o "$tmp_dump"
[ -s "$tmp_dump" ] || fail 'the encrypted dump is empty'
age -R "$recipients" -o "$tmp_key" "$master_key"
[ -s "$tmp_key" ] || fail 'the encrypted master key is empty'
mv -- "$tmp_dump" "$dump"
mv -- "$tmp_key" "$key"
log "wrote $dump ($(stat -c %s "$dump") bytes) and $key"

# Retention, only now that a new backup exists, and never the files just written.
find "$backup_dir" -maxdepth 1 -type f \( -name 'iris-*.dump.age' -o -name 'master_key-*.age' \) \
  -mmin +$((keep_days * 1440)) ! -name "${dump##*/}" ! -name "${key##*/}" -print -delete \
  | sed 's/^/backup: deleted /'

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$dump" "$BACKUP_RCLONE_REMOTE" || fail "off-box copy to $BACKUP_RCLONE_REMOTE failed"
  rclone copy "$key" "$BACKUP_RCLONE_REMOTE" || fail "off-box copy to $BACKUP_RCLONE_REMOTE failed"
  log "copied both to $BACKUP_RCLONE_REMOTE"
else
  log 'WARNING: BACKUP_RCLONE_REMOTE is unset; the backups are on the same box as the database'
fi
