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

# Prerequisite checks
if ! command -v docker &> /dev/null; then
  log_error "Docker is not installed or not in PATH"
  log_error "Install from: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info &> /dev/null; then
  log_error "Docker daemon is not running"
  log_error "Start Docker Desktop or run: sudo systemctl start docker"
  exit 1
fi

# Determine compose command
if docker compose version &> /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
  COMPOSE_CMD="docker-compose"
else
  log_error "docker-compose is not installed"
  log_error "Install from: https://docs.docker.com/compose/install/"
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

# Check if container exists
if ! docker ps -a --format '{{.Names}}' | grep -q '^agentlip-verdaccio$'; then
  log_info "No running or stopped registry found (already clean)"
  # Still exit 0 (idempotent)
  exit 0
fi

# Stop the registry
log_info "Stopping Verdaccio registry..."
if $COMPOSE_CMD down; then
  log_info "Registry stopped successfully"
else
  log_error "Failed to stop registry via Docker Compose"
  exit 2
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
