#!/usr/bin/env bash
# Measures a phone reaching a machine directly and through hinacode-relayd, over Docker links
# that netem slows down. Each container adds its delay to every packet it sends, so a round trip
# between two containers costs the sum of their delays.
set -euo pipefail

PHONE_MS=${PHONE_MS:-30}
RELAY_MS=${RELAY_MS:-5}
MACHINE_MS=${MACHINE_MS:-15}
RATE=${RATE:-}
LOSS=${LOSS:-0}
RELAY_IDLE=${RELAY_IDLE:-2}
CONNECTS=${CONNECTS:-30}
ROUTES=${ROUTES:-direct relay}

repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${BENCH_OUT:-$repo/.context/relay-bench}
network=hinacode-relay-bench
image=hinacode-relay-bench
host_id=bench-machine-000000
token=$(openssl rand -hex 32)
mkdir -p "$out"

cleanup() { docker rm -f bench-relay bench-machine bench-phone >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

(cd "$repo/relayd" && CGO_ENABLED=0 go build -o "$out/relayd" .)
(cd "$repo/relayd/bench/client" && CGO_ENABLED=0 go build -o "$out/bench-client" .)
docker build -q -t "$image" "$repo/relayd/bench" >/dev/null
docker network inspect "$network" >/dev/null 2>&1 || docker network create "$network" >/dev/null
if [ ! -f "$out/relay.pem" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=relay \
    -addext subjectAltName=DNS:relay -keyout "$out/relay-key.pem" -out "$out/relay.pem" 2>/dev/null
fi

netem() {
  local args="delay ${2}ms limit 100000"
  [ "$LOSS" != 0 ] && args="$args loss ${LOSS}%"
  [ -n "$RATE" ] && args="$args rate $RATE"
  docker exec "$1" tc qdisc add dev eth0 root netem $args
}

start() {
  docker run -d --name "$1" --hostname "${1#bench-}" --network "$network" --network-alias "${1#bench-}" \
    --cpuset-cpus "$2" --cap-add NET_ADMIN -v "$out:/bench:ro" -v "$repo:/repo:ro" -w /repo "$image" sleep infinity >/dev/null
}

start bench-relay 8,9
start bench-machine 10,11
start bench-phone 6,7
netem bench-relay "$RELAY_MS"
netem bench-machine "$MACHINE_MS"
netem bench-phone "$PHONE_MS"

docker exec -d -e HINACODE_RELAY_TOKEN="$token" bench-relay \
  /bench/relayd -listen :8443 -tls-cert /bench/relay.pem -tls-key /bench/relay-key.pem
docker exec -d -e HINACODE_RELAY_TOKEN="$token" -e RELAY_URL=https://relay:8443 -e RELAY_HOST_ID=$host_id \
  -e RELAY_IDLE="$RELAY_IDLE" -e NODE_EXTRA_CA_CERTS=/bench/relay.pem bench-machine \
  sh -c 'node relayd/bench/machine.ts > /tmp/machine.log 2>&1'

for _ in $(seq 50); do
  docker exec bench-machine grep -q '"connected"' /tmp/machine.log 2>/dev/null && break
  sleep 0.2
done
docker exec bench-machine grep -q '"connected"' /tmp/machine.log || {
  docker exec bench-machine cat /tmp/machine.log
  exit 1
}

bench() { docker exec bench-phone /bench/bench-client -ca /bench/relay.pem -connects "$CONNECTS" "$@"; }
echo "{\"profile\":{\"phoneMs\":$PHONE_MS,\"relayMs\":$RELAY_MS,\"machineMs\":$MACHINE_MS,\"rate\":\"$RATE\",\"loss\":$LOSS,\"idle\":$RELAY_IDLE}}"
for route in $ROUTES; do
  case $route in
    direct) bench -route direct -url ws://machine:9000/remote ;;
    relay) bench -route relay -url "wss://relay:8443/h/$host_id/remote" ;;
  esac
done
if [ -n "${SHOW_CPU:-}" ]; then
  cpu() { docker exec "$1" sh -c "awk '{print \"$2 cpu ms:\", (\$14+\$15)*10}' /proc/\$(pidof $2 | cut -d' ' -f1)/stat"; }
  cpu bench-relay relayd
  cpu bench-machine node
  docker exec bench-machine sh -c 'p=$(pidof node | cut -d" " -f1); awk "{print \"node main thread cpu ms:\", (\$14+\$15)*10}" /proc/$p/task/$p/stat'
fi
