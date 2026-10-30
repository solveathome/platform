#!/usr/bin/env bash
# Runs the checks a change could break, picked by scripts/test-select.mjs (Oct 30 2026): the typecheck when TypeScript moved, the
# tests that name a changed file, all DB tests for src/db/, everything for dependencies or tsconfig. A docs or style change runs nothing.
# Usage: npm run test:changed [-- <base>[..<head>] ...]   Without a range: what differs from origin/main, uncommitted work included.
# The pre-push hook passes the pushed ranges. The whole suite is `npm run test:all`, by hand.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
unset $(git rev-parse --local-env-vars) 2>/dev/null || true
[ $# -gt 0 ] || set -- "$(git merge-base origin/main HEAD)"
START=$SECONDS
{ read -r CHECK; read -r UNIT; read -r DB; } < <(node scripts/test-select.mjs "$@")
if [ "$CHECK" = none ] && [ -z "$UNIT" ] && [ -z "$DB" ]; then echo "no checks cover this change"; exit 0; fi
summary() { grep -E '^(#|ℹ) (pass|fail)' <<<"$1" | tr '\n' ' ' || true; echo; }
if [ "$CHECK" = check ]; then echo "typecheck"; npm run -s check || { echo "typecheck failed"; exit 1; }; fi
if [ -n "$UNIT" ]; then
  echo "unit: $UNIT"
  OUT=$(node --import tsx --test $UNIT 2>&1 || true); summary "$OUT"
  if grep -qE '^(#|ℹ) fail [1-9]' <<<"$OUT"; then grep -E '^(not ok|✖)' <<<"$OUT"; echo "unit tests failed"; exit 1; fi
fi
if [ -n "$DB" ]; then
  [ "$DB" = all ] && DB=$(node -e 'console.log(require("./package.json").scripts["test:db"].match(/tests\/[\w.-]+\.test\.mjs/g).join(" "))')
  echo "db: $DB"
  source scripts/test-db-env.sh
  OUT=$(node --import tsx --test --test-concurrency=1 $DB 2>&1 || true); summary "$OUT"
  if grep -qE '^(#|ℹ) fail [1-9]' <<<"$OUT"; then grep -E '^(not ok|✖)|error:' <<<"$OUT"; echo "db tests failed"; exit 1; fi
fi
echo "checks passed in $((SECONDS - START)) s"
