#!/usr/bin/env bash
set -euo pipefail

# === smoke-install-from-registry.sh ===
# Installs @agentlip/client from a local registry into a temp project
# and verifies that imports work correctly.
#
# Usage: scripts/smoke-install-from-registry.sh <version> --registry <url>
#
# Safety:
# - Rejects missing --registry flag
# - Rejects non-localhost registries
# - Cleans up temp directory on exit (even on failure)
#
# Examples:
#   scripts/smoke-install-from-registry.sh 0.1.0 --registry http://localhost:4873
#   scripts/smoke-install-from-registry.sh 0.2.0-beta.1 --registry http://127.0.0.1:4873/

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
  echo "accidental installation from npmjs.org." >&2
  echo "" >&2
  echo "Usage: $0 <version> --registry <url>" >&2
  exit 1
fi

# === Localhost-only registry validation ===
# Remove trailing slash for consistent matching
REGISTRY_NORMALIZED="${REGISTRY%/}"

if ! [[ "$REGISTRY_NORMALIZED" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]]; then
  echo "Error: Registry must be localhost-only" >&2
  echo "" >&2
  echo "For safety, this script only installs from localhost registries." >&2
  echo "Allowed patterns:" >&2
  echo "  - http://127.0.0.1:<port>" >&2
  echo "  - http://localhost:<port>" >&2
  echo "" >&2
  echo "You provided: $REGISTRY" >&2
  exit 1
fi

# === Create temp directory ===
TEMP_DIR=$(mktemp -d -t agentlip-smoke-XXXXXX)

# Clean up on exit (even on failure)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo ""
echo "Smoke testing @agentlip/client@$VERSION from $REGISTRY"
echo "Temp directory: $TEMP_DIR"
echo ""

cd "$TEMP_DIR"

# === Initialize Bun project ===
echo "→ Initializing Bun project..."
if ! bun init -y > /dev/null 2>&1; then
  echo "✗ Failed to initialize Bun project in $TEMP_DIR" >&2
  exit 1
fi

# === Install @agentlip/client ===
echo "→ Installing @agentlip/client@$VERSION..."

# Use --registry flag to scope registry to this command only
# (avoids mutating global npm/bun config)
if bun add "@agentlip/client@$VERSION" --registry "$REGISTRY" 2>&1; then
  :
else
  EXIT_CODE=$?
  echo "" >&2
  echo "✗ Failed to install @agentlip/client@$VERSION from $REGISTRY" >&2
  echo "" >&2
  echo "Temp directory was: $TEMP_DIR (it will be cleaned up on exit)" >&2
  echo "Check that:" >&2
  echo "  1. The local registry is running" >&2
  echo "  2. @agentlip/client@$VERSION is published to the registry" >&2
  echo "  3. You have run: npm adduser --registry $REGISTRY" >&2
  exit $EXIT_CODE
fi

# === Verify imports ===
echo "→ Verifying TypeScript imports..."

# Create a quick TypeScript test file
cat > verify-import.ts <<'EOF'
import { createChannel } from "@agentlip/client";

// Verify the import is a function
if (typeof createChannel !== "function") {
  console.error("Error: createChannel is not a function");
  process.exit(1);
}

console.log("✓ Import verified: createChannel is a function");
EOF

# Run the verification
if ! bun run verify-import.ts; then
  echo "" >&2
  echo "✗ Import verification failed" >&2
  echo "Temp directory was: $TEMP_DIR (it will be cleaned up on exit)" >&2
  exit 1
fi

echo ""
echo "✓ Smoke test passed: @agentlip/client@$VERSION works correctly"
echo ""

# Cleanup happens via trap EXIT
exit 0
