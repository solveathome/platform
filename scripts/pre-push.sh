#!/usr/bin/env bash
# The check that runs before a push, on your machine. No hosted CI: this repo does not use GitHub Actions.
# Install once:  ln -sf ../../scripts/pre-push.sh .git/hooks/pre-push
set -euo pipefail
cd "$(dirname "$0")/.."
npm run -s check
# Each suite runs once; its summary line is printed and its failure refuses the push.
UNIT=$(npm test 2>&1 || true); echo "$UNIT" | grep -E '^# (pass|fail)' | tr '\n' ' '; echo
if echo "$UNIT" | grep -qE '^# fail [1-9]'; then echo "$UNIT" | grep -E '^not ok' ; echo "unit tests failed; push refused"; exit 1; fi
# DB tests need a Postgres: TEST_DATABASE_URL, or the dev compose one on :5434 (docker compose up -d). Without either the push is refused: the gate is the gate.
DB_URL="${TEST_DATABASE_URL:-postgres://solveathome:solveathome@localhost:5434/solveathome}"
port_open() { if command -v nc >/dev/null 2>&1; then nc -z -w 2 localhost 5434 >/dev/null 2>&1; else node -e "require('net').connect(5434,'localhost').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"; fi; }
if [ -z "${TEST_DATABASE_URL:-}" ] && ! port_open; then echo "no Postgres on :5434 and no TEST_DATABASE_URL; start it (docker compose up -d) and push again"; exit 1; fi
export TEST_DATABASE_URL="$DB_URL" DATABASE_URL="$DB_URL"
DB=$(npm run -s test:db 2>&1 || true); echo "$DB" | grep -E '^# (pass|fail)' | tr '\n' ' '; echo
if echo "$DB" | grep -qE '^# fail [1-9]'; then echo "$DB" | grep -E '^not ok|error:' ; echo "db tests failed; push refused"; exit 1; fi
