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
 *   startIfMissing: false
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
  /** Whether to spawn hub if not running (NOT IMPLEMENTED - must be false) */
  startIfMissing?: false;
  /** AfterEventId for WS replay (defaults to 0 = from beginning) */
  afterEventId?: number;
  /** Channel/topic subscription filters */
  subscriptions?: {
    channels?: string[];
    topics?: string[];
  };
}

export interface LocalAgentlipClient {
  /** Workspace root directory */
  readonly workspaceRoot: string;
  /** Hub base URL (http://host:port) */
  readonly baseUrl: string;
  /** Auth token */
  readonly authToken: string;
  /** Whether hub was started by this client (always false for bd-27i.4) */
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
// Main Export: connectToLocalAgentlip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect to an already-running local Agentlip hub.
 * 
 * Steps:
 * 1. Discover workspace via upward walk from cwd
 * 2. Read .agentlip/server.json
 * 3. Validate hub via /health and check protocol version
 * 4. Connect WebSocket
 * 5. Return LocalAgentlipClient with bound mutations + event methods
 * 
 * @param options - Connection options
 * @returns LocalAgentlipClient instance
 * @throws WorkspaceNotFoundError if no workspace discovered/initialized
 * @throws Error if server.json missing or invalid
 * @throws ProtocolVersionMismatchError if protocol version doesn't match
 * @throws Error if hub validation fails
 */
export async function connectToLocalAgentlip(
  options: ConnectToLocalAgentlipOptions = {}
): Promise<LocalAgentlipClient> {
  const {
    cwd = process.cwd(),
    startIfMissing = false,
    afterEventId = 0,
    subscriptions,
  } = options;

  if (startIfMissing !== false) {
    throw new Error(
      "startIfMissing: true is not yet implemented (bd-27i.5). Use startIfMissing: false."
    );
  }

  // 1. Discover workspace
  const workspace = await discoverOrInitWorkspace(cwd);
  if (!workspace) {
    throw new WorkspaceNotFoundError();
  }

  // 2. Read server.json
  const serverJson = await readServerJson(workspace.root);
  if (!serverJson) {
    throw new Error(
      `Hub not running: .agentlip/server.json not found in workspace ${workspace.root}`
    );
  }

  // 3. Validate hub via /health
  const validation = await validateHub(serverJson);
  if (!validation.valid || !validation.health) {
    throw new Error(`Hub validation failed: ${validation.reason}`);
  }

  // Check protocol version
  if (validation.health.protocol_version !== PROTOCOL_VERSION) {
    throw new ProtocolVersionMismatchError(
      PROTOCOL_VERSION,
      validation.health.protocol_version
    );
  }

  // 4. Connect WebSocket
  const baseUrl = `http://${serverJson.host}:${serverJson.port}`;
  const wsBaseUrl = `ws://${serverJson.host}:${serverJson.port}`;

  const wsConn = await wsConnect({
    url: `${wsBaseUrl}/ws`,
    authToken: serverJson.auth_token,
    afterEventId,
    subscriptions,
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
    startedHub: false,

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
        let timeoutHandle: Timer | null = null;
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
