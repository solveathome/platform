#!/usr/bin/env bash
# Deploy main to the production host under a lock, so two deploys cannot pull into the same checkout at once.
set -euo pipefail
SERVER="${SERVER:-$(security find-generic-password -s solveathome.org -a SERVER -w 2>/dev/null || true)}"
: "${SERVER:?set SERVER=user@host (or store it: security add-generic-password -s solveathome.org -a SERVER -w user@host)}"
# No agent forwarding: the host pulls the public repo over https. After the build the new container must answer /healthz within a
# minute or the checkout is reset to the previous commit and rebuilt.
ssh "$SERVER" 'flock -w 600 /run/lock/solveathome-deploy.lock sh -c "cd /data/services/solveathome && prev=\$(git rev-parse HEAD) && git pull -q origin main && git log --oneline -1 && bash scripts/deploy-remote.sh \$prev"'
