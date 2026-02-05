# Plugin Isolation (bd-16d.4.4)

## Overview

Plugin isolation prevents plugins from writing to the `.zulip/` directory (db.sqlite3, server.json, locks). This protects workspace integrity by ensuring only the hub can mutate canonical state.

**Implementation date**: Feb 2026  
**Status**: ✅ Implemented with runtime filesystem guards  
**Tests**: 15 tests, 40 assertions (all passing)  
**Approach**: Practical isolation via runtime guards (not cryptographic sandboxing)

---

## Isolation Strategy

### Runtime Filesystem Guards

The plugin Worker script (`pluginWorker.ts`) installs filesystem guards **before** loading plugin code. These guards wrap Node.js `fs` methods (both async promises API and sync API) to detect and block write attempts to `.zulip/`.

**Wrapped methods** (async):
- `fs.writeFile`
- `fs.appendFile`
- `fs.mkdir`
- `fs.rm`
- `fs.rmdir`
- `fs.unlink`
- `fs.open` (blocks write/append modes)

**Wrapped methods** (sync):
- `fsSync.writeFileSync`
- `fsSync.appendFileSync`
- `fsSync.mkdirSync`
- `fsSync.rmSync`
- `fsSync.rmdirSync`
- `fsSync.unlinkSync`
- `fsSync.openSync` (blocks write/append modes)

**Path detection logic**:
```typescript
function isZulipPath(targetPath: string): boolean {
  const normalized = normalize(resolve(targetPath));
  const parts = normalized.split(sep);
  return parts.includes(".zulip");
}
```

- Resolves paths to absolute normalized form
- Checks if any path component equals `.zulip`
- Blocks relative paths (e.g., `../workspace/.zulip/`)
- Blocks nested .zulip directories

**Error on violation**:
```
Plugin isolation violation: write access to .zulip/ directory is forbidden
```

### Path-Blind Execution

Plugins receive **no workspace path context** in their input:

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

- No filesystem paths in message metadata
- No `workspace_root` or `.zulip` location
- Plugins must use explicit paths or config-provided paths

This is **practical obscurity**, not security through obscurity—it makes accidental writes harder while the guards block intentional ones.

---

## Guarantees (v1)

### ✅ Strong Guarantees

1. **Write blocking**: Plugins **cannot** write to `.zulip/` via standard fs APIs
2. **DB protection**: `db.sqlite3` is protected from plugin writes
3. **Config protection**: `server.json` is protected from plugin writes
4. **Lock protection**: `.zulip/locks/` is protected from plugin writes
5. **Error clarity**: Violations produce clear error messages
6. **Circuit breaker integration**: Violations count as failures (opens circuit after 3)
7. **Legitimate writes allowed**: Plugins can write outside `.zulip/`

### ⚠️ Limitations (v1)

These are **by design** trade-offs for the Worker-based approach:

1. **Not cryptographic sandboxing**: Guards are runtime wrappers, not OS-level enforcement
2. **Sophisticated bypass possible**: A plugin could:
   - Use native modules or FFI to bypass guards
   - Attempt syscalls directly (platform-dependent)
   - Use undocumented fs APIs not wrapped
3. **Read access allowed**: Plugins **can** read `.zulip/` (e.g., to inspect schema)
   - Rationale: Read-only DB access may be useful for plugins (future RPC layer)
   - Risk: Plugins could leak sensitive data (workspace-local only)
4. **Network access allowed**: Plugins can make HTTP requests
   - Rationale: Many legitimate plugins need network (URL preview, API enrichment)
   - Risk: Exfiltration of message content (workspace is localhost-only)
5. **Process memory shared**: Worker threads share process memory
   - Risk: Memory corruption or side-channel attacks (low likelihood)
6. **No CPU/memory limits**: Bun Workers don't enforce resource limits
   - Mitigated by: wall-clock timeout + circuit breaker

---

## Security Posture

### Threat Model

**In scope (protected)**:
- Accidental writes by buggy plugins
- Naive malicious plugins attempting straightforward writes
- Path traversal attacks (`../../../.zulip/`)

**Out of scope (residual risk)**:
- Sophisticated malicious plugins with native code
- Memory corruption or side-channel attacks
- Data exfiltration via network (workspace is localhost-scoped)
- CPU/memory exhaustion (mitigated by timeout + circuit breaker)

### Risk Acceptance

**Accepted risks for v1**:
1. Plugin can read `.zulip/` (future: explicit RPC for DB queries)
2. Plugin can access network (future: capability grants)
3. Plugin can consume CPU until timeout (future: CPU-based limits)
4. Plugin can leak data via network (workspace is localhost; user trusts their plugins)

**Rationale**:
- Workspace is **single-user, localhost-only, trusted environment**
- Plugin installation is explicit (user enables plugins in `zulip.config.ts`)
- True sandboxing requires subprocess (ADR-0005 reserved for v2)

---

## Testing

### Test Coverage

**File**: `packages/hub/src/pluginIsolation.test.ts`

**Categories**:
1. **Write protection** (11 tests):
   - Blocks writeFile, appendFile, mkdir, rm, rmdir, unlink, open
   - Blocks sync APIs (writeFileSync, etc.)
   - Blocks relative paths, nested .zulip dirs
   - Allows legitimate writes outside .zulip
2. **Path-blind execution** (2 tests):
   - Verifies no workspace path in plugin input
   - Documents that plugins see process cwd (Worker limitation)
3. **Error reporting** (2 tests):
   - Violation errors include clear context
   - Circuit breaker tracks violations

**Test strategy**:
- Create malicious plugins that attempt writes
- Run via Worker runtime harness (`runPlugin`)
- Assert writes fail with specific error message
- Verify files unchanged after blocked attempts

**Example test**:
```typescript
test("blocks writeFile to db.sqlite3", async () => {
  const dbPath = join(testDir, ".zulip", "db.sqlite3");
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
  expect(result.error).toContain(".zulip/");
  
  // Verify db.sqlite3 unchanged
  const dbContent = await Bun.file(dbPath).text();
  expect(dbContent).toBe("fake-db");
});
```

---

## Known Bypass Vectors (Documented)

### Low Likelihood (Requires Sophistication)

1. **Native modules**: Plugin imports native code that uses syscalls directly
   - Mitigation: User must explicitly install native plugin (trust required)
   - Detection: Future work—scan plugin imports for native modules
2. **FFI**: Plugin uses Bun FFI to call libc functions
   - Mitigation: Same as native modules (explicit install)
3. **Undocumented fs APIs**: Node/Bun may have unlisted fs functions
   - Mitigation: Periodic audit of fs module exports
4. **Memory manipulation**: Plugin corrupts guard function pointers
   - Mitigation: Very low likelihood; requires deep runtime knowledge

### Medium Likelihood (Requires Intent)

1. **Symlink attack**: Plugin creates symlink targeting `.zulip/`, then writes via link
   - Current guards: Check path components, not resolved targets
   - Future: Resolve symlinks before path check
2. **Race condition**: Plugin writes between guard check and actual write
   - Current guards: No TOCTOU protection
   - Future: Consider atomic operations or advisory locks

### Accepted (By Design)

1. **Read access**: Plugin reads `db.sqlite3` and leaks content
   - Workspace is localhost; user trusts their plugins
2. **Network exfiltration**: Plugin sends message content to external service
   - Same as read access; workspace is localhost-scoped

---

## Future Improvements

### v2: Subprocess Isolation (ADR-0005)

- Spawn plugin in separate process with no filesystem access
- RPC-only communication (postMessage equivalent)
- OS-level enforcement (chroot, seccomp, etc.)
- Trade-off: Higher latency (process spawn ~50ms)

### v2: Capability Grants

- Explicit plugin permissions in `zulip.config.ts`:
  ```typescript
  plugins: [{
    name: "url-extractor",
    capabilities: ["network:fetch", "fs:read:/tmp"]
  }]
  ```
- Deny-by-default (plugins get no capabilities unless granted)

### v2: Resource Limits

- CPU time limits (RLIMIT_CPU or cgroup)
- Memory limits (RLIMIT_AS or cgroup)
- Network rate limits (iptables or userspace proxy)

### v2: Wasm/Deno Sandboxing

- Compile plugins to WebAssembly (true memory isolation)
- Or use Deno runtime (explicit permissions model)
- Trade-off: More restrictive plugin API

---

## Code Locations

**Core implementation**:
- `packages/hub/src/pluginWorker.ts` (lines 1-150)
  - Filesystem guards installation
  - Path detection logic

**Tests**:
- `packages/hub/src/pluginIsolation.test.ts` (15 tests, 600 lines)

**Related components**:
- `packages/hub/src/pluginRuntime.ts` (Worker spawn + timeout)
- `packages/hub/src/PLUGIN_INTEGRATION.md` (integration guide)

---

## Operational Notes

### For Hub Operators

- **Trust model**: Plugins run in workspace owner's security context
- **Plugin installation**: Explicit opt-in via `zulip.config.ts`
- **Violation logging**: Circuit breaker emits warnings after 3 failures
- **Monitoring**: Track `CIRCUIT_OPEN` errors (indicator of malicious plugin)

### For Plugin Authors

- **Write access**: You **cannot** write to `.zulip/` (db, config, locks)
- **Read access**: You **can** read `.zulip/` (but future may restrict)
- **Network access**: You **can** make HTTP requests (workspace is localhost)
- **Legitimate writes**: You **can** write to any path outside `.zulip/`
- **Error handling**: Violations fail plugin execution (counts toward circuit breaker)

### For Security Auditors

- **Isolation level**: Practical (runtime guards), not cryptographic (OS-level)
- **Threat model**: Defense against buggy/naive plugins, not sophisticated attackers
- **Residual risks**: See "Security Posture" section above
- **Mitigation path**: Subprocess isolation in v2 (ADR-0005)

---

## References

- **ADR-0005**: Plugin isolation and timeouts
- **bd-16d.4.3**: Worker runtime harness (prerequisite)
- **bd-16d.4.4**: This implementation (plugin write protection)
- **Gate E**: Plugin safety tests (timeout + isolation)
- **AGENTLIP_PLAN.md**: Section 0.14 (plugin isolation requirements)

---

## Changelog

**2026-02-05** (bd-16d.4.4):
- ✅ Implemented runtime filesystem guards
- ✅ Added 15 isolation tests (100% passing)
- ✅ Documented limitations and residual risks
- ✅ Integrated with circuit breaker
- ✅ Verified via typecheck + full test suite
