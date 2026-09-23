#!/usr/bin/env bash
# The check that runs before a push, on your machine. No hosted CI: this repo does not use GitHub Actions.
# Install once:  ln -sf ../../scripts/pre-push.sh .git/hooks/pre-push
set -euo pipefail
# The tree being pushed is the one tested: as a hook in a linked worktree, $0 is the main checkout's copy of this script,
# so the root comes from git, not from where the script lives.
cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
# A hook runs with GIT_DIR, GIT_INDEX_FILE and friends exported; a test that builds a git fixture must never inherit them.
unset $(git rev-parse --local-env-vars) 2>/dev/null || true
# An agent's worktree (Align) carries TEST_DATABASE_URL in its .env, pointed at its own stack's test database: that one, when none is set.
if [ -z "${TEST_DATABASE_URL:-}" ] && [ -f .env ]; then TEST_DATABASE_URL=$(sed -n 's/^TEST_DATABASE_URL=//p' .env | tail -1); if [ -n "$TEST_DATABASE_URL" ]; then export TEST_DATABASE_URL; else unset TEST_DATABASE_URL; fi; fi
case "${TEST_DATABASE_URL:-}" in *@127.0.0.1:1/*) echo "your agent stack is not up (.env points the tests at port 1): run tools/align/stack up (mba repo) and push again"; exit 1;; esac
npm run -s check
# Each suite runs once; its summary line is printed and its failure refuses the push.
UNIT=$(npm test 2>&1 || true); echo "$UNIT" | grep -E '^(#|ℹ) (pass|fail)' | tr '\n' ' '; echo
if echo "$UNIT" | grep -qE '^(#|ℹ) fail [1-9]'; then echo "$UNIT" | grep -E '^(not ok|✖)' ; echo "unit tests failed; push refused"; exit 1; fi
# DB tests need a Postgres: TEST_DATABASE_URL, or the dev compose one on :5434 (docker compose up -d). Without either the push is refused: the gate is the gate.
DB_URL="${TEST_DATABASE_URL:-postgres://solveathome:solveathome@localhost:5434/solveathome}"
port_open() { if command -v nc >/dev/null 2>&1; then nc -z -w 2 localhost 5434 >/dev/null 2>&1; else node -e "require('net').connect(5434,'localhost').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"; fi; }
if [ -z "${TEST_DATABASE_URL:-}" ] && ! port_open; then echo "no Postgres on :5434 and no TEST_DATABASE_URL; start it (docker compose up -d) and push again"; exit 1; fi
export TEST_DATABASE_URL="$DB_URL" DATABASE_URL="$DB_URL"
DB=$(npm run -s test:db 2>&1 || true); echo "$DB" | grep -E '^(#|ℹ) (pass|fail)' | tr '\n' ' '; echo
if echo "$DB" | grep -qE '^(#|ℹ) fail [1-9]'; then echo "$DB" | grep -E '^(not ok|✖)|error:' ; echo "db tests failed; push refused"; exit 1; fi
