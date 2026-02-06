#!/usr/bin/env bash
set -euo pipefail

# Validate args
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.1.0" >&2
  exit 1
fi

VERSION="$1"

# Validate semver format (X.Y.Z, optional pre-release/build metadata)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver version" >&2
  echo "Expected format: X.Y.Z or X.Y.Z-pre.N" >&2
  echo "Examples: 0.1.0, 1.2.3, 2.0.0-beta.1" >&2
  exit 1
fi

PACKAGES=(protocol kernel workspace client cli hub)

echo "Updating version to $VERSION in all packages..."
echo ""

for pkg in "${PACKAGES[@]}"; do
  FILE="packages/$pkg/package.json"
  
  if [[ ! -f "$FILE" ]]; then
    echo "Error: $FILE not found" >&2
    exit 1
  fi
  
  # Update version using jq, preserving formatting
  jq --indent 2 ".version = \"$VERSION\"" "$FILE" > "$FILE.tmp"
  mv "$FILE.tmp" "$FILE"
  
  echo "✓ $FILE → $VERSION"
done

echo ""
echo "All packages updated to version $VERSION"
