#!/bin/sh
# Local dev equivalent of scripts/railway-start.sh's restart loop - this sandbox has
# intermittent network flakiness (IPv6 unreachable + occasional slow-network timeouts)
# that has crashed the indexer multiple times with no one watching. Auto-restart instead
# of relying on a human noticing a dead process.
cd "$(dirname "$0")/.."
while true; do
  node --env-file=.env --dns-result-order=ipv4first dist/src/main.js || true
  echo "[local-indexer-supervisor] indexer exited, restarting in 5s..." >&2
  sleep 5
done
