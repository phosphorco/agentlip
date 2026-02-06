/**
 * ADR-0008 Compliance Tests: Edit + Tombstone Delete Semantics
 * 
 * These tests validate the invariants documented in ADR-0008:
 * - No hard deletes (DB trigger enforcement)
 * - Tombstone delete semantics (Gate H)
 * - Edit semantics with version increments
 * 
 * See: docs/adr/ADR-0008-edit-tombstone-delete.md
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, runMigrations, getMessageById, getEventById } from "./index";
import { tombstoneDeleteMessage, editMessage } from "./messageMutations";
import type { Database } from "bun:sqlite";

const TEST_DIR = join(import.meta.dir, ".test-tmp-adr008");
const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

function setupTestDb(): { db: Database; dbPath: string } {
  const dbPath = join(
    TEST_DIR,
    `adr008-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  return { db, dbPath };
}

function setupTestMessage(
  db: Database,
  content = "Original content"
): { channelId: string; topicId: string; messageId: string } {
  const uniqueId = crypto.randomUUID().slice(0, 8);
  const channelId = `ch_${uniqueId}`;
  const topicId = `topic_${uniqueId}`;
  const messageId = `msg_${uniqueId}`;
  const now = new Date().toISOString();

  db.run(
    "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
    [channelId, `test-channel-${uniqueId}`, now]
  );
  db.run(
    "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [topicId, channelId, `test-topic-${uniqueId}`, now, now]
  );
  db.run(
    "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    [messageId, topicId, channelId, "test-user", content, now]
  );

  return { channelId, topicId, messageId };
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
// ADR-0008: No Hard Deletes Invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0008: No Hard Deletes Invariant", () => {
  test("DB trigger prevents DELETE FROM messages", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    // Attempt hard delete should fail
    expect(() => {
      db.run("DELETE FROM messages WHERE id = ?", [messageId]);
    }).toThrow(/Hard deletes forbidden on messages/);

    // Message must still exist (row not removed)
    const message = getMessageById(db, messageId);
    expect(message).not.toBeNull();
    expect(message!.id).toBe(messageId);

    db.close();
  });

  test("DELETE ALL also prevented by trigger", () => {
    const { db } = setupTestDb();
    setupTestMessage(db, "Message 1");
    setupTestMessage(db, "Message 2");

    // Attempt to delete all messages
    expect(() => {
      db.run("DELETE FROM messages");
    }).toThrow(/Hard deletes forbidden on messages/);

    // Both messages should still exist
    const count = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM messages")
      .get();
    expect(count?.cnt).toBe(2);

    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0008: Gate H - Tombstone Delete Semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0008: Gate H - Tombstone Delete Semantics", () => {
  test("After successful delete: message row still exists", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    tombstoneDeleteMessage({ db, messageId, actor: "moderator" });

    // Row must exist
    const message = getMessageById(db, messageId);
    expect(message).not.toBeNull();

    db.close();
  });

  test("After successful delete: deleted_at != NULL", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    tombstoneDeleteMessage({ db, messageId, actor: "moderator" });

    const message = getMessageById(db, messageId);
    expect(message!.deleted_at).not.toBeNull();
    expect(typeof message!.deleted_at).toBe("string");
    // Verify it's a valid ISO timestamp
    const deletedAt = message!.deleted_at as string;
    expect(new Date(deletedAt).toISOString()).toBe(deletedAt);

    db.close();
  });

  test("After successful delete: deleted_by is non-empty", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    tombstoneDeleteMessage({ db, messageId, actor: "moderator-bot" });

    const message = getMessageById(db, messageId);
    expect(message!.deleted_by).toBe("moderator-bot");

    db.close();
  });

  test("After successful delete: content_raw is tombstoned to '[deleted]'", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db, "Sensitive secret content");

    tombstoneDeleteMessage({ db, messageId, actor: "admin" });

    const message = getMessageById(db, messageId);
    expect(message!.content_raw).toBe("[deleted]");

    db.close();
  });

  test("After successful delete: version is incremented", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    const beforeMsg = getMessageById(db, messageId);
    expect(beforeMsg!.version).toBe(1);

    tombstoneDeleteMessage({ db, messageId, actor: "admin" });

    const afterMsg = getMessageById(db, messageId);
    expect(afterMsg!.version).toBe(2);

    db.close();
  });

  test("After successful delete: message.deleted event emitted exactly once", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    const result = tombstoneDeleteMessage({ db, messageId, actor: "admin" });
    expect(result.eventId).toBeGreaterThan(0);

    const event = getEventById(db, result.eventId);
    expect(event).not.toBeNull();
    expect(event!.name).toBe("message.deleted");
    expect(event!.data.message_id).toBe(messageId);
    expect(event!.data.deleted_by).toBe("admin");
    expect(event!.data.version).toBe(2);

    // Count message.deleted events for this message
    const deleteEvents = db
      .query<{ cnt: number }, [string, string]>(
        `SELECT COUNT(*) as cnt FROM events 
         WHERE name = ? AND json_extract(data_json, '$.message_id') = ?`
      )
      .get("message.deleted", messageId);
    expect(deleteEvents?.cnt).toBe(1);

    db.close();
  });

  test("Tombstone delete is idempotent: second delete emits no new event", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    // First delete
    const result1 = tombstoneDeleteMessage({ db, messageId, actor: "admin" });
    expect(result1.eventId).toBeGreaterThan(0);

    // Second delete (idempotent)
    const result2 = tombstoneDeleteMessage({ db, messageId, actor: "other-admin" });
    expect(result2.eventId).toBe(0); // No new event

    // Only one message.deleted event exists
    const deleteEvents = db
      .query<{ cnt: number }, [string, string]>(
        `SELECT COUNT(*) as cnt FROM events 
         WHERE name = ? AND json_extract(data_json, '$.message_id') = ?`
      )
      .get("message.deleted", messageId);
    expect(deleteEvents?.cnt).toBe(1);

    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0008: Edit Semantics with Version Increments
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0008: Edit Semantics", () => {
  test("Edit preserves old_content in event payload for audit trail", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db, "Original secret content");

    const result = editMessage({
      db,
      messageId,
      newContentRaw: "Edited content",
    });

    const event = getEventById(db, result.eventId);
    expect(event!.name).toBe("message.edited");
    expect(event!.data.old_content).toBe("Original secret content");
    expect(event!.data.new_content).toBe("Edited content");

    db.close();
  });

  test("Version increments on both edit and delete", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    // Initial version
    expect(getMessageById(db, messageId)!.version).toBe(1);

    // Edit bumps version
    editMessage({ db, messageId, newContentRaw: "v2" });
    expect(getMessageById(db, messageId)!.version).toBe(2);

    // Another edit bumps version
    editMessage({ db, messageId, newContentRaw: "v3" });
    expect(getMessageById(db, messageId)!.version).toBe(3);

    // Delete bumps version
    tombstoneDeleteMessage({ db, messageId, actor: "admin" });
    expect(getMessageById(db, messageId)!.version).toBe(4);

    db.close();
  });

  test("edited_at is set on both edit and tombstone delete", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    // Initially null
    expect(getMessageById(db, messageId)!.edited_at).toBeNull();

    // Edit sets edited_at
    editMessage({ db, messageId, newContentRaw: "Edited" });
    const afterEdit = getMessageById(db, messageId);
    expect(afterEdit!.edited_at).not.toBeNull();
    // Verify it's a valid ISO timestamp
    const editedAt1 = afterEdit!.edited_at as string;
    expect(new Date(editedAt1).toISOString()).toBe(editedAt1);

    // Create second message for tombstone test
    const { messageId: msg2 } = setupTestMessage(db);
    expect(getMessageById(db, msg2)!.edited_at).toBeNull();

    // Tombstone also sets edited_at (content changed)
    tombstoneDeleteMessage({ db, messageId: msg2, actor: "admin" });
    const afterDelete = getMessageById(db, msg2);
    expect(afterDelete!.edited_at).not.toBeNull();
    // Verify it's a valid ISO timestamp
    const editedAt2 = afterDelete!.edited_at as string;
    expect(new Date(editedAt2).toISOString()).toBe(editedAt2);

    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0008: Privacy Implication - Event Log Retains Old Content
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0008: Privacy Implication - Immutable Event Log", () => {
  test("Deleted message content remains in message.edited event history", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db, "Super secret password: abc123");

    // Edit to change content
    editMessage({ db, messageId, newContentRaw: "Edited to hide secret" });

    // Then delete
    tombstoneDeleteMessage({ db, messageId, actor: "admin" });

    // Current message state shows tombstone
    const message = getMessageById(db, messageId);
    expect(message!.content_raw).toBe("[deleted]");

    // But edit event still contains original content
    const editEvent = db
      .query<{ data_json: string }, [string, string]>(
        `SELECT data_json FROM events 
         WHERE name = ? AND json_extract(data_json, '$.message_id') = ?`
      )
      .get("message.edited", messageId);

    expect(editEvent).not.toBeNull();
    const data = JSON.parse(editEvent!.data_json);
    expect(data.old_content).toBe("Super secret password: abc123");

    db.close();
  });

  test("Events table is immutable (UPDATE/DELETE forbidden)", () => {
    const { db } = setupTestDb();
    const { messageId } = setupTestMessage(db);

    const result = tombstoneDeleteMessage({ db, messageId, actor: "admin" });

    // Cannot UPDATE events
    expect(() => {
      db.run("UPDATE events SET name = 'hacked' WHERE event_id = ?", [result.eventId]);
    }).toThrow(/immutable/);

    // Cannot DELETE events
    expect(() => {
      db.run("DELETE FROM events WHERE event_id = ?", [result.eventId]);
    }).toThrow(/append-only/);

    db.close();
  });
});
