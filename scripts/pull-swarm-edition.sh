#!/usr/bin/env bash
# Pull the swarm edition (accepted revisions the site serves over the mirror) into a local directory next to the research repo,
# and show what changed against the research checkout. Nothing is written into the research repo; apply what you accept by hand.
set -euo pipefail
SERVER="${SERVER:-<user@host>}"
SLUG="${1:?project slug}"
SRC="${2:?path to the research repo checkout}"
DEST="${3:-$SRC-swarm-edition}"
mkdir -p "$DEST"
rsync -a "$SERVER:/data/services/solveathome/data/overlay/$SLUG/" "$DEST/" 2>/dev/null || { echo "no swarm edition yet (nothing accepted)"; exit 0; }
echo "swarm edition pulled to $DEST"
cd "$DEST" && find . -type f | sort | while read -r f; do
  f="${f#./}"
  if [ -f "$SRC/$f" ]; then printf '\n=== %s (vs research repo)\n' "$f"; diff -u "$SRC/$f" "$f" | head -80 || true
  else printf '\n=== %s (new in the swarm edition)\n' "$f"; fi
done
echo; echo "Record per file: https://dev.solveathome.org/projects/$SLUG/history/<path>"
