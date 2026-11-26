#!/bin/bash
# Container egress firewall (issue #376). Run by the `egress` service of
# docker-compose.production.yml, from the iris image, on the host's network with
# NET_ADMIN (+ NET_RAW for the legacy backend) and nothing else.
#
# Every container of the stack sits on one bridge, IRIS_EGRESS_BRIDGE (deploy.sh finds it
# and writes it into the release's .env). Packets coming in from that bridge, routed
# (DOCKER-USER) or addressed to the host itself (INPUT), go through IRIS-EGRESS-<bridge>:
#   - replies on a connection someone else opened (the ingress to a published port)
#     return to the host's own rules, and so does DNS to the host's own resolvers: Docker's
#     resolver forwards to a non-loopback nameserver from inside the container, and that
#     may be a private address (a loopback one it reaches from the host's namespace);
#   - so do the two globally reachable anycast addresses inside 192.0.0.0/24 (PCP, TURN);
#   - new connections to the stack's own containers never enter the chain (DOCKER-USER
#     matches `! -o <bridge>`);
#   - everything else to a private, CGNAT, link-local (cloud metadata), loopback,
#     documentation, benchmarking, multicast or reserved IPv4 range is rejected: TCP with
#     a reset, so the deploy probe sees "connection refused" at once, not a timeout.
# Public destinations fall through to the host's rules untouched. The network carries no
# IPv6 (deploy.sh refuses a network with it enabled), so these IPv4 rules are all of it.
#
# Both jumps must be the first rule of their chain: a firewall manager (ufw) that puts its
# own ACCEPTs above them would let traffic past. The check fails then, and the repair moves
# them back to the top.
#
# The rules stay when this container stops: the firewall fails closed. It applies them,
# then checks every 30 seconds and re-applies whatever went missing or moved (a flush by
# hand, ufw reloading; a host reboot restarts this container, `restart: unless-stopped`).
# They go into every iptables backend that holds Docker's DOCKER-USER chain.
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

# The host's nameservers: in host network mode this file is the host's own.
mapfile -t resolvers < <(awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $2 !~ /^127\./ { print $2 }' /etc/resolv.conf)

# The rules as `iptables` arguments, one per line: the chain's body, then the two jumps.
body() {
  echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  local resolver
  for resolver in "${resolvers[@]}"; do
    echo "-d $resolver/32 -p udp --dport 53 -j RETURN"
    echo "-d $resolver/32 -p tcp --dport 53 -j RETURN"
  done
  echo "-d 192.0.0.9/32 -j RETURN"
  echo "-d 192.0.0.10/32 -j RETURN"
  for range in "${denied[@]}"; do
    echo "-d $range -p tcp -j REJECT --reject-with tcp-reset"
    echo "-d $range -j REJECT --reject-with icmp-admin-prohibited"
  done
}
jumps() {
  echo "DOCKER-USER -i $bridge ! -o $bridge -j $chain"
  echo "INPUT -i $bridge -j $chain"
}

# Docker's backend: whichever holds its DOCKER-USER chain (both, after a migration).
backends=()
for candidate in iptables-nft iptables-legacy; do
  if "$candidate" -w -n -L DOCKER-USER >/dev/null 2>&1; then backends+=("$candidate"); fi
done
if [ "${#backends[@]}" = 0 ]; then
  log "no DOCKER-USER chain in either iptables backend: this needs Docker's iptables firewall"
  exit 1
fi

check() {
  local ipt rule
  for ipt in "${backends[@]}"; do
    while read -r rule; do
      # shellcheck disable=SC2086 # each line is a list of arguments
      "$ipt" -w -C "$chain" $rule 2>/dev/null || return 1
    done < <(body)
    while read -r rule; do
      # First in its chain: `-S` lists the policy line, then the rules in order.
      [ "$("$ipt" -w -S "${rule%% *}" 2>/dev/null | sed -n 2p)" = "-A $rule" ] || return 1
    done < <(jumps)
  done
}

apply() {
  local ipt rule
  for ipt in "${backends[@]}"; do
    # One transaction: declaring the chain with --noflush empties (or creates) it.
    { echo '*filter'; echo ":$chain - [0:0]"; body | sed "s/^/-A $chain /"; echo COMMIT; } \
      | "$ipt-restore" -w --noflush
    while read -r rule; do
      # shellcheck disable=SC2086
      while "$ipt" -w -D $rule 2>/dev/null; do :; done
      # shellcheck disable=SC2086
      "$ipt" -w -I ${rule/ / 1 }
    done < <(jumps)
  done
  check
}

if [ "${1:-}" = check ]; then
  check
  exit
fi

apply
log "applied (${backends[*]}): new connections from $bridge to private and reserved ranges are refused"
trap 'exit 0' TERM INT
while :; do
  sleep 30 &
  wait $! || :
  if ! check; then
    apply
    log 're-applied missing rules'
  fi
done
