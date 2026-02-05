/**
 * AgentChat Client SDK - HTTP Mutation Methods
 * 
 * Convenience wrappers around the hub's POST/PATCH /api/v1/* endpoints.
 * Each method handles:
 * - Type-safe request/response
 * - Proper error handling with HubApiError
 * - JSON serialization/deserialization
 */

import type { ApiErrorResponse, ErrorCode } from '@agentchat/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// Client Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface HubHttpClient {
  baseUrl: string;
  authToken: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────────────────────

export class HubApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HubApiError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal HTTP Helper
// ─────────────────────────────────────────────────────────────────────────────

async function hubFetch<T>(
  client: HubHttpClient,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${client.baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${client.authToken}`,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new HubApiError(
      'INTERNAL_ERROR',
      text || 'Unknown error',
      res.status
    );
  }

  if (!res.ok) {
    const err = json as ApiErrorResponse;
    throw new HubApiError(
      err.code || 'INTERNAL_ERROR',
      err.error || 'Unknown error',
      res.status,
      err.details
    );
  }

  return json as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Mutations
// ─────────────────────────────────────────────────────────────────────────────

export interface SendMessageParams {
  topicId: string;
  sender: string;
  contentRaw: string;
}

export interface SendMessageResult {
  message: {
    id: string;
    topic_id: string;
    channel_id: string;
    sender: string;
    content_raw: string;
    version: number;
    created_at: string;
    edited_at: null;
    deleted_at: null;
    deleted_by: null;
  };
  event_id: number;
}

/**
 * Send a new message to a topic.
 * 
 * POST /api/v1/messages
 */
export async function sendMessage(
  client: HubHttpClient,
  params: SendMessageParams
): Promise<SendMessageResult> {
  return hubFetch(client, 'POST', '/api/v1/messages', {
    topic_id: params.topicId,
    sender: params.sender,
    content_raw: params.contentRaw,
  });
}

export interface EditMessageParams {
  messageId: string;
  contentRaw: string;
  expectedVersion?: number;
}

export interface EditMessageResult {
  message: {
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
  };
  event_id: number;
}

/**
 * Edit an existing message's content.
 * 
 * PATCH /api/v1/messages/:message_id
 * 
 * @throws HubApiError with code VERSION_CONFLICT if expectedVersion doesn't match
 */
export async function editMessage(
  client: HubHttpClient,
  params: EditMessageParams
): Promise<EditMessageResult> {
  return hubFetch(client, 'PATCH', `/api/v1/messages/${params.messageId}`, {
    op: 'edit',
    content_raw: params.contentRaw,
    ...(params.expectedVersion !== undefined
      ? { expected_version: params.expectedVersion }
      : {}),
  });
}

export interface DeleteMessageParams {
  messageId: string;
  actor: string;
}

export interface DeleteMessageResult {
  message: {
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
  };
  event_id: number | null;
}

/**
 * Delete a message (tombstone deletion).
 * 
 * PATCH /api/v1/messages/:message_id
 */
export async function deleteMessage(
  client: HubHttpClient,
  params: DeleteMessageParams
): Promise<DeleteMessageResult> {
  return hubFetch(client, 'PATCH', `/api/v1/messages/${params.messageId}`, {
    op: 'delete',
    actor: params.actor,
  });
}

export interface RetopicMessageParams {
  messageId: string;
  toTopicId: string;
  mode?: 'one' | 'later' | 'all';
}

export interface RetopicMessageResult {
  affected_count: number;
  event_ids: number[];
}

/**
 * Move a message to a different topic.
 * 
 * PATCH /api/v1/messages/:message_id
 * 
 * @param mode - 'one' (just this message), 'later' (this and subsequent), 'all' (entire thread)
 */
export async function retopicMessage(
  client: HubHttpClient,
  params: RetopicMessageParams
): Promise<RetopicMessageResult> {
  return hubFetch(client, 'PATCH', `/api/v1/messages/${params.messageId}`, {
    op: 'move_topic',
    to_topic_id: params.toTopicId,
    mode: params.mode ?? 'one',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachment Mutations
// ─────────────────────────────────────────────────────────────────────────────

export interface AddAttachmentParams {
  topicId: string;
  kind: string;
  key?: string;
  valueJson: Record<string, unknown>;
  dedupeKey?: string;
  sourceMessageId?: string;
}

export interface AddAttachmentResult {
  attachment: {
    id: string;
    topic_id: string;
    kind: string;
    key: string | null;
    value_json: Record<string, unknown>;
    dedupe_key: string | null;
    source_message_id: string | null;
    created_at: string;
  };
  event_id: number | null;
  deduplicated?: boolean;
}

/**
 * Add an attachment to a topic.
 * 
 * POST /api/v1/topics/:topic_id/attachments
 * 
 * Supports deduplication: if an attachment with the same dedupe_key exists,
 * returns the existing attachment with deduplicated=true and event_id=null.
 */
export async function addAttachment(
  client: HubHttpClient,
  params: AddAttachmentParams
): Promise<AddAttachmentResult> {
  return hubFetch(client, 'POST', `/api/v1/topics/${params.topicId}/attachments`, {
    kind: params.kind,
    key: params.key,
    value_json: params.valueJson,
    dedupe_key: params.dedupeKey,
    source_message_id: params.sourceMessageId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel Mutations
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateChannelParams {
  name: string;
}

export interface CreateChannelResult {
  channel: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
  };
  event_id: number;
}

/**
 * Create a new channel.
 * 
 * POST /api/v1/channels
 */
export async function createChannel(
  client: HubHttpClient,
  params: CreateChannelParams
): Promise<CreateChannelResult> {
  return hubFetch(client, 'POST', '/api/v1/channels', {
    name: params.name,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic Mutations
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateTopicParams {
  channelId: string;
  title: string;
}

export interface CreateTopicResult {
  topic: {
    id: string;
    channel_id: string;
    title: string;
    created_at: string;
    updated_at: string;
  };
  event_id: number;
}

/**
 * Create a new topic in a channel.
 * 
 * POST /api/v1/topics
 */
export async function createTopic(
  client: HubHttpClient,
  params: CreateTopicParams
): Promise<CreateTopicResult> {
  return hubFetch(client, 'POST', '/api/v1/topics', {
    channel_id: params.channelId,
    title: params.title,
  });
}

export interface RenameTopicParams {
  topicId: string;
  title: string;
}

export interface RenameTopicResult {
  topic: {
    id: string;
    channel_id: string;
    title: string;
    created_at: string;
    updated_at: string;
  };
  event_id: number;
}

/**
 * Rename a topic.
 * 
 * PATCH /api/v1/topics/:topic_id
 */
export async function renameTopic(
  client: HubHttpClient,
  params: RenameTopicParams
): Promise<RenameTopicResult> {
  return hubFetch(client, 'PATCH', `/api/v1/topics/${params.topicId}`, {
    title: params.title,
  });
}
