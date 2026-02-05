#!/usr/bin/env bash
set -euo pipefail

# Rename AgentChat → Agentlip, .zulip → .agentlip
# Safe: only operates on git-tracked text files, never .git/ or node_modules/

cd "$(git rev-parse --show-toplevel)"

DRY_RUN="${1:-}"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "=== DRY RUN MODE ==="
  echo ""
fi

# --- Phase 1: Content replacements ---
# Order matters: longer/more-specific patterns first to avoid partial matches.

REPLACEMENTS=(
  # npm scope (imports, package.json deps)
  '@agentchat/|@agentlip/'
  # daemon name (before shorter "agentchat")
  'agentchatd|agentlipd'
  # PascalCase
  'AgentChat|Agentlip'
  # UPPER_CASE env vars
  'AGENTCHAT|AGENTLIP'
  # lowercase (CLI binary, identifiers, prose) — after daemon and PascalCase
  'agentchat|agentlip'
  # workspace marker directory
  '.zulip|.agentlip'
  # config file references and variable names containing "zulip"
  'zulip\.config|agentlip.config'
  'zulipDir|agentlipDir'
  'isZulipPath|isAgentlipPath'
  'Zulip|Agentlip'
)

# Get list of git-tracked text files (excludes .git/ and untracked files automatically)
# Also exclude node_modules via grep, and skip binary files
get_text_files() {
  git ls-files | grep -v '^node_modules/' | grep -v '\.png$' | grep -v '\.jpg$' | grep -v '\.gif$' | grep -v '\.ico$' | grep -v '\.woff' | grep -v '\.sqlite3$' | grep -v '\.lock$'
}

echo "=== Phase 1: Content replacements ==="

for pair in "${REPLACEMENTS[@]}"; do
  OLD="${pair%%|*}"
  NEW="${pair##*|}"
  
  # Find files containing the old pattern
  MATCHING_FILES=$(get_text_files | xargs grep -l "$OLD" 2>/dev/null || true)
  
  if [[ -z "$MATCHING_FILES" ]]; then
    echo "  '$OLD' → '$NEW': no matches"
    continue
  fi
  
  COUNT=$(echo "$MATCHING_FILES" | wc -l | tr -d ' ')
  
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    echo "  '$OLD' → '$NEW': would change $COUNT files"
  else
    echo "  '$OLD' → '$NEW': changing $COUNT files"
    echo "$MATCHING_FILES" | while read -r f; do
      perl -pi -e "s|\Q${OLD}\E|${NEW}|g" "$f"
    done
  fi
done

# --- Phase 1b: Handle remaining bare "zulip" references in code ---
echo ""
echo "=== Phase 1b: Remaining 'zulip' references ==="

ZULIP_REMAINING=$(get_text_files | xargs grep -li 'zulip' 2>/dev/null || true)
if [[ -n "$ZULIP_REMAINING" ]]; then
  COUNT=$(echo "$ZULIP_REMAINING" | wc -l | tr -d ' ')
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    echo "  Files still containing 'zulip' ($COUNT files)"
  else
    echo "  Replacing remaining 'zulip' → 'agentlip' in $COUNT files"
    echo "$ZULIP_REMAINING" | while read -r f; do
      perl -pi -e 's|zulip|agentlip|g' "$f"
    done
  fi
else
  echo "  No remaining 'zulip' references."
fi

# --- Phase 2: File renames ---
echo ""
echo "=== Phase 2: File renames ==="

FILE_RENAMES=(
  "packages/cli/src/agentchat.ts|packages/cli/src/agentlip.ts"
  "packages/cli/src/agentchat.test.ts|packages/cli/src/agentlip.test.ts"
  "packages/hub/src/agentchatd.ts|packages/hub/src/agentlipd.ts"
  "packages/hub/example.zulip.config.ts|packages/hub/example.agentlip.config.ts"
)

for pair in "${FILE_RENAMES[@]}"; do
  OLD_PATH="${pair%%|*}"
  NEW_PATH="${pair##*|}"
  
  if [[ -f "$OLD_PATH" ]]; then
    if [[ "$DRY_RUN" == "--dry-run" ]]; then
      echo "  Would rename: $OLD_PATH → $NEW_PATH"
    else
      git mv "$OLD_PATH" "$NEW_PATH"
      echo "  Renamed: $OLD_PATH → $NEW_PATH"
    fi
  else
    echo "  Skip (not found): $OLD_PATH"
  fi
done

# --- Phase 3: Update internal references to renamed files ---
echo ""
echo "=== Phase 3: Update references to renamed files ==="

REF_FIXES=(
  'agentchat\.ts|agentlip.ts'
  'agentchat\.test\.ts|agentlip.test.ts'
  'agentchatd\.ts|agentlipd.ts'
  'example\.zulip\.config|example.agentlip.config'
)

for pair in "${REF_FIXES[@]}"; do
  OLD="${pair%%|*}"
  NEW="${pair##*|}"
  
  MATCHING_FILES=$(get_text_files | xargs grep -l "$OLD" 2>/dev/null || true)
  
  if [[ -z "$MATCHING_FILES" ]]; then
    continue
  fi
  
  COUNT=$(echo "$MATCHING_FILES" | wc -l | tr -d ' ')
  
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    echo "  '$OLD' → '$NEW': would fix refs in $COUNT files"
  else
    echo "  '$OLD' → '$NEW': fixing refs in $COUNT files"
    echo "$MATCHING_FILES" | while read -r f; do
      perl -pi -e "s|${OLD}|${NEW}|g" "$f"
    done
  fi
done

echo ""
echo "=== Done ==="

if [[ "$DRY_RUN" != "--dry-run" ]]; then
  echo ""
  echo "Changed files:"
  git diff --stat
fi
