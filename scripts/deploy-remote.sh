#!/usr/bin/env bash
# Runs on the host, from the checkout, after `git pull`: build, start, and prove the new container answers; otherwise roll back.
set -uo pipefail
cd "$(dirname "$0")/.."
prev="${1:?previous commit}"
compose() { docker compose -f docker-compose.prod.yml "$@"; }
get() { compose exec -T backend wget -qO- --header="Accept: $2" "http://localhost:8600$1" 2>/dev/null; }
compose up -d --build 2>&1 | tail -1
ok=0
for i in $(seq 1 30); do
  sleep 2
  get /healthz application/json | grep -q '"ok":true' || continue
  slug=$(get /projects application/json | sed -n 's/.*"slug":"\([a-z0-9-]*\)".*/\1/p' | head -1)
  ok=1
  for path in / "/projects/$slug" "/projects/$slug/board" "/projects/$slug/trust" /terms; do
    get "$path" text/html >/dev/null || { echo "page $path failed"; ok=0; }
  done
  break
done
if [ "$ok" = 1 ]; then echo healthy; exit 0; fi
echo "UNHEALTHY after deploy: rolling back to $prev"
compose logs --tail 30 backend
git reset -q --hard "$prev" && compose up -d --build 2>&1 | tail -1
exit 1
