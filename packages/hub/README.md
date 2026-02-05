# @agentchat/hub

Bun-based HTTP + WebSocket hub daemon for AgentChat local coordination.

## Features

### Phase 0 (Current)

- ✅ `GET /health` endpoint (unauthenticated)
- ✅ Localhost-only bind validation
- ✅ `startHub()` API with configurable options

## API

### `startHub(options?)`

Start the AgentChat hub HTTP server.

```typescript
import { startHub } from "@agentchat/hub";

const hub = await startHub({
  host: "127.0.0.1",    // Default: 127.0.0.1
  port: 8080,           // Default: 0 (random port)
  instanceId: "...",    // Default: auto-generated UUID
  dbId: "...",          // Default: "unknown"
  schemaVersion: 1,     // Default: 0
  allowUnsafeNetwork: false, // Default: false
});

console.log(`Hub running on ${hub.host}:${hub.port}`);

// Stop server
await hub.stop();
```

### `assertLocalhostBind(host, options?)`

Validates that a bind host is localhost-only.

```typescript
import { assertLocalhostBind } from "@agentchat/hub";

// These pass:
assertLocalhostBind("127.0.0.1");
assertLocalhostBind("::1");
assertLocalhostBind("localhost");

// These throw unless allowUnsafeNetwork is true:
assertLocalhostBind("0.0.0.0");  // Error
assertLocalhostBind("0.0.0.0", { allowUnsafeNetwork: true });  // OK
```

## Endpoints

### `GET /health`

Unauthenticated health check endpoint. Always returns 200 when hub is responsive.

**Response:**
```json
{
  "status": "ok",
  "instance_id": "abc123-def456",
  "db_id": "workspace-db-uuid",
  "schema_version": 1,
  "protocol_version": "v1",
  "pid": 12345,
  "uptime_seconds": 3600
}
```

## Security

By default, the hub only binds to localhost (`127.0.0.1` or `::1`). Attempts to bind to `0.0.0.0` or other network interfaces will fail unless `allowUnsafeNetwork: true` is explicitly set.

This prevents accidental network exposure of the hub.

## Manual Verification

Start a test server:

```bash
cd packages/hub
bun run verify-health.ts
```

Or test manually:

```bash
# Terminal 1: Start hub on random port
bun -e "import {startHub} from './src/index.ts'; const h = await startHub(); console.log('Port:', h.port); await new Promise(r => setTimeout(r, 60000))"

# Terminal 2: Test health endpoint (replace PORT with actual port from Terminal 1)
curl http://127.0.0.1:PORT/health | jq

# Should output:
# {
#   "status": "ok",
#   "instance_id": "...",
#   "db_id": "unknown",
#   "schema_version": 0,
#   "protocol_version": "v1",
#   "pid": ...,
#   "uptime_seconds": ...
# }
```

Test bind validation:

```bash
# Should fail (0.0.0.0 not allowed by default)
bun -e "import {startHub} from './src/index.ts'; await startHub({host: '0.0.0.0'})"

# Should succeed (explicit unsafe flag)
bun -e "import {startHub} from './src/index.ts'; const h = await startHub({host: '0.0.0.0', allowUnsafeNetwork: true}); console.log('Port:', h.port)"
```

## Future Work

- Authentication (auth token validation)
- WebSocket endpoint (`/ws`)
- REST API routes (`/api/v1/*`)
- Writer lock management
- server.json persistence
- Database integration (db_id, schema_version from meta table)
