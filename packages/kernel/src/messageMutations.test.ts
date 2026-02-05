/**
 * Unit tests for @agentchat/kernel message mutations module
 * 
 * Tests bd-16d.2.6 (edit + tombstone delete) and bd-16d.2.8 (retopic)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, runMigrations, getMessageById, getEventById } from "./index";
import {
  editMessage,
  tombstoneDeleteMessage,
  retopicMessage,
  VersionConflictError,
  MessageNotFoundError,
  CrossChannelMoveError,
  TopicNotFoundError,
} from "./messageMutations";
import { getLatestEventId, replayEvents } from "./events";
import type { Database } from "bun:sqlite";

const TEST_DIR = join(import.meta.dir, ".test-tmp-mutations");
const MIGRATIONS_DIR = join(import.meta.dir, "../../../migrations");

// Helper to generate sortable message IDs
let msgCounter = 0;
function nextMsgId(): string {
  msgCounter++;
  return `msg_${String(msgCounter).padStart(4, "0")}`;
}

function setupTestDb(): { db: Database; dbPath: string } {
  msgCounter = 0; // Reset counter for each test
  const dbPath = join(
    TEST_DIR,
    `mutations-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  return { db, dbPath };
}

function createChannel(
  db: Database,
  channelId: string,
  name: string
): void {
  db.run(
    `INSERT INTO channels (id, name, description, created_at)
     VALUES (?, ?, NULL, ?)`,
    [channelId, name, new Date().toISOString()]
  );
}

function createTopic(
  db: Database,
  topicId: string,
  channelId: string,
  title: string
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO topics (id, channel_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [topicId, channelId, title, now, now]
  );
}

function createMessage(
  db: Database,
  messageId: string,
  topicId: string,
  channelId: string,
  content: string,
  sender = "test-user"
): void {
  db.run(
    `INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [messageId, topicId, channelId, sender, content, new Date().toISOString()]
  );
}

beforeEach(() => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    for (const file of readdirSync(TEST_DIR)) {
      const filePath = join(TEST_DIR, file);
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// editMessage Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("editMessage", () => {
  test("updates content_raw, edited_at, and increments version", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Original content");

    const result = editMessage({
      db,
      messageId: msgId,
      newContentRaw: "Updated content",
    });

    expect(result.messageId).toBe(msgId);
    expect(result.version).toBe(2);
    expect(result.eventId).toBeGreaterThan(0);

    // Verify message state
    const message = getMessageById(db, msgId);
    expect(message).not.toBeNull();
    expect(message!.content_raw).toBe("Updated content");
    expect(message!.version).toBe(2);
    expect(message!.edited_at).not.toBeNull();

    db.close();
  });

  test("emits message.edited event with correct data and scopes", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Original content");

    const result = editMessage({
      db,
      messageId: msgId,
      newContentRaw: "New content",
    });

    const event = getEventById(db, result.eventId);
    expect(event).not.toBeNull();
    expect(event!.name).toBe("message.edited");
    expect(event!.scope.channel_id).toBe("ch_1");
    expect(event!.scope.topic_id).toBe("topic_1");
    expect(event!.entity.type).toBe("message");
    expect(event!.entity.id).toBe(msgId);
    expect(event!.data.message_id).toBe(msgId);
    expect(event!.data.old_content).toBe("Original content");
    expect(event!.data.new_content).toBe("New content");
    expect(event!.data.version).toBe(2);

    db.close();
  });

  test("succeeds with correct expectedVersion", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Original");

    const result = editMessage({
      db,
      messageId: msgId,
      newContentRaw: "Updated",
      expectedVersion: 1,
    });

    expect(result.version).toBe(2);

    db.close();
  });

  test("throws VersionConflictError when expectedVersion mismatches", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Original");

    // First edit succeeds
    editMessage({ db, messageId: msgId, newContentRaw: "v2" });

    // Second edit with stale version should fail
    const eventsBefore = getLatestEventId(db);

    try {
      editMessage({
        db,
        messageId: msgId,
        newContentRaw: "v3",
        expectedVersion: 1, // Stale!
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError);
      const conflictErr = err as VersionConflictError;
      expect(conflictErr.code).toBe("VERSION_CONFLICT");
      expect(conflictErr.messageId).toBe(msgId);
      expect(conflictErr.expectedVersion).toBe(1);
      expect(conflictErr.currentVersion).toBe(2);
    }

    // Verify no event was inserted
    expect(getLatestEventId(db)).toBe(eventsBefore);

    // Verify message was not modified
    const message = getMessageById(db, msgId);
    expect(message!.content_raw).toBe("v2");
    expect(message!.version).toBe(2);

    db.close();
  });

  test("throws MessageNotFoundError for non-existent message", () => {
    const { db } = setupTestDb();

    expect(() =>
      editMessage({
        db,
        messageId: "nonexistent",
        newContentRaw: "Hello",
      })
    ).toThrow(MessageNotFoundError);

    db.close();
  });

  test("throws error for content exceeding 64KB", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Original");

    const largeContent = "x".repeat(65537); // > 64KB

    expect(() =>
      editMessage({
        db,
        messageId: msgId,
        newContentRaw: largeContent,
      })
    ).toThrow(/Content too large/);

    db.close();
  });

  test("multiple edits increment version correctly", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "v1");

    editMessage({ db, messageId: msgId, newContentRaw: "v2" });
    editMessage({ db, messageId: msgId, newContentRaw: "v3" });
    const result = editMessage({ db, messageId: msgId, newContentRaw: "v4" });

    expect(result.version).toBe(4);

    const message = getMessageById(db, msgId);
    expect(message!.version).toBe(4);

    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tombstoneDeleteMessage Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("tombstoneDeleteMessage", () => {
  test("sets deleted_at, deleted_by, tombstones content, increments version", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Secret content");

    const result = tombstoneDeleteMessage({
      db,
      messageId: msgId,
      actor: "moderator",
    });

    expect(result.messageId).toBe(msgId);
    expect(result.version).toBe(2);
    expect(result.eventId).toBeGreaterThan(0);

    // Verify message state
    const message = getMessageById(db, msgId);
    expect(message).not.toBeNull();
    expect(message!.content_raw).toBe("[deleted]");
    expect(message!.deleted_at).not.toBeNull();
    expect(message!.deleted_by).toBe("moderator");
    expect(message!.edited_at).not.toBeNull();
    expect(message!.version).toBe(2);

    db.close();
  });

  test("emits message.deleted event with correct data and scopes", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "To be deleted");

    const result = tombstoneDeleteMessage({
      db,
      messageId: msgId,
      actor: "admin",
    });

    const event = getEventById(db, result.eventId);
    expect(event).not.toBeNull();
    expect(event!.name).toBe("message.deleted");
    expect(event!.scope.channel_id).toBe("ch_1");
    expect(event!.scope.topic_id).toBe("topic_1");
    expect(event!.entity.type).toBe("message");
    expect(event!.entity.id).toBe(msgId);
    expect(event!.data.message_id).toBe(msgId);
    expect(event!.data.deleted_by).toBe("admin");
    expect(event!.data.version).toBe(2);

    db.close();
  });

  test("is idempotent: deleting already-deleted message succeeds without new event", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Content");

    // First delete
    const result1 = tombstoneDeleteMessage({
      db,
      messageId: msgId,
      actor: "user1",
    });
    expect(result1.eventId).toBeGreaterThan(0);

    const eventsBefore = getLatestEventId(db);

    // Second delete (idempotent)
    const result2 = tombstoneDeleteMessage({
      db,
      messageId: msgId,
      actor: "user2",
    });

    expect(result2.messageId).toBe(msgId);
    expect(result2.eventId).toBe(0); // No new event

    // No new event inserted
    expect(getLatestEventId(db)).toBe(eventsBefore);

    // Message state unchanged from first delete
    const message = getMessageById(db, msgId);
    expect(message!.deleted_by).toBe("user1");

    db.close();
  });

  test("throws VersionConflictError when expectedVersion mismatches", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Original");

    // Edit to bump version
    editMessage({ db, messageId: msgId, newContentRaw: "edited" });

    const eventsBefore = getLatestEventId(db);

    try {
      tombstoneDeleteMessage({
        db,
        messageId: msgId,
        actor: "admin",
        expectedVersion: 1, // Stale!
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError);
      const conflictErr = err as VersionConflictError;
      expect(conflictErr.currentVersion).toBe(2);
    }

    // No event inserted
    expect(getLatestEventId(db)).toBe(eventsBefore);

    // Message not deleted
    const message = getMessageById(db, msgId);
    expect(message!.deleted_at).toBeNull();

    db.close();
  });

  test("throws MessageNotFoundError for non-existent message", () => {
    const { db } = setupTestDb();

    expect(() =>
      tombstoneDeleteMessage({
        db,
        messageId: "nonexistent",
        actor: "admin",
      })
    ).toThrow(MessageNotFoundError);

    db.close();
  });

  test("throws error for empty actor", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test Topic");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Content");

    expect(() =>
      tombstoneDeleteMessage({
        db,
        messageId: msgId,
        actor: "",
      })
    ).toThrow(/Actor must be a non-empty string/);

    expect(() =>
      tombstoneDeleteMessage({
        db,
        messageId: msgId,
        actor: "   ",
      })
    ).toThrow(/Actor must be a non-empty string/);

    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// retopicMessage Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("retopicMessage", () => {
  describe("mode=one", () => {
    test("moves single message, increments version, emits event", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      createTopic(db, "topic_b", "ch_1", "Topic B");
      const msgId = nextMsgId();
      createMessage(db, msgId, "topic_a", "ch_1", "Hello");

      const result = retopicMessage({
        db,
        messageId: msgId,
        toTopicId: "topic_b",
        mode: "one",
      });

      expect(result.affectedCount).toBe(1);
      expect(result.affectedMessages[0].messageId).toBe(msgId);
      expect(result.affectedMessages[0].version).toBe(2);

      // Verify message state
      const message = getMessageById(db, msgId);
      expect(message!.topic_id).toBe("topic_b");
      expect(message!.version).toBe(2);

      db.close();
    });

    test("emits message.moved_topic event with correct scopes (old, new topic)", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      createTopic(db, "topic_b", "ch_1", "Topic B");
      const msgId = nextMsgId();
      createMessage(db, msgId, "topic_a", "ch_1", "Hello");

      const result = retopicMessage({
        db,
        messageId: msgId,
        toTopicId: "topic_b",
        mode: "one",
      });

      const event = getEventById(db, result.affectedMessages[0].eventId);
      expect(event).not.toBeNull();
      expect(event!.name).toBe("message.moved_topic");
      expect(event!.scope.channel_id).toBe("ch_1");
      expect(event!.scope.topic_id).toBe("topic_a"); // old topic
      expect(event!.scope.topic_id2).toBe("topic_b"); // new topic
      expect(event!.data.message_id).toBe(msgId);
      expect(event!.data.old_topic_id).toBe("topic_a");
      expect(event!.data.new_topic_id).toBe("topic_b");
      expect(event!.data.channel_id).toBe("ch_1");
      expect(event!.data.mode).toBe("one");
      expect(event!.data.version).toBe(2);

      db.close();
    });

    test("idempotent: moving to current topic returns success with no changes", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      const msgId = nextMsgId();
      createMessage(db, msgId, "topic_a", "ch_1", "Hello");

      const eventsBefore = getLatestEventId(db);

      const result = retopicMessage({
        db,
        messageId: msgId,
        toTopicId: "topic_a", // Same topic
        mode: "one",
      });

      expect(result.affectedCount).toBe(0);
      expect(result.affectedMessages.length).toBe(0);

      // No event
      expect(getLatestEventId(db)).toBe(eventsBefore);

      // Version unchanged
      const message = getMessageById(db, msgId);
      expect(message!.version).toBe(1);

      db.close();
    });
  });

  describe("mode=later", () => {
    test("moves anchor and all subsequent messages in topic", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      createTopic(db, "topic_b", "ch_1", "Topic B");

      // Create 5 messages with sortable IDs
      const msg1 = nextMsgId(); // msg_0001
      const msg2 = nextMsgId(); // msg_0002
      const msg3 = nextMsgId(); // msg_0003
      const msg4 = nextMsgId(); // msg_0004
      const msg5 = nextMsgId(); // msg_0005

      createMessage(db, msg1, "topic_a", "ch_1", "Message 1");
      createMessage(db, msg2, "topic_a", "ch_1", "Message 2");
      createMessage(db, msg3, "topic_a", "ch_1", "Message 3");
      createMessage(db, msg4, "topic_a", "ch_1", "Message 4");
      createMessage(db, msg5, "topic_a", "ch_1", "Message 5");

      // Move from msg3 onwards
      const result = retopicMessage({
        db,
        messageId: msg3,
        toTopicId: "topic_b",
        mode: "later",
      });

      expect(result.affectedCount).toBe(3); // msg3, msg4, msg5
      const affectedIds = result.affectedMessages.map((m) => m.messageId);
      expect(affectedIds).toContain(msg3);
      expect(affectedIds).toContain(msg4);
      expect(affectedIds).toContain(msg5);

      // Verify msg1, msg2 unchanged
      expect(getMessageById(db, msg1)!.topic_id).toBe("topic_a");
      expect(getMessageById(db, msg2)!.topic_id).toBe("topic_a");

      // Verify msg3, msg4, msg5 moved
      expect(getMessageById(db, msg3)!.topic_id).toBe("topic_b");
      expect(getMessageById(db, msg4)!.topic_id).toBe("topic_b");
      expect(getMessageById(db, msg5)!.topic_id).toBe("topic_b");

      db.close();
    });

    test("emits one event per affected message", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      createTopic(db, "topic_b", "ch_1", "Topic B");

      const msg1 = nextMsgId();
      const msg2 = nextMsgId();
      createMessage(db, msg1, "topic_a", "ch_1", "Message 1");
      createMessage(db, msg2, "topic_a", "ch_1", "Message 2");

      const eventsBefore = getLatestEventId(db);

      const result = retopicMessage({
        db,
        messageId: msg1,
        toTopicId: "topic_b",
        mode: "later",
      });

      expect(result.affectedCount).toBe(2);

      // Two new events
      expect(getLatestEventId(db)).toBe(eventsBefore + 2);

      db.close();
    });
  });

  describe("mode=all", () => {
    test("moves all messages in topic", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      createTopic(db, "topic_b", "ch_1", "Topic B");

      const msg1 = nextMsgId();
      const msg2 = nextMsgId();
      const msg3 = nextMsgId();

      createMessage(db, msg1, "topic_a", "ch_1", "Message 1");
      createMessage(db, msg2, "topic_a", "ch_1", "Message 2");
      createMessage(db, msg3, "topic_a", "ch_1", "Message 3");

      // Move from any message with mode=all
      const result = retopicMessage({
        db,
        messageId: msg2, // Anchor doesn't matter for mode=all
        toTopicId: "topic_b",
        mode: "all",
      });

      expect(result.affectedCount).toBe(3);

      // All messages moved
      expect(getMessageById(db, msg1)!.topic_id).toBe("topic_b");
      expect(getMessageById(db, msg2)!.topic_id).toBe("topic_b");
      expect(getMessageById(db, msg3)!.topic_id).toBe("topic_b");

      db.close();
    });
  });

  describe("same-channel enforcement", () => {
    test("throws CrossChannelMoveError when target topic in different channel", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "General");
      createChannel(db, "ch_2", "Random");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      createTopic(db, "topic_x", "ch_2", "Topic X"); // Different channel!
      const msgId = nextMsgId();
      createMessage(db, msgId, "topic_a", "ch_1", "Hello");

      const eventsBefore = getLatestEventId(db);

      try {
        retopicMessage({
          db,
          messageId: msgId,
          toTopicId: "topic_x",
          mode: "one",
        });
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CrossChannelMoveError);
        const crossErr = err as CrossChannelMoveError;
        expect(crossErr.code).toBe("CROSS_CHANNEL_MOVE");
        expect(crossErr.sourceChannelId).toBe("ch_1");
        expect(crossErr.targetChannelId).toBe("ch_2");
      }

      // No event inserted
      expect(getLatestEventId(db)).toBe(eventsBefore);

      // Message unchanged
      const message = getMessageById(db, msgId);
      expect(message!.topic_id).toBe("topic_a");

      db.close();
    });
  });

  describe("version conflict handling", () => {
    test("throws VersionConflictError when expectedVersion mismatches anchor", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      createTopic(db, "topic_b", "ch_1", "Topic B");
      const msgId = nextMsgId();
      createMessage(db, msgId, "topic_a", "ch_1", "Hello");

      // Edit to bump version
      editMessage({ db, messageId: msgId, newContentRaw: "edited" });

      const eventsBefore = getLatestEventId(db);

      try {
        retopicMessage({
          db,
          messageId: msgId,
          toTopicId: "topic_b",
          mode: "one",
          expectedVersion: 1,
        });
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(VersionConflictError);
        const conflictErr = err as VersionConflictError;
        expect(conflictErr.currentVersion).toBe(2);
      }

      // No event inserted
      expect(getLatestEventId(db)).toBe(eventsBefore);

      db.close();
    });
  });

  describe("error cases", () => {
    test("throws MessageNotFoundError for non-existent anchor message", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_b", "ch_1", "Topic B");

      expect(() =>
        retopicMessage({
          db,
          messageId: "nonexistent",
          toTopicId: "topic_b",
          mode: "one",
        })
      ).toThrow(MessageNotFoundError);

      db.close();
    });

    test("throws TopicNotFoundError for non-existent target topic", () => {
      const { db } = setupTestDb();

      createChannel(db, "ch_1", "general");
      createTopic(db, "topic_a", "ch_1", "Topic A");
      const msgId = nextMsgId();
      createMessage(db, msgId, "topic_a", "ch_1", "Hello");

      expect(() =>
        retopicMessage({
          db,
          messageId: msgId,
          toTopicId: "nonexistent",
          mode: "one",
        })
      ).toThrow(TopicNotFoundError);

      db.close();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transaction atomicity tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Transaction atomicity", () => {
  test("editMessage: state and event committed together", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Original");

    const result = editMessage({
      db,
      messageId: msgId,
      newContentRaw: "Updated",
    });

    // Verify both state and event exist
    const message = getMessageById(db, msgId);
    const event = getEventById(db, result.eventId);

    expect(message!.content_raw).toBe("Updated");
    expect(event!.name).toBe("message.edited");
    expect(event!.data.new_content).toBe("Updated");

    db.close();
  });

  test("tombstoneDeleteMessage: state and event committed together", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_1", "ch_1", "Test");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_1", "ch_1", "Secret");

    const result = tombstoneDeleteMessage({
      db,
      messageId: msgId,
      actor: "admin",
    });

    const message = getMessageById(db, msgId);
    const event = getEventById(db, result.eventId);

    expect(message!.deleted_at).not.toBeNull();
    expect(event!.name).toBe("message.deleted");

    db.close();
  });

  test("retopicMessage: state and events committed together for multiple messages", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_a", "ch_1", "Topic A");
    createTopic(db, "topic_b", "ch_1", "Topic B");

    const msg1 = nextMsgId();
    const msg2 = nextMsgId();
    createMessage(db, msg1, "topic_a", "ch_1", "Message 1");
    createMessage(db, msg2, "topic_a", "ch_1", "Message 2");

    const result = retopicMessage({
      db,
      messageId: msg1,
      toTopicId: "topic_b",
      mode: "all",
    });

    // Both messages moved
    expect(getMessageById(db, msg1)!.topic_id).toBe("topic_b");
    expect(getMessageById(db, msg2)!.topic_id).toBe("topic_b");

    // Both events exist
    expect(result.affectedMessages.length).toBe(2);
    for (const affected of result.affectedMessages) {
      const event = getEventById(db, affected.eventId);
      expect(event!.name).toBe("message.moved_topic");
    }

    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event replay correctness
// ─────────────────────────────────────────────────────────────────────────────

describe("Event replay correctness", () => {
  test("message.moved_topic events can be replayed by either old or new topic subscription", () => {
    const { db } = setupTestDb();

    createChannel(db, "ch_1", "general");
    createTopic(db, "topic_a", "ch_1", "Topic A");
    createTopic(db, "topic_b", "ch_1", "Topic B");
    const msgId = nextMsgId();
    createMessage(db, msgId, "topic_a", "ch_1", "Hello");

    retopicMessage({
      db,
      messageId: msgId,
      toTopicId: "topic_b",
      mode: "one",
    });

    const latestId = getLatestEventId(db);

    // Subscription to old topic should see the event
    const oldTopicEvents = replayEvents({
      db,
      afterEventId: 0,
      replayUntil: latestId,
      topicIds: ["topic_a"],
    });
    expect(oldTopicEvents.some((e) => e.name === "message.moved_topic")).toBe(true);

    // Subscription to new topic should also see the event
    const newTopicEvents = replayEvents({
      db,
      afterEventId: 0,
      replayUntil: latestId,
      topicIds: ["topic_b"],
    });
    expect(newTopicEvents.some((e) => e.name === "message.moved_topic")).toBe(true);

    // Subscription to channel should see the event
    const channelEvents = replayEvents({
      db,
      afterEventId: 0,
      replayUntil: latestId,
      channelIds: ["ch_1"],
    });
    expect(channelEvents.some((e) => e.name === "message.moved_topic")).toBe(true);

    db.close();
  });
});
