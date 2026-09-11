#!/usr/bin/env bash
# Runs on the host, from the checkout, after `git pull`. Blue/green: build and start the idle slot while the live one keeps serving,
# prove the new container answers, then stop the old one. Caddy reaches whichever slot is up through the shared network alias
# `solveathome-backend`, so a deploy is not an outage, and a build that never answers is stopped without touching the live slot.
set -uo pipefail
cd "$(dirname "$0")/.."
prev="${1:?previous commit}"
compose() { docker compose -f docker-compose.prod.yml "$@"; }
running() { docker ps -q -f "name=^$1$" -f status=running | grep -q .; }
if running solveathome-backend-a; then live=a; target=b; elif running solveathome-backend-b; then live=b; target=a; else live=""; target=a; fi
legacy=""; running solveathome-backend && legacy=solveathome-backend   # the single-slot container from before Sep 11 2026
get() { docker exec "solveathome-backend-$target" wget -qO- --header="Accept: $2" "http://localhost:8600$1" 2>/dev/null; }
if ! compose build "backend-$target" >/tmp/solveathome-build.log 2>&1; then
  echo "BUILD FAILED: backend-${live:-$legacy} keeps serving; the checkout goes back to $prev"; tail -20 /tmp/solveathome-build.log
  git reset -q --hard "$prev"; exit 1
fi
compose up -d --no-deps --no-build "backend-$target" 2>&1 | grep -v "orphan" | tail -1
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
if [ "$ok" = 1 ]; then
  # The old slot drains (SIGTERM: the server stops accepting and finishes what it holds) while new connections already reach the new one.
  [ -n "$live" ] && compose stop "backend-$live" >/dev/null 2>&1
  [ -n "$legacy" ] && docker stop "$legacy" >/dev/null 2>&1 && docker rm "$legacy" >/dev/null 2>&1
  echo "healthy: backend-$target is live${live:+; backend-$live stopped}${legacy:+; the single-slot container was retired}"
  exit 0
fi
echo "UNHEALTHY: backend-$target never answered; backend-${live:-$legacy} kept serving throughout. The checkout goes back to $prev"
docker logs --tail 30 "solveathome-backend-$target" 2>&1
compose stop "backend-$target" >/dev/null 2>&1
git reset -q --hard "$prev"
exit 1
