/**
 * Canonical read query helpers for @agentchat/kernel
 * 
 * Implements bd-16d.2.3: index-backed read queries for channels, topics, messages, attachments.
 * Designed to be usable by hub/cli later.
 */

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Channel {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Topic {
  id: string;
  channel_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
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

export interface TopicAttachment {
  id: string;
  topic_id: string;
  kind: string;
  key: string | null;
  value_json: Record<string, unknown>;
  dedupe_key: string;
  source_message_id: string | null;
  created_at: string;
}

interface TopicAttachmentRow {
  id: string;
  topic_id: string;
  kind: string;
  key: string | null;
  value_json: string;
  dedupe_key: string;
  source_message_id: string | null;
  created_at: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface MessageQueryOptions {
  channelId?: string;
  topicId?: string;
  limit?: number;
  beforeId?: string;
  afterId?: string;
}

export interface ListResult<T> {
  items: T[];
  hasMore: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all channels.
 * 
 * @param db - Database instance
 * @returns Array of channels ordered by name
 */
export function listChannels(db: Database): Channel[] {
  return db
    .query<Channel, []>(`
      SELECT id, name, description, created_at
      FROM channels
      ORDER BY name ASC
    `)
    .all();
}

/**
 * Get a channel by ID.
 * 
 * @param db - Database instance
 * @param channelId - Channel ID
 * @returns Channel or null if not found
 */
export function getChannelById(db: Database, channelId: string): Channel | null {
  return db
    .query<Channel, [string]>(`
      SELECT id, name, description, created_at
      FROM channels
      WHERE id = ?
    `)
    .get(channelId) ?? null;
}

/**
 * Get a channel by name.
 * 
 * @param db - Database instance
 * @param name - Channel name
 * @returns Channel or null if not found
 */
export function getChannelByName(db: Database, name: string): Channel | null {
  return db
    .query<Channel, [string]>(`
      SELECT id, name, description, created_at
      FROM channels
      WHERE name = ?
    `)
    .get(name) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List topics by channel with pagination.
 * 
 * Uses idx_topics_channel index (channel_id, updated_at DESC).
 * 
 * @param db - Database instance
 * @param channelId - Channel ID
 * @param pagination - Pagination options
 * @returns List result with topics and hasMore flag
 */
export function listTopicsByChannel(
  db: Database,
  channelId: string,
  pagination: PaginationOptions = {}
): ListResult<Topic> {
  const { limit = 50, offset = 0 } = pagination;
  const fetchLimit = limit + 1; // Fetch one extra to determine hasMore
  
  const rows = db
    .query<Topic, [string, number, number]>(`
      SELECT id, channel_id, title, created_at, updated_at
      FROM topics
      WHERE channel_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(channelId, fetchLimit, offset);
  
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  
  return { items, hasMore };
}

/**
 * Get a topic by ID.
 * 
 * @param db - Database instance
 * @param topicId - Topic ID
 * @returns Topic or null if not found
 */
export function getTopicById(db: Database, topicId: string): Topic | null {
  return db
    .query<Topic, [string]>(`
      SELECT id, channel_id, title, created_at, updated_at
      FROM topics
      WHERE id = ?
    `)
    .get(topicId) ?? null;
}

/**
 * Get a topic by channel ID and title.
 * 
 * @param db - Database instance
 * @param channelId - Channel ID
 * @param title - Topic title
 * @returns Topic or null if not found
 */
export function getTopicByTitle(db: Database, channelId: string, title: string): Topic | null {
  return db
    .query<Topic, [string, string]>(`
      SELECT id, channel_id, title, created_at, updated_at
      FROM topics
      WHERE channel_id = ? AND title = ?
    `)
    .get(channelId, title) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List messages with flexible filtering and pagination.
 * 
 * Supports querying by channel OR topic (at least one required).
 * Uses idx_messages_topic or idx_messages_channel for efficient pagination.
 * 
 * Pagination:
 * - beforeId: get messages with id < beforeId (older messages)
 * - afterId: get messages with id > afterId (newer messages)
 * - If neither: gets latest messages
 * 
 * @param db - Database instance
 * @param options - Query options
 * @returns List result with messages and hasMore flag
 */
export function listMessages(
  db: Database,
  options: MessageQueryOptions
): ListResult<Message> {
  const { channelId, topicId, limit = 50, beforeId, afterId } = options;
  
  if (!channelId && !topicId) {
    throw new Error("At least one of channelId or topicId must be provided");
  }
  
  const fetchLimit = limit + 1;
  const params: (string | number)[] = [];
  const conditions: string[] = [];
  
  // Scope condition
  if (topicId) {
    conditions.push("topic_id = ?");
    params.push(topicId);
  } else if (channelId) {
    conditions.push("channel_id = ?");
    params.push(channelId);
  }
  
  // Cursor conditions
  let orderDirection = "DESC";
  
  if (beforeId) {
    conditions.push("id < ?");
    params.push(beforeId);
    orderDirection = "DESC";
  } else if (afterId) {
    conditions.push("id > ?");
    params.push(afterId);
    orderDirection = "ASC";
  }
  
  params.push(fetchLimit);
  
  const sql = `
    SELECT id, topic_id, channel_id, sender, content_raw, version,
           created_at, edited_at, deleted_at, deleted_by
    FROM messages
    WHERE ${conditions.join(" AND ")}
    ORDER BY id ${orderDirection}
    LIMIT ?
  `;
  
  let rows = db.query<Message, (string | number)[]>(sql).all(...params);
  
  // If we fetched with ASC order (afterId), reverse to get consistent DESC order
  if (afterId) {
    rows = rows.reverse();
  }
  
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  
  return { items, hasMore };
}

/**
 * Tail messages (get latest N messages from a topic or channel).
 * 
 * Convenience wrapper for listMessages optimized for "tail" use case.
 * 
 * @param db - Database instance
 * @param topicId - Topic ID
 * @param limit - Maximum messages to return (default 50)
 * @returns Array of messages, newest first
 */
export function tailMessages(db: Database, topicId: string, limit = 50): Message[] {
  const result = listMessages(db, { topicId, limit });
  return result.items;
}

/**
 * Get a message by ID.
 * 
 * @param db - Database instance
 * @param messageId - Message ID
 * @returns Message or null if not found
 */
export function getMessageById(db: Database, messageId: string): Message | null {
  return db
    .query<Message, [string]>(`
      SELECT id, topic_id, channel_id, sender, content_raw, version,
             created_at, edited_at, deleted_at, deleted_by
      FROM messages
      WHERE id = ?
    `)
    .get(messageId) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachment Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List attachments for a topic.
 * 
 * Uses idx_attachments_topic index (topic_id, created_at DESC).
 * 
 * @param db - Database instance
 * @param topicId - Topic ID
 * @param kind - Optional filter by attachment kind
 * @returns Array of attachments with parsed value_json
 */
export function listTopicAttachments(
  db: Database,
  topicId: string,
  kind?: string
): TopicAttachment[] {
  let sql = `
    SELECT id, topic_id, kind, key, value_json, dedupe_key, source_message_id, created_at
    FROM topic_attachments
    WHERE topic_id = ?
  `;
  const params: string[] = [topicId];
  
  if (kind) {
    sql += " AND kind = ?";
    params.push(kind);
  }
  
  sql += " ORDER BY created_at DESC";
  
  const rows = db.query<TopicAttachmentRow, string[]>(sql).all(...params);
  
  // Parse value_json for each row
  return rows.map((row) => ({
    ...row,
    value_json: JSON.parse(row.value_json),
  }));
}

/**
 * Get an attachment by ID.
 * 
 * @param db - Database instance
 * @param attachmentId - Attachment ID
 * @returns Attachment with parsed value_json or null if not found
 */
export function getAttachmentById(db: Database, attachmentId: string): TopicAttachment | null {
  const row = db
    .query<TopicAttachmentRow, [string]>(`
      SELECT id, topic_id, kind, key, value_json, dedupe_key, source_message_id, created_at
      FROM topic_attachments
      WHERE id = ?
    `)
    .get(attachmentId);
  
  if (!row) return null;
  
  return {
    ...row,
    value_json: JSON.parse(row.value_json),
  };
}

/**
 * Find attachment by dedupe key (for idempotent insert checks).
 * 
 * @param db - Database instance  
 * @param topicId - Topic ID
 * @param kind - Attachment kind
 * @param key - Attachment key (optional, use empty string if null)
 * @param dedupeKey - Dedupe key
 * @returns Attachment or null if not found
 */
export function findAttachmentByDedupeKey(
  db: Database,
  topicId: string,
  kind: string,
  key: string | null,
  dedupeKey: string
): TopicAttachment | null {
  const row = db
    .query<TopicAttachmentRow, [string, string, string, string]>(`
      SELECT id, topic_id, kind, key, value_json, dedupe_key, source_message_id, created_at
      FROM topic_attachments
      WHERE topic_id = ? AND kind = ? AND COALESCE(key, '') = ? AND dedupe_key = ?
    `)
    .get(topicId, kind, key ?? "", dedupeKey);
  
  if (!row) return null;
  
  return {
    ...row,
    value_json: JSON.parse(row.value_json),
  };
}
