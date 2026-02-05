# Hub Infrastructure Modules - Verification Report

**Date:** 2026-02-05  
**Task:** bd-16d.1.6, bd-16d.1.8, bd-16d.1.9  
**Status:** ✅ Complete and Verified

## Deliverables

### 1. Auth Token Module (`src/authToken.ts`)

**Functions:**
- `generateAuthToken()`: Generates cryptographically random 256-bit token (64 hex chars)
- `constantTimeEqual(a, b)`: Timing-attack-safe string comparison

**Verification:**
- ✅ Token length: 64 hex characters (256 bits entropy)
- ✅ Uniqueness: 100 consecutive tokens all unique (no collisions)
- ✅ Format: Lowercase hexadecimal (`[0-9a-f]{64}`)
- ✅ Constant-time comparison works correctly
- ✅ Uses `crypto.randomBytes(32)` for cryptographic randomness

**Security:**
- Token never logged (responsibility of caller)
- Exceeds >=128-bit requirement (256 bits)
- Suitable for Bearer token authentication

---

### 2. Server JSON Module (`src/serverJson.ts`)

**Types:**
```typescript
interface ServerJsonData {
  instance_id: string;
  db_id: string;
  port: number;
  host: string;
  auth_token: string;
  pid: number;
  started_at: string;
  protocol_version: string;
  schema_version?: number;
}
```

**Functions:**
- `writeServerJson({workspaceRoot, data})`: Atomic write with mode 0600
- `readServerJson({workspaceRoot})`: Parse JSON, return null if missing
- `removeServerJson({workspaceRoot})`: Idempotent delete

**Verification:**
- ✅ Atomic write via temp file + rename (same filesystem)
- ✅ File mode 0600 (owner read/write only) set and verified
- ✅ JSON content preserved correctly (all fields)
- ✅ Read returns null for missing file (not error)
- ✅ Remove is idempotent (no error if already gone)
- ✅ Creates `.agentlip/` directory if needed

**Security:**
- Mode 0600 enforced (belt-and-suspenders: set on write + verify + chmod)
- Auth token never logged by these functions
- Temp files cleaned up on error

---

### 3. Writer Lock Module (`src/lock.ts`)

**Types:**
```typescript
interface HealthCheckFn {
  (serverJson: ServerJsonData): Promise<boolean>;
}
```

**Functions:**
- `acquireWriterLock({workspaceRoot, healthCheck})`: Acquire exclusive lock
- `releaseWriterLock({workspaceRoot})`: Release lock (idempotent)
- `readLockInfo({workspaceRoot})`: Debug helper

**Verification:**
- ✅ Lock acquired via exclusive create (`flag: "wx"`)
- ✅ Lock contains PID and timestamp
- ✅ Prevents double acquisition when hub is live
- ✅ Staleness detection: calls `healthCheck(serverJson)`
- ✅ Removes stale locks and retries (max 3 attempts)
- ✅ Creates `.agentlip/locks/` directory if needed
- ✅ Release is idempotent

**Behavior:**
- Lock path: `.agentlip/locks/writer.lock`
- Staleness check:
  1. Read `server.json` (if missing → stale)
  2. Call `healthCheck(serverJson)` (if false or throws → stale)
  3. If stale: remove lock and retry
  4. If live: throw error (cannot start)
- Health check is injected (decouples from HTTP implementation)

---

## Test Results

**Test script:** `packages/hub/test-infra.ts`

```
🧪 Agentlip Hub Infrastructure Verification

=== Test 1: Auth Token Generation ===
✅ Token length: 64 hex chars (256-bit entropy)
✅ Uniqueness: 100 tokens all unique
✅ Constant-time comparison works

=== Test 2: server.json Atomic Write (mode 0600) ===
✅ File created with mode 0600
✅ Content read/written correctly
✅ Remove is idempotent

=== Test 3: Writer Lock Acquisition ===
✅ Lock acquired exclusively
✅ Live hub detection prevents double-start
✅ Stale lock removed and retried
✅ Release is idempotent

==================================================
✅ All tests passed! (19 assertions)
==================================================
```

**Run verification:**
```bash
cd packages/hub
bun test-infra.ts
```

---

## Integration Notes

### Startup Sequence (Hub Implementation)

```typescript
import { generateAuthToken } from "./authToken.js";
import { writeServerJson, removeServerJson } from "./serverJson.js";
import { acquireWriterLock, releaseWriterLock } from "./lock.js";

// 1. Define health check (will be implemented by hub)
const healthCheck = async (serverJson: ServerJsonData): Promise<boolean> => {
  try {
    const response = await fetch(
      `http://${serverJson.host}:${serverJson.port}/health`,
      { headers: { Authorization: `Bearer ${serverJson.auth_token}` } }
    );
    if (!response.ok) return false;
    
    const data = await response.json();
    return data.instance_id === serverJson.instance_id;
  } catch {
    return false;
  }
};

// 2. Acquire lock (removes stale locks)
await acquireWriterLock({ workspaceRoot, healthCheck });

// 3. Generate auth token
const authToken = generateAuthToken();

// 4. Write server.json (mode 0600)
await writeServerJson({
  workspaceRoot,
  data: {
    instance_id: crypto.randomUUID(),
    db_id: "...", // from DB
    port: 8080,
    host: "127.0.0.1",
    auth_token: authToken,
    pid: process.pid,
    started_at: new Date().toISOString(),
    protocol_version: "v1",
  },
});

// 5. Start server...
// (use authToken for authentication middleware)

// 6. On shutdown:
await removeServerJson({ workspaceRoot });
await releaseWriterLock({ workspaceRoot });
```

### CLI Integration (`agentlipd status`)

```typescript
import { readServerJson } from "@agentlip/hub";

const serverJson = await readServerJson({ workspaceRoot });
if (!serverJson) {
  console.error("Hub not running (no server.json)");
  process.exit(1);
}

// Validate via /health
const response = await fetch(`http://${serverJson.host}:${serverJson.port}/health`);
const health = await response.json();

if (health.instance_id !== serverJson.instance_id) {
  console.error("Hub instance mismatch (stale server.json?)");
  process.exit(1);
}

console.log("✓ Hub running:", health);
```

---

## Beads Completed

- **bd-16d.1.6**: Hub: writer lock acquisition + stale lock handling ✅
- **bd-16d.1.8**: Hub: auth token generation (>=128-bit crypto random) ✅
- **bd-16d.1.9**: Hub: write server.json (chmod 0600; never log token) ✅

---

## Files Changed

### New Files
- `packages/hub/src/authToken.ts` (744 bytes)
- `packages/hub/src/serverJson.ts` (3200 bytes)
- `packages/hub/src/lock.ts` (4462 bytes)
- `packages/hub/test-infra.ts` (8033 bytes) - verification script

### Modified Files
- `packages/hub/src/index.ts` - added exports for new modules

---

## Next Steps

**For orchestrator:**
1. Close beads bd-16d.1.6, bd-16d.1.8, bd-16d.1.9
2. Integrate these modules into hub startup sequence (bd-16d.1.7: main startup)
3. Implement HTTP /health endpoint (bd-16d.1.10)
4. Implement CLI `agentlipd status` (bd-16d.1.11)

**Dependencies unblocked:**
- bd-16d.1.11: CLI status command (needs server.json reader)
- bd-16d.2.29: Gate J security baseline (needs token + server.json)

---

## Quality Checklist

- [x] Auth token ≥128-bit entropy (256-bit delivered)
- [x] server.json mode 0600 enforced and verified
- [x] Atomic server.json write (temp + rename)
- [x] Lock acquisition with staleness check
- [x] Lock staleness uses health check (injectable)
- [x] Never log auth token (modules don't log; caller responsibility)
- [x] All functions are pure/injectable (no globals, no side effects beyond filesystem)
- [x] Error handling (file not found, permission denied, etc.)
- [x] Idempotent operations (remove, release)
- [x] Test coverage (19 assertions, all green)

---

## Notes

- All modules use pure functions (no Bun.serve coupling)
- Health check is injected (hub owns HTTP implementation)
- File permissions verified via stat() after write
- Temp files use random suffix to avoid collisions
- Lock retries up to 3 times with 100ms delay
- server.json advisory; /health is authoritative (per plan)
