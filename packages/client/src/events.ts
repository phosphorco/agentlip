/**
 * Typed event envelope processing for Agentlip SDK
 * 
 * Provides TypeScript discriminated unions for known event types,
 * type guards, and async iterator wrapper for type-safe event handling.
 * 
 * Uses additive-only schema: new event types can be added without
 * breaking existing consumers. Unknown events pass through as EventEnvelope.
 */

import type { EventEnvelope } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Known Event Names (additive-only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known event names in the protocol.
 * New names can be added over time without breaking existing consumers.
 */
export type KnownEventName =
  | "channel.created"
  | "message.created"
  | "message.edited"
  | "message.deleted"
  | "message.moved_topic"
  | "topic.created"
  | "topic.renamed"
  | "topic.attachment_added"
  | "message.enriched";

// ─────────────────────────────────────────────────────────────────────────────
// Event Data Shapes (matching actual hub/kernel implementation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message shape in event data (matches kernel message table + apiV1 emission).
 */
export interface EventMessage {
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

/**
 * Topic shape in event data.
 */
export interface EventTopic {
  id: string;
  channel_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/**
 * Channel shape in event data.
 */
export interface EventChannel {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

/**
 * Attachment shape in event data.
 */
export interface EventAttachment {
  id: string;
  topic_id: string;
  kind: string;
  key: string | null;
  value_json: Record<string, unknown>;
  dedupe_key: string;
  source_message_id: string | null;
  created_at: string;
}

/**
 * Enrichment shape in event data.
 */
export interface EventEnrichment {
  id: number;
  message_id: string;
  plugin_name: string;
  kind: string;
  span_start: number;
  span_end: number;
  label: string;
  url: string | null;
  metadata_json: Record<string, unknown> | null;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed Event Discriminated Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * channel.created event (from apiV1.ts handleCreateChannel)
 */
export interface ChannelCreatedEvent extends EventEnvelope {
  name: "channel.created";
  data: {
    channel: EventChannel;
  };
}

/**
 * message.created event (from apiV1.ts handleCreateMessage)
 */
export interface MessageCreatedEvent extends EventEnvelope {
  name: "message.created";
  data: {
    message: EventMessage;
  };
}

/**
 * message.edited event (from kernel messageMutations.ts)
 */
export interface MessageEditedEvent extends EventEnvelope {
  name: "message.edited";
  data: {
    message_id: string;
    old_content: string;
    new_content: string;
    version: number;
  };
}

/**
 * message.deleted event (from kernel messageMutations.ts)
 */
export interface MessageDeletedEvent extends EventEnvelope {
  name: "message.deleted";
  data: {
    message_id: string;
    deleted_by: string;
  };
}

/**
 * message.moved_topic event (from kernel messageMutations.ts retopicMessage)
 */
export interface MessageMovedTopicEvent extends EventEnvelope {
  name: "message.moved_topic";
  data: {
    message_id: string;
    old_topic_id: string;
    new_topic_id: string;
    channel_id: string;
    mode: "one" | "later" | "all";
    version: number;
  };
}

/**
 * topic.created event (from apiV1.ts handleCreateTopic)
 */
export interface TopicCreatedEvent extends EventEnvelope {
  name: "topic.created";
  data: {
    topic: EventTopic;
  };
}

/**
 * topic.renamed event (from apiV1.ts handleUpdateTopic)
 */
export interface TopicRenamedEvent extends EventEnvelope {
  name: "topic.renamed";
  data: {
    topic_id: string;
    old_title: string;
    new_title: string;
  };
}

/**
 * topic.attachment_added event (from apiV1.ts handleCreateMessage + handleCreateAttachment)
 */
export interface AttachmentAddedEvent extends EventEnvelope {
  name: "topic.attachment_added";
  data: {
    attachment: EventAttachment;
  };
}

/**
 * message.enriched event (from linkifierDerived.ts)
 */
export interface MessageEnrichedEvent extends EventEnvelope {
  name: "message.enriched";
  data: {
    message_id: string;
    plugin_name: string;
    enrichments: EventEnrichment[];
    enrichment_ids: number[];
  };
}

/**
 * Discriminated union of all known typed events.
 * 
 * Pattern: consumers can switch on .name and TypeScript will narrow the data shape.
 */
export type TypedEvent =
  | ChannelCreatedEvent
  | MessageCreatedEvent
  | MessageEditedEvent
  | MessageDeletedEvent
  | MessageMovedTopicEvent
  | TopicCreatedEvent
  | TopicRenamedEvent
  | AttachmentAddedEvent
  | MessageEnrichedEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Type Guard Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type guard: check if an envelope is a known typed event.
 * 
 * Unknown event names return false (but are still valid EventEnvelopes).
 */
export function isKnownEvent(envelope: EventEnvelope): envelope is TypedEvent {
  const knownNames: KnownEventName[] = [
    "channel.created",
    "message.created",
    "message.edited",
    "message.deleted",
    "message.moved_topic",
    "topic.created",
    "topic.renamed",
    "topic.attachment_added",
    "message.enriched",
  ];
  return knownNames.includes(envelope.name as KnownEventName);
}

/**
 * Type guard: channel.created event
 */
export function isChannelCreated(e: EventEnvelope): e is ChannelCreatedEvent {
  return e.name === "channel.created";
}

/**
 * Type guard: message.created event
 */
export function isMessageCreated(e: EventEnvelope): e is MessageCreatedEvent {
  return e.name === "message.created";
}

/**
 * Type guard: message.edited event
 */
export function isMessageEdited(e: EventEnvelope): e is MessageEditedEvent {
  return e.name === "message.edited";
}

/**
 * Type guard: message.deleted event
 */
export function isMessageDeleted(e: EventEnvelope): e is MessageDeletedEvent {
  return e.name === "message.deleted";
}

/**
 * Type guard: message.moved_topic event
 */
export function isMessageMovedTopic(e: EventEnvelope): e is MessageMovedTopicEvent {
  return e.name === "message.moved_topic";
}

/**
 * Type guard: topic.created event
 */
export function isTopicCreated(e: EventEnvelope): e is TopicCreatedEvent {
  return e.name === "topic.created";
}

/**
 * Type guard: topic.renamed event
 */
export function isTopicRenamed(e: EventEnvelope): e is TopicRenamedEvent {
  return e.name === "topic.renamed";
}

/**
 * Type guard: topic.attachment_added event
 */
export function isAttachmentAdded(e: EventEnvelope): e is AttachmentAddedEvent {
  return e.name === "topic.attachment_added";
}

/**
 * Type guard: message.enriched event
 */
export function isMessageEnriched(e: EventEnvelope): e is MessageEnrichedEvent {
  return e.name === "message.enriched";
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed Async Iterator Wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed async iterator wrapper for event streams.
 * 
 * Yields all events (both known and unknown) as-is. Consumers use type guards
 * to narrow to specific event types.
 * 
 * Example:
 * ```ts
 * for await (const envelope of typedEvents(wsConnection.events())) {
 *   if (isMessageCreated(envelope)) {
 *     console.log(envelope.data.message.content_raw); // ✅ typed!
 *   } else if (isKnownEvent(envelope)) {
 *     // Handle other known events
 *   } else {
 *     // Unknown event (future-proof: don't crash on new event types)
 *     console.log("Unknown event:", envelope.name);
 *   }
 * }
 * ```
 * 
 * @param source - Async iterator of raw event envelopes
 * @returns Async iterator that yields events (typed or unknown)
 */
export async function* typedEvents(
  source: AsyncIterableIterator<EventEnvelope>
): AsyncIterableIterator<EventEnvelope> {
  for await (const envelope of source) {
    yield envelope;
  }
}
