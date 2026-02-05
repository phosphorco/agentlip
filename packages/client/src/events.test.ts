/**
 * Tests for typed event envelope processing
 */

import { describe, test, expect } from "bun:test";
import type { EventEnvelope } from "./types";
import {
  isKnownEvent,
  isChannelCreated,
  isMessageCreated,
  isMessageEdited,
  isMessageDeleted,
  isMessageMovedTopic,
  isTopicCreated,
  isTopicRenamed,
  isAttachmentAdded,
  isMessageEnriched,
  typedEvents,
  type TypedEvent,
  type MessageCreatedEvent,
  type MessageEditedEvent,
} from "./events";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createEnvelope = (name: string, data: Record<string, unknown>): EventEnvelope => ({
  type: "event",
  event_id: 1,
  ts: new Date().toISOString(),
  name,
  scope: { channel_id: "ch_test" },
  data,
});

const channelCreatedEnvelope = createEnvelope("channel.created", {
  channel: {
    id: "ch_123",
    name: "test-channel",
    description: null,
    created_at: "2024-01-01T00:00:00Z",
  },
});

const messageCreatedEnvelope = createEnvelope("message.created", {
  message: {
    id: "msg_123",
    topic_id: "topic_456",
    channel_id: "ch_123",
    sender: "alice",
    content_raw: "Hello world",
    version: 1,
    created_at: "2024-01-01T00:00:00Z",
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
  },
});

const messageEditedEnvelope = createEnvelope("message.edited", {
  message_id: "msg_123",
  old_content: "Hello world",
  new_content: "Hello universe",
  version: 2,
});

const messageDeletedEnvelope = createEnvelope("message.deleted", {
  message_id: "msg_123",
  deleted_by: "admin",
});

const messageMovedTopicEnvelope = createEnvelope("message.moved_topic", {
  message_id: "msg_123",
  old_topic_id: "topic_456",
  new_topic_id: "topic_789",
  channel_id: "ch_123",
  mode: "one",
  version: 2,
});

const topicCreatedEnvelope = createEnvelope("topic.created", {
  topic: {
    id: "topic_456",
    channel_id: "ch_123",
    title: "Test Topic",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
});

const topicRenamedEnvelope = createEnvelope("topic.renamed", {
  topic_id: "topic_456",
  old_title: "Old Title",
  new_title: "New Title",
});

const attachmentAddedEnvelope = createEnvelope("topic.attachment_added", {
  attachment: {
    id: "att_123",
    topic_id: "topic_456",
    kind: "url",
    key: null,
    value_json: { url: "https://example.com" },
    dedupe_key: "https://example.com",
    source_message_id: "msg_123",
    created_at: "2024-01-01T00:00:00Z",
  },
});

const messageEnrichedEnvelope = createEnvelope("message.enriched", {
  message_id: "msg_123",
  plugin_name: "linkifier",
  enrichments: [
    {
      id: 1,
      message_id: "msg_123",
      plugin_name: "linkifier",
      kind: "url",
      span_start: 0,
      span_end: 20,
      label: "example.com",
      url: "https://example.com",
      metadata_json: null,
      created_at: "2024-01-01T00:00:00Z",
    },
  ],
  enrichment_ids: [1],
});

const unknownEventEnvelope = createEnvelope("future.new_event", {
  some_data: "value",
});

// ─────────────────────────────────────────────────────────────────────────────
// Type Guard Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Type Guards", () => {
  describe("isKnownEvent", () => {
    test("returns true for all known event types", () => {
      expect(isKnownEvent(channelCreatedEnvelope)).toBe(true);
      expect(isKnownEvent(messageCreatedEnvelope)).toBe(true);
      expect(isKnownEvent(messageEditedEnvelope)).toBe(true);
      expect(isKnownEvent(messageDeletedEnvelope)).toBe(true);
      expect(isKnownEvent(messageMovedTopicEnvelope)).toBe(true);
      expect(isKnownEvent(topicCreatedEnvelope)).toBe(true);
      expect(isKnownEvent(topicRenamedEnvelope)).toBe(true);
      expect(isKnownEvent(attachmentAddedEnvelope)).toBe(true);
      expect(isKnownEvent(messageEnrichedEnvelope)).toBe(true);
    });

    test("returns false for unknown event types", () => {
      expect(isKnownEvent(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isChannelCreated", () => {
    test("returns true for channel.created events", () => {
      expect(isChannelCreated(channelCreatedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isChannelCreated(messageCreatedEnvelope)).toBe(false);
      expect(isChannelCreated(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isMessageCreated", () => {
    test("returns true for message.created events", () => {
      expect(isMessageCreated(messageCreatedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isMessageCreated(messageEditedEnvelope)).toBe(false);
      expect(isMessageCreated(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isMessageEdited", () => {
    test("returns true for message.edited events", () => {
      expect(isMessageEdited(messageEditedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isMessageEdited(messageCreatedEnvelope)).toBe(false);
      expect(isMessageEdited(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isMessageDeleted", () => {
    test("returns true for message.deleted events", () => {
      expect(isMessageDeleted(messageDeletedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isMessageDeleted(messageCreatedEnvelope)).toBe(false);
      expect(isMessageDeleted(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isMessageMovedTopic", () => {
    test("returns true for message.moved_topic events", () => {
      expect(isMessageMovedTopic(messageMovedTopicEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isMessageMovedTopic(messageCreatedEnvelope)).toBe(false);
      expect(isMessageMovedTopic(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isTopicCreated", () => {
    test("returns true for topic.created events", () => {
      expect(isTopicCreated(topicCreatedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isTopicCreated(messageCreatedEnvelope)).toBe(false);
      expect(isTopicCreated(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isTopicRenamed", () => {
    test("returns true for topic.renamed events", () => {
      expect(isTopicRenamed(topicRenamedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isTopicRenamed(topicCreatedEnvelope)).toBe(false);
      expect(isTopicRenamed(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isAttachmentAdded", () => {
    test("returns true for topic.attachment_added events", () => {
      expect(isAttachmentAdded(attachmentAddedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isAttachmentAdded(messageCreatedEnvelope)).toBe(false);
      expect(isAttachmentAdded(unknownEventEnvelope)).toBe(false);
    });
  });

  describe("isMessageEnriched", () => {
    test("returns true for message.enriched events", () => {
      expect(isMessageEnriched(messageEnrichedEnvelope)).toBe(true);
    });

    test("returns false for other event types", () => {
      expect(isMessageEnriched(messageCreatedEnvelope)).toBe(false);
      expect(isMessageEnriched(unknownEventEnvelope)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type Narrowing Tests (compile-time type safety)
// ─────────────────────────────────────────────────────────────────────────────

describe("Type Narrowing", () => {
  test("type guards narrow to specific event types", () => {
    const envelope: EventEnvelope = messageCreatedEnvelope;

    // Before narrowing: envelope.data is Record<string, unknown>
    // After narrowing: envelope.data.message is typed
    if (isMessageCreated(envelope)) {
      // This should compile without errors (type narrowing works)
      const messageId: string = envelope.data.message.id;
      const content: string = envelope.data.message.content_raw;
      expect(messageId).toBe("msg_123");
      expect(content).toBe("Hello world");
    } else {
      throw new Error("Should have narrowed to MessageCreatedEvent");
    }
  });

  test("discriminated union works with switch statement", () => {
    const envelope: EventEnvelope = messageEditedEnvelope;

    let result: string | null = null;

    // TypeScript should narrow types in each case
    if (isMessageCreated(envelope)) {
      result = `created: ${envelope.data.message.id}`;
    } else if (isMessageEdited(envelope)) {
      result = `edited: ${envelope.data.message_id} v${envelope.data.version}`;
    } else if (isMessageDeleted(envelope)) {
      result = `deleted: ${envelope.data.message_id} by ${envelope.data.deleted_by}`;
    }

    expect(result).toBe("edited: msg_123 v2");
  });

  test("isKnownEvent narrows to TypedEvent union", () => {
    const envelope: EventEnvelope = topicRenamedEnvelope;

    if (isKnownEvent(envelope)) {
      // envelope is now TypedEvent, which is a union of all known events
      // We can access .name and .data, but data shape depends on name
      expect(envelope.name).toBe("topic.renamed");

      // Further narrow with specific guard
      if (isTopicRenamed(envelope)) {
        const oldTitle: string = envelope.data.old_title;
        const newTitle: string = envelope.data.new_title;
        expect(oldTitle).toBe("Old Title");
        expect(newTitle).toBe("New Title");
      }
    }
  });

  test("unknown events don't match isKnownEvent but are still valid", () => {
    const envelope: EventEnvelope = unknownEventEnvelope;

    // Should not narrow (unknown event)
    expect(isKnownEvent(envelope)).toBe(false);

    // But we can still access base EventEnvelope properties
    expect(envelope.name).toBe("future.new_event");
    expect(envelope.data).toEqual({ some_data: "value" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Async Iterator Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("typedEvents async iterator", () => {
  test("yields all events from source iterator", async () => {
    const sourceEvents: EventEnvelope[] = [
      messageCreatedEnvelope,
      messageEditedEnvelope,
      topicRenamedEnvelope,
      unknownEventEnvelope,
    ];

    // Create async iterator from array
    async function* sourceIterator() {
      for (const event of sourceEvents) {
        yield event;
      }
    }

    const collected: EventEnvelope[] = [];
    for await (const envelope of typedEvents(sourceIterator())) {
      collected.push(envelope);
    }

    expect(collected).toHaveLength(4);
    expect(collected).toEqual(sourceEvents);
  });

  test("consumers can use type guards on yielded events", async () => {
    const sourceEvents: EventEnvelope[] = [
      messageCreatedEnvelope,
      messageEditedEnvelope,
      unknownEventEnvelope,
    ];

    async function* sourceIterator() {
      for (const event of sourceEvents) {
        yield event;
      }
    }

    const results: string[] = [];
    for await (const envelope of typedEvents(sourceIterator())) {
      if (isMessageCreated(envelope)) {
        results.push(`created: ${envelope.data.message.content_raw}`);
      } else if (isMessageEdited(envelope)) {
        results.push(`edited: ${envelope.data.new_content}`);
      } else {
        results.push(`unknown: ${envelope.name}`);
      }
    }

    expect(results).toEqual([
      "created: Hello world",
      "edited: Hello universe",
      "unknown: future.new_event",
    ]);
  });

  test("handles empty source iterator", async () => {
    async function* emptyIterator() {
      // Yield nothing
    }

    const collected: EventEnvelope[] = [];
    for await (const envelope of typedEvents(emptyIterator())) {
      collected.push(envelope);
    }

    expect(collected).toHaveLength(0);
  });

  test("preserves event order", async () => {
    const sourceEvents: EventEnvelope[] = [
      { ...createEnvelope("message.created", {}), event_id: 1 },
      { ...createEnvelope("message.edited", {}), event_id: 2 },
      { ...createEnvelope("message.deleted", {}), event_id: 3 },
    ];

    async function* sourceIterator() {
      for (const event of sourceEvents) {
        yield event;
      }
    }

    const collected: number[] = [];
    for await (const envelope of typedEvents(sourceIterator())) {
      collected.push(envelope.event_id);
    }

    expect(collected).toEqual([1, 2, 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additive-Only Schema Tests (future-proofing)
// ─────────────────────────────────────────────────────────────────────────────

describe("Additive-Only Schema", () => {
  test("unknown event names pass through without error", () => {
    const futureEvent = createEnvelope("future.awesome_feature", {
      awesome_data: "value",
    });

    // Should not throw
    expect(() => {
      const _envelope: EventEnvelope = futureEvent;
    }).not.toThrow();

    // Should be accessible
    expect(futureEvent.name).toBe("future.awesome_feature");
    expect(futureEvent.data.awesome_data).toBe("value");
  });

  test("consumers can handle both known and unknown events gracefully", () => {
    const events: EventEnvelope[] = [
      messageCreatedEnvelope,
      unknownEventEnvelope,
      createEnvelope("another.future_event", { data: 123 }),
    ];

    const knownCount = events.filter(isKnownEvent).length;
    const unknownCount = events.filter((e) => !isKnownEvent(e)).length;

    expect(knownCount).toBe(1); // Only message.created is known
    expect(unknownCount).toBe(2); // The other two are unknown
    expect(knownCount + unknownCount).toBe(events.length); // All accounted for
  });

  test("type guards never throw on unknown events", () => {
    const futureEvent = createEnvelope("future.event", {});

    // All type guards should return false (not throw)
    expect(() => {
      expect(isChannelCreated(futureEvent)).toBe(false);
      expect(isMessageCreated(futureEvent)).toBe(false);
      expect(isMessageEdited(futureEvent)).toBe(false);
      expect(isMessageDeleted(futureEvent)).toBe(false);
      expect(isMessageMovedTopic(futureEvent)).toBe(false);
      expect(isTopicCreated(futureEvent)).toBe(false);
      expect(isTopicRenamed(futureEvent)).toBe(false);
      expect(isAttachmentAdded(futureEvent)).toBe(false);
      expect(isMessageEnriched(futureEvent)).toBe(false);
      expect(isKnownEvent(futureEvent)).toBe(false);
    }).not.toThrow();
  });
});
