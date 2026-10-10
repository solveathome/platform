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
# DB tests need a Postgres: TEST_DATABASE_URL, or the dev compose one on :5434 (docker compose up -d). Without either the run stops.
DB_URL="${TEST_DATABASE_URL:-postgres://solveathome:solveathome@localhost:5434/solveathome}"
port_open() { if command -v nc >/dev/null 2>&1; then nc -z -w 2 localhost 5434 >/dev/null 2>&1; else node -e "require('net').connect(5434,'localhost').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"; fi; }
if [ -z "${TEST_DATABASE_URL:-}" ] && ! port_open; then echo "no Postgres on :5434 and no TEST_DATABASE_URL; start it (docker compose up -d) or set TEST_DATABASE_URL"; exit 1; fi
# Without TEST_DATABASE_URL each run gets a throwaway database of its own on the dev server, dropped on exit (Sep 29 2026: two runs
# sharing the dev database deadlocked each other's DB tests and a sound push was refused). The name carries the start time, so a run
# that was killed before its trap leaves a database the next run drops once it is six hours old; a younger one may still be running.
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  ADMIN_URL="$DB_URL"
  pgadmin() { node -e 'const {Client}=require("pg");(async()=>{const c=new Client({connectionString:process.argv[1]});await c.connect();try{await c.query(process.argv[2])}finally{await c.end()}})().catch(e=>{console.error(e.message);process.exit(1)})' "$ADMIN_URL" "$1"; }
  node -e 'const {Client}=require("pg");(async()=>{const c=new Client({connectionString:process.argv[1]});await c.connect();try{for(const {datname} of (await c.query("SELECT datname FROM pg_database WHERE datname ~ $1 AND split_part(datname, $2, 2)::bigint < extract(epoch FROM now()) - 21600", ["^prepush_[0-9]+_[0-9]+$", "_"])).rows)await c.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)}finally{await c.end()}})().catch(()=>{})' "$ADMIN_URL" || true
  PREPUSH_DB="prepush_$(date +%s)_$$"
  pgadmin "CREATE DATABASE $PREPUSH_DB"
  trap 'pgadmin "DROP DATABASE IF EXISTS $PREPUSH_DB WITH (FORCE)" || echo "could not drop $PREPUSH_DB; drop it by hand"' EXIT
  trap 'exit 130' INT TERM
  DB_URL="${DB_URL%/*}/$PREPUSH_DB"
fi
export TEST_DATABASE_URL="$DB_URL" DATABASE_URL="$DB_URL"
DB=$(npm run -s test:db 2>&1 || true); echo "$DB" | grep -E '^(#|ℹ) (pass|fail)' | tr '\n' ' '; echo
if grep -qE '^(#|ℹ) fail [1-9]' <<<"$DB"; then echo "$DB" | grep -E '^(not ok|✖)|error:' ; echo "db tests failed"; exit 1; fi
