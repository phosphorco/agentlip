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

## Node Local Client (ESM)

Requirements:
- Node.js v22+ (ESM-only)
- Bun installed (used to spawn the hub daemon when missing)

```typescript
import { connectToLocalAgentlip } from "agentlip/local-client";

const client = await connectToLocalAgentlip({
  cwd: process.cwd(),
  startIfMissing: true,
});

await client.sendMessage({ topicId: "...", sender: "agent", contentRaw: "Hello" });

for await (const event of client.events()) {
  // ...
}

client.close();
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

Hub/CLI packages run on **Bun** (not Node.js). SDK packages can be imported from Node.js v22+ (ESM-only); the local client helper still requires Bun installed to spawn `agentlipd`.

### Publishing Security (OIDC)

Agentlip uses **npm Trusted Publishing** via GitHub Actions OIDC, which provides short-lived tokens and provenance attestation.

**Configuration:**  
See `.context/runbooks/npm-trusted-publishing.md` for npm Trusted Publishing setup (required for all 6 packages).

**Emergency publish:**  
If OIDC publishing fails, publish manually from your local machine with a personal npm token (see Recovery section below). CI uses OIDC exclusively.

### Release Flow

Agentlip uses [Craft](https://craft.sentry.dev) for automated release preparation:

1. **Trigger Release Prepare** workflow (GitHub Actions → workflow_dispatch)
   - Input the desired version (semver, e.g., `0.2.0`)
   - Craft bumps all package versions and updates `CHANGELOG.md`
   - Creates a release PR (branch: `release/X.Y.Z`)

2. **Review and merge** the generated PR
   - CI verifies typecheck + tests pass
   - Changelog preview workflow annotates the PR

3. **Tag the release** to trigger publish:
   ```bash
   git tag v0.2.0 && git push --tags
   ```

4. **CI publishes** to npm (`.github/workflows/publish.yml`):
   - Publishes packages in dependency order: `protocol` → `kernel` → `workspace` → `client` → `cli` → `hub`
   - Waits 5s between packages for npm propagation
   - Post-publish smoke test: installs `@agentlip/client` and verifies import
   - Uses OIDC with provenance attestation

**See:** 
- `.context/runbooks/craft-release.md` for step-by-step release instructions
- `.context/runbooks/npm-trusted-publishing.md` for OIDC setup and troubleshooting

### Local Registry Testing

For testing the publish flow before releasing:

```bash
# Start local Verdaccio registry
./scripts/local-registry-up.sh

# Publish all packages locally
./scripts/publish-local.sh 0.2.0-test.1 --registry http://127.0.0.1:4873

# Verify installation works
./scripts/smoke-install-from-registry.sh 0.2.0-test.1 --registry http://127.0.0.1:4873
```

**See:** `.context/runbooks/local-registry-testing.md` for full workflow and troubleshooting.

### Prerequisites

- npm account with access to the `@agentlip` scope
- npm Trusted Publishing configured for all packages (see `.context/runbooks/npm-trusted-publishing.md`)
- Bun installed locally

### Recovery

**Check published versions:**
```bash
for pkg in protocol kernel workspace client cli hub; do
  echo "$pkg: $(npm view @agentlip/$pkg version)"
done
```

**Resume from failed package:**  
If `client` failed but `protocol`, `kernel`, `workspace` succeeded:

- Prefer re-running CI with a new patch version.
- If you must publish the remaining package manually (emergency only):

```bash
# Authenticate with your personal npm token
npm login
cd packages/client
npm publish --access public
```

**Unpublish bad version** (within 72 hours only):
```bash
npm unpublish @agentlip/<pkg>@<version>
```

After 72 hours, publish a patch version instead.

## Release Troubleshooting

For help with release and publish workflows, see:

- [Craft Release Workflow](.context/runbooks/craft-release.md) — Step-by-step release instructions + common failures
- [npm Trusted Publishing (OIDC)](.context/runbooks/npm-trusted-publishing.md) — OIDC setup and troubleshooting
- [Local Registry Testing](.context/runbooks/local-registry-testing.md) — Test publish flow with Verdaccio before releasing

## Quality Gates

All gates pass (verified in test suites):

- **Gate A–D:** Schema invariants, event monotonicity, optimistic locking, replay boundary
- **Gate E:** Plugin timeouts bounded; hub continues ingesting
- **Gate F:** SDK reconnects indefinitely with forward progress; JSON output additive-only
- **Gate G:** Version conflict returns error, no DB change
- **Gate H:** Tombstone delete preserves row, emits event exactly once
- **Gate I:** Derived jobs don't commit stale results
- **Gate J:** Auth token ≥128-bit, localhost bind, prepared statements
