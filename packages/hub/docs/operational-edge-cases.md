# Operational Edge Cases - Test Coverage Summary

This document summarizes the deterministic operational edge-case test suite for `@agentchat/hub`.

## Test Location

`packages/hub/src/operational.edge.test.ts`

## Coverage Areas

### 1. Port Already in Use

**Tests:**
- ✅ `fails clearly when attempting to bind to occupied port` - Verifies hub startup fails with clear error when port is already bound
- ✅ `succeeds when binding to different port` - Confirms multiple hubs can run on different ports

**Edge cases covered:**
- Starting second hub on same port as running hub
- Bun error message format validation (`EADDRINUSE` / "Failed to start server")

### 2. server.json Permission Errors (Daemon Mode)

**Tests:**
- ✅ `fails when .zulip directory is read-only` - Hub cannot write server.json when directory lacks write permission
- ⏭️ `fails when server.json exists and is read-only` - **SKIPPED**: Platform-specific behavior (atomic rename can overwrite read-only files)
- ✅ `succeeds when server.json is writable` - Normal daemon mode startup with proper permissions

**Edge cases covered:**
- Read-only `.zulip/` directory (hub fails with `EACCES`/`EPERM`)
- server.json mode verification (0600 required)
- Atomic write implementation (temp file + rename)

**Platform note:** The atomic write implementation (temp file → rename) can bypass read-only target files on some filesystems, making this behavior platform-specific and not reliably testable.

### 3. Multiple Hub Instances / Writer Lock Behavior

**Tests:**
- ✅ `prevents second hub from starting when first is live` - Writer lock enforcement prevents concurrent hubs
- ✅ `removes stale lock and succeeds when health check fails` - Stale lock detection and removal
- ✅ `cleans up lock and server.json on graceful shutdown` - Resource cleanup verification

**Edge cases covered:**
- Live lock detection (health check via `/health` endpoint)
- Stale lock removal (unreachable port / missing server.json)
- Lock + server.json cleanup on hub shutdown

**Staleness detection strategy:**
1. Read `server.json` to get hub instance info (port, instance_id)
2. Call health check against `/health` endpoint (2s timeout)
3. Verify `instance_id` matches (same hub instance)
4. If health check fails/times out → lock is stale

### 4. Permission Errors for Directory Creation

**Tests:**
- ✅ `fails when workspace root is read-only` - Cannot create `.zulip/` when workspace is read-only
- ✅ `fails when .zulip/locks directory cannot be created` - Cannot create lock file when `.zulip/` is read-only
- ✅ `succeeds when all directories are writable` - Normal daemon mode initialization

**Edge cases covered:**
- Read-only workspace root
- Read-only `.zulip/` directory
- Successful directory creation with proper permissions

### 5. Lock Staleness Detection (Low-Level)

**Tests:**
- ✅ `treats lock as stale when server.json missing` - Missing server.json → stale lock
- ✅ `treats lock as stale when health check times out` - Unreachable health endpoint → stale lock (uses TEST-NET-1: 192.0.2.1)

**Edge cases covered:**
- Lock exists but no server.json
- Health check timeout (2s) with non-routable IP
- Automatic stale lock removal and retry

**Network testing:** Uses `192.0.2.1` (TEST-NET-1, RFC 5737) to reliably trigger timeout without external network dependency.

### 6. Direct Lock API Tests

**Tests:**
- ✅ `acquireWriterLock succeeds when no lock exists` - Normal lock acquisition
- ✅ `acquireWriterLock retries and succeeds when lock is stale` - Stale lock removal and retry
- ✅ `acquireWriterLock fails when lock is live` - Live lock enforcement (with valid server.json)
- ✅ `releaseWriterLock is no-op when lock doesn't exist` - Idempotent cleanup

**Edge cases covered:**
- Lock acquisition with/without existing lock
- Stale vs. live lock detection
- Idempotent lock release

## Test Characteristics

### Determinism
- ✅ All tests use temp workspaces (isolated)
- ✅ Random port binding (no fixed port conflicts)
- ✅ No flaky timing dependencies (except designed timeouts)
- ✅ Platform-agnostic where possible (1 test skipped for platform variance)

### CI-Friendliness
- ✅ No external network dependencies (uses TEST-NET-1 for timeout tests)
- ✅ Proper cleanup in `afterEach` (hub stop + workspace removal)
- ✅ Permission restoration before cleanup (chmod to writable)
- ✅ Short execution time (~2.5s for full suite)

## Test Results

```
 16 pass
  1 skip
  0 fail
 38 expect() calls
Ran 17 tests across 1 file. [2.54s]
```

## Verification Commands

```bash
# Run edge-case tests
cd packages/hub
bun test src/operational.edge.test.ts

# Run all hub tests
bun test

# Typecheck
bunx tsc --noEmit
```

## Known Limitations

1. **Platform-specific behavior:** Atomic rename can overwrite read-only files on some filesystems (Windows, some POSIX). One test skipped for this reason.

2. **Timeout tests:** Health check timeout tests use non-routable IPs (TEST-NET-1) which may behave differently on systems with unusual network configurations.

3. **Permission tests:** Require POSIX-like permission model. May not work correctly on filesystems without full chmod support (e.g., FAT32, some network mounts).

## Future Enhancements

- [ ] Add process-level lock tests (check if PID is still running)
- [ ] Test concurrent lock acquisition attempts (race conditions)
- [ ] Add tests for lock file corruption scenarios
- [ ] Test behavior with symlinked workspace directories
- [ ] Add performance benchmarks for lock acquisition under contention
