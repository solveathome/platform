#!/usr/bin/env bash
# The whole suite: typecheck, unit tests, database tests. Run by hand (`npm run test:all`) when a change warrants a wide run
# (docs/testing.md says when); no push or deploy requires it since Oct 10 2026. No hosted CI.
set -euo pipefail
# The tree tested is the checkout you run it in: from a linked worktree, the root comes from git, not from where the script lives.
cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
# Run from a hook, git exports GIT_DIR, GIT_INDEX_FILE and friends; a test that builds a git fixture must never inherit them.
unset $(git rev-parse --local-env-vars) 2>/dev/null || true
npm run -s check
# Each suite runs once; its summary line is printed and its failure fails the run.
UNIT=$(npm test 2>&1 || true); echo "$UNIT" | grep -E '^(#|ℹ) (pass|fail)' | tr '\n' ' '; echo
# A here-string, not `echo | grep -q`: grep -q stops at the first match, echo then dies of SIGPIPE, and under pipefail the whole
# test reads as "no failure" whenever failure details follow the summary line. That let a push with 208 failing DB tests through.
if grep -qE '^(#|ℹ) fail [1-9]' <<<"$UNIT"; then echo "$UNIT" | grep -E '^(not ok|✖)' ; echo "unit tests failed"; exit 1; fi
source scripts/test-db-env.sh
DB=$(npm run -s test:db 2>&1 || true); echo "$DB" | grep -E '^(#|ℹ) (pass|fail)' | tr '\n' ' '; echo
if grep -qE '^(#|ℹ) fail [1-9]' <<<"$DB"; then echo "$DB" | grep -E '^(not ok|✖)|error:' ; echo "db tests failed"; exit 1; fi
