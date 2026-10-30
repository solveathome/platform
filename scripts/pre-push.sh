#!/usr/bin/env bash
# The check that runs before a push, on your machine. No hosted CI: this repo does not use GitHub Actions.
# Install once:  ln -sf ../../scripts/pre-push.sh .git/hooks/pre-push
# It runs only what the pushed commits could break (Oct 30 2026, scripts/test-changed.sh): nothing for docs or styles, the typecheck
# and the tests that name a changed file otherwise. The whole suite is `npm run test:all`, by hand, when the change warrants it.
set -euo pipefail
# The tree being pushed is the one checked: as a hook in a linked worktree, $0 is the main checkout's copy of this script,
# so the root comes from git, not from where the script lives.
cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
unset $(git rev-parse --local-env-vars) 2>/dev/null || true
# A branch cut before the selector existed keeps the old gate, the typecheck.
[ -f scripts/test-select.mjs ] || { npm run -s check || { echo "typecheck failed; push refused"; exit 1; }; exit 0; }
# git gives one line per pushed ref: <local ref> <local sha> <remote ref> <remote sha>. A new branch is compared with origin/main.
ZERO=0000000000000000000000000000000000000000
RANGES=()
while read -r _ LOCAL _ REMOTE; do
  [ "$LOCAL" = "$ZERO" ] && continue
  if [ "$REMOTE" = "$ZERO" ] || ! git cat-file -e "$REMOTE" 2>/dev/null; then REMOTE=$(git merge-base origin/main "$LOCAL"); fi
  RANGES+=("$REMOTE..$LOCAL")
done
[ ${#RANGES[@]} -gt 0 ] || exit 0
bash scripts/test-changed.sh "${RANGES[@]}" || { echo "push refused"; exit 1; }
