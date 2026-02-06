#!/usr/bin/env bash
set -euo pipefail

# === publish-local.sh ===
# Publishes all Agentlip workspace packages to a local registry (Verdaccio etc.)
# with safety guardrails to prevent accidental public publishing.
#
# Usage: scripts/publish-local.sh <version> --registry <url>
#
# Safety:
# - Rejects missing --registry flag
# - Rejects non-localhost registries
# - Checks package versions match <version> before publish
# - Publishes in dependency order
#
# Examples:
#   scripts/publish-local.sh 0.1.0 --registry http://localhost:4873
#   scripts/publish-local.sh 0.2.0-beta.1 --registry http://127.0.0.1:4873/

# === Change to repo root ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# === Argument parsing ===
VERSION=""
REGISTRY=""

if [[ $# -lt 3 ]]; then
  echo "Error: Missing required arguments" >&2
  echo "" >&2
  echo "Usage: $0 <version> --registry <url>" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 0.1.0 --registry http://localhost:4873" >&2
  echo "  $0 0.2.0-beta.1 --registry http://127.0.0.1:4873/" >&2
  exit 1
fi

VERSION="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)
      if [[ $# -lt 2 ]]; then
        echo "Error: --registry requires a URL argument" >&2
        exit 1
      fi
      REGISTRY="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      echo "Usage: $0 <version> --registry <url>" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REGISTRY" ]]; then
  echo "Error: --registry flag is required" >&2
  echo "" >&2
  echo "This script requires an explicit registry URL to prevent" >&2
  echo "accidental publishing to npmjs.org." >&2
  echo "" >&2
  echo "Usage: $0 <version> --registry <url>" >&2
  exit 1
fi

# === Semver validation ===
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver version" >&2
  echo "Expected format: X.Y.Z or X.Y.Z-pre.N" >&2
  echo "Examples: 0.1.0, 1.2.3, 2.0.0-beta.1" >&2
  exit 1
fi

# === Localhost-only registry validation ===
# Remove trailing slash for consistent matching
REGISTRY_NORMALIZED="${REGISTRY%/}"

if ! [[ "$REGISTRY_NORMALIZED" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  echo "Error: Registry must be localhost-only" >&2
  echo "" >&2
  echo "For safety, this script only publishes to localhost registries." >&2
  echo "Allowed patterns:" >&2
  echo "  - http://127.0.0.1:<port>" >&2
  echo "  - http://localhost:<port>" >&2
  echo "" >&2
  echo "You provided: $REGISTRY" >&2
  echo "" >&2
  echo "To publish to npmjs.org, use a proper release workflow." >&2
  exit 1
fi

# === Package list in dependency order ===
# protocol → kernel → workspace → (client, cli, hub)
# client depends on protocol + workspace
# cli depends on kernel + workspace (and hub as devDep)
# hub depends on protocol + kernel + workspace
PACKAGES=(protocol kernel workspace client cli hub)

echo ""
echo "Publishing Agentlip packages to $REGISTRY"
echo "Target version: $VERSION"
echo ""

# === Pre-flight: verify all package versions match ===
echo "Pre-flight: verifying package versions..."
MISMATCHES=0

for pkg in "${PACKAGES[@]}"; do
  FILE="packages/$pkg/package.json"
  
  if [[ ! -f "$FILE" ]]; then
    echo "Error: $FILE not found" >&2
    exit 1
  fi
  
  CURRENT_VERSION=$(jq -r '.version' "$FILE")
  
  if [[ "$CURRENT_VERSION" != "$VERSION" ]]; then
    echo "✗ $FILE version is $CURRENT_VERSION (expected $VERSION)" >&2
    ((MISMATCHES++))
  else
    echo "✓ $FILE is at $VERSION"
  fi
done

if [[ $MISMATCHES -gt 0 ]]; then
  echo "" >&2
  echo "Error: $MISMATCHES package(s) have version mismatches" >&2
  echo "Run scripts/bump-version.sh $VERSION to fix versions." >&2
  exit 1
fi

echo ""
echo "All packages verified at version $VERSION"
echo ""

# === Publish each package ===
echo "Publishing packages in dependency order..."
echo ""

PUBLISHED=0
FAILED=0

for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="packages/$pkg"
  
  echo "→ Publishing $pkg..."
  
  # bun publish doesn't need --access public because:
  # - Scoped packages (@agentlip/*) have publishConfig.access = "public" in package.json
  # - Non-scoped (agentlip cli) defaults to public
  if (cd "$PKG_DIR" && bun publish --registry "$REGISTRY" --no-git-checks 2>&1); then
    echo "✓ $pkg published successfully"
    ((PUBLISHED++))
  else
    EXIT_CODE=$?
    echo "✗ $pkg failed to publish (exit code $EXIT_CODE)" >&2
    
    # Check for common auth error
    if [[ $EXIT_CODE -eq 1 ]]; then
      echo "" >&2
      echo "If you see an authentication error, run:" >&2
      echo "  npm adduser --registry $REGISTRY" >&2
      echo "" >&2
    fi
    
    ((FAILED++))
  fi
  
  echo ""
done

# === Summary ===
if [[ $FAILED -eq 0 ]]; then
  echo "✓ Successfully published $PUBLISHED package(s) to $REGISTRY"
  exit 0
else
  echo "✗ Failed to publish $FAILED package(s)" >&2
  exit 1
fi
