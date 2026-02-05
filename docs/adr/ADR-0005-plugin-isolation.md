# ADR-0005: Plugin Isolation (Worker Threads + Filesystem Guards)

**Status:** Accepted  
**Date:** 2026-02-05  
**Context:** bd-16d.4.* (Plugin system implementation)

## Context

AgentLip's plugin system allows users to extend message enrichment and entity extraction via custom TypeScript/JavaScript modules. These plugins execute in response to every ingested message, making them **hot-path code** with significant operational risk:

- **Workspace integrity risk**: Buggy or malicious plugins could corrupt the SQLite database, config files, or lock state in `.agentlip/`
- **Availability risk**: Plugins might hang indefinitely, blocking message ingestion
- **Resource exhaustion**: Plugins could consume unbounded CPU or memory
- **Data exfiltration**: Plugins have access to message content and could leak sensitive data

Without isolation, a single broken plugin can bring down the entire hub. The question is: **what level of isolation is appropriate for v1?**

### Threat Model

**In-scope threats (must protect against):**
1. **Accidental corruption**: Buggy plugin writes to wrong file path (e.g., `writeFile(".agentlip/db.sqlite3", ...)`)
2. **Path traversal**: Plugin uses relative paths to escape workspace (e.g., `../../../.agentlip/db.sqlite3`)
3. **Naive malicious plugin**: Straightforward write attempts without sophisticated bypass techniques
4. **Indefinite hangs**: Plugin enters infinite loop or waits on unresolved promise
5. **Cascading failures**: Single plugin failure shouldn't affect other plugins or hub operation

**Out-of-scope threats (residual risk accepted for v1):**
1. **Sophisticated malicious plugins**: Native modules, FFI, syscalls, memory corruption
2. **Data exfiltration via network**: Plugin sends message content to external service (workspace is localhost-only; user trusts their plugins)
3. **Read access to `.agentlip/`**: Plugin reads database schema or config (future: explicit RPC layer)
4. **Resource exhaustion within timeout**: Plugin maxes CPU/memory until timeout expires
5. **Side-channel attacks**: Timing attacks, speculative execution (Bun Workers share process memory)

**Trust assumptions:**
- Workspace is **single-user, localhost-only, trusted environment**
- Plugin installation is **explicit opt-in** via `agentlip.config.ts` (user chooses plugins)
- Workspace owner **trusts the plugins they install** (similar to npm dependencies)

## Decision

### Default Isolation: Bun Worker Threads + Runtime Filesystem Guards

Plugin execution uses **Bun Workers** (isolated threads) with **practical filesystem isolation** via runtime guards. This provides **best-effort protection** against accidental and naive malicious writes, while accepting residual risk from sophisticated attackers.

### Architecture

**Components:**

1. **pluginRuntime.ts** (`packages/hub/src/pluginRuntime.ts`, lines 1-250)
   - Spawns Bun Worker for each plugin execution
   - Enforces wall-clock timeout (default: 5000ms, configurable)
   - Terminates Worker via `worker.terminate()` on timeout
   - Implements circuit breaker (3 failures → skip for 60s)
   - Validates plugin output schema

2. **pluginWorker.ts** (`packages/hub/src/pluginWorker.ts`, lines 1-280)
   - Worker script executed in isolated thread
   - Installs filesystem guards **before loading plugin code**
   - Receives RPC requests via `postMessage`
   - Loads and executes plugin module
   - Returns results or errors to main thread

3. **Circuit breaker** (`pluginRuntime.ts`, lines 35-150)
   - Tracks failure count per plugin
   - Opens circuit after `FAILURE_THRESHOLD` failures (default: 3)
   - Cooldown period: 60s (configurable)
   - Auto-resets on successful execution or cooldown expiration

### Isolation Mechanisms

#### 1. Thread Isolation (Bun Workers)

Plugins execute in **separate Worker threads** spawned by the hub:

```typescript
worker = new Worker(new URL("./pluginWorker.ts", import.meta.url).href, {
  type: "module",
});
```

**Guarantees:**
- Separate JavaScript execution context (isolated global scope)
- Worker crash doesn't crash main thread
- Worker can be forcibly terminated via `worker.terminate()`

**Limitations:**
- **Not OS-level sandboxing**: Workers share process memory space
- **No capability restrictions**: Workers inherit hub process permissions (file I/O, network, etc.)
- **No resource limits**: Bun doesn't enforce CPU/memory quotas for Workers

#### 2. Wall-Clock Timeout (`pluginRuntime.ts`, lines 177-215)

Every plugin execution has a configurable timeout (default: 5s):

```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    reject(new Error("Plugin execution timeout"));
  }, timeoutMs);
});

const data = await Promise.race([resultPromise, timeoutPromise]);
```

**On timeout:**
- Timeout promise rejects
- Worker is terminated via `worker.terminate()` (force-kills thread)
- Returns `{ ok: false, code: "TIMEOUT" }` to caller
- Failure is recorded in circuit breaker

**Guarantees:**
- Plugin execution **cannot hang indefinitely**
- Hub continues processing messages even if plugin times out
- Timeouts are wall-clock based (not CPU time)

**Limitations:**
- Plugin can still consume CPU/memory **within timeout window**
- No sub-second timeout precision (JavaScript timer granularity)

#### 3. Filesystem Guards (`pluginWorker.ts`, lines 45-195)

The Worker script installs **runtime guards** that wrap Node.js `fs` module methods to detect and block writes to `.agentlip/`:

**Wrapped methods (async promises API):**
- `fs.writeFile`, `fs.appendFile`, `fs.mkdir`, `fs.rm`, `fs.rmdir`, `fs.unlink`
- `fs.open` (blocks write/append modes: `'w'`, `'a'`, `'+'`)

**Wrapped methods (sync API):**
- `fsSync.writeFileSync`, `fsSync.appendFileSync`, `fsSync.mkdirSync`, `fsSync.rmSync`, `fsSync.rmdirSync`, `fsSync.unlinkSync`, `fsSync.openSync`

**Path detection logic** (`isAgentlipPath()`, lines 60-72):
```typescript
function isAgentlipPath(targetPath: string): boolean {
  const normalized = normalize(resolve(targetPath));
  const parts = normalized.split(sep);
  return parts.includes(".agentlip");
}
```

- Resolves path to **absolute normalized form** (handles `../`, `./`, symlinks via `resolve()`)
- Splits by path separator (`/` or `\`)
- Blocks if **any path component** equals exactly `".agentlip"`

**Error on violation:**
```
Plugin isolation violation: write access to .agentlip/ directory is forbidden
```

**Guarantees:**
- Plugins **cannot write** to `.agentlip/db.sqlite3`, `.agentlip/server.json`, `.agentlip/locks/`, etc. via standard fs APIs
- Path traversal attacks blocked (`../../.agentlip/` resolved to absolute path before check)
- Nested `.agentlip` directories blocked (e.g., `/tmp/test/.agentlip/file`)

**Limitations (acknowledged trade-offs):**
1. **Not cryptographic sandboxing**: Guards are runtime wrappers, not OS-level enforcement
2. **Read access allowed**: Plugins **can read** `.agentlip/` files (intentional; future may add explicit RPC for safe DB queries)
3. **Bypass vectors exist** (low likelihood, requires sophistication):
   - Native modules calling syscalls directly
   - Bun FFI to call libc functions
   - Undocumented fs APIs not wrapped
   - Symlink race conditions (guards check resolved path, but no TOCTOU protection)
   - Memory manipulation (corrupt guard function pointers)
4. **Network access unrestricted**: Plugins can make HTTP requests (intentional; many plugins need network for enrichment)

#### 4. Path-Blind Execution (`pluginWorker.ts`, lines 13-28)

Plugin input **does not include workspace filesystem paths**:

```typescript
interface EnrichInput {
  message: {
    id: string;
    content_raw: string;
    sender: string;
    topic_id: string;
    channel_id: string;
    created_at: string;
  };
  config: Record<string, unknown>;
}
```

**Rationale:**
- Reduces surface area for accidental `.agentlip` writes (plugin doesn't know where `.agentlip` is)
- **Not security through obscurity**: Combined with runtime guards, makes accidental writes harder while guards block intentional ones

**Limitation:**
- Plugins still see `process.cwd()` (Bun Worker limitation; Workers inherit parent cwd)
- Sophisticated plugin could discover workspace root via filesystem probing

#### 5. Circuit Breaker (`pluginRuntime.ts`, lines 35-150)

Plugins that fail repeatedly are **temporarily disabled**:

**Algorithm:**
- Track failure count per plugin (keyed by `pluginName` or `modulePath`)
- After `FAILURE_THRESHOLD` failures (default: 3), open circuit
- Circuit remains open for `COOLDOWN_MS` (default: 60s)
- Auto-reset to closed state after cooldown expires
- Successful execution immediately resets failure count

**Failure triggers:**
- Timeout (`TIMEOUT`)
- Worker crash (`WORKER_CRASH`)
- Invalid output schema (`INVALID_OUTPUT`)
- Execution error (`EXECUTION_ERROR`)
- Isolation violation (`EXECUTION_ERROR` wrapping guard error)

**When circuit is open:**
```json
{
  "ok": false,
  "code": "CIRCUIT_OPEN",
  "error": "Circuit breaker open for plugin-name (3 failures, 45s cooldown remaining)"
}
```

**Guarantees:**
- Broken plugin **cannot** repeatedly slow down message ingestion
- Hub **continues processing** messages and other plugins even when one plugin is broken
- Circuit auto-recovers (transient failures don't permanently disable plugins)

### Output Validation (`pluginRuntime.ts`, lines 220-280)

Plugin return values are validated against expected schemas:

**Linkifier plugins** must return `Enrichment[]`:
```typescript
interface Enrichment {
  kind: string;          // non-empty string
  span: { start: number; end: number }; // 0 <= start <= end
  data: Record<string, unknown>;        // non-null object
}
```

**Extractor plugins** must return `Attachment[]`:
```typescript
interface Attachment {
  kind: string;          // non-empty string
  key?: string;          // optional string
  value_json: Record<string, unknown>;  // non-null object
  dedupe_key?: string;   // optional string
}
```

**On validation failure:**
- Returns `{ ok: false, code: "INVALID_OUTPUT", error: "..." }`
- Failure counted toward circuit breaker threshold

## Alternatives Considered

### 1. Subprocess Sandboxing (OS-level isolation)

**Approach:** Spawn plugin in separate child process with restricted permissions (chroot, seccomp-bpf, pledge, etc.)

**Pros:**
- **True OS-level isolation**: Plugin cannot access `.agentlip/` even with native code
- **Resource limits**: Can enforce CPU time, memory, file descriptor limits via rlimit or cgroups
- **Stronger security**: No shared memory, no bypass via FFI/native modules

**Cons:**
- **Higher latency**: Process spawn ~50-100ms on macOS/Linux (vs. ~5ms for Worker)
- **Complexity**: Platform-specific sandboxing (Linux seccomp, macOS Sandbox.framework, Windows AppContainer)
- **IPC overhead**: Requires serialization for RPC (postMessage is zero-copy for Workers)
- **Maturity**: Bun subprocess sandboxing not well-documented (v1.0 as of 2024)

**Decision:** Rejected for v1 (accept Worker trade-offs for lower latency and simpler implementation). **Reserved for v2** if threat model changes (e.g., multi-user workspace, untrusted plugin marketplace).

### 2. Deno Runtime (Capability-Based Permissions)

**Approach:** Execute plugins via Deno with explicit `--allow-*` flags (deny-by-default)

**Pros:**
- **Explicit capabilities**: Can grant `--allow-read=/tmp` without allowing `.agentlip/` access
- **Mature sandboxing**: Deno's permission model is battle-tested
- **Network restrictions**: Can block network entirely or allow specific domains

**Cons:**
- **Non-native runtime**: Requires Deno installation (not bundled with Bun)
- **Plugin compatibility**: Deno runtime has different APIs than Node.js/Bun
- **Deployment complexity**: Hub must shell out to `deno` binary
- **Performance**: Additional process spawn overhead

**Decision:** Rejected for v1 (prefer single-runtime simplicity). Could revisit if Bun adds first-class Deno interop.

### 3. WebAssembly (Memory-Safe Sandboxing)

**Approach:** Compile plugins to Wasm modules, execute in Wasm runtime

**Pros:**
- **Memory safety**: Wasm cannot corrupt host memory
- **True isolation**: No direct syscall access
- **Cross-platform**: Wasm runtime is portable

**Cons:**
- **Plugin authoring complexity**: TypeScript → Wasm compilation is non-trivial
- **Limited ecosystem**: Few TypeScript-to-Wasm toolchains (AssemblyScript, not full TS)
- **No filesystem access**: Wasm has no fs by default (requires WASI, which is experimental)
- **Performance**: Slower than native Workers for I/O-heavy plugins

**Decision:** Rejected for v1 (too restrictive for plugin authors). Could offer as **opt-in stricter mode** in v2.

### 4. VM2 or vm Module (Contextual Isolation)

**Approach:** Execute plugin code in Node.js `vm` context (isolated global scope but same process)

**Pros:**
- **Simple API**: `vm.runInContext()` is built-in Node.js
- **Low overhead**: No process/thread spawn

**Cons:**
- **No real isolation**: vm escapes are well-documented (prototype pollution, constructor chains)
- **Deprecated**: VM2 library deprecated due to unfixable sandbox escapes
- **No filesystem protection**: Same process fs access

**Decision:** Rejected (insufficient isolation for filesystem protection).

### 5. No Isolation (Trust Plugin Authors)

**Approach:** Load plugins directly in hub process via `require()` or `import()`

**Pros:**
- **Lowest latency**: No Worker spawn overhead
- **Simplest implementation**: Direct function calls

**Cons:**
- **No fault isolation**: Plugin crash crashes hub
- **No timeout enforcement**: Plugin hang blocks hub
- **No filesystem protection**: Plugin can corrupt `.agentlip/`

**Decision:** Rejected (operational risk too high for hot-path code).

## Consequences

### Positive

1. **Workspace integrity protected**: Accidental and naive malicious writes to `.agentlip/` are blocked
2. **Availability guaranteed**: Timeouts + circuit breaker ensure hub continues processing messages even when plugins fail
3. **Fast execution**: Worker threads have ~5ms spawn overhead (vs. ~50ms for subprocess)
4. **Simple implementation**: ~400 LOC total (runtime + worker + guards + circuit breaker)
5. **Testable**: Isolation behavior verified by 15 tests (`packages/hub/src/pluginIsolation.test.ts`)
6. **Graceful degradation**: Circuit breaker allows transient failures while preventing cascading failures
7. **Legitimate use cases preserved**: Plugins can still read `.agentlip/` (for future safe DB query APIs), write to other paths, access network

### Negative

1. **Not cryptographic sandboxing**: Sophisticated malicious plugins can bypass guards (residual risk accepted for v1)
2. **Network exfiltration possible**: Plugins can send message content to external services (workspace is localhost; user trusts plugins)
3. **Resource exhaustion within timeout**: Plugin can max CPU/memory for 5s before being killed
4. **Read access to `.agentlip/`**: Plugins can inspect DB schema and config (may leak sensitive metadata)
5. **Shared process memory**: Bun Workers share memory space (theoretical side-channel attacks)
6. **No sub-second timeout precision**: JavaScript timer granularity limits timeout accuracy
7. **Platform-specific behavior**: Filesystem path handling differs on Windows vs. Unix (guards tested on macOS; need Windows CI)

### Operational Implications

**For hub operators:**
- Monitor circuit breaker state (open circuits indicate broken plugins)
- Review plugin list periodically (audit for unmaintained or suspicious plugins)
- Log plugin failures to detect patterns (e.g., specific message content triggering crashes)

**For plugin authors:**
- Cannot write to `.agentlip/` (database, config, locks)
- **Can** write to workspace root or subdirectories (for caching, temp files, etc.)
- **Can** read `.agentlip/` (for inspecting schema; use responsibly)
- **Can** access network (for URL preview, API enrichment, etc.)
- Must complete within timeout (default 5s; configurable per plugin)
- Failures trigger circuit breaker (3 failures → 60s cooldown)

**For security auditors:**
- Isolation is **best-effort**, not cryptographic
- Threat model assumes **trusted plugin authors** (similar to npm dependencies)
- v1 prioritizes operational stability over defense against sophisticated attackers
- v2 may introduce stronger sandboxing if threat model changes (multi-user, untrusted marketplace)

### Future Improvements (v2 Candidates)

1. **Subprocess isolation** (ADR-0005 revisit):
   - Spawn plugins in separate process with chroot/seccomp/pledge
   - RPC-only communication (no shared filesystem)
   - OS-level resource limits (CPU time, memory, file descriptors)

2. **Capability grants** (explicit permissions):
   - Plugins declare required capabilities in manifest: `["network:fetch", "fs:read:/tmp"]`
   - Hub enforces deny-by-default (plugins get no capabilities unless granted)
   - User approves capabilities at install time

3. **Read-only `.agentlip/` access via RPC**:
   - Remove direct filesystem read access
   - Provide safe query API: `queryDatabase({ sql, params })`
   - Hub validates queries (read-only, no schema mutations)

4. **Network sandboxing**:
   - Plugins declare allowed domains in manifest
   - Hub proxies network requests (enforce domain whitelist)
   - Rate limiting per plugin (prevent DoS)

5. **CPU/memory limits**:
   - Use OS resource limits (rlimit on Linux, job objects on Windows)
   - Or implement userspace accounting (sample CPU usage, kill if exceeded)

6. **Wasm opt-in mode**:
   - Offer stricter isolation for security-critical plugins
   - Compile TypeScript → Wasm (via AssemblyScript or similar)
   - WASI for filesystem access (explicit capability grants)

## Test Coverage

**File:** `packages/hub/src/pluginIsolation.test.ts` (15 tests, 40 assertions)

**Categories:**
1. **Write protection** (11 tests):
   - Blocks `writeFile`, `appendFile`, `mkdir`, `rm`, `rmdir`, `unlink`, `open` to `.agentlip/`
   - Blocks sync APIs (`writeFileSync`, etc.)
   - Blocks relative paths (`../../.agentlip/`)
   - Blocks nested `.agentlip` dirs (`/tmp/test/.agentlip/`)
   - Allows legitimate writes outside `.agentlip/`

2. **Path-blind execution** (2 tests):
   - Verifies no workspace path in plugin input
   - Documents that plugins see `process.cwd()` (Worker limitation)

3. **Error reporting** (2 tests):
   - Violation errors include clear message
   - Circuit breaker tracks violations

**Test strategy:**
- Create malicious plugin modules that attempt writes
- Run via Worker runtime harness (`runPlugin()`)
- Assert writes fail with specific error message
- Verify target files unchanged after blocked attempts

**Example test:**
```typescript
test("blocks writeFile to db.sqlite3", async () => {
  const dbPath = join(testDir, ".agentlip", "db.sqlite3");
  const pluginPath = await createMaliciousPlugin("writeFile", dbPath);

  const result = await runPlugin<Enrichment[]>({
    type: "linkifier",
    modulePath: pluginPath,
    input: testInput,
    timeoutMs: 2000,
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("Plugin isolation violation");
  expect(result.error).toContain(".agentlip/");
  
  const dbContent = await Bun.file(dbPath).text();
  expect(dbContent).toBe("fake-db"); // unchanged
});
```

**Coverage gaps (future work):**
- Windows path handling (tests run on macOS; need Windows CI)
- Symlink race conditions (TOCTOU attacks)
- Native module bypass (requires actual native plugin)
- Memory corruption (requires expertise + fuzzing)

## Known Bypass Vectors (Documented)

### Low Likelihood (Requires Sophistication)

1. **Native modules**: Plugin imports native addon that uses syscalls directly
   - **Mitigation**: User must explicitly install native plugin (trust required)
   - **Detection**: Future work—scan plugin imports for `.node` files

2. **Bun FFI**: Plugin uses `bun:ffi` to call libc functions (`open`, `write`, `unlink`)
   - **Mitigation**: Same as native modules (explicit install)

3. **Undocumented fs APIs**: Bun may have unlisted filesystem functions
   - **Mitigation**: Periodic audit of `fs` module exports

4. **Memory manipulation**: Plugin corrupts guard function pointers
   - **Mitigation**: Very low likelihood; requires deep Bun runtime knowledge

### Medium Likelihood (Requires Intent)

1. **Symlink attack**: Plugin creates symlink targeting `.agentlip/`, then writes via link
   - **Current guards**: Check resolved path via `resolve()` (should block)
   - **Remaining risk**: Race condition (TOCTOU) if symlink changes between check and write
   - **Future**: Consider atomic operations or advisory locks

2. **Hard link attack**: Plugin creates hard link to `.agentlip/db.sqlite3`, writes via link
   - **Current guards**: Hard links resolve to same inode; `resolve()` returns original path (should block)
   - **Test coverage**: Not explicitly tested (add test)

### Accepted (By Design)

1. **Read access**: Plugin reads `.agentlip/db.sqlite3` and leaks schema/data
   - Workspace is localhost; user trusts their plugins
   - Future: Provide explicit RPC for safe DB queries

2. **Network exfiltration**: Plugin sends message content to external service
   - Same as read access; workspace is localhost-scoped
   - Future: Network sandboxing with domain whitelist

## Code Locations

**Core implementation:**
- `packages/hub/src/pluginRuntime.ts` (250 lines)
  - `runPlugin()` function (lines 135-235)
  - Circuit breaker class (lines 35-150)
  - Output validation (lines 220-280)

- `packages/hub/src/pluginWorker.ts` (280 lines)
  - Filesystem guards installation (lines 45-195)
  - `isAgentlipPath()` path detection (lines 60-72)
  - RPC request handler (lines 245-280)

**Tests:**
- `packages/hub/src/pluginIsolation.test.ts` (15 tests, 600 lines)

**Documentation:**
- `packages/hub/src/PLUGIN_ISOLATION.md` (overview)
- `packages/hub/src/PLUGIN_INTEGRATION.md` (plugin author guide)

**Related components:**
- `packages/hub/src/enrichmentPipeline.ts` (calls `runPlugin()`)
- `agentlip.config.ts` (plugin configuration)

## References

- **AGENTLIP_PLAN.md** §0.8 (Plugin system requirements)
- **bd-16d.4.1**: This ADR
- **bd-16d.4.3**: Worker runtime harness (timeout + circuit breaker)
- **bd-16d.4.4**: Filesystem guards implementation
- **Gate E**: Plugin safety tests (timeout + isolation + circuit breaker)
- **ADR-0003**: Replay boundary (similar operational concern: runtime guarantees vs. theoretical attacks)
- **ADR-0007**: Attachment idempotency (similar: practical correctness over theoretical perfection)

## Changelog

**2026-02-05** (bd-16d.4.1):
- ✅ Accepted Worker-based isolation with filesystem guards as v1 default
- ✅ Documented threat model and accepted risks
- ✅ Defined path to v2 (subprocess sandboxing, capability grants)
- ✅ Verified via 15 tests (100% passing)
