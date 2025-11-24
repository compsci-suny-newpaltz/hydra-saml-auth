#!/usr/bin/env bash
set -euo pipefail

# Run from repository root: ./dev/normalize-eol.sh
# This will set core.autocrlf=false and renormalize all tracked files to LF.

git_root=$(git rev-parse --show-toplevel)
cd "$git_root"

echo "Setting core.autocrlf=false"
git config core.autocrlf false

echo "Removing files from index (do not worry, files stay on disk)"
git rm --cached -r .

echo "Re-adding files and renormalizing to LF"
git add --renormalize .

# Only commit if there are changes
if git diff --staged --quiet; then
  echo "No changes after renormalization. Nothing to commit."
else
  git commit -m "Normalize line endings to LF"
  echo "Committed line ending normalization."
fi

# Show summary
echo "Git status after normalization:"
git status --porcelain
