# Sourced by scripts/test-all.sh and scripts/test-changed.sh: points TEST_DATABASE_URL and DATABASE_URL at a database the tests may write.
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
