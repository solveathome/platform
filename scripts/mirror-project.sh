#!/usr/bin/env bash
# Re-cut the public mirror of the research corpus into solveathome/twin-primes as ONE squashed commit (scope Q11).
# Repeatable: run whenever the research repo moves. History never leaves the private repo.
# Publishes a filtered edition: external publications are linked, never mirrored.
set -euo pipefail
SRC="${1:-<path-to-research-repo>}"
DEST_REPO="${2:-git@github.com:solveathome/twin-primes.git}"
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

This is a filtered public edition of the twin-prime research programme, prepared from private commit \`$SRC_SHA\` on $(date -u +%Y-%m-%d). Notes containing source excerpts are replaced with research summaries and external links. Book scans and downloaded publications are excluded.
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
SERVER="${SERVER:-<user@host>}"
DOCS_DEST="${DOCS_DEST:-/data/services/solveathome/data/repos/twin-primes}"
rsync -a --delete --exclude '.git' "$PORTFOLIO/" "$SERVER:$DOCS_DEST/" && echo "docs synced to $SERVER:$DOCS_DEST"
ssh "$SERVER" "cd /data/services/solveathome && docker compose -f docker-compose.prod.yml exec -T backend node dist/scripts/import-papers.js" || echo "paper registry refresh failed (run import-papers on the server)"

cd "$PORTFOLIO"
git init -q -b main
git add -A
git -c user.name=Benjaminsen -c user.email=chris@moltkebenjaminsen.com commit -q -m "the research corpus mirror: snapshot of private $SRC_SHA ($(date -u +%Y-%m-%d))"
git remote add origin "$DEST_REPO"
OLD_HEAD="$(git ls-remote origin refs/heads/main | cut -f1)"
git push -q --force-with-lease="refs/heads/main:$OLD_HEAD" origin main
echo "mirrored $SRC_SHA -> $DEST_REPO ($(git ls-files | wc -l | tr -d ' ') files)"
