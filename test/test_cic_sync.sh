#!/bin/sh
# cic.sh exists in two places until v0.4.0 deletes the shell implementation:
# the repo root, for the standalone curl download, and the plugin's own
# copy, so the installed plugin cache is self-contained. Nothing enforces
# these stay identical except this check, so it fails loudly on drift
# instead of the two copies silently diverging.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)

if cmp -s "$REPO/cic.sh" "$REPO/plugins/claude-in-chrome/cic.sh"; then
  echo "PASS  cic.sh and plugins/claude-in-chrome/cic.sh are byte-identical"
else
  echo "FAIL  cic.sh and plugins/claude-in-chrome/cic.sh have diverged"
  diff "$REPO/cic.sh" "$REPO/plugins/claude-in-chrome/cic.sh" || true
  exit 1
fi

echo "All checks passed."
