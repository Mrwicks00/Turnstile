#!/bin/sh
# Railway runs one service = one container = one foreground process. This project is three
# cooperating processes (indexer writes, server reads, Traefik proxies gRPC-web for the
# migration assistant) sharing one container - Railway's free plan doesn't allow a second
# service, so the gRPC-web proxy runs here instead of as its own service (see
# src/server.ts's internal-proxy middleware, which forwards to it on 127.0.0.1:8081).
set -e

(
  while true; do
    # `|| true` is required: under `set -e`, a failing command as a loop *body* statement
    # (not the loop's own condition) still triggers errexit and kills the whole subshell -
    # without this the restart loop would only ever run once, defeating its own purpose.
    node dist/src/main.js || true
    echo "[railway-start] indexer exited, restarting in 5s..." >&2
    sleep 5
  done
) &

(
  while true; do
    ./bin/traefik --configFile=proxy/traefik.yml || true
    echo "[railway-start] traefik exited, restarting in 5s..." >&2
    sleep 5
  done
) &

exec node dist/src/serve.js
