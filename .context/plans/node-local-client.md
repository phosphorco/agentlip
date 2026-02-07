# Node-compatible default local client (`connectToLocalAgentlip`)

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal and Motivation

Ship a **Node v22+ (ESM-only)** "default local client" that:

- discovers the current Agentlip workspace (from `cwd`)
- finds an already-running local hub via `.agentlip/server.json` + `/health`
- otherwise starts the **Bun-only hub daemon** via `node:child_process` (requires system `bun`)
- establishes WebSocket streaming + HTTP mutation wiring

Primary UX target:

```ts
import { connectToLocalAgentlip } from "agentlip/local-client"

const al = await connectToLocalAgentlip({ cwd, signal })
await al.sendMessage({ topicId, sender: "agent", contentRaw: "hello" })
const ev = await al.waitForEvent((e) => e.name === "message.created", { signal })
await al.close()
```

Secondary goal: avoid leaving stray daemons around by enabling **idle auto-shutdown** when the hub is started by the local client.

## Scope

Delivers:

- `@agentlip/client/local` export implementing `connectToLocalAgentlip()`
- `agentlip/local-client` re-export for convenience
- child-process startup path for Bun hub (requires `bun` installed)
- idle auto-shutdown behavior in hub (configurable; local client enables it)
- tests covering: discovery-only, start-and-connect, stale server.json, abort during start, idle shutdown

Excludes (v1):

- bundling an embedded Bun executable (`bun build --compile`) for npm distribution
- Node-native hub implementation (hub remains Bun-only)
- remote / multi-host discovery
- CJS support

## Non-negotiables / engineering contract

- Hub bind remains localhost-only (existing `assertLocalhostBind` stays enforced).
- Do not leak auth token into logs **or process argument lists** (never pass token via CLI args; prefer reading it from `server.json`).
- `server.json` must be written with restrictive file permissions (mode `0600`) since it contains the auth token.
- `connectToLocalAgentlip()` must be cancellation-safe via `AbortSignal`.
- Starting a hub must be race-safe when multiple processes attempt it (writer lock remains the source of truth).
- Orphan hub mitigation: when `connectToLocalAgentlip()` spawns a hub, idle-shutdown must be enabled (non-optional for spawned hubs) to prevent strays if the parent crashes.

## Codebase Context

| Area | Path | Notes |
|---|---|---|
| Workspace discovery | `packages/workspace/src/index.ts` | `discoverOrInitWorkspace`, home/device boundary |
| server.json | `packages/client/src/serverJson.ts` + `packages/hub/src/serverJson.ts` | read/validate vs write/cleanup |
| WS client | `packages/client/src/ws.ts` | reconnect + replay; currently uses global `WebSocket` |
| HTTP mutations | `packages/client/src/mutations.ts` | `sendMessage`, etc |
| Hub startup | `packages/hub/src/index.ts` | `startHub({ workspaceRoot })` writes lock + server.json |
| Hub daemon CLI | `packages/hub/src/agentlipd.ts` | currently only `status` command (docs mention `up`) |
| CLI package (unscoped) | `packages/cli/package.json` | published name `agentlip`; Bun runtime guard in bin |

## Key decisions / ADRs (locked for this plan)

1. **Hub remains Bun-only**; local client starts it via `child_process.spawn()`.
2. **System `bun` is required** (no embedded executable yet).
3. **Node v22+, ESM-only** for the local client API surface.
4. Implement in `@agentlip/client/local` and re-export via `agentlip/local-client`.

## Controversial forks (need explicit decision)

### Fork A - How to ship Node-compatible code (runtime TS vs build output)

Node cannot reliably import `.ts` from npm without additional flags/loaders.

Options:

1) **Build dist JS for Node packages** (`@agentlip/client`, `@agentlip/workspace`, `@agentlip/protocol`) and use conditional exports.
- Pros: actually works in plain Node
- Cons: adds build step for publish/CI; slightly more packaging complexity

2) Rely on Node's TypeScript type-stripping / loaders.
- Pros: no build pipeline
- Cons: fragile; requires runtime flags and varying Node behavior

**Recommendation:** Option (1).

### Fork B - Idle shutdown default vs opt-in

Options:

1) Default-on idle shutdown in daemon mode.
- Pros: fewer strays
- Cons: surprising for users who expect hub to stay up between tasks

2) **Opt-in via flag/env**; local client enables by default when it started the hub.
- Pros: no behavior change for manual `agentlipd up`
- Cons: requires wrapper to pass option

**Recommendation:** Option (2).

### Fork C - WebSocket client implementation in Node

`@agentlip/client/wsConnect()` currently uses a global `WebSocket` constructor.

Options:

1) Require Node versions where `globalThis.WebSocket` is available (Node 22+ assumption) and fail fast with a clear error if missing.
- Pros: no dependency
- Cons: if Node's WebSocket is experimental/absent on some 22.x versions, users get runtime failures

2) Accept an injected WebSocket implementation in `connectToLocalAgentlip({ webSocketImpl })`.
- Pros: lets users bring their own (`ws`, `undici`) without us depending on it
- Cons: slightly worse DX

3) Add an optional dependency/peerDependency on `ws` as a fallback.
- Pros: robust
- Cons: adds dependency (user preference is to avoid this if possible)

**Recommendation:** Option (2) with a default of `globalThis.WebSocket`.

### Fork D - Mutation surface on LocalAgentlipClient

`LocalAgentlipClient` needs to expose HTTP mutations. Options:

1) Expose only `sendMessage` (most common use case).
   - Pros: simpler surface
   - Cons: users must import other mutations separately and manage baseUrl/authToken

2) **Expose all mutations** (sendMessage, createChannel, createTopic, editMessage, deleteMessage, etc.) as bound methods.
   - Pros: complete API; no need for manual wiring
   - Cons: slightly larger interface

**Recommendation:** Option (2) - expose all mutations as bound methods.

---

## Error Contract

### Startup errors (from `connectToLocalAgentlip`)

| Error class | Condition |
|---|---|
| `WorkspaceNotFoundError` | No `.agentlip/` found and could not initialize (e.g., crossed device boundary) |
| `BunNotFoundError` | `startIfMissing` is true but `bun` executable not found on PATH / at `bunPath` |
| `HubStartTimeoutError` | Hub did not become healthy within `startTimeoutMs` |
| `AbortError` | `signal` was aborted during startup |
| `ProtocolVersionMismatchError` | Hub is running but its protocol version doesn't match client |

### Runtime errors (from client methods)

| Error class | Condition |
|---|---|
| `WaitTimeoutError` | `waitForEvent` exceeded `timeoutMs` without matching event |
| `AbortError` | `signal` was aborted during `waitForEvent` |
| `ConnectionClosedError` | WebSocket closed before `waitForEvent` matched (or during `events()` iteration) |
| `MutationError` | HTTP mutation failed (wraps status code + body); check `.statusCode` and `.response` |

All error classes extend `Error` and should be exported from `@agentlip/client/local` for programmatic handling.

**Reconnect behavior:** The underlying `wsConnect` already implements reconnect with replay. If the WS connection drops and reconnects, `events()` continues seamlessly. However, if reconnect fails repeatedly (existing WS client behavior), `ConnectionClosedError` is thrown. `waitForEvent` will reject on connection close; callers should handle this by re-calling `connectToLocalAgentlip()` if needed.

---

## Gate 1 - Add hub idle auto-shutdown (opt-in)

### Deliverables

- Add new option to hub startup:
  - `StartHubOptions.idleShutdownMs?: number` (or env `AGENTLIP_IDLE_SHUTDOWN_MS`)
  - only active when `workspaceRoot` is set (daemon mode)
- Implement idle detection:
  - track `lastActivityMs` (any non-`/health` HTTP request, WS open/close, WS handshake, **and** incoming WS messages)
  - consider hub "active" if there is any connected WS client
  - **check interval:** `Math.min(idleShutdownMs / 4, 30_000)` (balance responsiveness vs CPU; e.g., 45s for 180s idle)
  - idle timer must be cleared on any shutdown path (graceful SIGTERM, crash, or idle-triggered) to avoid dangling intervals
  - if **no WS clients** and `Date.now() - lastActivityMs > idleShutdownMs`, trigger graceful shutdown (`hub.stop()`), then `process.exit(0)`

### Acceptance criteria

- When enabled, hub exits within ~`idleShutdownMs + checkInterval` of idleness.
- server.json and writer.lock are removed on idle shutdown (same guarantees as normal shutdown).
- **server.json is written with mode `0600`** (owner-only read/write) since it contains the auth token.
- When disabled, no behavioral change.
- **Shutdown race safety:** The idle check must not initiate shutdown if activity occurred between the check and shutdown initiation. Implementation: re-verify `lastActivityMs` and WS client count inside the shutdown path, abort if activity detected.

### Tests

- hub: start in daemon mode with `idleShutdownMs=200` and no activity → exits and cleans up.
- hub: with WS client connected → does not exit.
- hub: server.json is created with mode `0600` (verify via `fs.stat`).
- hub: activity during idle check does not cause shutdown (race safety test — send request right as idle period elapses, verify hub stays up).

---

## Gate 2 - Implement `agentlipd up` (Bun CLI) with idle-shutdown flag

### Deliverables

Extend `packages/hub/src/agentlipd.ts`:

- New command: `up`
  - `agentlipd up [--workspace <path>] [--host 127.0.0.1] [--port 0] [--idle-shutdown-ms 180000] [--json]`
  - uses `discoverOrInitWorkspace()` (or `discoverWorkspaceRoot` + `ensureWorkspaceInitialized`) to resolve workspace root
  - calls `startHub({ host, port, workspaceRoot, idleShutdownMs })`
  - stays running until signal or idle shutdown
  - prints connection info (host/port + workspaceRoot), but never prints auth token

### Acceptance criteria

- `agentlipd up` creates server.json (mode `0600`) and holds writer lock.
- Auth token is never accepted as a CLI argument and is never printed. Hub token is generated/reused internally by `startHub()` and persisted to `server.json` (mode `0600`).
- Second `agentlipd up` in same workspace fails with a clear error due to writer lock.
- Graceful shutdown on SIGINT/SIGTERM.
- **Exit codes:** 0 = clean shutdown; 1 = error; 10 = lock conflict (distinct code allows parent to distinguish "already running" from crash).
- **Stderr logging:** On lock conflict or startup failure, print structured message to stderr (includes workspace path, reason) so parent process can capture and surface diagnostics.

### Tests

- cli: `agentlipd up` starts and holds lock; second instance exits with code 10.
- cli: SIGINT triggers graceful shutdown with cleanup.
- cli: missing auth token env/config is OK; token is written only to `server.json` (mode `0600`) and must not appear in stdout/stderr, including `--json` output.

---

## Gate 3 - Implement `connectToLocalAgentlip()` in `@agentlip/client/local`

**Prerequisite:** The `wsConnect` interface change (adding `webSocketImpl` parameter) is part of this gate's deliverables, not Gate 5. See "Interface change" section below.

### Interface change: wsConnect

Update `packages/client/src/ws.ts` → `wsConnect()` to accept an optional `webSocketImpl`:

```ts
export interface WsConnectOptions {
  url: string
  authToken: string
  afterEventId?: number
  subscriptions?: { channels?: string[]; topics?: string[] }
  /** Default: globalThis.WebSocket. Inject for Node compat. */
  webSocketImpl?: typeof WebSocket
}
```

The implementation must:
1. Default to `globalThis.WebSocket` if not provided.
2. Throw a clear error if no WebSocket is available: `"WebSocket not available. Pass webSocketImpl option or use Node 22+."`
3. Use the injected constructor for all WebSocket instantiation (including reconnects).

### API surface

```ts
export interface ConnectToLocalAgentlipOptions {
  cwd?: string
  signal?: AbortSignal
  /** default: true */
  startIfMissing?: boolean
  /**
   * default: "bun"
   * Security: If provided, must be an absolute path or bare command name (no path traversal).
   * The implementation must validate this before spawning.
   */
  bunPath?: string
  /** default: 180000 (3min), only applied if this call starts the hub */
  idleShutdownMs?: number
  /** default: 10_000 */
  startTimeoutMs?: number
  /** WS resume cursor */
  afterEventId?: number
  /** optional WS filters; default wildcard */
  subscriptions?: { channels?: string[]; topics?: string[] }
  /**
   * WebSocket constructor to use. Default: globalThis.WebSocket.
   * Allows Node users on older versions or custom environments to inject `ws` or `undici` WebSocket.
   * Must be API-compatible with the standard WebSocket constructor.
   */
  webSocketImpl?: typeof WebSocket
}

export interface LocalAgentlipClient {
  readonly workspaceRoot: string
  readonly baseUrl: string
  readonly authToken: string
  readonly startedHub: boolean

  /**
   * All mutations are bound to this client's baseUrl/authToken.
   * Signatures match the standalone functions from `@agentlip/client/mutations`
   * but without the `client` first argument (it's captured in the closure).
   */
  sendMessage(args: SendMessageArgs): Promise<SendMessageResult>
  createChannel(args: CreateChannelArgs): Promise<CreateChannelResult>
  createTopic(args: CreateTopicArgs): Promise<CreateTopicResult>
  editMessage(args: EditMessageArgs): Promise<EditMessageResult>
  deleteMessage(args: DeleteMessageArgs): Promise<DeleteMessageResult>
  // Note: Arg/Result types are re-exported from `@agentlip/client/local`

  /**
   * Async iterator over incoming events (filtered by subscriptions).
   * Closes when close() is called or connection drops.
   */
  events(): AsyncIterableIterator<EventEnvelope>

  /**
   * Wait for a specific event matching predicate.
   * Rejects with WaitTimeoutError if timeoutMs exceeded.
   * Rejects with AbortError (standard DOMException) if signal aborts.
   * Rejects with ConnectionClosedError if connection closes before match.
   */
  waitForEvent(
    predicate: (e: EventEnvelope) => boolean,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<EventEnvelope>
  // Note: EventEnvelope is re-exported from `@agentlip/client/local`

  /**
   * Close the WebSocket connection and release resources.
   * If this client spawned the hub and no other clients are connected,
   * the hub will idle-shutdown after idleShutdownMs.
   * 
   * Pending waitForEvent() calls will reject with ConnectionClosedError.
   * The events() iterator will terminate.
   * 
   * Idempotent: calling close() multiple times is safe (subsequent calls are no-ops).
   */
  close(): Promise<void>
}

export function connectToLocalAgentlip(opts?: ConnectToLocalAgentlipOptions): Promise<LocalAgentlipClient>
```

### Behavior

- **Validate inputs:**
  - If `bunPath` is provided, reject if it contains path traversal (`..`) or shell metacharacters; allow only absolute paths or bare command names.
- Resolve workspace via `discoverOrInitWorkspace(opts.cwd)`.
- Attempt hub discovery: read `server.json` via existing `readServerJson()` from `@agentlip/client`, then call `/health` to validate.
  - **Stale server.json handling:** If server.json exists but `/health` fails (connection refused, timeout, or wrong protocol version), treat as stale. The subsequent spawn attempt will acquire the writer lock (stale server.json without a live lock holder can be overwritten).
- If not found and `startIfMissing !== false`:
  - spawn a Bun daemon child process using `bun x` so we don't require `@agentlip/hub` to be installed as a Node dependency:
    - command shape: `<bunPath> x --bun -p @agentlip/hub@<matchingVersion?> agentlipd up --workspace <workspaceRoot> --idle-shutdown-ms <idleShutdownMs> [--host 127.0.0.1] [--port 0]`
    - If version pinning is unavailable, omit `@<matchingVersion?>` and rely on `/health.protocol_version` validation.
  - do not pass auth token via CLI args or env; instead wait for `server.json` and read `auth_token` from disk (0600)
  - wait until `.agentlip/server.json` exists + validates (`/health` ok + protocol match)
- **Race-safe startup loop** (handles concurrent starters):
  1. Try hub discovery (read server.json + /health) - if success, done (another process started it).
  2. Attempt to spawn child; child will try to acquire writer lock.
  3. If child exits quickly with lock-conflict error, retry step 1 after short backoff (e.g., 50-100ms jitter).
  4. If child exits with non-zero code for other reasons (crash, missing bun, etc.), capture stderr and reject with descriptive error including the child's output.
  5. Repeat up to `startTimeoutMs`, then fail.
  - This handles: (a) hub already running, (b) another process starting concurrently, (c) stale server.json from crashed hub, (d) child crash with useful diagnostics.
- Create:
  - `HubHttpClient` (`baseUrl`, `authToken`)
  - `WsConnection` via `wsConnect({ url: `${baseUrl.replace("http", "ws")}/ws`, authToken, afterEventId, subscriptions, webSocketImpl: opts.webSocketImpl })`
- Ensure cancellation:
  - if `signal` aborts during startup, kill child (if spawned) and reject.
  - if `startTimeoutMs` exceeded while child is still running, kill child with SIGTERM (then SIGKILL after 2s grace), then reject with `HubStartTimeoutError`.
  - **Child process cleanup:** Always attach handlers for both `exit` and `error` events on the spawned child. On unexpected exit before healthy, reject immediately with captured stderr.

### Acceptance criteria

- Returns usable `sendMessage` and WS event stream.
- Handles stale server.json by starting a new hub (lock acquisition already handles staleness).
- Does not require callers to know about server.json.

### Tests

- client: if hub already running, does not spawn child.
- client: if hub not running, spawns child and connects.
- client: abort during wait-for-start → rejects quickly and does not leave a live child.
- client: concurrent start race — two `connectToLocalAgentlip()` calls; only one hub is started, both connect.
- client: auth token not visible in spawned process arguments (check via `/proc` or `ps` in test).
- client: if child crashes during startup, error includes child stderr/exit code.
- client: if `startTimeoutMs` exceeded, child is killed and does not become orphaned.
- client: `close()` is idempotent (multiple calls do not throw).
- client: `startedHub` property is `false` when connecting to existing hub, `true` when this call spawned it.

---

## Gate 4 - Re-export as `agentlip/local-client`

### Deliverables

- Add `packages/cli/src/local-client.ts` (Node-safe; no `bun:` imports):
  - `export * from "@agentlip/client/local"`
- Add a new subpath export in `packages/cli/package.json` (wired to Gate 5 build output for Node):
  - `"./local-client": { "types": "./dist/local-client.d.ts", "bun": "./src/local-client.ts", "import": "./dist/local-client.js" }`
- Keep `agentlip` bin behavior unchanged (still Bun-only).

### Dependency direction note

This adds a runtime dependency edge: `agentlip` (CLI) → `@agentlip/client`. This is **allowed** because:
- The CLI package already depends on kernel+workspace; client is a sibling package at the same layer.
- The re-export is a thin passthrough (no circular import risk).
- The CLI's bin script remains Bun-only; only the `./local-client` subpath is Node-compatible.

**Pre-check before implementation:** Verify no circular dependency exists by running `bun run check` after adding the import. If a cycle is detected, skip this gate entirely—users will import from `@agentlip/client/local` directly.

### Acceptance criteria

- `import { connectToLocalAgentlip } from "agentlip/local-client"` works in Node v22+ ESM **after Gate 5 packaging is in place**.
- Also export all custom error classes: `import { WorkspaceNotFoundError, BunNotFoundError, HubStartTimeoutError, ProtocolVersionMismatchError, WaitTimeoutError, ConnectionClosedError, MutationError } from "agentlip/local-client"` (Note: `AbortError` is a standard `DOMException`, not a custom class.)

---

## Gate 5 - Node compatibility + packaging (follows Fork A recommendation)

### Deliverables

- Create build output (`dist/`) for:
  - `@agentlip/protocol`
  - `@agentlip/workspace`
  - `@agentlip/client`
  - `agentlip` (CLI package) **at least for** `src/local-client.ts` → `dist/local-client.js` + `dist/local-client.d.ts`
- **Build tool:** Use `tsc` (TypeScript compiler) with `outDir: "dist"`, `declaration: true`. Avoid bundlers (esbuild, bun build) to preserve module structure and type-checking at build time.
- Adjust package.json exports to ship JS to Node, but allow Bun dev to keep using TS sources.
  - Prefer conditional exports keyed by `"bun"` vs `"import"`.
  - Ensure `agentlip` package `files` includes `dist/local-client.*` in the published tarball.
- Fix Node-compat footguns in SDK:
  - replace Bun-specific `Timer` type usage with `ReturnType<typeof setTimeout>` in WS client.
  - ensure no `bun:` imports exist in these packages.

### Acceptance criteria

- Minimal smoke test: `node -e 'import { connectToLocalAgentlip } from "agentlip/local-client"; console.log(typeof connectToLocalAgentlip)'` succeeds.

---

## Gate 6 - Documentation

- Update `docs/ops.md` to match actual `agentlipd` commands (add `up`; document idle shutdown flag).
- Add a short doc snippet in README:
  - Node usage example
  - requirement: Bun installed
  - Node v22+, ESM-only
