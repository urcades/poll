#!/bin/sh
# Starts the app, wrapped in Litestream replication when a replica is configured.
set -e
if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  # On a fresh volume, restore the latest replica before starting.
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DB_PATH"
  exec litestream replicate -config /etc/litestream.yml -exec "node build/index.js"
fi
exec node build/index.js
