#!/usr/bin/env bash
# The check that runs before a push, on your machine: the typecheck only, a few seconds. No hosted CI: this repo does not use GitHub Actions.
# Install once:  ln -sf ../../scripts/pre-push.sh .git/hooks/pre-push
# Tests are not swept here (Oct 10 2026): the author runs the tests that cover the change and names them (docs/testing.md);
# the whole suite is `npm run test:all`, by hand, when the change warrants it.
set -euo pipefail
# The tree being pushed is the one checked: as a hook in a linked worktree, $0 is the main checkout's copy of this script,
# so the root comes from git, not from where the script lives.
cd "$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
unset $(git rev-parse --local-env-vars) 2>/dev/null || true
npm run -s check || { echo "typecheck failed; push refused"; exit 1; }
