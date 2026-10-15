#!/bin/sh
set -eu
# Hosted Slipstream must keep its credential key outside the volume, or a restored
# database can't decrypt the mail-account tokens it holds.
if [ "${SLIPSTREAM_MODE:-team}" = "team" ] && [ -z "${SLIPSTREAM_SECRET:-}" ]; then
  echo "SLIPSTREAM_SECRET is not set. Generate one with: openssl rand -base64 32" >&2
  exit 1
fi
mkdir -p "$SLIPSTREAM_DATA_DIR"

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  # Fresh volume + existing backup: restore before starting.
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$SLIPSTREAM_DATA_DIR/slipstream.db"
  exec litestream replicate -config /etc/litestream.yml -exec "node /app/dist/server.js"
fi
exec node /app/dist/server.js
