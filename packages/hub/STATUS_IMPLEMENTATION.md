# agentchatd status Implementation

## Overview

Implemented `agentchatd status` command as specified in AGENTLIP_PLAN.md §4.2 and bead bd-16d.1.11.

The command:
- Reads `.zulip/server.json` (if absent → status=not_running)
- Calls `GET /health` on port from server.json (timeout 5s)
- Validates `db_id` from /health against on-disk `meta.db_id`
- Prints status (human or JSON) with instance_id, port, pid, uptime, schema_version, protocol_version
- **Never leaks auth_token** (security requirement)

## Files Changed

### New Files

1. **`packages/hub/src/agentchatd.ts`** (237 lines)
   - Main CLI implementation
   - `checkStatus()`: core status checking logic
   - `main()`: CLI argument parsing and output
   - Supports `--workspace <path>` and `--json` flags
   - Exit codes: 0 (running), 3 (not running/unreachable), 1 (errors)

2. **`packages/hub/verify-status.ts`** (253 lines)
   - Comprehensive verification script
   - Tests 6 scenarios:
     - server.json missing → not_running
     - server.json stale → unreachable
     - Hub running + db_id matches → running
     - Hub running + db_id mismatch → db_mismatch
     - JSON output format
     - Auth token security (not leaked)

3. **`packages/hub/demo-status.ts`** (120 lines)
   - Interactive demonstration
   - Shows status command usage in realistic workflow

### Modified Files

4. **`packages/hub/package.json`**
   - Added exports for `./agentchatd`
   - Added `bin` entry for CLI usage
   - Added dependencies: `@agentchat/workspace`, `@agentchat/kernel`

## Usage

### Basic Usage

```bash
# Check status in current workspace (auto-discover)
bun packages/hub/src/agentchatd.ts status

# Explicit workspace path
bun packages/hub/src/agentchatd.ts status --workspace /path/to/workspace

# JSON output
bun packages/hub/src/agentchatd.ts status --json
```

### After Installation (future)

Once bun installs the workspace, you can use:
```bash
agentchatd status [--workspace <path>] [--json]
```

### Example Output

**Human-readable (hub running):**
```
✓ Hub is running
  Instance ID:      a5993a55-9639-44e9-a160-2d02206f46d2
  Database ID:      c435008b-6834-477d-b7f2-57d8f539fc23
  Schema Version:   1
  Protocol Version: v1
  Port:             53234
  PID:              27186
  Uptime:           15s
```

**Human-readable (hub not running):**
```
✗ Hub is not running
  No hub running (server.json not found)
```

**JSON output:**
```json
{
  "status": "running",
  "instance_id": "a5993a55-9639-44e9-a160-2d02206f46d2",
  "db_id": "c435008b-6834-477d-b7f2-57d8f539fc23",
  "schema_version": 1,
  "protocol_version": "v1",
  "port": 53234,
  "pid": 27186,
  "uptime_seconds": 15
}
```

## Status Values

| Status | Meaning | Exit Code |
|--------|---------|-----------|
| `running` | Hub is healthy and db_id matches | 0 |
| `not_running` | server.json not found | 3 |
| `unreachable` | server.json exists but /health fails | 3 |
| `stale` | server.json stale (detected via other means) | 3 |
| `db_mismatch` | Hub reports different db_id than on-disk | 1 |

## Security Features

1. **Auth token never printed**: The `auth_token` from server.json is NOT included in any output (human or JSON)
2. **Read-only DB access**: Opens database in readonly mode for status checks
3. **Timeout protection**: /health requests timeout after 5 seconds
4. **Workspace discovery boundaries**: Uses secure workspace discovery (stops at home directory and filesystem boundaries)

## Implementation Details

### Status Check Flow

```
1. discoverWorkspaceRoot(workspace)
   ↓
   [No workspace] → status=not_running, exit 3
   ↓
2. readServerJson()
   ↓
   [No server.json] → status=not_running, exit 3
   ↓
3. readDbIdFromDisk(dbPath)
   ↓
4. GET http://{host}:{port}/health (5s timeout)
   ↓
   [Network error] → status=unreachable, exit 3
   ↓
5. Compare health.db_id vs diskDbId
   ↓
   [Mismatch] → status=db_mismatch, exit 1
   ↓
6. status=running, exit 0
```

### DB ID Validation

The validation ensures the running hub is serving the same database as the one discovered in the workspace:

- **On-disk db_id**: Read from `SELECT value FROM meta WHERE key = 'db_id'`
- **Hub db_id**: From `GET /health` response
- **Validation**: `health.db_id === diskDbId`

This catches scenarios where:
- Hub is pointing to wrong database file
- Database was replaced/restored from backup
- Multiple hubs running (port conflict with stale server.json)

## Testing

### Run Verification

```bash
# Full verification suite (33 tests)
bun packages/hub/verify-status.ts
```

**Expected output:**
```
=== AgentChat Status Command Verification ===

Test 1: No server.json (hub not running)
✓ Status is not_running
✓ Error mentions server.json

Test 2: Stale server.json (hub unreachable)
✓ Status is unreachable
✓ Port preserved from server.json
✓ PID preserved from server.json
✓ Error mentions unreachable

Test 3: Running hub with valid db_id
✓ Status is running
✓ Instance ID matches
✓ DB ID matches
✓ Port matches
...

=== Summary ===
Passed: 33
Failed: 0

✅ All tests passed!
```

### Run Demo

```bash
# Interactive demonstration
bun packages/hub/demo-status.ts
```

Shows status command in realistic workflow:
1. Initialize workspace
2. Start hub + write server.json
3. Run status (running)
4. Stop hub
5. Run status (unreachable)
6. Remove server.json
7. Run status (not_running)

### Typecheck

```bash
bun run typecheck
```

Verifies TypeScript compilation without errors.

## Architecture Decisions

### Why read db_id from disk?

The status command validates that the running hub is serving the correct database. This requires comparing:
- What the hub reports (via /health)
- What's actually on disk (in .zulip/db.sqlite3)

If they don't match, the hub might be:
- Pointing to a different database file
- Stale after database restore
- Conflicting with another hub instance

### Why timeout /health at 5s?

Per spec (AGENTLIP_PLAN.md §4.2), status checks should be fast and fail quickly. 5 seconds is long enough for:
- Local network latency
- Hub startup/warmup time
- SQLite query overhead

But short enough to avoid hanging indefinitely on dead connections.

### Why use workspace discovery instead of explicit .zulip path?

Matches the pattern established in other AgentChat tools:
- Auto-discover workspace from cwd (walk upward)
- Stop at security boundaries (home dir, filesystem boundary)
- Allow explicit override via `--workspace`

This provides ergonomic CLI UX while maintaining security.

## Future Enhancements

Not in v1 scope, but documented for future reference:

1. **PID liveness check**: Verify PID from server.json is actually running (requires cross-platform solution)
2. **Stale detection heuristics**: Check server.json timestamp vs current time
3. **Multi-hub detection**: Scan for conflicting server.json files
4. **Health check caching**: Cache /health response for 1-2 seconds to avoid redundant requests
5. **Plugin status**: Show which plugins are enabled/loaded
6. **Connection pool status**: Report active WS connections, event backlog, etc.

## References

- **Spec**: AGENTLIP_PLAN.md §4.2 (CLI daemon control)
- **Bead**: bd-16d.1.11 (agentchatd status implementation)
- **Related**: bd-16d.1.10 (GET /health endpoint) - implemented in packages/hub/src/index.ts
