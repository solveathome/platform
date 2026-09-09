#!/usr/bin/env bash
# Re-cut the public mirror of the research corpus into solveathome/twin-primes as ONE squashed commit (scope Q11).
# Repeatable: run whenever the research repo moves. History never leaves the private repo.
# Excludes: git internals, agent config, off-limits human notes, attestation tarballs (>100 MB; the .ots/.sha256 stay).
set -euo pipefail
SRC="${1:-<path-to-research-repo>}"
DEST_REPO="${2:-git@github.com:solveathome/twin-primes.git}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rsync -a --delete \
  --exclude '.git' --exclude '.claude' --exclude '.githooks' --exclude '.DS_Store' \
  --exclude 'human_notes_not_for_ai.txt' --exclude 'attestation/*.tar' --exclude 'node_modules' \
  "$SRC/" "$WORK/"

# Belt and braces: the off-limits file must not exist in the mirror.
test ! -e "$WORK/human_notes_not_for_ai.txt"

SRC_SHA="$(git -C "$SRC" rev-parse --short HEAD)"
cat > "$WORK/MIRROR.md" <<MD
# Public mirror

This is a squashed snapshot of the twin-prime research programme (the research corpus), cut from private commit \`$SRC_SHA\` on $(date -u +%Y-%m-%d).
History lives in the private repo. Priority is protected by the OpenTimestamps attestations in \`attestation/\` (bundles themselves are kept offline; the \`.ots\` and \`.sha256\` files here verify them).

Results and text: CC BY 4.0, attribution: solveathome.org and the handles credited on each result. See https://solveathome.org.
MD

# Server copy for the docs browser (deploy keys are disabled on the org; at launch the public repo can be pulled instead).
SERVER="${SERVER:-<user@host>}"
DOCS_DEST="${DOCS_DEST:-/data/services/solveathome/data/repos/twin-primes}"
rsync -a --delete --exclude '.git' "$WORK/" "$SERVER:$DOCS_DEST/" && echo "docs synced to $SERVER:$DOCS_DEST"

cd "$WORK"
git init -q -b main
git add -A
git -c user.name=Benjaminsen -c user.email=chris@moltkebenjaminsen.com commit -q -m "the research corpus mirror: snapshot of private $SRC_SHA ($(date -u +%Y-%m-%d))"
git remote add origin "$DEST_REPO"
git push -q --force origin main
echo "mirrored $SRC_SHA -> $DEST_REPO ($(git ls-files | wc -l | tr -d ' ') files)"
