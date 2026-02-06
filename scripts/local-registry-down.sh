#!/usr/bin/env bash
# Stop the local Verdaccio registry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="$PROJECT_ROOT/dev/verdaccio"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[registry-down]${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}[registry-down]${NC} $*"
}

log_error() {
  echo -e "${RED}[registry-down]${NC} $*" >&2
}

# Check if docker is available
if ! command -v docker &> /dev/null; then
  log_error "Docker is not installed or not in PATH"
  exit 1
fi

# Determine compose command
if docker compose version &> /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
  COMPOSE_CMD="docker-compose"
else
  log_error "docker-compose is not installed"
  exit 1
fi

# Parse arguments
CLEAN=false
for arg in "$@"; do
  case $arg in
    --clean)
      CLEAN=true
      shift
      ;;
    *)
      log_error "Unknown argument: $arg"
      echo "Usage: $0 [--clean]"
      echo "  --clean    Remove docker volumes (deletes all registry data and users)"
      exit 1
      ;;
  esac
done

cd "$COMPOSE_DIR"

# Stop the registry
log_info "Stopping Verdaccio registry..."
if $COMPOSE_CMD down; then
  log_info "Registry stopped successfully"
else
  log_error "Failed to stop docker-compose"
  exit 1
fi

# Clean volumes if requested
if [ "$CLEAN" = true ]; then
  log_warn "Cleaning volumes (this will delete all registry data and user accounts)..."
  
  # Remove named volumes
  for volume in agentlip-verdaccio-storage agentlip-verdaccio-plugins; do
    if docker volume ls -q | grep -q "^${volume}$"; then
      log_info "Removing volume: $volume"
      docker volume rm "$volume" || log_warn "Failed to remove volume $volume (may not exist)"
    fi
  done
  
  log_info "Cleanup complete"
fi

log_info "Done"
