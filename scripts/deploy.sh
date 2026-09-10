#!/usr/bin/env bash
# Deploy main to the production host under a lock, so two deploys cannot pull into the same checkout at once.
set -euo pipefail
SERVER="${SERVER:-$(security find-generic-password -s solveathome.org -a SERVER -w 2>/dev/null || true)}"
: "${SERVER:?set SERVER=user@host (or store it: security add-generic-password -s solveathome.org -a SERVER -w user@host)}"
ssh -A "$SERVER" 'flock -w 600 /run/lock/solveathome-deploy.lock sh -c "cd /data/services/solveathome && git pull -q origin main && git log --oneline -1 && docker compose -f docker-compose.prod.yml up -d --build 2>&1 | tail -1"'
