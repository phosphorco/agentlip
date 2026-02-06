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

# Prerequisite checks
if ! command -v curl &> /dev/null; then
  log_error "curl is not installed or not in PATH"
  log_error "Install: apt-get install curl (Linux) or brew install curl (macOS)"
  exit 1
fi

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

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  log_error "docker-compose is not installed"
  log_error "Install from: https://docs.docker.com/compose/install/"
  exit 1
fi

# Determine compose command
if docker compose version &> /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

# Check for port conflict (must happen before docker-compose up)
if lsof -Pi :4873 -sTCP:LISTEN -t >/dev/null 2>&1 || netstat -an 2>/dev/null | grep -q ':4873.*LISTEN'; then
  log_error "Port 4873 is already in use"
  log_error "Check what's using it: lsof -i :4873 (macOS/Linux) or netstat -ano | findstr :4873 (Windows)"
  log_error "To stop an existing registry: $SCRIPT_DIR/local-registry-down.sh"
  exit 1
fi

# Check for existing container (warn if present but not running)
if docker ps -a --format '{{.Names}}' | grep -q '^agentlip-verdaccio$'; then
  if docker ps --format '{{.Names}}' | grep -q '^agentlip-verdaccio$'; then
    log_warn "Container 'agentlip-verdaccio' already exists and is running"
    log_warn "Proceeding will attempt to recreate it..."
  else
    log_warn "Container 'agentlip-verdaccio' exists but is stopped"
    log_warn "Proceeding will start it..."
  fi
fi

cd "$COMPOSE_DIR"

# Start the registry
log_info "Starting Verdaccio registry..."
if $COMPOSE_CMD up -d; then
  log_info "Docker Compose started successfully"
else
  log_error "Failed to start registry via Docker Compose"
  exit 2
fi

# Wait for health check
log_info "Waiting for registry to be healthy (timeout: ${TIMEOUT}s)..."
elapsed=0

while [ $elapsed -lt $TIMEOUT ]; do
  if curl -fsS "$HEALTH_ENDPOINT" > /dev/null 2>&1; then
    log_info "Registry is healthy!"
    echo ""
    # Machine-readable output (safe to grep/parse)
    echo "REGISTRY_URL=$REGISTRY_URL"
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
log_error "The container may be failing to start. Check logs with:"
log_error "  cd $COMPOSE_DIR && $COMPOSE_CMD logs verdaccio"
log_error "Or check container status:"
log_error "  docker ps -a | grep verdaccio"
exit 2
