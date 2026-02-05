/**
 * AgentChat Hub HTTP API v1 handler
 * 
 * Pure handler module implementing all /api/v1/* endpoints:
 * - GET /api/v1/channels
 * - POST /api/v1/channels (auth)
 * - GET /api/v1/channels/:channel_id/topics
 * - POST /api/v1/topics (auth)
 * - PATCH /api/v1/topics/:topic_id (auth)
 * - GET /api/v1/messages
 * - POST /api/v1/messages (auth)
 * - PATCH /api/v1/messages/:message_id (auth)
 * - GET /api/v1/topics/:topic_id/attachments
 * - POST /api/v1/topics/:topic_id/attachments (auth)
 * - GET /api/v1/events
 * 
 * Returns Response objects; does NOT touch packages/hub/src/index.ts.
 */

import type { Database } from "bun:sqlite";
import { requireAuth } from "./authMiddleware";
import {
  readJsonBody,
  SIZE_LIMITS,
  validationErrorResponse,
  validateJsonSize,
} from "./bodyParser";
import type { HubRateLimiter } from "./rateLimiter";
import { rateLimitedResponse, addRateLimitHeaders } from "./rateLimiter";
import {
  listChannels,
  getChannelById,
  listTopicsByChannel,
  getTopicById,
  listMessages,
  listTopicAttachments,
  findAttachmentByDedupeKey,
  editMessage,
  tombstoneDeleteMessage,
  retopicMessage,
  VersionConflictError,
  MessageNotFoundError,
  CrossChannelMoveError,
  TopicNotFoundError,
  insertEvent,
  replayEvents,
  getLatestEventId,
} from "@agentchat/kernel";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiV1Context {
  db: Database;
  /** Expected Bearer token for mutation endpoints. */
  authToken: string;
  instanceId: string;
  rateLimiter?: HubRateLimiter;
  /** Optional hook invoked after successful mutations to publish newly-created event ids (e.g. for WS fanout). */
  onEventIds?: (eventIds: number[]) => void;
}

interface RouteMatch {
  handler: (req: Request, ctx: ApiV1Context, params: Record<string, string>) => Response | Promise<Response>;
  params: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ID Generation
// ─────────────────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const randomPart = Math.random().toString(36).substring(2, 10);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${randomPart}`;
}

function publishEventIds(
  ctx: ApiV1Context,
  eventIds: Array<number | null | undefined>
): void {
  if (!ctx.onEventIds) return;
  const ids = eventIds.filter((id): id is number => typeof id === "number" && id > 0);
  if (ids.length > 0) {
    ctx.onEventIds(ids);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Response Helpers
// ─────────────────────────────────────────────────────────────────────────────

function notFoundResponse(message = "Not found"): Response {
  return new Response(
    JSON.stringify({
      error: message,
      code: "NOT_FOUND",
    }),
    {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function versionConflictResponse(error: VersionConflictError): Response {
  return new Response(
    JSON.stringify({
      error: error.message,
      code: "VERSION_CONFLICT",
      current_version: error.currentVersion,
    }),
    {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function crossChannelMoveResponse(error: CrossChannelMoveError): Response {
  return new Response(
    JSON.stringify({
      error: error.message,
      code: "CROSS_CHANNEL_MOVE",
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function internalErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    }),
    {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/channels
 */
function handleListChannels(req: Request, ctx: ApiV1Context): Response {
  const channels = listChannels(ctx.db);
  return jsonResponse({ channels });
}

/**
 * POST /api/v1/channels
 */
async function handleCreateChannel(req: Request, ctx: ApiV1Context): Promise<Response> {
  // Auth required
  const authResult = requireAuth(req, ctx.authToken);
  if (!authResult.ok) {
    return authResult.response;
  }

  // Parse and validate body
  const bodyResult = await readJsonBody<{ name: string; description?: string }>(req);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { name, description } = bodyResult.data;

  // Validate name
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return validationErrorResponse("Channel name is required");
  }
  if (name.length > 100) {
    return validationErrorResponse("Channel name must be <= 100 characters");
  }

  try {
    const channelId = generateId("ch");
    const now = new Date().toISOString();

    // Use transaction
    const result = ctx.db.transaction(() => {
      // Insert channel
      ctx.db.run(
        `INSERT INTO channels (id, name, description, created_at)
         VALUES (?, ?, ?, ?)`,
        [channelId, name, description ?? null, now]
      );

      // Emit event
      const eventId = insertEvent({
        db: ctx.db,
        name: "channel.created",
        scopes: { channel_id: channelId },
        entity: { type: "channel", id: channelId },
        data: {
          channel: {
            id: channelId,
            name,
            description: description ?? null,
            created_at: now,
          },
        },
      });

      return { channelId, eventId };
    })();

    publishEventIds(ctx, [result.eventId]);

    const channel = {
      id: result.channelId,
      name,
      description: description ?? null,
      created_at: now,
    };

    return jsonResponse({ channel, event_id: result.eventId }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return validationErrorResponse("Channel name already exists");
    }
    console.error("Failed to create channel:", error);
    return internalErrorResponse();
  }
}

/**
 * GET /api/v1/channels/:channel_id/topics
 */
function handleListTopics(
  req: Request,
  ctx: ApiV1Context,
  params: Record<string, string>
): Response {
  const channelId = params.channel_id;

  // Validate channel exists
  const channel = getChannelById(ctx.db, channelId);
  if (!channel) {
    return notFoundResponse("Channel not found");
  }

  // Parse pagination params
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const result = listTopicsByChannel(ctx.db, channelId, { limit, offset });

  return jsonResponse({ topics: result.items, has_more: result.hasMore });
}

/**
 * POST /api/v1/topics
 */
async function handleCreateTopic(req: Request, ctx: ApiV1Context): Promise<Response> {
  // Auth required
  const authResult = requireAuth(req, ctx.authToken);
  if (!authResult.ok) {
    return authResult.response;
  }

  // Parse and validate body
  const bodyResult = await readJsonBody<{ channel_id: string; title: string }>(req);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { channel_id, title } = bodyResult.data;

  // Validate inputs
  if (!channel_id || typeof channel_id !== "string") {
    return validationErrorResponse("channel_id is required");
  }
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return validationErrorResponse("title is required");
  }
  if (title.length > 200) {
    return validationErrorResponse("title must be <= 200 characters");
  }

  // Validate channel exists
  const channel = getChannelById(ctx.db, channel_id);
  if (!channel) {
    return notFoundResponse("Channel not found");
  }

  try {
    const topicId = generateId("topic");
    const now = new Date().toISOString();

    // Use transaction
    const result = ctx.db.transaction(() => {
      // Insert topic
      ctx.db.run(
        `INSERT INTO topics (id, channel_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [topicId, channel_id, title, now, now]
      );

      // Emit event
      const eventId = insertEvent({
        db: ctx.db,
        name: "topic.created",
        scopes: { channel_id, topic_id: topicId },
        entity: { type: "topic", id: topicId },
        data: {
          topic: {
            id: topicId,
            channel_id,
            title,
            created_at: now,
            updated_at: now,
          },
        },
      });

      return { topicId, eventId };
    })();

    publishEventIds(ctx, [result.eventId]);

    const topic = {
      id: result.topicId,
      channel_id,
      title,
      created_at: now,
      updated_at: now,
    };

    return jsonResponse({ topic, event_id: result.eventId }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return validationErrorResponse("Topic title already exists in this channel");
    }
    console.error("Failed to create topic:", error);
    return internalErrorResponse();
  }
}

/**
 * PATCH /api/v1/topics/:topic_id
 */
async function handleUpdateTopic(
  req: Request,
  ctx: ApiV1Context,
  params: Record<string, string>
): Promise<Response> {
  // Auth required
  const authResult = requireAuth(req, ctx.authToken);
  if (!authResult.ok) {
    return authResult.response;
  }

  const topicId = params.topic_id;

  // Parse and validate body
  const bodyResult = await readJsonBody<{ title: string }>(req);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { title } = bodyResult.data;

  // Validate title
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return validationErrorResponse("title is required");
  }
  if (title.length > 200) {
    return validationErrorResponse("title must be <= 200 characters");
  }

  // Validate topic exists
  const topic = getTopicById(ctx.db, topicId);
  if (!topic) {
    return notFoundResponse("Topic not found");
  }

  try {
    const now = new Date().toISOString();

    // Use transaction
    const result = ctx.db.transaction(() => {
      const oldTitle = topic.title;

      // Update topic
      ctx.db.run(
        `UPDATE topics
         SET title = ?, updated_at = ?
         WHERE id = ?`,
        [title, now, topicId]
      );

      // Emit event
      const eventId = insertEvent({
        db: ctx.db,
        name: "topic.renamed",
        scopes: { channel_id: topic.channel_id, topic_id: topicId },
        entity: { type: "topic", id: topicId },
        data: {
          topic_id: topicId,
          old_title: oldTitle,
          new_title: title,
        },
      });

      return { eventId };
    })();

    publishEventIds(ctx, [result.eventId]);

    const updatedTopic = {
      id: topicId,
      channel_id: topic.channel_id,
      title,
      created_at: topic.created_at,
      updated_at: now,
    };

    return jsonResponse({ topic: updatedTopic, event_id: result.eventId });
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return validationErrorResponse("Topic title already exists in this channel");
    }
    console.error("Failed to update topic:", error);
    return internalErrorResponse();
  }
}

/**
 * GET /api/v1/messages
 */
function handleListMessages(req: Request, ctx: ApiV1Context): Response {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channel_id") ?? undefined;
  const topicId = url.searchParams.get("topic_id") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const beforeId = url.searchParams.get("before_id") ?? undefined;
  const afterId = url.searchParams.get("after_id") ?? undefined;

  // Validate at least one scope
  if (!channelId && !topicId) {
    return validationErrorResponse("At least one of channel_id or topic_id is required");
  }

  try {
    const result = listMessages(ctx.db, {
      channelId,
      topicId,
      limit,
      beforeId,
      afterId,
    });

    return jsonResponse({ messages: result.items, has_more: result.hasMore });
  } catch (error) {
    console.error("Failed to list messages:", error);
    return internalErrorResponse();
  }
}

/**
 * POST /api/v1/messages
 */
async function handleCreateMessage(req: Request, ctx: ApiV1Context): Promise<Response> {
  // Auth required
  const authResult = requireAuth(req, ctx.authToken);
  if (!authResult.ok) {
    return authResult.response;
  }

  // Parse and validate body
  const bodyResult = await readJsonBody<{
    topic_id: string;
    sender: string;
    content_raw: string;
  }>(req);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { topic_id, sender, content_raw } = bodyResult.data;

  // Validate inputs
  if (!topic_id || typeof topic_id !== "string") {
    return validationErrorResponse("topic_id is required");
  }
  if (!sender || typeof sender !== "string" || sender.trim().length === 0) {
    return validationErrorResponse("sender is required");
  }
  if (typeof content_raw !== "string") {
    return validationErrorResponse("content_raw must be a string");
  }
  if (content_raw.length > SIZE_LIMITS.MESSAGE_BODY) {
    return validationErrorResponse("content_raw exceeds 64KB limit");
  }

  // Validate topic exists
  const topic = getTopicById(ctx.db, topic_id);
  if (!topic) {
    return notFoundResponse("Topic not found");
  }

  try {
    const messageId = generateId("msg");
    const now = new Date().toISOString();

    // Use transaction
    const result = ctx.db.transaction(() => {
      // Insert message
      ctx.db.run(
        `INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [messageId, topic_id, topic.channel_id, sender, content_raw, now]
      );

      // Update topic updated_at
      ctx.db.run(
        `UPDATE topics SET updated_at = ? WHERE id = ?`,
        [now, topic_id]
      );

      // Emit event
      const eventId = insertEvent({
        db: ctx.db,
        name: "message.created",
        scopes: { channel_id: topic.channel_id, topic_id },
        entity: { type: "message", id: messageId },
        data: {
          message: {
            id: messageId,
            topic_id,
            channel_id: topic.channel_id,
            sender,
            content_raw,
            version: 1,
            created_at: now,
            edited_at: null,
            deleted_at: null,
            deleted_by: null,
          },
        },
      });

      return { messageId, eventId };
    })();

    publishEventIds(ctx, [result.eventId]);

    const message = {
      id: result.messageId,
      topic_id,
      channel_id: topic.channel_id,
      sender,
      content_raw,
      version: 1,
      created_at: now,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
    };

    return jsonResponse({ message, event_id: result.eventId }, 201);
  } catch (error) {
    console.error("Failed to create message:", error);
    return internalErrorResponse();
  }
}

/**
 * PATCH /api/v1/messages/:message_id
 */
async function handlePatchMessage(
  req: Request,
  ctx: ApiV1Context,
  params: Record<string, string>
): Promise<Response> {
  // Auth required
  const authResult = requireAuth(req, ctx.authToken);
  if (!authResult.ok) {
    return authResult.response;
  }

  const messageId = params.message_id;

  // Parse and validate body
  const bodyResult = await readJsonBody<{
    op: "edit" | "delete" | "move_topic";
    content_raw?: string;
    actor?: string;
    to_topic_id?: string;
    mode?: "one" | "later" | "all";
    expected_version?: number;
  }>(req);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { op, content_raw, actor, to_topic_id, mode, expected_version } = bodyResult.data;

  // Validate op
  if (!op || !["edit", "delete", "move_topic"].includes(op)) {
    return validationErrorResponse("op must be one of: edit, delete, move_topic");
  }

  try {
    // Handle each operation
    if (op === "edit") {
      // Validate content_raw
      if (!content_raw || typeof content_raw !== "string") {
        return validationErrorResponse("content_raw is required for edit operation");
      }
      if (content_raw.length > SIZE_LIMITS.MESSAGE_BODY) {
        return validationErrorResponse("content_raw exceeds 64KB limit");
      }

      const result = editMessage({
        db: ctx.db,
        messageId,
        newContentRaw: content_raw,
        expectedVersion: expected_version,
      });

      publishEventIds(ctx, [result.eventId]);

      // Get updated message
      const message = ctx.db
        .query<{
          id: string;
          topic_id: string;
          channel_id: string;
          sender: string;
          content_raw: string;
          version: number;
          created_at: string;
          edited_at: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        }, [string]>(
          `SELECT id, topic_id, channel_id, sender, content_raw, version, 
                  created_at, edited_at, deleted_at, deleted_by
           FROM messages WHERE id = ?`
        )
        .get(messageId);

      return jsonResponse({ message, event_id: result.eventId });
    } else if (op === "delete") {
      // Validate actor
      if (!actor || typeof actor !== "string" || actor.trim().length === 0) {
        return validationErrorResponse("actor is required for delete operation");
      }

      const result = tombstoneDeleteMessage({
        db: ctx.db,
        messageId,
        actor,
        expectedVersion: expected_version,
      });

      publishEventIds(ctx, [result.eventId]);

      // Get updated message
      const message = ctx.db
        .query<{
          id: string;
          topic_id: string;
          channel_id: string;
          sender: string;
          content_raw: string;
          version: number;
          created_at: string;
          edited_at: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
        }, [string]>(
          `SELECT id, topic_id, channel_id, sender, content_raw, version,
                  created_at, edited_at, deleted_at, deleted_by
           FROM messages WHERE id = ?`
        )
        .get(messageId);

      return jsonResponse({ message, event_id: result.eventId === 0 ? null : result.eventId });
    } else if (op === "move_topic") {
      // Validate to_topic_id
      if (!to_topic_id || typeof to_topic_id !== "string") {
        return validationErrorResponse("to_topic_id is required for move_topic operation");
      }

      // Validate mode
      if (!mode || !["one", "later", "all"].includes(mode)) {
        return validationErrorResponse("mode must be one of: one, later, all");
      }

      const result = retopicMessage({
        db: ctx.db,
        messageId,
        toTopicId: to_topic_id,
        mode,
        expectedVersion: expected_version,
      });

      const eventIds = result.affectedMessages.map((m) => m.eventId);
      publishEventIds(ctx, eventIds);

      return jsonResponse({
        affected_count: result.affectedCount,
        event_ids: eventIds,
      });
    }

    return internalErrorResponse();
  } catch (error) {
    if (error instanceof VersionConflictError) {
      return versionConflictResponse(error);
    }
    if (error instanceof MessageNotFoundError || error instanceof TopicNotFoundError) {
      return notFoundResponse(error.message);
    }
    if (error instanceof CrossChannelMoveError) {
      return crossChannelMoveResponse(error);
    }
    console.error("Failed to patch message:", error);
    return internalErrorResponse();
  }
}

/**
 * GET /api/v1/topics/:topic_id/attachments
 */
function handleListAttachments(
  req: Request,
  ctx: ApiV1Context,
  params: Record<string, string>
): Response {
  const topicId = params.topic_id;

  // Validate topic exists
  const topic = getTopicById(ctx.db, topicId);
  if (!topic) {
    return notFoundResponse("Topic not found");
  }

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? undefined;

  const attachments = listTopicAttachments(ctx.db, topicId, kind);

  return jsonResponse({ attachments });
}

/**
 * POST /api/v1/topics/:topic_id/attachments
 */
async function handleCreateAttachment(
  req: Request,
  ctx: ApiV1Context,
  params: Record<string, string>
): Promise<Response> {
  // Auth required
  const authResult = requireAuth(req, ctx.authToken);
  if (!authResult.ok) {
    return authResult.response;
  }

  const topicId = params.topic_id;

  // Validate topic exists
  const topic = getTopicById(ctx.db, topicId);
  if (!topic) {
    return notFoundResponse("Topic not found");
  }

  // Parse and validate body
  const bodyResult = await readJsonBody<{
    kind: string;
    key?: string;
    value_json: Record<string, unknown>;
    dedupe_key?: string;
    source_message_id?: string;
  }>(req, { maxBytes: SIZE_LIMITS.ATTACHMENT });
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { kind, key, value_json, dedupe_key, source_message_id } = bodyResult.data;

  // Validate inputs
  if (!kind || typeof kind !== "string" || kind.trim().length === 0) {
    return validationErrorResponse("kind is required");
  }
  if (!value_json || typeof value_json !== "object" || Array.isArray(value_json)) {
    return validationErrorResponse("value_json must be an object");
  }

  // Validate value_json size
  if (!validateJsonSize(value_json, SIZE_LIMITS.ATTACHMENT)) {
    return validationErrorResponse("value_json exceeds 16KB limit");
  }

  try {
    // Compute dedupe_key if not provided
    const finalDedupeKey = dedupe_key ?? JSON.stringify(value_json);

    const attachmentId = generateId("att");
    const now = new Date().toISOString();
    const valueJsonStr = JSON.stringify(value_json);

    // Use transaction with idempotency check
    const result = ctx.db.transaction(() => {
      // Check if attachment already exists (dedupe)
      const existing = ctx.db
        .query<{ id: string }, [string, string, string, string]>(
          `SELECT id FROM topic_attachments
           WHERE topic_id = ? AND kind = ? AND COALESCE(key, '') = ? AND dedupe_key = ?`
        )
        .get(topicId, kind, key ?? "", finalDedupeKey);

      if (existing) {
        // Return existing attachment, no event
        return { attachmentId: existing.id, eventId: null, deduplicated: true };
      }

      // Insert new attachment
      ctx.db.run(
        `INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attachmentId,
          topicId,
          kind,
          key ?? null,
          valueJsonStr,
          finalDedupeKey,
          source_message_id ?? null,
          now,
        ]
      );

      // Emit event
      const eventId = insertEvent({
        db: ctx.db,
        name: "topic.attachment_added",
        scopes: { channel_id: topic.channel_id, topic_id: topicId },
        entity: { type: "attachment", id: attachmentId },
        data: {
          attachment: {
            id: attachmentId,
            topic_id: topicId,
            kind,
            key: key ?? null,
            value_json,
            dedupe_key: finalDedupeKey,
            source_message_id: source_message_id ?? null,
            created_at: now,
          },
        },
      });

      return { attachmentId, eventId, deduplicated: false };
    })();

    if (result.deduplicated) {
      const existing = findAttachmentByDedupeKey(
        ctx.db,
        topicId,
        kind,
        key ?? null,
        finalDedupeKey
      );

      if (!existing) {
        // Should never happen: dedupe check found a row, but we can't fetch it.
        return internalErrorResponse();
      }

      return jsonResponse({ attachment: existing, event_id: null });
    }

    publishEventIds(ctx, [result.eventId]);

    const attachment = {
      id: result.attachmentId,
      topic_id: topicId,
      kind,
      key: key ?? null,
      value_json,
      dedupe_key: finalDedupeKey,
      source_message_id: source_message_id ?? null,
      created_at: now,
    };

    return jsonResponse({ attachment, event_id: result.eventId }, 201);
  } catch (error) {
    console.error("Failed to create attachment:", error);
    return internalErrorResponse();
  }
}

/**
 * GET /api/v1/events
 */
function handleListEvents(req: Request, ctx: ApiV1Context): Response {
  const url = new URL(req.url);
  const after = parseInt(url.searchParams.get("after") ?? "0", 10);
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "100", 10),
    1000
  );

  try {
    const replayUntil = getLatestEventId(ctx.db);
    const events = replayEvents({
      db: ctx.db,
      afterEventId: after,
      replayUntil,
      limit,
    });

    // Convert events to simplified format
    const formattedEvents = events.map((event) => ({
      event_id: event.event_id,
      ts: event.ts,
      name: event.name,
      data_json: event.data,
    }));

    return jsonResponse({ events: formattedEvents });
  } catch (error) {
    console.error("Failed to list events:", error);
    return internalErrorResponse();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Matching
// ─────────────────────────────────────────────────────────────────────────────

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (req: Request, ctx: ApiV1Context, params: Record<string, string>) => Response | Promise<Response>;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/v1\/channels$/,
    paramNames: [],
    handler: handleListChannels,
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/channels$/,
    paramNames: [],
    handler: handleCreateChannel,
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/channels\/([^/]+)\/topics$/,
    paramNames: ["channel_id"],
    handler: handleListTopics,
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/topics$/,
    paramNames: [],
    handler: handleCreateTopic,
  },
  {
    method: "PATCH",
    pattern: /^\/api\/v1\/topics\/([^/]+)$/,
    paramNames: ["topic_id"],
    handler: handleUpdateTopic,
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/messages$/,
    paramNames: [],
    handler: handleListMessages,
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/messages$/,
    paramNames: [],
    handler: handleCreateMessage,
  },
  {
    method: "PATCH",
    pattern: /^\/api\/v1\/messages\/([^/]+)$/,
    paramNames: ["message_id"],
    handler: handlePatchMessage,
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/topics\/([^/]+)\/attachments$/,
    paramNames: ["topic_id"],
    handler: handleListAttachments,
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/topics\/([^/]+)\/attachments$/,
    paramNames: ["topic_id"],
    handler: handleCreateAttachment,
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/events$/,
    paramNames: [],
    handler: handleListEvents,
  },
];

function matchRoute(method: string, path: string): RouteMatch | null {
  for (const route of routes) {
    if (route.method !== method) continue;

    const match = path.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]] = match[i + 1];
    }

    return { handler: route.handler, params };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle API v1 requests.
 * 
 * Pure handler that returns Response. Does not touch index.ts.
 * Integrator should mount this at /api/v1/*.
 * 
 * @param req - HTTP request
 * @param ctx - Handler context (db, auth, instance ID)
 * @returns HTTP response
 */
export async function handleApiV1(req: Request, ctx: ApiV1Context): Promise<Response> {
  // Rate limiting (if provided). IMPORTANT: HubRateLimiter.check() consumes a token,
  // so only call it once per request.
  let rateLimitResult: ReturnType<HubRateLimiter["check"]> | null = null;
  if (ctx.rateLimiter) {
    rateLimitResult = ctx.rateLimiter.check(req);
    if (!rateLimitResult.allowed) {
      return rateLimitedResponse(rateLimitResult);
    }
  }

  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Match route
  const match = matchRoute(method, path);
  if (!match) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const response = await match.handler(req, ctx, match.params);

    // Add rate limit headers using the result from the single check.
    if (rateLimitResult) {
      return addRateLimitHeaders(response, rateLimitResult);
    }

    return response;
  } catch (error) {
    console.error("Unhandled error in API handler:", error);
    return internalErrorResponse();
  }
}
