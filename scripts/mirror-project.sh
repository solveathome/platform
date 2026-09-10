#!/usr/bin/env bash
# Re-cut the public mirror of a private research repo into its public project repo as ONE squashed commit (scope Q11).
# Usage: scripts/mirror-project.sh <src repo> <dest git url> [project note]
# Repeatable: run whenever the research repo moves. History never leaves the private repo.
# Publishes a filtered edition: external publications are linked, never mirrored.
set -euo pipefail
SRC="${1:?source repo path}"
DEST_REPO="${2:?destination git url}"
NOTE="${3:-research programme}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PLATFORM_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLATFORM_ROOT"
npm run build
node dist/scripts/prepare-document-portfolio.js "$SRC" "$WORK/portfolio"
PORTFOLIO="$WORK/portfolio"

# Belt and braces: the off-limits file must not exist in the mirror, and no file may mention it or the moratorium.
test ! -e "$PORTFOLIO/human_notes_not_for_ai.txt"
if grep -rIl "human_notes_not_for_ai" "$PORTFOLIO" >/dev/null; then echo "the off-limits file is mentioned in the portfolio:"; grep -rIl "human_notes_not_for_ai" "$PORTFOLIO"; exit 1; fi

SRC_SHA="$(git -C "$SRC" rev-parse --short HEAD)"
cat > "$PORTFOLIO/MIRROR.md" <<MD
# Public mirror

This is a filtered public edition of the ${NOTE}, prepared from private commit \`$SRC_SHA\` on $(date -u +%Y-%m-%d). Notes containing source excerpts are replaced with research summaries and external links. Book scans and downloaded publications are excluded.
History and the unmodified working material stay in the private repo. The OpenTimestamps proofs and hashes in \`attestation/\` refer to private snapshots, not to redistribution rights or authorship.

Project-authored results and text: CC BY 4.0, attribution: solveathome.org and the handles credited on each result. Linked third-party sources retain their own rights. See PUBLICATION-POLICY.md.
MD
# Admit this generated first-party notice to the exact-byte manifest.
node --input-type=module - "$PORTFOLIO" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=process.argv[2], path=root+'/PUBLICATION.json';
const manifest=JSON.parse(readFileSync(path,'utf8'));
manifest.files['MIRROR.md']={sha256:createHash('sha256').update(readFileSync(root+'/MIRROR.md')).digest('hex'),mode:'project'};
writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');
JS

# Server copy for the docs browser (deploy keys are disabled on the org; at launch the public repo can be pulled instead).
SERVER="${SERVER:-$(security find-generic-password -s solveathome.org -a SERVER -w 2>/dev/null || true)}"
: "${SERVER:?set SERVER=user@host (or store it: security add-generic-password -s solveathome.org -a SERVER -w user@host)}"
SLUG="${SLUG:-$(basename "${DEST_REPO%.git}")}"
DOCS_DEST="${DOCS_DEST:-/data/services/solveathome/data/repos/$SLUG}"
rsync -a --delete --exclude '.git' "$PORTFOLIO/" "$SERVER:$DOCS_DEST/" && echo "docs synced to $SERVER:$DOCS_DEST"
# The seed edition: the first cut is copied once and never touched again (Prior Work on the project page links into it).
ssh "$SERVER" "cd /data/services/solveathome && if [ ! -d data/seed/$SLUG ]; then mkdir -p data/seed && cp -a data/repos/$SLUG data/seed/$SLUG && printf '{\"date\":\"%s\",\"note\":\"seed: private %s\"}\n' \"\$(date -u +%Y-%m-%d)\" '$SRC_SHA' > data/seed/$SLUG.json && echo 'seed edition taken'; fi"
ssh "$SERVER" "cd /data/services/solveathome && docker compose -f docker-compose.prod.yml exec -T backend node dist/scripts/import-papers.js" || echo "paper registry refresh failed (run import-papers on the server)"
# Documents the swarm has history on: a cut that caught up drops the overlay; a cut that changed one is recorded as its next version.
ssh "$SERVER" "cd /data/services/solveathome && docker compose -f docker-compose.prod.yml exec -T backend node dist/scripts/reconcile-mirror.js $SLUG 'private $SRC_SHA'" || echo "mirror reconciliation failed (run reconcile-mirror on the server)"

cd "$PORTFOLIO"
git init -q -b main
git add -A
git -c user.name=Benjaminsen -c user.email=chris@lol.dk commit -q -m "mirror: snapshot of private $SRC_SHA ($(date -u +%Y-%m-%d))"
git remote add origin "$DEST_REPO"
OLD_HEAD="$(git ls-remote origin refs/heads/main | cut -f1)"
git push -q --force-with-lease="refs/heads/main:$OLD_HEAD" origin main
echo "mirrored $SRC_SHA -> $DEST_REPO ($(git ls-files | wc -l | tr -d ' ') files)"
