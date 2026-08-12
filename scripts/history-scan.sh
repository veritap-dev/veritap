#!/usr/bin/env bash
# Pre-publish secret scan over git HISTORY, not just the working tree.
#
# Exists because the working-tree audit that preceded the first public push
# was structurally incapable of catching what leaked. It grepped `git ls-files`,
# which by construction only sees the current checkout — so it passed while
# eight earlier commits still contained the operator's email in wrangler.jsonc,
# and while the very commit message describing the scrub quoted the address
# verbatim. The repo had to be deleted and recreated.
#
# Scans every blob in every reachable commit AND every commit message.
# Run before any push to a public remote.
set -uo pipefail

PATTERNS='bartonjc2|@gmail\.com|veritap-ops-|BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}'
fail=0

echo "== blobs across all history =="
for sha in $(git rev-list --all); do
  # Exclude this script: its own pattern list necessarily contains every
  # literal it hunts for, so it would flag itself forever. Same reason
  # a3-audit.mjs skips its own file.
  hits=$(git grep -lIE "$PATTERNS" "$sha" -- 2>/dev/null | grep -v 'history-scan\.sh$')
  if [ -n "$hits" ]; then
    echo "  ${sha:0:8}"; echo "$hits" | sed 's/^/      /'
    fail=1
  fi
done
[ "$fail" = "0" ] && echo "  clean"

echo "== commit messages =="
msgfail=0
for sha in $(git rev-list --all); do
  if git log -1 --format='%B' "$sha" | grep -qiE "$PATTERNS"; then
    echo "  ${sha:0:8}  $(git log -1 --format='%s' "$sha" | cut -c1-60)"
    msgfail=1; fail=1
  fi
done
[ "$msgfail" = "0" ] && echo "  clean"

if [ "$fail" != "0" ]; then
  echo
  echo "HISTORY SCAN FAILED — do not push to a public remote."
  echo "Rewrite with: git filter-repo --replace-text <file>  (also rewrites messages)"
  exit 1
fi
echo
echo "History scan clean across $(git rev-list --all | wc -l | tr -d ' ') commits."
