#!/usr/bin/env bash
# OpenTimestamps attestation of dataset dumps (scope notes: every dump is attested). Runs on the host after the daily dump.
# For each data/dumps/<day>/manifest.json: stamp it if unstamped or if it changed since it was stamped; upgrade pending proofs.
# Writes <day>/attestation.json {file, sha256, stamped_at, upgraded, upgraded_at}. Idempotent.
set -uo pipefail
export PATH="$PATH:/root/.local/bin"
DUMPS="${1:-/data/services/solveathome/data/dumps}"
command -v ots >/dev/null || { echo "ots not installed (pipx install opentimestamps-client)"; exit 1; }
for dir in "$DUMPS"/????-??-??; do
  [ -f "$dir/manifest.json" ] || continue
  cd "$dir" || continue
  sha="$(sha256sum manifest.json | cut -d" " -f1)"
  stamped="$(python3 -c 'import json; print(json.load(open("attestation.json")).get("sha256",""))' 2>/dev/null || true)"
  if [ ! -f manifest.json.ots ] || [ "$sha" != "$stamped" ]; then
    [ -f manifest.json.ots ] && mv manifest.json.ots "manifest.json.$(date -u +%Y%m%dT%H%M%SZ).superseded.ots"
    if ots stamp manifest.json >/dev/null 2>&1; then
      printf '{"file":"manifest.json","sha256":"%s","stamped_at":"%s","upgraded":false,"upgraded_at":null,"verify":"ots verify manifest.json.ots"}\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > attestation.json
      echo "stamped $(basename "$dir")"
    else echo "stamp failed $(basename "$dir")"; fi
  elif ! python3 -c 'import json,sys; sys.exit(0 if json.load(open("attestation.json")).get("upgraded") else 1)' 2>/dev/null; then
    if ots upgrade manifest.json.ots >/dev/null 2>&1; then
      python3 -c 'import json,datetime; a=json.load(open("attestation.json")); a["upgraded"]=True; a["upgraded_at"]=datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"); open("attestation.json","w").write(json.dumps(a)+"\n")'
      echo "upgraded $(basename "$dir")"
    fi
  fi
done
# The app runs as uid 1000 and must be able to rewrite what this root cron touched.
chown -R 1000:1000 "$(dirname "$0")/../data/dumps" 2>/dev/null || true
