/**
 * WebSocket endpoint implementation for AgentChat Hub
 * 
 * Implements the WS protocol from AGENTLIP_PLAN.md:
 * - Hello handshake with token validation
 * - Event replay with subscription filtering
 * - Live event streaming with backpressure disconnect
 * - Size validation and proper error handling
 */

import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { requireWsToken } from "./authMiddleware";
import { parseWsMessage, validateWsMessageSize, SIZE_LIMITS } from "./bodyParser";
import {
  getLatestEventId,
  replayEvents,
  getEventById,
  type ParsedEvent,
} from "@agentchat/kernel";
import { randomBytes } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface HelloMessage {
  type: "hello";
  after_event_id: number;
  subscriptions?: {
    channels?: string[];
    topics?: string[];
  };
}

interface HelloOkMessage {
  type: "hello_ok";
  replay_until: number;
  instance_id: string;
}

interface EventEnvelope {
  type: "event";
  event_id: number;
  ts: string;
  name: string;
  scope: {
    channel_id?: string | null;
    topic_id?: string | null;
    topic_id2?: string | null;
  };
  data: Record<string, unknown>;
}

interface WsConnectionData {
  authenticated: boolean;
  handshakeComplete: boolean;
  /**
   * Subscription filters:
   * - `null` for channels/topics means "wildcard" (subscribe to all) - used when hello.subscriptions is omitted
   * - Empty Set means "subscribe to none" - used when hello.subscriptions is provided but empty
   * - Non-empty Set means "subscribe to specific IDs"
   */
  subscriptions: {
    channels: Set<string> | null;
    topics: Set<string> | null;
  };
  replayUntil?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Hub (manages connections and fanout)
// ─────────────────────────────────────────────────────────────────────────────

export interface WsHub {
  /**
   * Notify hub of a new event for fanout to subscribed clients.
   * Called after event is committed to DB.
   */
  publishEvent(event: ParsedEvent): void;

  /**
   * Notify hub of new events by ID (will fetch from DB).
   * Alternative to publishEvent when you only have event IDs.
   */
  publishEventIds(eventIds: number[]): void;

  /**
   * Get current connection count (for monitoring).
   */
  getConnectionCount(): number;

  /**
   * Close all connections (for graceful shutdown).
   */
  closeAll(): void;
}

interface WsHubOptions {
  db: Database;
  instanceId?: string;
}

/**
 * Create a WebSocket hub for managing connections and event fanout.
 * 
 * @param options - Database and instance ID
 * @returns WsHub instance
 */
export function createWsHub(options: WsHubOptions): WsHub {
  const { db } = options;
  const instanceId = options.instanceId ?? randomBytes(16).toString("hex");
  const connections = new Set<ServerWebSocket<WsConnectionData>>();

  function publishEvent(event: ParsedEvent): void {
    const envelope: EventEnvelope = {
      type: "event",
      event_id: event.event_id,
      ts: event.ts,
      name: event.name,
      scope: event.scope,
      data: event.data,
    };

    for (const ws of connections) {
      if (!ws.data.handshakeComplete) {
        continue;
      }

      // Check if event matches subscription
      const matchesSubscription = isEventSubscribed(event, ws.data.subscriptions);
      if (!matchesSubscription) {
        continue;
      }

      // Only send live events (> replay_until)
      if (ws.data.replayUntil !== undefined && event.event_id <= ws.data.replayUntil) {
        continue;
      }

      // Send event with backpressure check
      sendEventWithBackpressure(ws, envelope);
    }
  }

  function publishEventIds(eventIds: number[]): void {
    for (const eventId of eventIds) {
      const event = getEventById(db, eventId);
      if (event) {
        publishEvent(event);
      }
    }
  }

  function getConnectionCount(): number {
    return connections.size;
  }

  function closeAll(): void {
    for (const ws of connections) {
      try {
        ws.close(1001, "Server shutting down");
      } catch {
        // Ignore errors during shutdown
      }
    }
    connections.clear();
  }

  return {
    publishEvent,
    publishEventIds,
    getConnectionCount,
    closeAll,
    // Internal: register/unregister connections (called by handlers)
    _registerConnection: (ws: ServerWebSocket<WsConnectionData>) => connections.add(ws),
    _unregisterConnection: (ws: ServerWebSocket<WsConnectionData>) => connections.delete(ws),
    _getInstanceId: () => instanceId,
  } as WsHub & { 
    _registerConnection: (ws: ServerWebSocket<WsConnectionData>) => void;
    _unregisterConnection: (ws: ServerWebSocket<WsConnectionData>) => void;
    _getInstanceId: () => string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Handlers (for Bun.serve)
// ─────────────────────────────────────────────────────────────────────────────

interface CreateWsHandlersOptions {
  db: Database;
  authToken: string;
  hub: WsHub & { 
    _registerConnection: (ws: ServerWebSocket<WsConnectionData>) => void;
    _unregisterConnection: (ws: ServerWebSocket<WsConnectionData>) => void;
    _getInstanceId: () => string;
  };
}

export interface WsHandlers {
  upgrade: (req: Request, server: unknown) => Response | undefined;
  open: (ws: ServerWebSocket<WsConnectionData>) => void;
  message: (ws: ServerWebSocket<WsConnectionData>, message: string | Buffer) => void;
  close: (ws: ServerWebSocket<WsConnectionData>) => void;
}

/**
 * Create WebSocket handlers for Bun.serve.
 * 
 * Usage:
 * ```ts
 * const hub = createWsHub({ db });
 * const handlers = createWsHandlers({ db, authToken, hub });
 * 
 * Bun.serve({
 *   fetch(req, server) {
 *     if (url.pathname === "/ws") {
 *       return handlers.upgrade(req, server);
 *     }
 *     // ... other routes
 *   },
 *   websocket: {
 *     open: handlers.open,
 *     message: handlers.message,
 *     close: handlers.close,
 *   },
 * });
 * ```
 */
export function createWsHandlers(options: CreateWsHandlersOptions): WsHandlers {
  const { db, authToken, hub } = options;

  function upgrade(req: Request, server: any): Response | undefined {
    const url = new URL(req.url);

    // Validate auth token
    const authResult = requireWsToken(url, authToken);
    if (!authResult.ok) {
      // Return HTTP 401 for upgrade failures (before WS handshake)
      return new Response("Unauthorized", { status: 401 });
    }

    // Upgrade to WebSocket
    const upgraded = server.upgrade(req, {
      data: {
        authenticated: true,
        handshakeComplete: false,
        subscriptions: {
          channels: null, // Will be set in handleHello
          topics: null,
        },
      } as WsConnectionData,
    });

    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return undefined; // Upgrade successful
  }

  function open(ws: ServerWebSocket<WsConnectionData>): void {
    hub._registerConnection(ws);
  }

  function message(ws: ServerWebSocket<WsConnectionData>, message: string | Buffer): void {
    // Validate message size
    if (!validateWsMessageSize(message, SIZE_LIMITS.WS_MESSAGE)) {
      ws.close(1009, "Message too large");
      return;
    }

    // Parse JSON
    const parsed = parseWsMessage<HelloMessage>(message, SIZE_LIMITS.WS_MESSAGE);
    if (!parsed) {
      ws.close(1003, "Invalid JSON");
      return;
    }

    // Only accept "hello" message before handshake
    if (!ws.data.handshakeComplete) {
      if (parsed.type !== "hello") {
        ws.close(1003, "Expected hello message");
        return;
      }

      handleHello(ws, parsed, db, hub._getInstanceId());
      return;
    }

    // After handshake, we don't expect client messages in v1
    // (Future: could support ping/pong, subscription updates, etc.)
    ws.close(1003, "Unexpected message after handshake");
  }

  function close(ws: ServerWebSocket<WsConnectionData>): void {
    hub._unregisterConnection(ws);
  }

  return { upgrade, open, message, close };
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleHello(
  ws: ServerWebSocket<WsConnectionData>,
  hello: HelloMessage,
  db: Database,
  instanceId: string
): void {
  // Validate hello message
  if (typeof hello.after_event_id !== "number" || hello.after_event_id < 0) {
    ws.close(1003, "Invalid after_event_id");
    return;
  }

  // Determine subscription mode:
  // - omitted subscriptions = wildcard (null) = subscribe to ALL
  // - provided but empty = subscribe to NONE
  // - provided with values = filter to those values
  const subscriptionsOmitted = hello.subscriptions === undefined;
  
  // Extract channel/topic arrays if subscriptions was provided
  const channelIds = hello.subscriptions?.channels ?? [];
  const topicIds = hello.subscriptions?.topics ?? [];

  // Validate subscriptions are arrays of strings (only if provided)
  if (!subscriptionsOmitted) {
    if (!Array.isArray(channelIds) || !channelIds.every(id => typeof id === "string")) {
      ws.close(1003, "Invalid channel subscriptions");
      return;
    }
    if (!Array.isArray(topicIds) || !topicIds.every(id => typeof id === "string")) {
      ws.close(1003, "Invalid topic subscriptions");
      return;
    }
  }

  // Store subscriptions:
  // - null means wildcard (subscribe to all) - when subscriptions omitted
  // - Set means filter to those IDs (empty Set = subscribe to none)
  if (subscriptionsOmitted) {
    ws.data.subscriptions.channels = null; // wildcard
    ws.data.subscriptions.topics = null;   // wildcard
  } else {
    ws.data.subscriptions.channels = new Set(channelIds);
    ws.data.subscriptions.topics = new Set(topicIds);
  }

  // Compute replay boundary (snapshot of latest event_id)
  const replayUntil = getLatestEventId(db);
  ws.data.replayUntil = replayUntil;

  // Send hello_ok
  const helloOk: HelloOkMessage = {
    type: "hello_ok",
    replay_until: replayUntil,
    instance_id: instanceId,
  };

  const sendStatus = ws.send(JSON.stringify(helloOk));
  if (sendStatus === -1 || sendStatus === 0) {
    ws.close(1008, "backpressure");
    return;
  }

  // Mark handshake complete
  ws.data.handshakeComplete = true;

  // Determine if we should do replay:
  // - If subscriptions was explicitly provided but both channels and topics are empty,
  //   that means "subscribe to none" - skip replay entirely
  // - Otherwise, replay with appropriate filters
  const subscribeToNone = !subscriptionsOmitted && 
    channelIds.length === 0 && topicIds.length === 0;

  if (subscribeToNone) {
    // No replay when explicitly subscribing to nothing
    return;
  }

  // Send replay events if any
  if (replayUntil > hello.after_event_id) {
    try {
      // For wildcard (omitted subscriptions), pass undefined to get all events
      // For filtered, pass the arrays (or undefined if that filter is empty but other isn't)
      const events = replayEvents({
        db,
        afterEventId: hello.after_event_id,
        replayUntil,
        channelIds: subscriptionsOmitted ? undefined : (channelIds.length > 0 ? channelIds : undefined),
        topicIds: subscriptionsOmitted ? undefined : (topicIds.length > 0 ? topicIds : undefined),
        limit: 1000, // Plan default
      });

      for (const event of events) {
        const envelope: EventEnvelope = {
          type: "event",
          event_id: event.event_id,
          ts: event.ts,
          name: event.name,
          scope: event.scope,
          data: event.data,
        };

        sendEventWithBackpressure(ws, envelope);

        // If connection was closed due to backpressure, stop
        if (ws.readyState !== 1) { // 1 = OPEN
          return;
        }
      }
    } catch (error) {
      console.error("Replay error:", error);
      ws.close(1011, "Internal error during replay");
      return;
    }
  }
}

function sendEventWithBackpressure(
  ws: ServerWebSocket<WsConnectionData>,
  envelope: EventEnvelope
): void {
  try {
    const serialized = JSON.stringify(envelope);
    const sendStatus = ws.send(serialized);

    // Backpressure detection (plan spec: close on -1 or 0)
    if (sendStatus === -1 || sendStatus === 0) {
      ws.close(1008, "backpressure");
    }
  } catch (error) {
    // Send error (connection may be closed)
    try {
      ws.close(1011, "Send error");
    } catch {
      // Ignore double-close errors
    }
  }
}

function isEventSubscribed(
  event: ParsedEvent,
  subscriptions: { channels: Set<string> | null; topics: Set<string> | null }
): boolean {
  // Wildcard mode: if both channels and topics are null, match ALL events
  // This happens when hello.subscriptions is omitted entirely
  if (subscriptions.channels === null && subscriptions.topics === null) {
    return true;
  }

  // If both are non-null Sets and both are empty, match NONE
  // This happens when hello.subscriptions was provided but empty: { channels: [], topics: [] }
  if (subscriptions.channels !== null && subscriptions.topics !== null &&
      subscriptions.channels.size === 0 && subscriptions.topics.size === 0) {
    return false;
  }

  // Filter mode: check if event matches any subscribed channel or topic
  // Match by channel
  if (subscriptions.channels !== null && subscriptions.channels.size > 0) {
    if (event.scope.channel_id && subscriptions.channels.has(event.scope.channel_id)) {
      return true;
    }
  }

  // Match by topic (scope_topic_id or scope_topic_id2)
  if (subscriptions.topics !== null && subscriptions.topics.size > 0) {
    if (event.scope.topic_id && subscriptions.topics.has(event.scope.topic_id)) {
      return true;
    }
    if (event.scope.topic_id2 && subscriptions.topics.has(event.scope.topic_id2)) {
      return true;
    }
  }

  return false;
}
