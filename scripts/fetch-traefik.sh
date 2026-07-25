#!/bin/sh
# Fetches a static Traefik binary at build time so it can run as a third background
# process inside the single Railway service (Railway's free plan doesn't allow a second
# service, so the gRPC-web proxy for the migration assistant runs alongside the indexer/API
# server here instead of as its own service - see src/server.ts's internal-proxy middleware).
set -e
TRAEFIK_VERSION="v3.1.7"
DEST_DIR="$(dirname "$0")/../bin"
mkdir -p "$DEST_DIR"

if [ -x "$DEST_DIR/traefik" ]; then
  echo "[fetch-traefik] already present, skipping download"
  exit 0
fi

curl -fsSL "https://github.com/traefik/traefik/releases/download/${TRAEFIK_VERSION}/traefik_${TRAEFIK_VERSION}_linux_amd64.tar.gz" -o /tmp/traefik.tar.gz
tar -xzf /tmp/traefik.tar.gz -C "$DEST_DIR" traefik
chmod +x "$DEST_DIR/traefik"
rm /tmp/traefik.tar.gz
echo "[fetch-traefik] installed to $DEST_DIR/traefik"
