# AgentChat Local Hub

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
| `@agentchat/kernel` | SQLite schema, migrations, events, queries, mutations |
| `@agentchat/hub` | Bun HTTP+WS server, plugin runtime, UI |
| `@agentchat/cli` | Stateless CLI (`agentchat`) — reads DB, writes via hub |
| `@agentchat/client` | TypeScript SDK — discovery, WS streaming, typed events, HTTP mutations |
| `@agentchat/protocol` | Shared types (error codes, health response, protocol version) |
| `@agentchat/workspace` | Workspace discovery (`.zulip/` upward walk with security boundary) |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  .zulip/db.sqlite3  (WAL mode, single writer)        │
│  .zulip/server.json (port, auth token, mode 0600)    │
│  .zulip/locks/writer.lock                             │
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
AGENTCHAT_ENABLE_FTS=1 bun test

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
} from '@agentchat/client';

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

## Quality Gates

All gates pass (verified in test suites):

- **Gate A–D:** Schema invariants, event monotonicity, optimistic locking, replay boundary
- **Gate E:** Plugin timeouts bounded; hub continues ingesting
- **Gate F:** SDK reconnects indefinitely with forward progress; JSON output additive-only
- **Gate G:** Version conflict returns error, no DB change
- **Gate H:** Tombstone delete preserves row, emits event exactly once
- **Gate I:** Derived jobs don't commit stale results
- **Gate J:** Auth token ≥128-bit, localhost bind, prepared statements
