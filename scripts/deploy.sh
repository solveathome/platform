#!/usr/bin/env bash
# Deploy main to the production host under a lock, so two deploys cannot pull into the same checkout at once.
set -euo pipefail
SERVER="${SERVER:-$(security find-generic-password -s solveathome.org -a SERVER -w 2>/dev/null || true)}"
: "${SERVER:?set SERVER=user@host (or store it: security add-generic-password -s solveathome.org -a SERVER -w user@host)}"
# No agent forwarding: the host pulls the public repo over https. After the build the new container must answer /healthz within a
# minute or the checkout is reset to the previous commit and rebuilt.
ssh "$SERVER" 'flock -w 600 /run/lock/solveathome-deploy.lock sh -c "
  set -e; cd /data/services/solveathome
  prev=\$(git rev-parse HEAD)
  git pull -q origin main && git log --oneline -1
  docker compose -f docker-compose.prod.yml up -d --build 2>&1 | tail -1
  for i in \$(seq 1 30); do sleep 2; if docker compose -f docker-compose.prod.yml exec -T backend wget -qO- http://localhost:8600/healthz 2>/dev/null | grep -q ok; then
    # The home page, the featured project page and its board must answer 200 too: a per-route 500 is a failed deploy.
    slug=\$(docker compose -f docker-compose.prod.yml exec -T backend wget -qO- --header=Accept:application/json http://localhost:8600/projects 2>/dev/null | sed -n 's/.*\"slug\":\"\([a-z0-9-]*\)\".*/\1/p' | head -1)
    ok=1; for path in / /projects/\$slug /projects/\$slug/board /projects/\$slug/trust /terms; do docker compose -f docker-compose.prod.yml exec -T backend wget -qO- --header=Accept:text/html http://localhost:8600\$path >/dev/null 2>&1 || { echo \"page \$path failed\"; ok=0; }; done
    [ \$ok = 1 ] && { echo healthy; exit 0; }; break
  fi; done
  echo \"UNHEALTHY after deploy: rolling back to \$prev\"; docker compose -f docker-compose.prod.yml logs --tail 30 backend
  git reset -q --hard \$prev && docker compose -f docker-compose.prod.yml up -d --build 2>&1 | tail -1; exit 1"'
