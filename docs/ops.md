# Operations Guide

This document covers starting, managing, and troubleshooting the Agentlip hub daemon.

## Table of Contents

- [Starting the Hub](#starting-the-hub)
- [Startup Sequence](#startup-sequence)
- [Recovery and Restart](#recovery-and-restart)
- [Migrations](#migrations)
- [Doctor Command](#doctor-command)
- [Configuration](#configuration)
- [Graceful Shutdown](#graceful-shutdown)

---

## Starting the Hub

### CLI Command

```bash
agentlipd up [--workspace <path>] [--host 127.0.0.1] [--port 0] [--idle-shutdown-ms <ms>] [--json]
```

**Options:**
- `--workspace`: Workspace root directory (default: auto-discover from `cwd`; initializes at `cwd` if none found)
- `--host`: Bind address (default: `127.0.0.1`). Localhost-only is enforced. See [Security: Transport Security](security.md#transport-security).
- `--port`: Port number (default: `0` = random available port)
- `--idle-shutdown-ms`: Optional idle auto-shutdown timeout (milliseconds, **daemon mode only** — requires `workspaceRoot`/`--workspace`). When enabled, the hub will stop if there are **no WS clients** and **no HTTP activity** for the configured duration. Note: `GET /health` does **not** reset the idle timer.
- `--json`: Output connection info as JSON (never prints auth token)

**Output (human):**
```
✓ Hub started
  Host:      127.0.0.1
  Port:      54321
  Workspace: /path/to/workspace
  Instance:  8a7f3e2d-...
```

**Output (`--json`):**
```json
{
  "status": "running",
  "host": "127.0.0.1",
  "port": 54321,
  "workspace_root": "/path/to/workspace",
  "instance_id": "8a7f3e2d-..."
}
```

**Exit codes:**
- `0`: Clean shutdown
- `1`: Error
- `10`: Writer lock conflict (hub already running)

**Auth token & server.json:**
- In daemon mode, the hub persists connection info (including the auth token) to `.agentlip/server.json` with mode **0600**.
- The auth token is **never printed** to stdout/stderr and must not appear in process argv.

### Programmatic Startup

From TypeScript/JavaScript:

```typescript
import { startHub } from "@agentlip/hub";

const hub = await startHub({
  host: "127.0.0.1",
  port: 0,  // random port
  workspaceRoot: process.cwd(),
  enableFts: true,  // optional full-text search
});

console.log(`Hub running on ${hub.host}:${hub.port}`);

// Later: graceful shutdown
await hub.stop();
```

**Reference:** `packages/hub/src/index.ts` lines 150-470

---

## Startup Sequence

The hub follows a deterministic startup sequence to ensure safe initialization:

### 1. Workspace Discovery and Validation

**File:** `packages/workspace/src/index.ts` lines 40-100

- Auto-discovers workspace by walking upward from current directory
- Stops at filesystem boundary or user home directory (security boundary)
- Looks for `.agentlip/db.sqlite3` marker file

### 2. Database Initialization

**File:** `packages/kernel/src/index.ts` lines 25-70

```typescript
const db = openDb({ dbPath: ".agentlip/db.sqlite3" });
```

**PRAGMAs applied:**
- `journal_mode = WAL` (Write-Ahead Logging for crash recovery)
- `foreign_keys = ON` (referential integrity)
- `busy_timeout = 5000` (5s wait for lock contention)
- `synchronous = NORMAL` (balance safety/performance)

### 3. Schema Migrations

**File:** `packages/kernel/src/index.ts` lines 130-230

```typescript
runMigrations({
  db,
  migrationsDir: "./migrations",
  enableFts: true,  // optional
});
```

**Migration files:**
- `0001_schema_v1.sql` - Core schema (channels, topics, messages, events, attachments, enrichments)
- `0001_schema_v1_fts.sql` - Optional FTS5 full-text search index (opportunistic, non-fatal)

**Tracking:**
- Current schema version stored in `meta.schema_version`
- Migrations are forward-only (no rollbacks)
- Before migration: creates timestamped backup (`.backup-v{version}-{timestamp}`)

### 4. Metadata Initialization

**File:** `packages/kernel/src/index.ts` lines 75-115

Ensures `meta` table has required keys:
- `db_id`: UUIDv4 (generated once at init, never changes)
- `schema_version`: Current version (initially '1')
- `created_at`: ISO8601 timestamp

### 5. Writer Lock Acquisition

**File:** `packages/hub/src/lock.ts` lines 25-90

**Daemon mode only** (when `workspaceRoot` is provided):

```
.agentlip/locks/writer.lock
```

**Lock contents:**
```
{pid}\n{started_at}
```

**Stale lock detection:**
1. Read `server.json` to get hub instance info
2. Check `/health` endpoint to verify hub is responsive
3. If health check fails → lock is stale, remove and retry acquisition
4. Max retries: 3 (with 100ms delay between attempts)

**Reference:** `packages/hub/src/lock.ts` lines 45-120

### 6. Authentication Token Generation

**File:** `packages/hub/src/authToken.ts` lines 10-20

```typescript
const authToken = generateAuthToken();  // 32 bytes (256 bits) cryptographically random
```

**Stored in:** `.agentlip/server.json` (mode 0600, owner read/write only)

**Token never logged** in error messages or structured logs.

### 7. HTTP + WebSocket Server Start

**File:** `packages/hub/src/index.ts` lines 250-350

```typescript
const server = Bun.serve({
  hostname: host,
  port: port,
  fetch: handleRequest,
  websocket: wsHandlers,
});
```

**Endpoints:**
- `GET /health` - Unauthenticated health check
- `GET /ws` - WebSocket upgrade (requires auth token in query param: `?token=...`)
- `/api/v1/*` - HTTP API (mutations require `Authorization: Bearer <token>`)

### 8. Server Metadata Write

**File:** `packages/hub/src/serverJson.ts` lines 40-85

**Daemon mode only:**

```json
{
  "instance_id": "8a7f3e2d-...",
  "db_id": "f3e2d4b1-...",
  "port": 54321,
  "host": "127.0.0.1",
  "auth_token": "a1b2c3d4...",
  "pid": 12345,
  "started_at": "2026-02-05T18:30:00.000Z",
  "protocol_version": "1",
  "schema_version": 1
}
```

**Atomic write:**
1. Write to temp file: `.server.json.tmp.{random}`
2. Set mode 0600
3. Rename to `server.json` (atomic on same filesystem)
4. Verify final permissions

**Security:** Mode 0600 ensures only workspace owner can read auth token.

### 9. Workspace Config Load (Optional)

**File:** `packages/hub/src/config.ts` lines 20-120

**Daemon mode only:**

```typescript
const config = await loadWorkspaceConfig(workspaceRoot);
```

**Config file:** `agentlip.config.ts` in workspace root

**Contents:**
```typescript
export default {
  plugins: [
    {
      type: "linkifier",
      name: "url-preview",
      module: "./plugins/url-preview.ts",
      enabled: true,
      config: { /* plugin-specific */ },
    },
  ],
};
```

**Note:** Config load failure aborts startup (releases lock before exiting).

### 10. Derived Pipeline Registration

**File:** `packages/hub/src/index.ts` lines 380-440

If workspace config declares enabled plugins:
- Linkifier plugins registered for `message.created` / `message.edited` events
- Extractor plugins registered for same events
- Execution is **asynchronous** (doesn't block HTTP response)
- Failures logged but don't affect message ingestion

---

## Recovery and Restart

### Crash Recovery

Agentlip uses **SQLite WAL mode** for automatic crash recovery:

**How WAL works:**
- Writes go to `.db.sqlite3-wal` (Write-Ahead Log) file
- On clean shutdown: WAL checkpointed back to main DB file
- On crash: next startup replays WAL automatically

**Recovery steps:**
1. Open database (SQLite replays WAL if present)
2. Database is now in consistent state as of last committed transaction
3. In-flight transactions during crash are rolled back

**WAL checkpoint:**

On graceful shutdown (`packages/hub/src/index.ts` lines 520-530):
```typescript
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
```

**TRUNCATE mode:**
- Checkpoints all WAL frames back to main DB
- Truncates WAL file to reclaim disk space
- Best-effort (failure logged but doesn't block shutdown)

### Stale Lock Cleanup

**File:** `packages/hub/src/lock.ts` lines 100-145

**Scenario:** Hub crashed without cleaning up `writer.lock`

**Detection:**
1. Next startup attempts lock acquisition
2. Finds existing lock file
3. Reads `server.json` to get previous instance info
4. Calls health check: `GET http://{host}:{port}/health`
5. Verifies `instance_id` matches (ensures same hub instance, not new hub on recycled port)

**If health check fails:**
- Lock is stale → remove lock file
- Retry acquisition (max 3 attempts)

**If health check succeeds:**
- Lock is live → abort startup with error:
  ```
  Writer lock already held by live hub. Cannot start another hub instance.
  ```

### Stale server.json Handling

**File:** `packages/hub/src/serverJson.ts` lines 90-120

**On startup:**
- Check if `server.json` exists
- If exists: attempt health check (same as lock staleness detection)
- If stale: overwrite with new instance info
- If live: abort startup

**On clean shutdown:**
- Remove `server.json`: `packages/hub/src/serverJson.ts` lines 125-140
- Remove `writer.lock`: `packages/hub/src/lock.ts` lines 150-165

---

## Migrations

### Migration Files

**Directory:** `migrations/` (repo root)

**Files:**
- `0001_schema_v1.sql` - Core schema (required)
- `0001_schema_v1_fts.sql` - Full-text search index (optional)

### Running Migrations

**Automatic:** Migrations run on every hub startup (`packages/kernel/src/index.ts` lines 160-230)

**Idempotent:** Migration SQL uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`

**Tracking:**
```sql
SELECT value FROM meta WHERE key = 'schema_version';
-- Returns: '1'
```

### FTS (Full-Text Search) Migration

**Optional feature** controlled by:
1. Explicit `enableFts` option in `startHub()`
2. Environment variable: `AGENTLIP_ENABLE_FTS=1`

**Resolution order (packages/hub/src/index.ts lines 200-215):**
```typescript
function resolveFtsEnabled(enableFts?: boolean): boolean {
  if (enableFts !== undefined) return enableFts;  // 1. Explicit option
  const env = process.env.AGENTLIP_ENABLE_FTS;
  if (env === "1") return true;                   // 2. Env var
  if (env === "0") return false;
  return false;                                    // 3. Default: disabled
}
```

**Non-fatal:**
- If FTS migration fails (e.g., SQLite build without FTS5 support), hub continues startup
- Error logged but doesn't abort initialization
- Search commands will return error if FTS unavailable

### Backup Before Migration

**File:** `packages/kernel/src/index.ts` lines 115-135

**Automatic backup:**
```
.agentlip/db.sqlite3.backup-v{fromVersion}-{timestamp}
```

**Example:**
```
.agentlip/db.sqlite3.backup-v0-2026-02-05T15-30-45-123Z
.agentlip/db.sqlite3-wal.backup-v0-2026-02-05T15-30-45-123Z
```

**Restoration:**
```bash
# Stop hub first
mv .agentlip/db.sqlite3.backup-v0-2026-02-05T15-30-45-123Z .agentlip/db.sqlite3
mv .agentlip/db.sqlite3-wal.backup-v0-2026-02-05T15-30-45-123Z .agentlip/db.sqlite3-wal
# Restart hub
agentlipd up
```

---

## Doctor Command

**CLI:** `agentlip doctor [--workspace /path] [--json]`

**File:** `packages/cli/src/agentlip.ts` lines 150-220

### What Doctor Checks

1. **Workspace discovery** (upward walk from current directory)
2. **Database file exists** (`.agentlip/db.sqlite3`)
3. **Database can be opened** (read-only mode)
4. **Schema version** (from `meta.schema_version`)
5. **Query-only mode** (whether DB is read-only)
6. **Database ID** (from `meta.db_id`)

### Example Output

**Human-readable:**
```
✓ Workspace found
  Workspace Root:  /Users/alice/my-project
  Database Path:   /Users/alice/my-project/.agentlip/db.sqlite3
  Database ID:     f3e2d4b1-c9a7-8e5f-6d2b-1a4c3e7f9b2d
  Schema Version:  1
  Query Only:      no
```

**JSON mode:**
```json
{
  "status": "ok",
  "workspace_root": "/Users/alice/my-project",
  "db_path": "/Users/alice/my-project/.agentlip/db.sqlite3",
  "db_id": "f3e2d4b1-c9a7-8e5f-6d2b-1a4c3e7f9b2d",
  "schema_version": 1,
  "query_only": false
}
```

**Error (workspace not found):**
```json
{
  "status": "error",
  "error": "No workspace found (no .agentlip/db.sqlite3 in directory tree starting from /Users/alice/random-dir)"
}
```

### Exit Codes

- `0` - OK
- `1` - Error (workspace not found, DB issues, etc.)

---

## Configuration

### Workspace Config File

**File:** `agentlip.config.ts` in workspace root

**Loaded by:** `packages/hub/src/config.ts` lines 20-120

**Schema:**
```typescript
export interface WorkspaceConfig {
  plugins: PluginConfig[];
}

export interface PluginConfig {
  type: "linkifier" | "extractor";
  name: string;
  module: string;  // relative path from workspace root
  enabled: boolean;
  config?: Record<string, unknown>;  // plugin-specific config
  timeout_ms?: number;  // default: 5000
  circuit_breaker?: {
    failure_threshold?: number;  // default: 3
    cooldown_ms?: number;        // default: 60000
  };
}
```

**Example:**
```typescript
export default {
  plugins: [
    {
      type: "linkifier",
      name: "url-preview",
      module: "./plugins/url-preview.ts",
      enabled: true,
      config: {
        max_urls: 5,
        timeout_ms: 3000,
      },
    },
    {
      type: "extractor",
      name: "jira-tickets",
      module: "./plugins/jira-extractor.ts",
      enabled: false,  // disabled; won't execute
    },
  ],
};
```

**Dynamic reload:**
- v1: Config loaded once at startup
- Future: Consider SIGHUP or file watcher for hot reload

### Rate Limiting

**File:** `packages/hub/src/rateLimiter.ts` lines 1-200

**Defaults (packages/hub/src/rateLimiter.ts lines 125-130):**
```typescript
{
  perClient: { limit: 100, windowMs: 1000 },  // 100 req/s per client
  global: { limit: 1000, windowMs: 1000 },    // 1000 req/s global
}
```

**Configure via startHub options:**
```typescript
await startHub({
  rateLimitPerClient: { limit: 50, windowMs: 1000 },
  rateLimitGlobal: { limit: 500, windowMs: 1000 },
  disableRateLimiting: false,  // disable for testing
});
```

**Headers in responses:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1704477890
```

**429 Too Many Requests:**
```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMITED",
  "details": {
    "limit": 100,
    "window": "1s",
    "retry_after": 5
  }
}
```

**Cleanup:**
- Expired rate limit buckets cleaned every 60s
- Automatic cleanup stops on graceful shutdown

---

## Graceful Shutdown

**File:** `packages/hub/src/index.ts` lines 500-570

### Shutdown Sequence

```typescript
await hub.stop();
```

**Steps:**

1. **Set shutdown flag** (reject new non-health requests)
   - New requests get 503 response: `{ code: "SHUTTING_DOWN" }`
   - Health endpoint continues responding

2. **Wait for in-flight requests** (max 10s)
   - Track pending requests via `inflightPromises` set
   - Drain with timeout: `Promise.race([drain, timeout(10000)])`

3. **Close WebSocket connections** (code 1001 = going away)
   - Hub broadcasts close to all connected clients
   - Clients should reconnect after delay

4. **Stop rate limiter cleanup**
   - Clear cleanup interval

5. **Attempt server stop** (bounded wait)
   - Call `server.stop(true)` (force close)
   - **Known issue (Bun 1.3.x):** `stop()` can hang after WebSocket connections
   - **Mitigation:** Race stop against 250ms timeout; proceed with cleanup anyway

6. **WAL checkpoint** (reclaim disk space)
   ```typescript
   db.run("PRAGMA wal_checkpoint(TRUNCATE)");
   ```
   - Best-effort; failure logged but doesn't block shutdown

7. **Close database**
   ```typescript
   db.close();
   ```

8. **Remove server.json** (daemon mode only)
   ```typescript
   await removeServerJson({ workspaceRoot });
   ```

9. **Release writer lock** (daemon mode only)
   ```typescript
   await releaseWriterLock({ workspaceRoot });
   ```

### Signal Handling

**CLI daemon:**
- `SIGINT` (Ctrl+C) → graceful shutdown
- `SIGTERM` → graceful shutdown

**Unhandled signals:**
- `SIGKILL` → immediate termination (no cleanup; lock/server.json left behind; next startup detects stale files)

### Shutdown Timeout

**Total shutdown time bounded:**
- In-flight drain: 10s
- Server stop: 250ms
- Total: ~10.5s worst-case

**After timeout:**
- Proceeds with cleanup regardless of drain status
- Outstanding requests may be aborted

---

## Observability

### Structured Logs

**File:** `packages/hub/src/index.ts` lines 25-90

**Format:** JSON lines to stdout

**Example:**
```json
{
  "ts": "2026-02-05T18:30:45.123Z",
  "level": "info",
  "msg": "request",
  "method": "POST",
  "path": "/api/v1/messages",
  "status": 201,
  "duration_ms": 15,
  "instance_id": "8a7f3e2d-...",
  "request_id": "a1b2c3d4-...",
  "event_ids": [42, 43]
}
```

**Suppressed in test environments:**
- `NODE_ENV=test`
- `VITEST` or `JEST_WORKER_ID` set
- Entry point matches `*.test.{js,ts}`

**Never logged:**
- Auth tokens (full or partial)
- Full message content (only message IDs)
- User credentials

### Health Endpoint

**Endpoint:** `GET /health`

**Unauthenticated** (always accessible, even during shutdown)

**Response:**
```json
{
  "status": "ok",
  "instance_id": "8a7f3e2d-4b1c-9d6e-5f8a-7c9e2b3d4a5f",
  "db_id": "f3e2d4b1-c9a7-8e5f-6d2b-1a4c3e7f9b2d",
  "schema_version": 1,
  "protocol_version": "1",
  "pid": 12345,
  "uptime_seconds": 3600
}
```

**Use cases:**
- Stale lock detection during startup
- Load balancer health checks (if exposed via reverse proxy)
- Monitoring systems

### Request IDs

**Header:** `X-Request-ID`

**Behavior:**
- Client can provide `X-Request-ID` in request header
- If not provided, hub generates random UUIDv4
- Returned in response header
- Included in structured logs (for request tracing)

---

## Troubleshooting

### Hub Won't Start: Lock Held

**Error:**
```
Writer lock already held by live hub. Cannot start another hub instance.
```

**Diagnosis:**
```bash
# Check if hub is actually running
ps aux | grep agentlipd

# Check lock file
cat .agentlip/locks/writer.lock
# Output: {pid}\n{timestamp}

# Verify hub health
curl http://127.0.0.1:{port}/health
```

**Resolution:**
1. If hub is running: stop it first (`kill {pid}` or Ctrl+C)
2. If hub crashed: remove stale lock manually
   ```bash
   rm .agentlip/locks/writer.lock
   ```
3. Restart hub: `agentlipd up`

### Database Locked Errors

**Error:**
```
database is locked
```

**Causes:**
- Another process has exclusive lock (unlikely with WAL mode)
- Long-running transaction holding write lock
- Filesystem issues (NFS, network drive)

**Diagnosis:**
```bash
# Check for other processes with DB open
lsof .agentlip/db.sqlite3

# Check WAL file size (large WAL indicates checkpoint issues)
ls -lh .agentlip/db.sqlite3-wal
```

**Resolution:**
1. Stop all hub instances
2. Checkpoint WAL manually:
   ```bash
   sqlite3 .agentlip/db.sqlite3 "PRAGMA wal_checkpoint(TRUNCATE);"
   ```
3. Restart hub

### Migration Failures

**Error:**
```
Migration file not found: /path/to/migrations/0001_schema_v1.sql
```

**Resolution:**
- Ensure `migrationsDir` points to correct path
- Default: `{repo}/migrations/`
- Programmatic start: provide explicit `migrationsDir` option

**Error:**
```
Migration failed: table already exists
```

**Resolution:**
- Migration SQL should use `IF NOT EXISTS` for idempotency
- Manual fix: inspect schema version, manually apply missing parts
- Last resort: restore from backup, rerun migrations

### FTS Not Available

**Error (in CLI):**
```
Full-text search not available: messages_fts table does not exist.
Enable FTS by running migrations with enableFts=true.
```

**Resolution:**
1. Stop hub
2. Enable FTS:
   ```bash
   AGENTLIP_ENABLE_FTS=1 agentlipd up
   ```
3. Or programmatic:
   ```typescript
   await startHub({ enableFts: true });
   ```

**Check FTS status:**
```typescript
import { isFtsAvailable } from "@agentlip/kernel";
const hasFts = isFtsAvailable(db);
```

### Plugin Failures

**Check circuit breaker state:**

Circuit breaker opens after 3 failures (default). Plugin skipped for 60s cooldown.

**Logs:**
```json
{
  "ts": "2026-02-05T18:30:45.123Z",
  "level": "warn",
  "msg": "[plugins] linkifier pipeline failed for message msg-123",
  "error": "Plugin timed out after 5000ms"
}
```

**Resolution:**
1. Check plugin code for infinite loops or blocking I/O
2. Increase timeout in config:
   ```typescript
   {
     timeout_ms: 10000,  // 10s
   }
   ```
3. Fix plugin code and restart hub (circuit auto-resets after cooldown)

---

## Performance Tuning

### Database Optimization

**WAL checkpoint frequency:**
```bash
# Manual checkpoint
sqlite3 .agentlip/db.sqlite3 "PRAGMA wal_checkpoint(TRUNCATE);"

# Autocheckpoint (default: every 1000 pages)
sqlite3 .agentlip/db.sqlite3 "PRAGMA wal_autocheckpoint=1000;"
```

**Analyze query performance:**
```bash
sqlite3 .agentlip/db.sqlite3 "ANALYZE;"
```

### Connection Limits

**WebSocket connections:**
- Default: no explicit limit (OS default: ~1024 on Linux)
- Future: add `maxConnections` option

**HTTP requests:**
- Rate limited (see [Configuration: Rate Limiting](#rate-limiting))

### Plugin Performance

**Timeout adjustment:**
- Default: 5s
- Increase for slow plugins (API calls, etc.)
- Monitor timeout errors in logs

**Parallelism:**
- Plugins execute sequentially per message
- Multiple messages processed concurrently
- Consider async batching for bulk enrichment (future feature)

---

## Backup and Restore

### Manual Backup

```bash
# Stop hub first (ensures clean state)
agentlipd down

# Backup database + WAL
cp .agentlip/db.sqlite3 backups/db-$(date +%Y%m%d-%H%M%S).sqlite3
cp .agentlip/db.sqlite3-wal backups/db-$(date +%Y%m%d-%H%M%S).sqlite3-wal

# Restart hub
agentlipd up
```

### Hot Backup (WAL mode)

```bash
# While hub is running
sqlite3 .agentlip/db.sqlite3 ".backup backups/db-$(date +%Y%m%d-%H%M%S).sqlite3"
```

**WAL mode allows hot backup** (consistent snapshot without stopping hub).

### Restore from Backup

```bash
# Stop hub
agentlipd down

# Restore database
cp backups/db-20260205-153045.sqlite3 .agentlip/db.sqlite3

# Restart hub (will replay WAL if present)
agentlipd up
```

---

## UI SPA Cutover (Completed)

### Background

The hub UI was migrated from inline HTML/CSS/JS to a Svelte 5 SPA served from `/ui/*` routes. The migration used a temporary feature flag (`HUB_UI_SPA_ENABLED`) during rollout; that flag was removed at final cutover.

### Cutover Timeline

1. **Gate 1-3 (completed):** SPA build pipeline, bootstrap endpoint, route migration with feature flag
2. **Soak period (completed):** Flag defaulted to `true`; legacy code path available via `HUB_UI_SPA_ENABLED=false`
3. **Gate 4 (completed):** Legacy code removed; CSP tightened; flag removed

### Post-Cutover Rollback

**After legacy code removal (current state):**

- **Rollback method:** Redeploy previous known-good release (e.g., v0.X.Y-1)
- **Feature flag no longer available:** Setting `HUB_UI_SPA_ENABLED` has no effect
- **CSP updated:** Removed `'unsafe-inline'` from `script-src` and `style-src` (SPA has no inline scripts/styles)

**Cutover verification checklist (required before/at removal):**

- Run `bun run typecheck`
- Run `bun test packages/hub`
- Run full workspace `bun test`
- Verify route matrix behavior:
  - `/ui` and deep `/ui/*` routes serve SPA shell
  - `/ui/bootstrap` returns runtime JSON
  - `/ui/assets/*` serves assets and missing assets return 404 (no shell fallback)
  - no-auth mode returns 503 for all `/ui/*`
- Verify CSP headers include no `unsafe-inline` in `script-src` / `style-src`
- Document rollback path for production deployments (redeploy previous release)

**Steady-state behavior:**

| Route | Behavior |
|-------|----------|
| `/ui` | Serves SPA shell (Svelte app) |
| `/ui/bootstrap` | Returns runtime config JSON (`baseUrl`, `wsUrl`, `authToken`) |
| `/ui/assets/*` | Serves static JS/CSS assets (hashed files get immutable cache) |
| Deep client routes (`/ui/channels/:id`, `/ui/topics/:id`, `/ui/events`) | SPA shell (client-side routing) |
| Missing `/ui/assets/*` | 404 (never SPA fallback) |
| All `/ui/*` routes (no auth token) | 503 (UI unavailable) |

**Emergency rollback procedure:**

If critical UI regression discovered post-cutover:

1. Identify last known-good release (e.g., v0.1.5)
2. Deploy previous release:
   ```bash
   git checkout v0.1.5
   bun install
   agentlipd down
   agentlipd up
   ```
3. Or via package manager (if using published releases):
   ```bash
   bun add @agentlip/hub@0.1.5
   agentlipd down
   agentlipd up
   ```
4. Report issue and prepare patch release

**CSP policy (current):**

```
default-src 'self';
script-src 'self';
style-src 'self';
connect-src 'self' ws://localhost:* ws://127.0.0.1:*;
frame-ancestors 'none'
```

**Note:** `'unsafe-inline'` removed from `script-src` and `style-src` after legacy removal (SPA uses external JS/CSS files only).

---

## See Also

- [Security Documentation](security.md) - Threat model, authentication, plugin isolation
- [API Reference](api.md) - HTTP and WebSocket API endpoints
- [Plugin Development](plugins.md) - Writing custom plugins
- [AGENTLIP_PLAN.md](../AGENTLIP_PLAN.md) - Full system specification
