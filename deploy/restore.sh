#!/usr/bin/env bash
# Restore an encrypted IRIS dump made by deploy/backup.sh (issue #274).
#
#   export RESTORE_TARGET_URL=postgres://iris:...@postgres:5432/iris_restore
#   ./restore.sh iris-<time>.dump.age --identity backup-identity.txt \
#     --network iris-production_default
#
# Runs in a disposable container of the postgres image production pins, so the host
# needs neither client tools nor a matching version. In one transaction, it replaces
# the target's `public` schema with the dump's (drop, create, then the dump through
# `pg_restore --no-owner --no-acl`): tables a later release added are gone, and
# `kysely_migration` is the dump's, so the next deploy's migrations apply cleanly. The
# commit is sent only after pg_restore succeeded, so a failed restore is rolled back.
# The file is decrypted once to /dev/null first, so a corrupt or truncated backup
# fails before the target is touched. The target database must exist.
#
# Refuses the serving database unless --force: the one <deploy dir>/shared/secrets/
# database_url names, compared by server identity (pg_control_system()'s
# system_identifier and current_database(), queried on both connections), not by URL
# text, which has many spellings. Without a readable database_url (off the box) it
# cannot check, and also refuses unless --force.
#
# The URLs reach the container as files in a 0700 temp dir mounted read-only, so they
# are on no command line and not in `docker inspect`; inside, the password moves to
# PGPASSWORD. Prefer RESTORE_TARGET_URL to --target: a command line is visible in `ps`.
#
# Options (or env): --identity (RESTORE_IDENTITY), --target (RESTORE_TARGET_URL),
# --network (RESTORE_NETWORK, default `host`: the docker network the container joins
# to reach the databases), --force. Also DEPLOY_DIR (default /opt/iris-production) and
# RESTORE_IMAGE (default: the postgres image in the compose file next to this script).
# Exit: 0 restored, 1 failed (rolled back), 2 refused or bad usage.
set -euo pipefail

log() { printf 'restore: %s\n' "$*"; }
fail() {
  log "$*" >&2
  exit 2
}

file=''
identity=${RESTORE_IDENTITY:-}
target=${RESTORE_TARGET_URL:-}
network=${RESTORE_NETWORK:-host}
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) identity=${2:?--identity needs a file}; shift 2 ;;
    --target) target=${2:?--target needs a URL}; shift 2 ;;
    --network) network=${2:?--network needs a name}; shift 2 ;;
    --force) force=1; shift ;;
    -*) fail "unknown option $1" ;;
    *) [ -z "$file" ] || fail 'one dump file only'; file=$1; shift ;;
  esac
done
[ -n "$file" ] || fail 'usage: restore.sh <dump.age> --identity <file> [--network <name>] [--force] (target in RESTORE_TARGET_URL)'
[ -r "$file" ] || fail "cannot read $file"
[ -r "$identity" ] || fail 'set --identity (or RESTORE_IDENTITY) to the age identity file'
case "$target" in postgres://* | postgresql://*) ;; *) fail 'set RESTORE_TARGET_URL (or --target) to a postgres:// URL' ;; esac

image=${RESTORE_IMAGE:-}
if [ -z "$image" ]; then
  here=$(dirname "$(readlink -f "$0")")
  for compose in "$here/docker-compose.yml" "$here/../docker-compose.production.yml"; do
    [ -r "$compose" ] || continue
    image=$(grep -m1 -oE 'postgres:[0-9A-Za-z._-]+@sha256:[0-9a-f]{64}' "$compose" || :)
    [ -z "$image" ] || break
  done
fi
[ -n "$image" ] || fail 'no pinned postgres image found; set RESTORE_IMAGE'

urls=$(mktemp -d)
trap 'rm -rf -- "$urls"' EXIT
printf '%s' "$target" >"$urls/target"
serving_file=${DEPLOY_DIR:-/opt/iris-production}/shared/secrets/database_url
if [ "$force" = 1 ]; then
  log '--force: not checking whether the target is the serving database'
elif [ -r "$serving_file" ]; then
  cp -- "$serving_file" "$urls/serving"
else
  fail "cannot read $serving_file, so cannot rule out the serving database; pass --force (e.g. off the box)"
fi
chmod -R go-rwx "$urls"

age -d -i "$identity" "$file" >/dev/null || { log "cannot decrypt $file" >&2; exit 1; }

# The container's script. Exit 20: the target is the serving database; 21: could not
# identify a database (psql uses 1-3 itself).
# shellcheck disable=SC2016 # expanded by the container's shell
inner='set -eu -o pipefail
split() { # URL file -> $url without the password, $pw percent-decoded
  u=$(cat "$1"); rest=${u#*://}; scheme=${u%%://*}; pw=
  case $rest in *@*) ui=${rest%@*}; rest=${rest##*@} ;; *) ui= ;; esac
  case $ui in *:*)
    pw=$(printf %s "${ui#*:}" | sed "s/\\\\/\\\\\\\\/g; s/%\\([0-9A-Fa-f][0-9A-Fa-f]\\)/\\\\x\\1/g")
    pw=$(printf %b "$pw"); ui=${ui%%:*} ;;
  esac
  url="$scheme://${ui:+$ui@}$rest"
}
ident() {
  PGPASSWORD=$pw psql -XAtq -d "$url" -c "select system_identifier, current_database() from pg_control_system()"
}
if [ -f /run/restore/serving ]; then
  split /run/restore/serving
  serving=$(ident) || { echo "restore: cannot identify the serving database" >&2; exit 21; }
  split /run/restore/target
  target=$(ident) || { echo "restore: cannot identify the target database" >&2; exit 21; }
  if [ "$target" = "$serving" ]; then
    echo "restore: the target is the serving database (${serving#*|}); pass --force to restore over it" >&2
    exit 20
  fi
fi
split /run/restore/target
export PGPASSWORD="$pw"
{
  echo "begin;"
  echo "drop schema if exists public cascade; create schema public;"
  pg_restore --no-owner --no-acl -f - && echo "commit;"
} | psql -Xq -v ON_ERROR_STOP=1 -d "$url" >/dev/null'

log "restoring $file with $image"
start=$(date +%s%N)
rc=0
age -d -i "$identity" "$file" \
  | docker run --rm -i --network "$network" -v "$urls:/run/restore:ro" "$image" sh -c "$inner" \
  || rc=$?
case "$rc" in
  0) log "restored in $(awk -v ns=$(($(date +%s%N) - start)) 'BEGIN { printf "%.1f", ns / 1e9 }') s" ;;
  20 | 21) log 'refused; nothing was restored' >&2; exit 2 ;;
  *) log 'restore FAILED; the transaction was not committed (check the target before use)' >&2; exit 1 ;;
esac
