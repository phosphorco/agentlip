#!/usr/bin/env bash
# Start the local Verdaccio registry and wait for it to be healthy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="$PROJECT_ROOT/dev/verdaccio"
REGISTRY_URL="http://127.0.0.1:4873"
HEALTH_ENDPOINT="$REGISTRY_URL/-/ping"
TIMEOUT=30
POLL_INTERVAL=1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[registry-up]${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}[registry-up]${NC} $*"
}

log_error() {
  echo -e "${RED}[registry-up]${NC} $*" >&2
}

# Check if docker is available
if ! command -v docker &> /dev/null; then
  log_error "Docker is not installed or not in PATH"
  exit 1
fi

if ! docker info &> /dev/null; then
  log_error "Docker daemon is not running"
  exit 1
fi

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  log_error "docker-compose is not installed"
  exit 1
fi

# Determine compose command
if docker compose version &> /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

cd "$COMPOSE_DIR"

# Start the registry
log_info "Starting Verdaccio registry..."
if $COMPOSE_CMD up -d; then
  log_info "Docker Compose started successfully"
else
  log_error "Failed to start docker-compose"
  exit 1
fi

# Wait for health check
log_info "Waiting for registry to be healthy (timeout: ${TIMEOUT}s)..."
elapsed=0

while [ $elapsed -lt $TIMEOUT ]; do
  if curl -fsS "$HEALTH_ENDPOINT" > /dev/null 2>&1; then
    log_info "Registry is healthy!"
    echo ""
    echo "  REGISTRY_URL=$REGISTRY_URL"
    echo ""
    log_info "To configure npm/bun to use this registry:"
    echo "  npm set registry $REGISTRY_URL"
    echo "  # or for scoped packages:"
    echo "  npm config set @agentlip:registry $REGISTRY_URL"
    echo ""
    log_info "To stop the registry:"
    echo "  $SCRIPT_DIR/local-registry-down.sh"
    exit 0
  fi
  
  sleep $POLL_INTERVAL
  elapsed=$((elapsed + POLL_INTERVAL))
  
  if [ $((elapsed % 5)) -eq 0 ]; then
    log_warn "Still waiting... (${elapsed}s / ${TIMEOUT}s)"
  fi
done

# Timeout reached
log_error "Registry failed to become healthy after ${TIMEOUT}s"
log_error "Check logs with: cd $COMPOSE_DIR && $COMPOSE_CMD logs"
exit 1
