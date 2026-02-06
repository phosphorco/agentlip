/**
 * Tests for derived job staleness guard (bd-16d.4.7)
 * 
 * Validates AGENTLIP_PLAN.md §4.6 staleness detection:
 * - Unchanged message: allow commit
 * - Content changed: discard
 * - Version changed (ABA): discard even if content returns to original
 * - Message deleted: discard
 * - Message missing: discard
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDb, runMigrations, MIGRATIONS_DIR } from "@agentlip/kernel";
import {
  withMessageStalenessGuard,
  captureSnapshot,
  type MessageSnapshot,
  type CurrentMessageState,
} from "./derivedStaleness";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, ".test-tmp-staleness");

async function setupTestDb(): Promise<Database> {
  await mkdir(TEST_DIR, { recursive: true });
  const dbPath = join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  return db;
}

function createTestChannel(db: Database, id: string, name: string): void {
  db.run(
    "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
    [id, name, new Date().toISOString()]
  );
}

function createTestTopic(db: Database, id: string, channelId: string, title: string): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, channelId, title, now, now]
  );
}

function createTestMessage(
  db: Database,
  id: string,
  topicId: string,
  channelId: string,
  sender: string,
  content: string,
  version = 1
): CurrentMessageState {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, topicId, channelId, sender, content, version, now]
  );

  const message = db
    .query<CurrentMessageState, [string]>(
      `SELECT id, topic_id, channel_id, sender, content_raw, version, 
              created_at, edited_at, deleted_at, deleted_by
       FROM messages WHERE id = ?`
    )
    .get(id);

  if (!message) throw new Error(`Failed to create test message ${id}`);
  return message;
}

function editMessage(db: Database, messageId: string, newContent: string): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE messages 
     SET content_raw = ?, edited_at = ?, version = version + 1
     WHERE id = ?`,
    [newContent, now, messageId]
  );
}

function tombstoneMessage(db: Database, messageId: string, actor: string): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE messages 
     SET deleted_at = ?, deleted_by = ?, content_raw = '[deleted]', version = version + 1
     WHERE id = ?`,
    [now, actor, messageId]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Happy Path
// ─────────────────────────────────────────────────────────────────────────────

describe("withMessageStalenessGuard - happy path", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
    createTestChannel(db, "ch1", "test-channel");
    createTestTopic(db, "topic1", "ch1", "test-topic");
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("allows commit when message unchanged", () => {
    const message = createTestMessage(db, "msg1", "topic1", "ch1", "agent-1", "Hello world");
    const snapshot = captureSnapshot(message);

    // Simulate derived job: process and commit
    const result = withMessageStalenessGuard(db, snapshot, (current) => {
      expect(current.id).toBe("msg1");
      expect(current.content_raw).toBe("Hello world");
      expect(current.version).toBe(1);
      return { committed: true };
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.committed).toBe(true);
    }
  });

  test("provides current message state to callback", () => {
    const message = createTestMessage(db, "msg2", "topic1", "ch1", "agent-2", "Test content");
    const snapshot = captureSnapshot(message);

    const result = withMessageStalenessGuard(db, snapshot, (current) => {
      // Verify callback receives full message state
      expect(current.id).toBe("msg2");
      expect(current.topic_id).toBe("topic1");
      expect(current.channel_id).toBe("ch1");
      expect(current.sender).toBe("agent-2");
      expect(current.content_raw).toBe("Test content");
      expect(current.version).toBe(1);
      expect(current.created_at).toBeTruthy();
      expect(current.edited_at).toBeNull();
      expect(current.deleted_at).toBeNull();
      expect(current.deleted_by).toBeNull();
      return { scopes: { channel_id: current.channel_id, topic_id: current.topic_id } };
    });

    expect(result.ok).toBe(true);
  });

  test("allows multiple concurrent checks on same message", () => {
    const message = createTestMessage(db, "msg3", "topic1", "ch1", "agent-3", "Concurrent test");
    const snapshot = captureSnapshot(message);

    // Simulate two plugin jobs processing same message
    const result1 = withMessageStalenessGuard(db, snapshot, () => ({ job: 1 }));
    const result2 = withMessageStalenessGuard(db, snapshot, () => ({ job: 2 }));

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.job).toBe(1);
      expect(result2.value.job).toBe(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Content Change Detection
// ─────────────────────────────────────────────────────────────────────────────

describe("withMessageStalenessGuard - content changes", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
    createTestChannel(db, "ch1", "test-channel");
    createTestTopic(db, "topic1", "ch1", "test-topic");
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("discards when content changed", () => {
    const message = createTestMessage(db, "msg1", "topic1", "ch1", "agent-1", "Original content");
    const snapshot = captureSnapshot(message);

    // Simulate edit during processing (changes both version and content)
    editMessage(db, "msg1", "Edited content");

    const result = withMessageStalenessGuard(db, snapshot, () => {
      throw new Error("Should not be called when stale");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Version check happens first; when content changes via edit, version also changes
      expect(result.reason).toBe("STALE_VERSION");
      expect(result.detail).toContain("msg1");
      expect(result.detail).toContain("version changed");
    }
  });

  test("discards when version changed (even if content same)", () => {
    const message = createTestMessage(db, "msg2", "topic1", "ch1", "agent-2", "Hello");
    const snapshot = captureSnapshot(message);

    // Simulate version increment without content change (e.g., retopic)
    db.run("UPDATE messages SET version = version + 1 WHERE id = ?", ["msg2"]);

    const result = withMessageStalenessGuard(db, snapshot, () => {
      throw new Error("Should not be called when version changed");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("STALE_VERSION");
      expect(result.detail).toContain("msg2");
      expect(result.detail).toContain("version changed");
      expect(result.detail).toContain("1 → 2");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: ABA Problem (Critical)
// ─────────────────────────────────────────────────────────────────────────────

describe("withMessageStalenessGuard - ABA problem", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
    createTestChannel(db, "ch1", "test-channel");
    createTestTopic(db, "topic1", "ch1", "test-topic");
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("discards when content edited back to original (ABA)", () => {
    // Setup: message starts with "Hello"
    const message = createTestMessage(db, "msg1", "topic1", "ch1", "agent-1", "Hello");
    const snapshot = captureSnapshot(message);
    expect(snapshot.contentRaw).toBe("Hello");
    expect(snapshot.version).toBe(1);

    // Simulate ABA sequence during processing:
    // v1: "Hello" → v2: "Goodbye" → v3: "Hello"
    editMessage(db, "msg1", "Goodbye"); // v1 → v2
    editMessage(db, "msg1", "Hello");   // v2 → v3

    // Verify current state: content matches original but version changed
    const current = db
      .query<{ content_raw: string; version: number }, [string]>(
        "SELECT content_raw, version FROM messages WHERE id = ?"
      )
      .get("msg1");
    expect(current?.content_raw).toBe("Hello"); // Same as original
    expect(current?.version).toBe(3);           // But version changed!

    // Guard must discard despite content match
    const result = withMessageStalenessGuard(db, snapshot, () => {
      throw new Error("Should not commit: ABA detected");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("STALE_VERSION");
      expect(result.detail).toContain("1 → 3");
    }
  });

  test("detects rapid edit sequence (version divergence)", () => {
    const message = createTestMessage(db, "msg2", "topic1", "ch1", "agent-2", "v1");
    const snapshot = captureSnapshot(message);

    // Rapid edits: v1 → v2 → v3 → v4 → back to "v1"
    editMessage(db, "msg2", "v2");
    editMessage(db, "msg2", "v3");
    editMessage(db, "msg2", "v4");
    editMessage(db, "msg2", "v1"); // Content matches original

    const result = withMessageStalenessGuard(db, snapshot, () => {
      throw new Error("Should not commit after rapid edits");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("STALE_VERSION");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Tombstone Detection
// ─────────────────────────────────────────────────────────────────────────────

describe("withMessageStalenessGuard - tombstone detection", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
    createTestChannel(db, "ch1", "test-channel");
    createTestTopic(db, "topic1", "ch1", "test-topic");
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("discards when message deleted", () => {
    const message = createTestMessage(db, "msg1", "topic1", "ch1", "agent-1", "To be deleted");
    const snapshot = captureSnapshot(message);

    // Delete message during processing
    tombstoneMessage(db, "msg1", "admin");

    const result = withMessageStalenessGuard(db, snapshot, () => {
      throw new Error("Should not enrich deleted content");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("DELETED");
      expect(result.detail).toContain("msg1");
      expect(result.detail).toContain("deleted at");
    }
  });

  test("detects tombstone even if content_raw is overwritten", () => {
    const message = createTestMessage(db, "msg2", "topic1", "ch1", "agent-2", "Sensitive data");
    const snapshot = captureSnapshot(message);

    // Tombstone: sets deleted_at AND overwrites content
    tombstoneMessage(db, "msg2", "agent-2");

    // Verify tombstone state
    const current = db
      .query<{ content_raw: string; deleted_at: string | null }, [string]>(
        "SELECT content_raw, deleted_at FROM messages WHERE id = ?"
      )
      .get("msg2");
    expect(current?.content_raw).toBe("[deleted]");
    expect(current?.deleted_at).not.toBeNull();

    const result = withMessageStalenessGuard(db, snapshot, () => {
      throw new Error("Should not process tombstoned content");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("DELETED");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Missing Message
// ─────────────────────────────────────────────────────────────────────────────

describe("withMessageStalenessGuard - missing message", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
    createTestChannel(db, "ch1", "test-channel");
    createTestTopic(db, "topic1", "ch1", "test-topic");
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("discards when message doesn't exist", () => {
    const snapshot: MessageSnapshot = {
      messageId: "msg_nonexistent",
      contentRaw: "Ghost content",
      version: 1,
    };

    const result = withMessageStalenessGuard(db, snapshot, () => {
      throw new Error("Should not be called for missing message");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("MISSING");
      expect(result.detail).toContain("msg_nonexistent");
      expect(result.detail).toContain("no longer exists");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Transaction Atomicity
// ─────────────────────────────────────────────────────────────────────────────

describe("withMessageStalenessGuard - transaction atomicity", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
    createTestChannel(db, "ch1", "test-channel");
    createTestTopic(db, "topic1", "ch1", "test-topic");
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("verification and commit happen in same transaction", () => {
    const message = createTestMessage(db, "msg1", "topic1", "ch1", "agent-1", "Test");
    const snapshot = captureSnapshot(message);

    let callbackExecuted = false;

    const result = withMessageStalenessGuard(db, snapshot, (current) => {
      callbackExecuted = true;
      
      // Insert enrichment in same transaction
      const enrichmentId = `enrich_${Date.now()}`;
      db.run(
        `INSERT INTO enrichments (id, message_id, kind, span_start, span_end, data_json, created_at)
         VALUES (?, ?, 'test', 0, 4, '{}', ?)`,
        [enrichmentId, current.id, new Date().toISOString()]
      );
      
      return { enrichmentId };
    });

    expect(callbackExecuted).toBe(true);
    expect(result.ok).toBe(true);

    // Verify enrichment was committed
    const enrichment = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM enrichments WHERE message_id = ?"
      )
      .get("msg1");
    expect(enrichment).toBeTruthy();
  });

  test("rolls back derived inserts when callback throws", () => {
    const message = createTestMessage(db, "msg2", "topic1", "ch1", "agent-2", "Test");
    const snapshot = captureSnapshot(message);

    expect(() => {
      withMessageStalenessGuard(db, snapshot, (current) => {
        // Insert enrichment
        db.run(
          `INSERT INTO enrichments (id, message_id, kind, span_start, span_end, data_json, created_at)
           VALUES (?, ?, 'test', 0, 4, '{}', ?)`,
          [`enrich_${Date.now()}`, current.id, new Date().toISOString()]
        );
        
        // Simulate error
        throw new Error("Processing failed");
      });
    }).toThrow("Processing failed");

    // Verify enrichment was NOT committed (transaction rolled back)
    const enrichment = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM enrichments WHERE message_id = ?"
      )
      .get("msg2");
    expect(enrichment).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Input Validation
// ─────────────────────────────────────────────────────────────────────────────

describe("withMessageStalenessGuard - input validation", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("throws on invalid snapshot.messageId", () => {
    const snapshot: any = { messageId: "", contentRaw: "test", version: 1 };
    expect(() => {
      withMessageStalenessGuard(db, snapshot, () => ({}));
    }).toThrow("messageId must be a non-empty string");
  });

  test("throws on invalid snapshot.contentRaw", () => {
    const snapshot: any = { messageId: "msg1", contentRaw: null, version: 1 };
    expect(() => {
      withMessageStalenessGuard(db, snapshot, () => ({}));
    }).toThrow("contentRaw must be a string");
  });

  test("throws on invalid snapshot.version", () => {
    const snapshot: any = { messageId: "msg1", contentRaw: "test", version: 0 };
    expect(() => {
      withMessageStalenessGuard(db, snapshot, () => ({}));
    }).toThrow("version must be a positive number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: captureSnapshot Helper
// ─────────────────────────────────────────────────────────────────────────────

describe("captureSnapshot", () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupTestDb();
    createTestChannel(db, "ch1", "test-channel");
    createTestTopic(db, "topic1", "ch1", "test-topic");
  });

  afterEach(async () => {
    db.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("extracts minimal snapshot from full message", () => {
    const message = createTestMessage(
      db,
      "msg1",
      "topic1",
      "ch1",
      "agent-1",
      "Test content",
      5
    );

    const snapshot = captureSnapshot(message);

    expect(snapshot.messageId).toBe("msg1");
    expect(snapshot.contentRaw).toBe("Test content");
    expect(snapshot.version).toBe(5);
    
    // Verify only essential fields are captured
    expect(Object.keys(snapshot)).toEqual(["messageId", "contentRaw", "version"]);
  });
});
