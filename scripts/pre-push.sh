#!/usr/bin/env bash
# The check that runs before a push, on your machine. No hosted CI: this repo does not use GitHub Actions.
# Install once:  ln -sf ../../scripts/pre-push.sh .git/hooks/pre-push
set -euo pipefail
cd "$(dirname "$0")/.."
npm run -s check
npm test 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; echo
if npm test 2>&1 | grep -qE '^# fail [1-9]'; then echo "unit tests failed; push refused"; exit 1; fi
# DB tests run when a local Postgres is up (docker compose up -d); skipped otherwise.
if [ -n "${TEST_DATABASE_URL:-}" ] || pg_isready -h localhost -p 5434 >/dev/null 2>&1; then
  export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://solveathome:solveathome@localhost:5434/solveathome}"
  npm run -s test:db 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; echo
fi
