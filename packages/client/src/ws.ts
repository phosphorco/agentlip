/**
 * WebSocket client with replay and reconnect for Agentlip Hub
 * 
 * Implements automatic reconnection with exponential backoff and event deduplication.
 * 
 * Usage:
 * ```typescript
 * const conn = await wsConnect({
 *   url: "ws://localhost:8080/ws",
 *   authToken: "secret",
 *   afterEventId: 0,
 *   subscriptions: { channels: ["general"] }
 * });
 * 
 * for await (const event of conn.events()) {
 *   console.log(event);
 *   if (shouldStop) {
 *     conn.close();
 *     break;
 *   }
 * }
 * ```
 */

import type { HelloMessage, HelloOkMessage, EventEnvelope } from "./types.js";

export interface WsConnectOptions {
  /** ws://host:port/ws URL (without token) */
  url: string;
  /** Auth token for query param */
  authToken: string;
  /** Resume from this event ID (0 = from beginning) */
  afterEventId?: number;
  /** Channel/topic subscription filters */
  subscriptions?: {
    channels?: string[];
    topics?: string[];
  };
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelay?: number;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Open timeout in ms (default: 10000) */
  openTimeout?: number;
  /** WebSocket implementation (for Node.js <22 or custom implementations) */
  webSocketImpl?: typeof WebSocket;
}

export interface WsConnection {
  /** Async iterator of event envelopes */
  events(): AsyncIterableIterator<EventEnvelope>;
  /** Last successfully received event ID */
  lastEventId(): number;
  /** Close connection (no reconnect) */
  close(): void;
  /** Whether connection is active */
  readonly connected: boolean;
}

interface PendingEvent {
  resolve: (value: IteratorResult<EventEnvelope>) => void;
  reject: (error: Error) => void;
}

/**
 * Connect to Agentlip Hub WebSocket with automatic reconnection.
 * 
 * Features:
 * - Automatic reconnect with exponential backoff
 * - Event replay from last received event_id
 * - Event deduplication (bounded Set)
 * - Clean shutdown via close()
 * 
 * @param options - Connection options
 * @returns WsConnection instance
 */
export async function wsConnect(options: WsConnectOptions): Promise<WsConnection> {
  const {
    url,
    authToken,
    afterEventId = 0,
    subscriptions,
    reconnectDelay: initialReconnectDelay = 1000,
    maxReconnectDelay = 30000,
    openTimeout: openTimeoutMs = 10000,
    webSocketImpl,
  } = options;

  // Select WebSocket constructor - injected or global
  const WebSocketCtor = webSocketImpl ?? globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket not available. Pass webSocketImpl option or use Node 22+.");
  }

  let ws: WebSocket | null = null;
  let isConnected = false;
  let shouldReconnect = true;
  let lastEventId = afterEventId;
  let currentReconnectDelay = initialReconnectDelay;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  // Event deduplication: keep last 1000 event IDs
  const seenEventIds = new Set<number>();
  const MAX_SEEN_IDS = 1000;

  // Event queue for async iteration
  const eventQueue: EventEnvelope[] = [];
  const pendingReaders: PendingEvent[] = [];
  let iteratorClosed = false;

  // Connect/reconnect function
  function connect(): void {
    if (!shouldReconnect) {
      return;
    }

    const wsUrl = `${url}?token=${encodeURIComponent(authToken)}`;
    ws = new WebSocketCtor(wsUrl);

    let handshakeComplete = false;
    let openTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (openTimeout) {
        clearTimeout(openTimeout);
        openTimeout = null;
      }
    };

    openTimeout = setTimeout(() => {
      if (!handshakeComplete && ws) {
        console.error("[ws] Open timeout, closing connection");
        ws.close();
        scheduleReconnect();
      }
    }, openTimeoutMs);

    ws.onopen = () => {
      isConnected = true;
      currentReconnectDelay = initialReconnectDelay; // Reset backoff
      consecutiveFailures = 0; // Reset failure counter on successful open

      // Send hello message
      const hello: HelloMessage = {
        type: "hello",
        after_event_id: lastEventId,
      };

      // Only add subscriptions if filters are specified
      // Per plan: omit subscriptions field entirely for ALL events
      if (subscriptions) {
        const hasChannels = subscriptions.channels && subscriptions.channels.length > 0;
        const hasTopics = subscriptions.topics && subscriptions.topics.length > 0;

        if (hasChannels || hasTopics) {
          hello.subscriptions = {};
          if (hasChannels) {
            hello.subscriptions.channels = subscriptions.channels;
          }
          if (hasTopics) {
            hello.subscriptions.topics = subscriptions.topics;
          }
        }
      }

      ws?.send(JSON.stringify(hello));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));

        if (data.type === "hello_ok") {
          handshakeComplete = true;
          cleanup();
          // Successfully connected, log for debugging
          const helloOk = data as HelloOkMessage;
          // Optional: store instance_id for debugging
          return;
        }

        if (data.type === "event") {
          const envelope = data as EventEnvelope;

          // Deduplicate
          if (seenEventIds.has(envelope.event_id)) {
            return;
          }

          // Add to seen set with bounded size
          seenEventIds.add(envelope.event_id);
          if (seenEventIds.size > MAX_SEEN_IDS) {
            // Remove oldest entries (convert to array, remove first half, recreate set)
            const ids = Array.from(seenEventIds);
            const toKeep = ids.slice(ids.length - Math.floor(MAX_SEEN_IDS / 2));
            seenEventIds.clear();
            toKeep.forEach((id) => seenEventIds.add(id));
          }

          // Update last event ID
          lastEventId = envelope.event_id;

          // Enqueue event for async iterator
          if (pendingReaders.length > 0) {
            const reader = pendingReaders.shift()!;
            reader.resolve({ value: envelope, done: false });
          } else {
            eventQueue.push(envelope);
          }
        }
      } catch (err) {
        console.error(`[ws] Error parsing message: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    ws.onerror = (_err) => {
      cleanup();
      // Error details will be in close event
    };

    ws.onclose = (event) => {
      cleanup();
      isConnected = false;

      const code = (event as CloseEvent).code;
      const reason = (event as CloseEvent).reason || "unknown";

      // Close codes per plan:
      // 1000: Normal closure - don't reconnect
      // 1001: Going away (server shutdown) - reconnect after delay
      // 1008: Policy violation (backpressure) - reconnect immediately
      // 1011: Internal error - reconnect with backoff
      // 4401: Unauthorized - don't reconnect

      if (code === 1000) {
        // Normal close - no reconnect
        shouldReconnect = false;
        closeIterator();
        return;
      }

      if (code === 4401) {
        // Unauthorized - no reconnect, close iterator with error
        shouldReconnect = false;
        closeIterator(new Error(`Unauthorized (code 4401)`));
        return;
      }

      // Track consecutive failures (connection never completed handshake)
      if (!handshakeComplete) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          // Likely a permanent failure (auth rejected at HTTP level, server down, etc.)
          console.error(`[ws] ${consecutiveFailures} consecutive connection failures, giving up`);
          shouldReconnect = false;
          closeIterator(new Error(`Connection failed after ${consecutiveFailures} attempts (code=${code})`));
          return;
        }
      }

      // All other codes: attempt reconnect
      if (shouldReconnect) {
        console.error(`[ws] Connection closed (code=${code}, reason=${reason}), reconnecting...`);
        scheduleReconnect();
      } else {
        closeIterator();
      }
    };
  }

  function scheduleReconnect(): void {
    if (!shouldReconnect) {
      return;
    }

    setTimeout(() => {
      if (shouldReconnect) {
        connect();
      }
    }, currentReconnectDelay);

    // Exponential backoff
    currentReconnectDelay = Math.min(currentReconnectDelay * 2, maxReconnectDelay);
  }

  function closeIterator(error?: Error): void {
    if (iteratorClosed) {
      return;
    }

    iteratorClosed = true;

    // Resolve all pending readers
    while (pendingReaders.length > 0) {
      const reader = pendingReaders.shift()!;
      if (error) {
        reader.reject(error);
      } else {
        reader.resolve({ value: undefined as any, done: true });
      }
    }

    // Clear queue
    eventQueue.length = 0;
  }

  // Start initial connection
  connect();

  return {
    async *events(): AsyncIterableIterator<EventEnvelope> {
      while (!iteratorClosed) {
        // If we have queued events, yield them
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
          continue;
        }

        // Wait for next event
        const result = await new Promise<IteratorResult<EventEnvelope>>((resolve, reject) => {
          if (iteratorClosed) {
            resolve({ value: undefined as any, done: true });
            return;
          }

          pendingReaders.push({ resolve, reject });
        });

        if (result.done) {
          break;
        }

        yield result.value;
      }
    },

    lastEventId(): number {
      return lastEventId;
    },

    close(): void {
      shouldReconnect = false;
      if (ws) {
        try {
          ws.close(1000, "Client closed");
        } catch {
          // Ignore errors during close
        }
        ws = null;
      }
      closeIterator();
    },

    get connected(): boolean {
      return isConnected;
    },
  };
}
