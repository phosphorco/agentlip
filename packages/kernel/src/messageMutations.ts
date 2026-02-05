/**
 * Message mutation helpers for @agentlip/kernel
 * 
 * Implements bd-16d.2.6 (edit + tombstone delete) and bd-16d.2.8 (retopic)
 * 
 * All mutations:
 * - Run in single DB transaction
 * - Update state (messages row(s))
 * - Increment messages.version
 * - Emit corresponding events via insertEvent
 */

import type { Database } from "bun:sqlite";
import { insertEvent } from "./events";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EditMessageOptions {
  db: Database;
  messageId: string;
  newContentRaw: string;
  expectedVersion?: number;
}

export interface EditMessageResult {
  messageId: string;
  version: number;
  eventId: number;
}

export interface TombstoneDeleteOptions {
  db: Database;
  messageId: string;
  actor: string;
  expectedVersion?: number;
}

export interface TombstoneDeleteResult {
  messageId: string;
  version: number;
  eventId: number;
}

export type RetopicMode = "one" | "later" | "all";

export interface RetopicMessageOptions {
  db: Database;
  messageId: string;
  toTopicId: string;
  mode: RetopicMode;
  expectedVersion?: number;
}

export interface RetopicMessageResult {
  affectedCount: number;
  affectedMessages: Array<{
    messageId: string;
    version: number;
    eventId: number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Classes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Error thrown when expectedVersion doesn't match current message version.
 * Contains current_version for 409 response.
 */
export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  readonly messageId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(messageId: string, expectedVersion: number, currentVersion: number) {
    super(
      `Version conflict for message ${messageId}: expected ${expectedVersion}, current ${currentVersion}`
    );
    this.name = "VersionConflictError";
    this.messageId = messageId;
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/**
 * Error thrown when message is not found.
 */
export class MessageNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly messageId: string;

  constructor(messageId: string) {
    super(`Message not found: ${messageId}`);
    this.name = "MessageNotFoundError";
    this.messageId = messageId;
  }
}

/**
 * Error thrown when attempting cross-channel retopic.
 */
export class CrossChannelMoveError extends Error {
  readonly code = "CROSS_CHANNEL_MOVE";
  readonly messageId: string;
  readonly sourceChannelId: string;
  readonly targetChannelId: string;

  constructor(messageId: string, sourceChannelId: string, targetChannelId: string) {
    super(
      `Cross-channel move forbidden: message ${messageId} is in channel ${sourceChannelId}, target topic is in channel ${targetChannelId}`
    );
    this.name = "CrossChannelMoveError";
    this.messageId = messageId;
    this.sourceChannelId = sourceChannelId;
    this.targetChannelId = targetChannelId;
  }
}

/**
 * Error thrown when target topic is not found.
 */
export class TopicNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly topicId: string;

  constructor(topicId: string) {
    super(`Topic not found: ${topicId}`);
    this.name = "TopicNotFoundError";
    this.topicId = topicId;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface MessageRow {
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
}

interface TopicRow {
  id: string;
  channel_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function getMessageOrThrow(db: Database, messageId: string): MessageRow {
  const message = db
    .query<MessageRow, [string]>(`
      SELECT id, topic_id, channel_id, sender, content_raw, version,
             created_at, edited_at, deleted_at, deleted_by
      FROM messages
      WHERE id = ?
    `)
    .get(messageId);

  if (!message) {
    throw new MessageNotFoundError(messageId);
  }

  return message;
}

function getTopicOrThrow(db: Database, topicId: string): TopicRow {
  const topic = db
    .query<TopicRow, [string]>(`
      SELECT id, channel_id, title, created_at, updated_at
      FROM topics
      WHERE id = ?
    `)
    .get(topicId);

  if (!topic) {
    throw new TopicNotFoundError(topicId);
  }

  return topic;
}

function checkVersion(
  message: MessageRow,
  expectedVersion: number | undefined
): void {
  if (expectedVersion !== undefined && message.version !== expectedVersion) {
    throw new VersionConflictError(message.id, expectedVersion, message.version);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit Message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edit message content.
 * 
 * Updates:
 * - content_raw to newContentRaw
 * - edited_at to now
 * - version incremented by 1
 * 
 * Emits: message.edited event with old_content, new_content, version
 * 
 * @throws MessageNotFoundError if message doesn't exist
 * @throws VersionConflictError if expectedVersion provided and mismatched
 */
export function editMessage(options: EditMessageOptions): EditMessageResult {
  const { db, messageId, newContentRaw, expectedVersion } = options;

  // Validate content length (per schema: max 64KB)
  if (newContentRaw.length > 65536) {
    throw new Error("Content too large: max 64KB");
  }

  // Use transaction for atomicity
  const result = db.transaction(() => {
    // 1. Get and validate message
    const message = getMessageOrThrow(db, messageId);
    
    // 2. Check version if provided
    checkVersion(message, expectedVersion);

    const oldContent = message.content_raw;
    const newVersion = message.version + 1;
    const now = new Date().toISOString();

    // 3. Update message state
    db.run(
      `UPDATE messages
       SET content_raw = ?, edited_at = ?, version = ?
       WHERE id = ?`,
      [newContentRaw, now, newVersion, messageId]
    );

    // 4. Emit event
    const eventId = insertEvent({
      db,
      name: "message.edited",
      scopes: {
        channel_id: message.channel_id,
        topic_id: message.topic_id,
      },
      entity: { type: "message", id: messageId },
      data: {
        message_id: messageId,
        old_content: oldContent,
        new_content: newContentRaw,
        version: newVersion,
      },
    });

    return { messageId, version: newVersion, eventId };
  })();

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tombstone Delete Message
// ─────────────────────────────────────────────────────────────────────────────

const TOMBSTONE_CONTENT = "[deleted]";

/**
 * Tombstone delete a message.
 * 
 * Updates:
 * - deleted_at to now
 * - deleted_by to actor
 * - content_raw to "[deleted]"
 * - edited_at to now
 * - version incremented by 1
 * 
 * Emits: message.deleted event with message_id, deleted_by, version
 * 
 * Idempotent: if already deleted, returns success with no new event.
 * 
 * @throws MessageNotFoundError if message doesn't exist
 * @throws VersionConflictError if expectedVersion provided and mismatched
 */
export function tombstoneDeleteMessage(
  options: TombstoneDeleteOptions
): TombstoneDeleteResult {
  const { db, messageId, actor, expectedVersion } = options;

  if (!actor || actor.trim().length === 0) {
    throw new Error("Actor must be a non-empty string");
  }

  const result = db.transaction(() => {
    // 1. Get and validate message
    const message = getMessageOrThrow(db, messageId);

    // 2. Check idempotency: if already deleted, return success
    if (message.deleted_at !== null) {
      // Return current state without new event (idempotent)
      return {
        messageId,
        version: message.version,
        eventId: 0, // No new event
        alreadyDeleted: true,
      };
    }

    // 3. Check version if provided
    checkVersion(message, expectedVersion);

    const newVersion = message.version + 1;
    const now = new Date().toISOString();

    // 4. Update message state (tombstone)
    db.run(
      `UPDATE messages
       SET deleted_at = ?, deleted_by = ?, content_raw = ?, edited_at = ?, version = ?
       WHERE id = ?`,
      [now, actor, TOMBSTONE_CONTENT, now, newVersion, messageId]
    );

    // 5. Emit event
    const eventId = insertEvent({
      db,
      name: "message.deleted",
      scopes: {
        channel_id: message.channel_id,
        topic_id: message.topic_id,
      },
      entity: { type: "message", id: messageId },
      data: {
        message_id: messageId,
        deleted_by: actor,
        version: newVersion,
      },
    });

    return { messageId, version: newVersion, eventId, alreadyDeleted: false };
  })();

  return {
    messageId: result.messageId,
    version: result.version,
    eventId: result.eventId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retopic Message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move message(s) to a different topic (same channel only).
 * 
 * Modes:
 * - "one": only the specified message
 * - "later": message and all subsequent messages in the topic (by id order)
 * - "all": all messages in the topic (regardless of position)
 * 
 * For each affected message:
 * - Updates topic_id
 * - Increments version
 * - Emits message.moved_topic event
 * 
 * Idempotent: if message(s) already in target topic, returns success with no changes.
 * 
 * @throws MessageNotFoundError if anchor message doesn't exist
 * @throws TopicNotFoundError if target topic doesn't exist
 * @throws CrossChannelMoveError if target topic is in different channel
 * @throws VersionConflictError if expectedVersion provided and mismatched (for anchor message only)
 */
export function retopicMessage(
  options: RetopicMessageOptions
): RetopicMessageResult {
  const { db, messageId, toTopicId, mode, expectedVersion } = options;

  const result = db.transaction(() => {
    // 1. Get and validate anchor message
    const anchorMessage = getMessageOrThrow(db, messageId);

    // 2. Idempotent: if already in target topic (mode=one), return success
    if (mode === "one" && anchorMessage.topic_id === toTopicId) {
      return { affectedCount: 0, affectedMessages: [] };
    }

    // 3. Check version if provided (only for anchor message)
    checkVersion(anchorMessage, expectedVersion);

    // 4. Get and validate target topic
    const targetTopic = getTopicOrThrow(db, toTopicId);

    // 5. Enforce same-channel constraint
    if (anchorMessage.channel_id !== targetTopic.channel_id) {
      throw new CrossChannelMoveError(
        messageId,
        anchorMessage.channel_id,
        targetTopic.channel_id
      );
    }

    const oldTopicId = anchorMessage.topic_id;

    // Idempotent: if already in target topic (any mode), return
    if (oldTopicId === toTopicId) {
      return { affectedCount: 0, affectedMessages: [] };
    }

    // 6. Determine affected messages based on mode
    let affectedMessageIds: string[];

    switch (mode) {
      case "one":
        affectedMessageIds = [messageId];
        break;

      case "later":
        // Messages with id >= anchor id in the same topic (by id order)
        affectedMessageIds = db
          .query<{ id: string }, [string, string]>(
            `SELECT id FROM messages
             WHERE topic_id = ? AND id >= ?
             ORDER BY id ASC`
          )
          .all(oldTopicId, messageId)
          .map((row) => row.id);
        break;

      case "all":
        // All messages in the topic
        affectedMessageIds = db
          .query<{ id: string }, [string]>(
            `SELECT id FROM messages
             WHERE topic_id = ?
             ORDER BY id ASC`
          )
          .all(oldTopicId)
          .map((row) => row.id);
        break;

      default:
        throw new Error(`Invalid retopic mode: ${mode}`);
    }

    if (affectedMessageIds.length === 0) {
      return { affectedCount: 0, affectedMessages: [] };
    }

    const affectedMessages: Array<{
      messageId: string;
      version: number;
      eventId: number;
    }> = [];

    const channelId = anchorMessage.channel_id;

    // 7. For each affected message: update state + emit event
    for (const affectedId of affectedMessageIds) {
      // Get current version
      const current = db
        .query<{ version: number }, [string]>(
          "SELECT version FROM messages WHERE id = ?"
        )
        .get(affectedId);

      if (!current) continue; // Shouldn't happen, but be defensive

      const newVersion = current.version + 1;

      // Update topic_id and version
      db.run(
        `UPDATE messages
         SET topic_id = ?, version = ?
         WHERE id = ?`,
        [toTopicId, newVersion, affectedId]
      );

      // Emit event
      const eventId = insertEvent({
        db,
        name: "message.moved_topic",
        scopes: {
          channel_id: channelId,
          topic_id: oldTopicId,
          topic_id2: toTopicId,
        },
        entity: { type: "message", id: affectedId },
        data: {
          message_id: affectedId,
          old_topic_id: oldTopicId,
          new_topic_id: toTopicId,
          channel_id: channelId,
          mode,
          version: newVersion,
        },
      });

      affectedMessages.push({
        messageId: affectedId,
        version: newVersion,
        eventId,
      });
    }

    return {
      affectedCount: affectedMessages.length,
      affectedMessages,
    };
  })();

  return result;
}
