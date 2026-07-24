#!/bin/sh
# Railway runs one service = one container = one foreground process. This project is two
# cooperating processes (indexer writes, server reads) sharing one SQLite file on a mounted
# volume - so we background a self-restarting indexer loop and exec the server as the
# foreground process, matching the resilience we've been doing manually in dev (the indexer
# has genuinely crashed on transient network blips before and needs auto-restart).
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

exec node dist/src/serve.js
