/**
 * @agentlip/client/local - Connect to local Agentlip hub via daemon mode
 * 
 * Provides Node-facing API for connecting to an already-running hub instance
 * discovered via .agentlip/server.json and workspace discovery.
 * 
 * Usage:
 * ```typescript
 * const client = await connectToLocalAgentlip({
 *   cwd: process.cwd(),
 * });
 * 
 * await client.sendMessage({ topicId: "...", sender: "bot", contentRaw: "Hello" });
 * 
 * for await (const event of client.events()) {
 *   console.log(event);
 * }
 * 
 * await client.close();
 * ```
 */

import { PROTOCOL_VERSION } from "@agentlip/protocol";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { discoverOrInitWorkspace } from "./discovery";
import { readServerJson, validateHub } from "./serverJson";
import { wsConnect, type WsConnection } from "./ws";
import type { EventEnvelope } from "./types";
import {
  HubApiError,
  sendMessage,
  editMessage,
  deleteMessage,
  retopicMessage,
  addAttachment,
  createChannel,
  createTopic,
  renameTopic,
  type SendMessageParams,
  type SendMessageResult,
  type EditMessageParams,
  type EditMessageResult,
  type DeleteMessageParams,
  type DeleteMessageResult,
  type RetopicMessageParams,
  type RetopicMessageResult,
  type AddAttachmentParams,
  type AddAttachmentResult,
  type CreateChannelParams,
  type CreateChannelResult,
  type CreateTopicParams,
  type CreateTopicResult,
  type RenameTopicParams,
  type RenameTopicResult,
} from "./mutations";

// ─────────────────────────────────────────────────────────────────────────────
// Error Classes
// ─────────────────────────────────────────────────────────────────────────────

export class WorkspaceNotFoundError extends Error {
  constructor(message: string = "No Agentlip workspace found in directory tree") {
    super(message);
    this.name = "WorkspaceNotFoundError";
  }
}

export class BunNotFoundError extends Error {
  constructor(message: string = "Bun executable not found in PATH") {
    super(message);
    this.name = "BunNotFoundError";
  }
}

export class HubStartTimeoutError extends Error {
  constructor(message: string = "Hub failed to start within timeout") {
    super(message);
    this.name = "HubStartTimeoutError";
  }
}

export class ProtocolVersionMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
    message?: string
  ) {
    super(
      message ||
        `Protocol version mismatch: expected ${expected}, got ${actual}`
    );
    this.name = "ProtocolVersionMismatchError";
  }
}

export class WaitTimeoutError extends Error {
  constructor(message: string = "Wait timeout: no matching event received") {
    super(message);
    this.name = "WaitTimeoutError";
  }
}

export class ConnectionClosedError extends Error {
  constructor(message: string = "Connection closed") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

export class MutationError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "MutationError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectToLocalAgentlipOptions {
  /** Starting directory for workspace discovery (defaults to process.cwd()) */
  cwd?: string;
  /** Whether to spawn hub if not running (defaults to true) */
  startIfMissing?: boolean;
  /** Path to Bun executable (defaults to "bun") */
  bunPath?: string;
  /** Idle shutdown timeout in ms (only if this call spawned the hub, defaults to 180000) */
  idleShutdownMs?: number;
  /** Timeout for hub startup in ms (defaults to 10000) */
  startTimeoutMs?: number;
  /** AbortSignal for cancelling startup */
  signal?: AbortSignal;
  /** AfterEventId for WS replay (defaults to 0 = from beginning) */
  afterEventId?: number;
  /** Channel/topic subscription filters */
  subscriptions?: {
    channels?: string[];
    topics?: string[];
  };
  /** WebSocket constructor override (Node compat / custom implementations) */
  webSocketImpl?: typeof WebSocket;
}

export interface LocalAgentlipClient {
  /** Workspace root directory */
  readonly workspaceRoot: string;
  /** Hub base URL (http://host:port) */
  readonly baseUrl: string;
  /** Auth token */
  readonly authToken: string;
  /** Whether hub was started by this client */
  readonly startedHub: boolean;

  // ───────────────────────────────────────────────────────────────────────────
  // Mutations (bound to this client's auth + base URL)
  // ───────────────────────────────────────────────────────────────────────────

  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
  editMessage(params: EditMessageParams): Promise<EditMessageResult>;
  deleteMessage(params: DeleteMessageParams): Promise<DeleteMessageResult>;
  retopicMessage(params: RetopicMessageParams): Promise<RetopicMessageResult>;
  addAttachment(params: AddAttachmentParams): Promise<AddAttachmentResult>;
  createChannel(params: CreateChannelParams): Promise<CreateChannelResult>;
  createTopic(params: CreateTopicParams): Promise<CreateTopicResult>;
  renameTopic(params: RenameTopicParams): Promise<RenameTopicResult>;

  // ───────────────────────────────────────────────────────────────────────────
  // Events (async iterator + predicate-based wait)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Async iterator over events from WS connection.
   * Multiple consumers can call this independently - events are fanout'd.
   */
  events(): AsyncIterableIterator<EventEnvelope>;

  /**
   * Wait for a specific event matching the predicate.
   * 
   * @param predicate - Function to test each event
   * @param options - Optional signal (for cancellation) and timeout
   * @returns Promise resolving to matching event
   * @throws WaitTimeoutError if timeout exceeded
   * @throws AbortError (DOMException) if signal aborted
   * @throws ConnectionClosedError if connection closed before match
   */
  waitForEvent(
    predicate: (event: EventEnvelope) => boolean,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
    }
  ): Promise<EventEnvelope>;

  /**
   * Close connection (idempotent).
   * Terminates event iterators and pending waitForEvent calls with ConnectionClosedError.
   */
  close(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Event Fanout (prevents waitForEvent from stealing from events())
// ─────────────────────────────────────────────────────────────────────────────

interface EventSubscriber {
  queue: EventEnvelope[];
  pendingResolve: ((event: EventEnvelope) => void) | null;
  pendingReject: ((error: Error) => void) | null;
  closed: boolean;
}

class EventBroadcaster {
  private subscribers = new Set<EventSubscriber>();
  private closed = false;

  constructor(private wsConn: WsConnection) {
    // Start background consumer
    this.consumeEvents();
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const event of this.wsConn.events()) {
        if (this.closed) break;
        this.broadcast(event);
      }
    } catch (err) {
      // WS connection error - close all subscribers
      this.closeAllSubscribers(
        err instanceof Error ? err : new ConnectionClosedError(String(err))
      );
    }
  }

  private broadcast(event: EventEnvelope): void {
    for (const sub of this.subscribers) {
      if (sub.closed) continue;

      if (sub.pendingResolve) {
        const resolve = sub.pendingResolve;
        const reject = sub.pendingReject;
        sub.pendingResolve = null;
        sub.pendingReject = null;
        resolve(event);
      } else {
        sub.queue.push(event);
      }
    }
  }

  createSubscriber(): EventSubscriber {
    const sub: EventSubscriber = {
      queue: [],
      pendingResolve: null,
      pendingReject: null,
      closed: false,
    };
    this.subscribers.add(sub);
    return sub;
  }

  removeSubscriber(sub: EventSubscriber): void {
    sub.closed = true;
    this.subscribers.delete(sub);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wsConn.close();
    this.closeAllSubscribers(new ConnectionClosedError());
  }

  private closeAllSubscribers(error: Error): void {
    for (const sub of this.subscribers) {
      if (sub.closed) continue;
      sub.closed = true;
      if (sub.pendingReject) {
        sub.pendingReject(error);
        sub.pendingResolve = null;
        sub.pendingReject = null;
      }
    }
    this.subscribers.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// bunPath Validation (prevent shell injection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate bunPath to prevent shell injection.
 * 
 * Allow:
 * - Bare command names (e.g., "bun")
 * - Absolute paths (e.g., "/usr/local/bin/bun")
 * 
 * Reject:
 * - Paths containing ".." (path traversal)
 * - Shell metacharacters (; & | $ ` \n)
 */
function validateBunPath(bunPath: string): void {
  // Check for path traversal
  if (bunPath.includes("..")) {
    throw new Error(`Invalid bunPath: contains path traversal (..): ${bunPath}`);
  }

  // Check for shell metacharacters
  const dangerousChars = /[;&|$`\n]/;
  if (dangerousChars.test(bunPath)) {
    throw new Error(`Invalid bunPath: contains shell metacharacters: ${bunPath}`);
  }

  // Must be either bare command name or absolute path
  const isAbsolute = bunPath.startsWith("/");
  const isBareCommand = !bunPath.includes("/");

  if (!isAbsolute && !isBareCommand) {
    throw new Error(`Invalid bunPath: must be absolute path or bare command name: ${bunPath}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hub Spawning (spawn-if-missing)
// ─────────────────────────────────────────────────────────────────────────────

interface SpawnHubOptions {
  workspaceRoot: string;
  bunPath: string;
  idleShutdownMs: number;
  startTimeoutMs: number;
  signal?: AbortSignal;
}

interface SpawnHubResult {
  success: true;
  /** True if this call spawned the hub, false if another process won the race */
  spawned: boolean;
}

/**
 * Spawn hub daemon via `bun x -p @agentlip/hub agentlipd up`.
 * 
 * Implements race-safe startup loop:
 * - Try discovery/validation first
 * - Spawn child if hub not running
 * - If child exits with code 10 (lock conflict), backoff and retry discovery
 * - If child exits non-zero otherwise, surface stderr
 * - Timeout and abort handling with child cleanup
 * 
 * Returns when hub is healthy (discovered + validated).
 * Sets startedHub=true ONLY if this call successfully spawned the hub.
 */
async function spawnHubIfMissing(
  opts: SpawnHubOptions
): Promise<SpawnHubResult> {
  const { workspaceRoot, bunPath, idleShutdownMs, startTimeoutMs, signal } = opts;

  const deadlineMs = Date.now() + startTimeoutMs;

  // Test override: spawn the repo-local agentlipd script (or any bun script)
  // instead of `bun x -p @agentlip/hub ...` to avoid network access.
  const testAgentlipdPath = process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  };

  const throwIfTimedOut = () => {
    if (Date.now() > deadlineMs) {
      throw new HubStartTimeoutError(
        `Hub failed to start within ${startTimeoutMs}ms`
      );
    }
  };

  const killChild = async (child: ChildProcess): Promise<void> => {
    if (child.pid == null) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
        child.once("error", () => resolve(true));
      }),
      sleep(2000).then(() => false),
    ]);

    if (exited) return;

    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      }),
      sleep(2000),
    ]);
  };

  while (true) {
    throwIfAborted();
    throwIfTimedOut();

    // Try discovery + validation first (in case hub already running)
    const serverJson = await readServerJson(workspaceRoot);
    if (serverJson) {
      const validation = await validateHub(serverJson);

      if (validation.health && validation.health.protocol_version !== PROTOCOL_VERSION) {
        throw new ProtocolVersionMismatchError(
          PROTOCOL_VERSION,
          validation.health.protocol_version
        );
      }

      if (validation.valid && validation.health) {
        // Hub is healthy - we discovered it, didn't spawn it
        return { success: true, spawned: false };
      }
    }

    // Hub not running or unhealthy - spawn child
    const args = testAgentlipdPath
      ? [
          testAgentlipdPath,
          "up",
          "--workspace",
          workspaceRoot,
          "--idle-shutdown-ms",
          String(idleShutdownMs),
        ]
      : [
          "x",
          "--bun",
          "-p",
          "@agentlip/hub",
          "agentlipd",
          "up",
          "--workspace",
          workspaceRoot,
          "--idle-shutdown-ms",
          String(idleShutdownMs),
        ];

    const child = spawn(bunPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let keepChildRunning = false;

    let childError: Error | null = null;
    let childExitCode: number | null = null;

    child.once("error", (err) => {
      childError = err;
    });

    child.once("exit", (code) => {
      childExitCode = code;
    });

    // Drain stdout to avoid backpressure
    child.stdout?.resume();

    // Capture stderr for diagnostics
    let stderr = "";
    const MAX_STDERR = 64 * 1024;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= MAX_STDERR) return;
      stderr += String(chunk);
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(0, MAX_STDERR);
    });

    try {
      while (true) {
        throwIfAborted();
        throwIfTimedOut();

        if (childError) {
          const anyErr = childError as any;
          if (anyErr?.code === "ENOENT") {
            throw new BunNotFoundError(`Bun not found: ${bunPath}`);
          }
          throw childError;
        }

        // Check if hub is now healthy
        const currentServerJson = await readServerJson(workspaceRoot);
        if (currentServerJson) {
          const validation = await validateHub(currentServerJson);

          if (validation.health && validation.health.protocol_version !== PROTOCOL_VERSION) {
            throw new ProtocolVersionMismatchError(
              PROTOCOL_VERSION,
              validation.health.protocol_version
            );
          }

          if (validation.health && !validation.valid) {
            throw new Error(`Hub validation failed: ${validation.reason}`);
          }

          if (validation.valid && validation.health) {
            // Hub is healthy. Determine whether *our* child is the daemon that wrote server.json.
            const spawned = child.pid != null && currentServerJson.pid === child.pid;
            keepChildRunning = spawned;
            return { success: true, spawned };
          }
        }

        if (childExitCode !== null) {
          // Child exited before hub became healthy
          if (childExitCode === 10) {
            // Lock conflict - another process won the race
            // Backoff (50-100ms jitter) and retry discovery
            const backoffMs = 50 + Math.random() * 50;
            await sleep(backoffMs);
            break; // restart outer loop
          }

          if (childExitCode !== 0) {
            throw new Error(
              `Hub startup failed with exit code ${childExitCode}:\n${stderr.trim()}`.trim()
            );
          }

          throw new Error(
            "Hub startup process exited before hub became healthy (exit code 0)."
          );
        }

        await sleep(50);
      }
    } finally {
      // If we didn't start the daemon successfully, make sure no orphan remains.
      if (!keepChildRunning) {
        await killChild(child).catch(() => {
          // Best-effort cleanup
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Export: connectToLocalAgentlip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect to local Agentlip hub, optionally spawning it if missing.
 * 
 * Steps:
 * 1. Discover workspace via upward walk from cwd
 * 2. Try to read .agentlip/server.json and validate hub
 * 3. If missing/unhealthy and startIfMissing=true, spawn hub daemon
 * 4. Connect WebSocket
 * 5. Return LocalAgentlipClient with bound mutations + event methods
 * 
 * @param options - Connection options
 * @returns LocalAgentlipClient instance
 * @throws WorkspaceNotFoundError if no workspace discovered/initialized
 * @throws HubStartTimeoutError if hub fails to start within timeout
 * @throws ProtocolVersionMismatchError if protocol version doesn't match
 * @throws Error if hub validation fails
 * @throws DOMException (AbortError) if signal aborted
 */
export async function connectToLocalAgentlip(
  options: ConnectToLocalAgentlipOptions = {}
): Promise<LocalAgentlipClient> {
  const {
    cwd = process.cwd(),
    startIfMissing = true,
    bunPath = "bun",
    idleShutdownMs = 180000,
    startTimeoutMs = 10000,
    signal,
    afterEventId = 0,
    subscriptions,
    webSocketImpl,
  } = options;

  // Validate bunPath for safety
  validateBunPath(bunPath);

  // Check abort signal upfront
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // 1. Discover workspace
  const workspace = await discoverOrInitWorkspace(cwd);
  if (!workspace) {
    throw new WorkspaceNotFoundError();
  }

  let startedHub = false;

  // 2. Try discovery + validation first
  let serverJson = await readServerJson(workspace.root);

  if (serverJson) {
    const validation = await validateHub(serverJson);

    // If hub is responsive but running a different protocol version, fail fast.
    if (
      validation.health &&
      validation.health.protocol_version !== PROTOCOL_VERSION
    ) {
      throw new ProtocolVersionMismatchError(
        PROTOCOL_VERSION,
        validation.health.protocol_version
      );
    }

    if (validation.health && !validation.valid) {
      throw new Error(`Hub validation failed: ${validation.reason}`);
    }

    if (!(validation.valid && validation.health)) {
      // Hub is unreachable/unhealthy - treat server.json as stale.
      serverJson = null;
    }
  }

  // 3. If hub not running/healthy and startIfMissing=true, spawn it
  if (!serverJson && startIfMissing) {
    const spawnResult = await spawnHubIfMissing({
      workspaceRoot: workspace.root,
      bunPath,
      idleShutdownMs,
      startTimeoutMs,
      signal,
    });

    // Hub should now be healthy - re-read server.json
    serverJson = await readServerJson(workspace.root);
    if (!serverJson) {
      throw new Error(
        `Hub spawn succeeded but server.json not found in workspace ${workspace.root}`
      );
    }

    const validation = await validateHub(serverJson);

    if (
      validation.health &&
      validation.health.protocol_version !== PROTOCOL_VERSION
    ) {
      throw new ProtocolVersionMismatchError(
        PROTOCOL_VERSION,
        validation.health.protocol_version
      );
    }

    if (!validation.valid || !validation.health) {
      throw new Error(`Hub spawn succeeded but validation failed: ${validation.reason}`);
    }

    // Use the spawned flag from the result
    startedHub = spawnResult.spawned;
  } else if (!serverJson) {
    // Hub not running and startIfMissing=false
    throw new Error(
      `Hub not running: .agentlip/server.json not found in workspace ${workspace.root}. Set startIfMissing=true to auto-spawn.`
    );
  }

  // serverJson is now guaranteed to be non-null and validated

  // 4. Connect WebSocket
  const baseUrl = `http://${serverJson.host}:${serverJson.port}`;
  const wsBaseUrl = `ws://${serverJson.host}:${serverJson.port}`;

  const wsConn = await wsConnect({
    url: `${wsBaseUrl}/ws`,
    authToken: serverJson.auth_token,
    afterEventId,
    subscriptions,
    webSocketImpl,
  });

  // 5. Create event broadcaster (fanout to multiple subscribers)
  const broadcaster = new EventBroadcaster(wsConn);

  // 6. Build HTTP client context for mutations
  const httpClient = {
    baseUrl,
    authToken: serverJson.auth_token,
  };

  // Helper to wrap mutation errors
  const wrapMutationError = async <T>(
    fn: () => Promise<T>
  ): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HubApiError) {
        throw new MutationError(
          `${err.code}: ${err.message}`,
          err
        );
      }
      throw err;
    }
  };

  // 7. Return LocalAgentlipClient
  return {
    workspaceRoot: workspace.root,
    baseUrl,
    authToken: serverJson.auth_token,
    startedHub,

    // Bound mutations
    sendMessage: (params) => wrapMutationError(() => sendMessage(httpClient, params)),
    editMessage: (params) => wrapMutationError(() => editMessage(httpClient, params)),
    deleteMessage: (params) => wrapMutationError(() => deleteMessage(httpClient, params)),
    retopicMessage: (params) => wrapMutationError(() => retopicMessage(httpClient, params)),
    addAttachment: (params) => wrapMutationError(() => addAttachment(httpClient, params)),
    createChannel: (params) => wrapMutationError(() => createChannel(httpClient, params)),
    createTopic: (params) => wrapMutationError(() => createTopic(httpClient, params)),
    renameTopic: (params) => wrapMutationError(() => renameTopic(httpClient, params)),

    // Event methods
    async *events(): AsyncIterableIterator<EventEnvelope> {
      const sub = broadcaster.createSubscriber();
      try {
        while (!sub.closed) {
          // Yield queued events first
          while (sub.queue.length > 0) {
            const event = sub.queue.shift()!;
            yield event;
          }

          // Wait for next event
          const event = await new Promise<EventEnvelope>((resolve, reject) => {
            if (sub.closed) {
              reject(new ConnectionClosedError());
              return;
            }
            sub.pendingResolve = resolve;
            sub.pendingReject = reject;
          });

          yield event;
        }
      } finally {
        broadcaster.removeSubscriber(sub);
      }
    },

    async waitForEvent(
      predicate: (event: EventEnvelope) => boolean,
      options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
      }
    ): Promise<EventEnvelope> {
      const { signal, timeoutMs } = options ?? {};

      // Check signal upfront
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const sub = broadcaster.createSubscriber();

      return new Promise<EventEnvelope>((resolve, reject) => {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let abortHandler: (() => void) | null = null;

        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (abortHandler && signal) {
            signal.removeEventListener("abort", abortHandler);
          }
          broadcaster.removeSubscriber(sub);
        };

        // Set up timeout
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            cleanup();
            reject(new WaitTimeoutError(`No matching event received within ${timeoutMs}ms`));
          }, timeoutMs);
        }

        // Set up abort signal
        if (signal) {
          abortHandler = () => {
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", abortHandler);
        }

        // Check existing queue
        for (const event of sub.queue) {
          if (predicate(event)) {
            cleanup();
            resolve(event);
            return;
          }
        }
        sub.queue = []; // Clear queue after checking

        // Set up pending resolve with predicate checking
        const checkEvent = (event: EventEnvelope) => {
          if (predicate(event)) {
            cleanup();
            resolve(event);
          } else {
            // Not a match, keep waiting for next event
            sub.pendingResolve = checkEvent;
          }
        };

        sub.pendingResolve = checkEvent;
        sub.pendingReject = (error: Error) => {
          cleanup();
          reject(error);
        };
      });
    },

    close(): void {
      broadcaster.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for convenience
// ─────────────────────────────────────────────────────────────────────────────

export type { EventEnvelope };
export type {
  SendMessageParams,
  SendMessageResult,
  EditMessageParams,
  EditMessageResult,
  DeleteMessageParams,
  DeleteMessageResult,
  RetopicMessageParams,
  RetopicMessageResult,
  AddAttachmentParams,
  AddAttachmentResult,
  CreateChannelParams,
  CreateChannelResult,
  CreateTopicParams,
  CreateTopicResult,
  RenameTopicParams,
  RenameTopicResult,
};
