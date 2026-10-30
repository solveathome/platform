#!/usr/bin/env bash
# Deploy main to the production host under a lock, so two deploys cannot pull into the same checkout at once.
# Go-live guard and release ledger (mba notes/release-ledger.md): this deploy runs through tools/bin/release-ledger, which
# refuses while the site is go-live pending and records the commit server01 runs afterwards.
L=${MBA_DIR:-$HOME/Files/Git/mba}/tools/bin/release-ledger
if [ -z "${RELEASE_LEDGER_IN:-}" ]; then [ -x "$L" ] && exec "$L" deploy solveathome -- bash "$0" "$@"; echo "release-ledger not found at $L: no go-live guard, no ledger row" >&2; fi
set -euo pipefail
SERVER_ENV=${MBA_DIR:-$HOME/Files/Git/mba}/tools/bin/server-env KEYS=$(cd "$(dirname "$0")/.." && pwd)/server-env
SERVER="${SERVER:-$(security find-generic-password -s solveathome.org -a SERVER -w 2>/dev/null || true)}"
: "${SERVER:?set SERVER=user@host (or store it: security add-generic-password -s solveathome.org -a SERVER -w user@host)}"
# No agent forwarding: the host pulls the public repo over https. After the build the new container must answer /healthz within a
# minute or the checkout is reset to the previous commit and rebuilt.
# Keys (mba rule #r2109): the env file on server01 is written from the Keychain, this service's keys only (server-env/;
# a changed live value is refused unless SERVER_ENV_ACCEPT names it)
# the app logs in as solveathome_app, without superuser, its password Keychain solveathome.org/APP_DB_PASSWORD (made there first)
"${MBA_DIR:-$HOME/Files/Git/mba}/tools/bin/pg-app-role" solveathome-postgres solveathome solveathome solveathome_app solveathome.org
"$SERVER_ENV" write "$KEYS/env.keys"
ssh "$SERVER" 'flock -w 600 /run/lock/solveathome-deploy.lock sh -c "cd /data/services/solveathome && prev=\$(git rev-parse HEAD) && git pull -q origin main && git log --oneline -1 && bash scripts/deploy-remote.sh \$prev"'
