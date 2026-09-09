#!/usr/bin/env bash
# Deploy main to server01 under a lock, so two deploys cannot pull into the same checkout at once.
set -euo pipefail
SERVER="${SERVER:-<user@host>}"
ssh -A "$SERVER" 'flock -w 600 /run/lock/solveathome-deploy.lock sh -c "cd /data/services/solveathome && git pull -q origin main && git log --oneline -1 && docker compose -f docker-compose.prod.yml up -d --build 2>&1 | tail -1"'
