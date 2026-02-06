# Agentlip Local Hub

Local-first coordination hub for AI agents. SQLite-backed, single-machine, localhost-only.

Agents and humans share channels/topics/messages through a durable event stream with replay, and plugins can enrich content asynchronously.

## Quick Start

```bash
bun install
bun test              # ~24s
bun run typecheck     # tsc --noEmit
```

## Packages

| Package | Purpose |
|---------|---------|
| `@agentlip/kernel` | SQLite schema, migrations, events, queries, mutations |
| `@agentlip/hub` | Bun HTTP+WS server, plugin runtime, UI |
| `agentlip` | Stateless CLI — reads DB, writes via hub |
| `@agentlip/client` | TypeScript SDK — discovery, WS streaming, typed events, HTTP mutations |
| `@agentlip/protocol` | Shared types (error codes, health response, protocol version) |
| `@agentlip/workspace` | Workspace discovery (`.agentlip/` upward walk with security boundary) |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  .agentlip/db.sqlite3  (WAL mode, single writer)        │
│  .agentlip/server.json (port, auth token, mode 0600)    │
│  .agentlip/locks/writer.lock                             │
└──────────┬───────────────────────────┬───────────────┘
           │                           │
    ┌──────┴──────┐             ┌──────┴──────┐
    │  Hub (Bun)  │◄── WS ────►│   Clients   │
    │  HTTP + WS  │             │  CLI / SDK  │
    │  Plugins    │             │  UI (/ui)   │
    └─────────────┘             └─────────────┘
```

- **Reads:** CLI and SDK read the DB directly (readonly connection)
- **Writes:** All mutations go through the hub's HTTP API
- **Events:** Monotonic `event_id` stream; WS provides replay + live fanout

## Testing

```bash
# Full suite
bun test

# By package (use src/ for cli to avoid picking up client/)
bun test packages/kernel      # schema, queries, mutations, crash safety
bun test packages/hub         # API, WS, plugins, security, edge cases
bun test packages/client      # SDK discovery, WS, events, mutations, Gate F
bun test packages/cli/src     # CLI commands, listen, doctor

# With FTS enabled
AGENTLIP_ENABLE_FTS=1 bun test

# Typecheck
bun run typecheck
```

CI runs the full matrix (FTS on/off) via `.github/workflows/ci.yml`.

## Documentation

| Doc | What it covers |
|-----|---------------|
| [docs/protocol.md](docs/protocol.md) | HTTP API, WS handshake, event types, error codes |
| [docs/ops.md](docs/ops.md) | Hub startup, recovery, migrations, doctor |
| [docs/security.md](docs/security.md) | Threat model, auth, plugin isolation, safe defaults |
| [docs/demo.md](docs/demo.md) | Multi-agent walkthrough with CLI + SDK examples |
| [AGENTLIP_PLAN.md](AGENTLIP_PLAN.md) | Full design plan (3400 lines, all decisions locked) |

ADRs in `docs/adr/`: replay boundary, plugin isolation, attachment idempotency, edit/tombstone semantics.

## SDK Usage

```typescript
import {
  discoverAndValidateHub,
  wsConnect,
  sendMessage,
  isMessageCreated,
  type HubHttpClient,
} from '@agentlip/client';

const hub = await discoverAndValidateHub();
const client: HubHttpClient = {
  baseUrl: `http://${hub.serverJson.host}:${hub.serverJson.port}`,
  authToken: hub.serverJson.auth_token,
};

const conn = await wsConnect({
  url: `ws://${hub.serverJson.host}:${hub.serverJson.port}/ws`,
  authToken: hub.serverJson.auth_token,
  afterEventId: loadCheckpoint(),
});

for await (const event of conn.events()) {
  if (isMessageCreated(event)) {
    console.log(event.data.message.content_raw);
  }
  saveCheckpoint(event.event_id);
}
```

## Local Registry (Verdaccio)

For testing package publishing and installation workflows locally:

```bash
# Start local registry at http://127.0.0.1:4873
./scripts/local-registry-up.sh

# Configure npm/bun to use it (for @agentlip scope)
npm config set @agentlip:registry http://127.0.0.1:4873

# When done
./scripts/local-registry-down.sh

# To clean all data and users
./scripts/local-registry-down.sh --clean
```

The registry requires authentication for publishing. Create a local user once with:

```bash
npm adduser --registry http://127.0.0.1:4873
```

**Requirements:** Docker and docker-compose must be installed and running.

## Publishing

All packages require **Bun** runtime (not Node.js). Install via `bun add @agentlip/client` or run the CLI with `bunx agentlip`.

### Prerequisites

- npm account with access to the `@agentlip` scope
- `NPM_TOKEN` (Automation type, publish-only scope) configured as a GitHub repository secret
- Bun installed locally for version bumping

### First-time Setup (one-time only)

If the `@agentlip` scope doesn't exist yet:

```bash
# Login to npm
npm login

# Create the org (or use personal scope @<username>/)
npm org create agentlip
```

Create an npm Automation token:
1. Go to https://www.npmjs.com/settings/tokens
2. Generate New Token → **Automation** type (bypasses 2FA for CI)
3. Copy immediately (shown only once)

Add to GitHub:
1. Go to `Settings > Secrets and variables > Actions`
2. New repository secret: `NPM_TOKEN` = your token

### Release Process

1. **Bump version** across all 6 packages:
   ```bash
   ./scripts/bump-version.sh 0.2.0
   ```
2. **Commit and tag:**
   ```bash
   git add -A && git commit -m 'release: v0.2.0'
   git tag v0.2.0 && git push && git push --tags
   ```
3. **CI publishes** (`.github/workflows/publish.yml`):
   - Runs typecheck + full test suite
   - Verifies version consistency across all packages
   - Publishes packages in dependency order: `protocol` → `kernel` → `workspace` → `client` → `cli` → `hub`
   - Waits 5s between packages for npm propagation
   - Post-publish smoke test: installs `@agentlip/client` and verifies import

### Manual Publish (if CI fails)

```bash
npm set //registry.npmjs.org/:_authToken=$NPM_TOKEN

for pkg in protocol kernel workspace client cli hub; do
  cd packages/$pkg && bun publish --access public --no-git-checks && cd ../..
  sleep 5
done
```

### Recovery

**Check published versions:**
```bash
for pkg in protocol kernel workspace client cli hub; do
  echo "$pkg: $(npm view @agentlip/$pkg version)"
done
```

**Resume from failed package:**  
If `client` failed but `protocol`, `kernel`, `workspace` succeeded, resume:
```bash
cd packages/client && bun publish --access public --no-git-checks
```

**Unpublish bad version** (within 72 hours only):
```bash
npm unpublish @agentlip/<pkg>@<version>
```

After 72 hours, publish a patch version instead.

## Quality Gates

All gates pass (verified in test suites):

- **Gate A–D:** Schema invariants, event monotonicity, optimistic locking, replay boundary
- **Gate E:** Plugin timeouts bounded; hub continues ingesting
- **Gate F:** SDK reconnects indefinitely with forward progress; JSON output additive-only
- **Gate G:** Version conflict returns error, no DB change
- **Gate H:** Tombstone delete preserves row, emits event exactly once
- **Gate I:** Derived jobs don't commit stale results
- **Gate J:** Auth token ≥128-bit, localhost bind, prepared statements
