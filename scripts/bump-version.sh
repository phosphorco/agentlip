#!/usr/bin/env bash
set -euo pipefail

# Cleanup trap for atomic writes
TEMP_FILES=()
cleanup() {
  if [[ ${#TEMP_FILES[@]} -gt 0 ]]; then
    for tmp in "${TEMP_FILES[@]}"; do
      [[ -f "$tmp" ]] && rm -f "$tmp"
    done
  fi
}
trap cleanup EXIT INT TERM

# === Version determination (Craft-compatible) ===
# Priority order:
# 1. CRAFT_NEW_VERSION env var (Craft primary mode)
# 2. Two positional args: old new (Craft backward-compat)
# 3. One positional arg: new (manual mode)
# 4. Otherwise: error

VERSION=""

if [[ -n "${CRAFT_NEW_VERSION:-}" ]]; then
  # Craft env var mode
  VERSION="$CRAFT_NEW_VERSION"
  echo "Using CRAFT_NEW_VERSION: $VERSION"
elif [[ $# -ge 2 ]]; then
  # Craft positional args mode (old new), possibly with extra args.
  # Craft guarantees old/new are the *last two* positional args.
  args=("$@")
  OLD_VERSION="${args[$(( $# - 2 ))]}"
  VERSION="${args[$(( $# - 1 ))]}"
  echo "Using positional args: old=$OLD_VERSION new=$VERSION"
elif [[ $# -eq 1 ]]; then
  # Manual mode
  VERSION="$1"
  echo "Using manual version: $VERSION"
else
  echo "Usage: $0 <new-version>" >&2
  echo "  or:  CRAFT_NEW_VERSION=<version> $0" >&2
  echo "  or:  $0 <old-version> <new-version>" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 0.1.0" >&2
  echo "  CRAFT_NEW_VERSION=0.1.0 $0" >&2
  echo "  $0 0.0.9 0.1.0" >&2
  exit 1
fi

# === Semver validation ===
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver version" >&2
  echo "Expected format: X.Y.Z or X.Y.Z-pre.N" >&2
  echo "Examples: 0.1.0, 1.2.3, 2.0.0-beta.1" >&2
  exit 1
fi

PACKAGES=(protocol kernel workspace client cli hub)

echo ""
echo "Updating workspace packages to version $VERSION..."
echo ""

UPDATED=0
SKIPPED=0

for pkg in "${PACKAGES[@]}"; do
  FILE="packages/$pkg/package.json"
  
  if [[ ! -f "$FILE" ]]; then
    echo "Error: $FILE not found" >&2
    exit 1
  fi
  
  # Check current version for idempotency
  CURRENT_VERSION=$(jq -r '.version' "$FILE")
  
  if [[ "$CURRENT_VERSION" == "$VERSION" ]]; then
    echo "✓ $FILE already at $VERSION (skipped)"
    ((SKIPPED++))
    continue
  fi
  
  # Atomic write: temp file + mv
  TEMP_FILE=$(mktemp "${FILE}.XXXXXX")
  TEMP_FILES+=("$TEMP_FILE")
  
  jq --indent 2 ".version = \"$VERSION\"" "$FILE" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$FILE"
  
  # Remove from cleanup list (successfully moved)
  TEMP_FILES=("${TEMP_FILES[@]/$TEMP_FILE}")
  
  echo "✓ $FILE $CURRENT_VERSION → $VERSION"
  ((UPDATED++))
done

echo ""
echo "Summary: $UPDATED updated, $SKIPPED already at version"
echo "All workspace packages now at version $VERSION"
