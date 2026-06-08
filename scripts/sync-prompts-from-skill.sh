#!/usr/bin/env bash
# scripts/sync-prompts-from-skill.sh
#
# The fig-bloom-email-generator skill in dgroch/skills is the *source of truth*
# for the system prompt and user template that drive the email-builder's
# "Create campaign" button. This script mirrors the latest versions into
# my-email-builder/lib/prompts/ so they're bundled with the deployed app.
#
# Usage:
#   ./scripts/sync-prompts-from-skill.sh
#   ./scripts/sync-prompts-from-skill.sh --check   # exit 1 if out of sync (CI-friendly)
#
# Override the skill location with SKILL_DIR=/path/to/dgroch/skills

set -euo pipefail

SKILL_DIR="${SKILL_DIR:-$(cd "$(dirname "$0")/.." && pwd)/../skills/creative/fig-bloom-email-generator}"
TARGET_DIR="$(cd "$(dirname "$0")/.." && pwd)/lib/prompts"

# Discover the actual dgroch/skills path (works whether the script runs from
# /opt/data/workspace/my-email-builder or a fork).
if [ ! -d "$SKILL_DIR" ]; then
  for candidate in \
    "$HOME/workspace/skills/creative/fig-bloom-email-generator" \
    "/opt/data/workspace/skills/creative/fig-bloom-email-generator" \
    "$(cd "$(dirname "$0")/../.." && pwd)/skills/creative/fig-bloom-email-generator"; do
    if [ -d "$candidate" ]; then SKILL_DIR="$candidate"; break; fi
  done
fi

if [ ! -d "$SKILL_DIR" ]; then
  echo "ERROR: skill not found at $SKILL_DIR" >&2
  echo "Set SKILL_DIR=/path/to/dgroch/skills/creative/fig-bloom-email-generator" >&2
  exit 2
fi

mkdir -p "$TARGET_DIR"

FILES=(system-prompt.md user-prompt-template.md)
DRIFT=0
for f in "${FILES[@]}"; do
  src="$SKILL_DIR/references/$f"
  dst="$TARGET_DIR/$f"
  if [ ! -f "$src" ]; then
    echo "ERROR: missing source $src" >&2
    exit 2
  fi
  if [ ! -f "$dst" ] || ! diff -q "$src" "$dst" >/dev/null 2>&1; then
    if [ "${1:-}" = "--check" ]; then
      echo "DRIFT: $f"
      DRIFT=1
    else
      cp "$src" "$dst"
      echo "synced: $f"
    fi
  fi
done

if [ "${1:-}" = "--check" ] && [ "$DRIFT" -ne 0 ]; then
  echo
  echo "lib/prompts/ is out of sync with the skill." >&2
  echo "Run ./scripts/sync-prompts-from-skill.sh" >&2
  exit 1
fi

# Bump the version in SKILL.md? — out of scope here. Do it manually in the skill
# repo when prompts change semantically.
echo "ok"
