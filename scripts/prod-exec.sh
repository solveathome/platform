#!/usr/bin/env bash
# Run a command inside the live backend slot on the host: `bash scripts/prod-exec.sh node dist/scripts/dump.js`.
# Crons and one-off scripts use this instead of a compose service name, because the live slot alternates between backend-a and backend-b.
set -euo pipefail
cd "$(dirname "$0")/.."
for c in solveathome-backend-a solveathome-backend-b solveathome-backend; do
  if docker ps -q -f "name=^$c$" -f status=running | grep -q .; then exec docker exec -i "$c" "$@"; fi
done
echo "prod-exec: no live backend container" >&2; exit 1
