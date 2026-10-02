#!/usr/bin/env bash
# Restore an encrypted IRIS dump made by deploy/backup.sh (issue #274).
#
#   RESTORE_TARGET_URL=postgres://iris:...@postgres:5432/iris_restore \
#     ./restore.sh iris-<time>.dump.age --identity backup-identity.txt \
#     --network iris-production_default
#
# Decrypts with `age -d -i <identity>` and pipes the dump into `pg_restore --no-owner
# --no-acl --clean --if-exists --single-transaction` running in a disposable postgres
# container (the image production pins, so the host needs neither client tools nor a
# matching version). One transaction: a failed restore leaves the target as it was.
#
# The target database must exist. The script refuses the serving database (the one
# <deploy dir>/shared/secrets/database_url names, compared by host, port and database)
# unless --force is given. Prints the elapsed time.
#
# Options (or env): --identity (RESTORE_IDENTITY), --target (RESTORE_TARGET_URL;
# prefer the env var, since a command line is visible to every user in `ps`),
# --network (RESTORE_NETWORK, default `host`: the docker network the container joins
# to reach the target), --force. Also DEPLOY_DIR (default /opt/iris-production) and
# RESTORE_IMAGE (default: the postgres image in the compose file next to this script).
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

# host:port/database, for comparing two URLs that may spell credentials differently.
where() {
  local rest=${1#*://}
  rest=${rest##*@}
  rest=${rest%%\?*}
  local hostport=${rest%%/*} db=${rest#*/}
  case "$hostport" in *:*) ;; *) hostport=$hostport:5432 ;; esac
  printf '%s/%s' "${hostport,,}" "$db"
}
serving_file=${DEPLOY_DIR:-/opt/iris-production}/shared/secrets/database_url
if [ -r "$serving_file" ] && [ "$(where "$target")" = "$(where "$(cat "$serving_file")")" ]; then
  [ "$force" = 1 ] || fail "$(where "$target") is the serving database; pass --force to restore over it"
  log "--force: restoring over the serving database $(where "$target")"
fi

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

# Inside the container: the password moves from the URL into PGPASSWORD (percent-
# decoded), so it is on no process's command line. The URL itself arrives by env.
# shellcheck disable=SC2016 # expanded by the container's shell
inner='rest=${TARGET_URL#*://}; scheme=${TARGET_URL%%://*}
case $rest in *@*) userinfo=${rest%@*}; rest=${rest##*@} ;; *) userinfo= ;; esac
case $userinfo in *:*)
  PGPASSWORD=$(printf %s "${userinfo#*:}" | sed "s/\\\\/\\\\\\\\/g; s/%\\([0-9A-Fa-f][0-9A-Fa-f]\\)/\\\\x\\1/g")
  PGPASSWORD=$(printf %b "$PGPASSWORD"); export PGPASSWORD; userinfo=${userinfo%%:*} ;;
esac
unset TARGET_URL
exec pg_restore --no-owner --no-acl --clean --if-exists --single-transaction \
  -d "$scheme://${userinfo:+$userinfo@}$rest"'

log "restoring $file into $(where "$target") with $image"
start=$(date +%s%N)
export TARGET_URL=$target
if ! age -d -i "$identity" "$file" \
  | docker run --rm -i --network "$network" -e TARGET_URL "$image" sh -c "$inner"; then
  log 'restore FAILED; the target is unchanged (one transaction)' >&2
  exit 1
fi
log "restored in $(awk -v ns=$(($(date +%s%N) - start)) 'BEGIN { printf "%.1f", ns / 1e9 }') s"
