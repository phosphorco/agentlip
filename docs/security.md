# Agentlip Security Model

> Source: implementation in `packages/hub/src/`, `packages/workspace/src/`, `docs/adr/ADR-0005-plugin-isolation.md`

---

## 1. Threat Model

Agentlip is a **single-machine, localhost-only** messaging hub designed for multi-agent collaboration. The threat model assumes:

| Actor | Trust Level | Access |
|-------|------------|--------|
| Local user (human) | Trusted | Full access via auth token |
| AI agents (local) | Trusted | Same access as human via auth token |
| Plugin code (agentlip.config.ts) | **Untrusted** | Sandboxed Worker threads, no direct DB |
| Network attackers | N/A | No network surface by default (localhost-only) |

**Out of scope:** remote access, multi-tenant isolation, encryption at rest, TLS.

---

## 2. Authentication

### Token Generation
- **128-bit cryptographically random** token generated on hub startup
- Source: `packages/hub/src/authToken.ts` using `crypto.randomBytes(16)`
- Format: hex string (32 characters)

### Token Storage
- Written to `.agentlip/server.json` with **mode 0600** (owner read/write only)
- Atomic write via temp file + rename (`packages/hub/src/serverJson.ts`)
- Token is **never logged** in error messages, responses, or diagnostic output

### Token Usage
- **HTTP:** `Authorization: Bearer <token>` header
- **WebSocket:** `?token=<token>` query parameter (validated at HTTP upgrade, before WS handshake)

### Auth Middleware
`packages/hub/src/authMiddleware.ts`:
- Constant-time comparison to prevent timing attacks
- Returns `INVALID_AUTH` error code on failure (HTTP 401)
- WS connections rejected at HTTP upgrade level (never upgrade unauthorized clients)

---

## 3. Authorization

**Single-role model:** token holder has full read/write access.

| Endpoint Type | Auth Required |
|--------------|---------------|
| GET (queries) | No |
| POST/PATCH (mutations) | **Yes** |
| WebSocket | **Yes** (at connect time) |
| GET /health | No |

Rationale: localhost-only deployment; read access is low-risk. All mutations require auth to prevent accidental writes.

---

## 4. Transport Security

### Localhost Binding
- Default bind: `127.0.0.1` (loopback only)
- Hub **rejects** `0.0.0.0` as bind address (`packages/hub/src/index.ts`)
- No network-facing surface by default

### No TLS
- Not needed for localhost communication
- For remote access (not recommended), use a reverse proxy with TLS

---

## 5. Input Validation

### SQL Injection Prevention
- **All SQL uses prepared statements** with parameterized queries
- No string interpolation in SQL queries anywhere in the codebase
- Kernel (`packages/kernel/src/`) enforces this for all DB operations

### Payload Size Limits
`packages/hub/src/apiV1.ts`:
- Message body (`content_raw`): **64 KB** max
- Attachment metadata (`value_json`): **16 KB** max
- WebSocket message: **64 KB** max (`packages/hub/src/bodyParser.ts`)
- Returns `PAYLOAD_TOO_LARGE` error code on violation

### Rate Limiting
`packages/hub/src/rateLimiter.ts`:
- Per-endpoint, per-client rate limiting
- Configurable windows and limits
- Returns HTTP 429 with `RATE_LIMITED` error code and `Retry-After` header
- Can be disabled for testing via `disableRateLimiting` option

### Body Parser Validation
`packages/hub/src/bodyParser.ts`:
- Validates `Content-Type: application/json`
- Parses JSON with size check before processing
- WebSocket messages validated for size and JSON structure

---

## 6. Plugin Isolation

> See also: `docs/adr/ADR-0005-plugin-isolation.md`

### Runtime Isolation
`packages/hub/src/pluginRuntime.ts`, `packages/hub/src/pluginWorker.ts`:

- Plugins execute in **Worker threads** (separate V8 isolates)
- No shared memory with hub process
- No direct database access
- Communication via structured clone (Worker postMessage)

### Filesystem Isolation
- Plugin output validated before commit
- Enrichment spans require integer indices, `end > start`
- Attachment `dedupe_key` validated if provided
- Plugins cannot write to arbitrary filesystem paths

### Timeout Enforcement
- Per-plugin execution timeout (configurable via `pluginDefaults.timeout`)
- Default: 5000ms
- Hanging plugins killed after timeout; hub continues processing

### Circuit Breaker
- Tracks consecutive failures per plugin
- After threshold, plugin is disabled for a cooldown period
- Prevents repeatedly failing plugins from consuming resources

### Output Validation
- Plugin results are validated before DB commit
- Staleness guard (`packages/hub/src/derivedStaleness.ts`) prevents committing results for stale content
- Version check + deleted_at check in same transaction

---

## 7. Safe Defaults

| Setting | Default | Source |
|---------|---------|--------|
| Bind address | `127.0.0.1` | `packages/hub/src/index.ts` |
| server.json permissions | `0600` | `packages/hub/src/serverJson.ts` |
| .agentlip/ directory permissions | `0700` | `packages/workspace/src/index.ts` |
| SQLite journal mode | WAL | `packages/kernel/src/index.ts` |
| Foreign keys | ON | `packages/kernel/src/index.ts` |
| busy_timeout | 5000ms | `packages/kernel/src/index.ts` |
| synchronous | NORMAL | `packages/kernel/src/index.ts` |
| Plugin timeout | 5000ms | `packages/hub/src/pluginRuntime.ts` |

---

## 8. File System Security

### Workspace Discovery Boundaries
`packages/workspace/src/index.ts`:
- Walks upward from cwd to find `.agentlip/`
- **Stops at:** filesystem boundary (device ID change) OR user home directory
- Never traverses above `$HOME`
- Prevents accidental loading of untrusted workspaces

### Lock Files
`packages/hub/src/lock.ts`:
- Writer lock (`.agentlip/locks/writer.lock`) prevents multiple hub instances
- PID-based liveness check for stale locks
- Removed on clean shutdown

### server.json Lifecycle
- Written atomically on startup (temp + rename)
- Removed on clean shutdown
- Stale file detected via PID liveness check and `/health` endpoint

---

## 9. Known Risks and Mitigations

### Event Log Immutability (Privacy)
- **Risk:** Deleted message content persists in `message.edited` event history
- Events table is immutable (INSERT only, no UPDATE/DELETE via triggers)
- **Mitigation:** Document this for users; future: optional event compaction

### Worker Thread Limitations
- **Risk:** Worker threads share the same process; not full sandbox
- A malicious plugin could theoretically crash the process
- **Mitigation:** Timeout enforcement, circuit breaker, validation of output

### No Encryption at Rest
- **Risk:** Database and server.json stored as plaintext on disk
- **Mitigation:** File permissions (0600/0700), localhost-only access
- Future: optional database encryption

### Token in Query Parameter (WebSocket)
- **Risk:** Auth token appears in server access logs for WS connections
- **Mitigation:** Hub does not log query parameters; localhost-only reduces exposure

---

## 10. Security Testing

Covered by test suites:
- `packages/hub/src/securityBaseline.test.ts` — Gate J security baseline
- `packages/hub/src/authMiddleware.test.ts` — auth validation
- `packages/hub/src/pluginIsolation.test.ts` — plugin sandboxing
- `packages/client/src/gateF.test.ts` — SDK stability + auth handling
- `packages/kernel/src/crash-safety.test.ts` — transaction atomicity, WAL recovery

Verified properties:
- Prepared statements prevent SQL injection
- Rate limiting returns 429
- Payload size limits enforced
- Auth token not leaked in responses
- File permissions verified
- Localhost bind enforced
- Plugin isolation boundaries maintained
