#!/bin/bash
# Container egress firewall (issue #376). Run by the `egress` service of
# docker-compose.production.yml, from the iris image, on the host's network with
# NET_ADMIN (+ NET_RAW for the legacy backend) and nothing else.
#
# Every container of the stack sits on one bridge, IRIS_EGRESS_BRIDGE (deploy.sh finds it
# and writes it into the release's .env). Packets coming in from that bridge, routed
# (DOCKER-USER) or addressed to the host itself (INPUT), go through IRIS-EGRESS-<bridge>:
#   - replies on a connection someone else opened (the ingress to a published port) and
#     DNS (Docker's resolver forwards from inside the container, to the host's resolvers,
#     which may be private) return to the host's own rules;
#   - new connections to the stack's own containers never enter the chain (DOCKER-USER
#     matches `! -o <bridge>`);
#   - everything else to a private, CGNAT, link-local (cloud metadata), loopback,
#     documentation, benchmarking, multicast or reserved IPv4 range is rejected: TCP with
#     a reset, so the deploy probe sees "connection refused" at once, not a timeout.
# Public destinations fall through to the host's rules untouched. The network carries no
# IPv6 (deploy.sh refuses a network with it enabled), so these IPv4 rules are all of it.
#
# The rules stay when this container stops: the firewall fails closed. It applies them,
# then checks every 30 seconds and re-applies whatever went missing (a flush by hand; a
# host reboot restarts this container, `restart: unless-stopped`).
#
#   egress-firewall.sh          apply, then keep them applied
#   egress-firewall.sh check    exit 0 only if every rule is in place (the healthcheck)
set -euo pipefail

log() { printf 'egress-firewall: %s\n' "$*"; }

bridge=${IRIS_EGRESS_BRIDGE:-}
# A Linux interface name: at most 15 characters.
if ! [[ "$bridge" =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; then
  log "IRIS_EGRESS_BRIDGE must name the stack's bridge, not '$bridge'"
  exit 1
fi
chain="IRIS-EGRESS-$bridge"

# IANA's special-purpose IPv4 ranges that are not globally reachable, plus multicast.
denied=(
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15
  198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4
)

# The rules as `iptables` arguments, one per line: the chain's body, then the two jumps.
body() {
  echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  echo "-p udp --dport 53 -j RETURN"
  echo "-p tcp --dport 53 -j RETURN"
  for range in "${denied[@]}"; do
    echo "-d $range -p tcp -j REJECT --reject-with tcp-reset"
    echo "-d $range -j REJECT --reject-with icmp-admin-prohibited"
  done
}
jumps() {
  echo "DOCKER-USER -i $bridge ! -o $bridge -j $chain"
  echo "INPUT -i $bridge -j $chain"
}

# Docker's own backend: the one holding its DOCKER-USER chain.
ipt=''
for candidate in iptables-nft iptables-legacy; do
  if "$candidate" -w -n -L DOCKER-USER >/dev/null 2>&1; then
    ipt=$candidate
    break
  fi
done
if [ -z "$ipt" ]; then
  log "no DOCKER-USER chain in either iptables backend: this needs Docker's iptables firewall"
  exit 1
fi

check() {
  local rule
  while read -r rule; do
    # shellcheck disable=SC2086 # each line is a list of arguments
    "$ipt" -w -C "$chain" $rule 2>/dev/null || return 1
  done < <(body)
  while read -r rule; do
    # shellcheck disable=SC2086
    "$ipt" -w -C $rule 2>/dev/null || return 1
  done < <(jumps)
}

apply() {
  # One transaction: declaring the chain with --noflush empties (or creates) it.
  { echo '*filter'; echo ":$chain - [0:0]"; body | sed "s/^/-A $chain /"; echo COMMIT; } \
    | "$ipt-restore" -w --noflush
  local rule
  while read -r rule; do
    # shellcheck disable=SC2086
    "$ipt" -w -C $rule 2>/dev/null || "$ipt" -w -I ${rule/ / 1 }
  done < <(jumps)
  check
}

if [ "${1:-}" = check ]; then
  check
  exit
fi

apply
log "applied ($ipt): new connections from $bridge to private and reserved ranges are refused"
trap 'exit 0' TERM INT
while :; do
  sleep 30 &
  wait $! || :
  if ! check; then
    apply
    log 're-applied missing rules'
  fi
done
