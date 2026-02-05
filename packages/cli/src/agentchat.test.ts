/**
 * Tests for @agentchat/cli read-only commands
 * 
 * Tests: channel list, msg tail, attachment list, search
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";

import {
  openWorkspaceDbReadonly,
  isQueryOnly,
} from "./index.js";
import {
  listChannels,
  listTopicsByChannel,
  tailMessages,
  listMessages,
  listTopicAttachments,
  isFtsAvailable,
} from "@agentchat/kernel";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a test workspace with initialized schema and seed data.
 */
async function createTestWorkspace(tempDir: string): Promise<{ dbPath: string; db: Database }> {
  // Create .zulip directory
  const zulipDir = join(tempDir, ".zulip");
  await mkdir(zulipDir, { recursive: true });
  const dbPath = join(zulipDir, "db.sqlite3");
  
  // Create database
  const db = new Database(dbPath, { create: true });
  
  // Apply schema (inline for testing)
  const migrationPath = join(process.cwd(), "migrations", "0001_schema_v1.sql");
  if (existsSync(migrationPath)) {
    const sql = readFileSync(migrationPath, "utf-8");
    db.exec(sql);
  } else {
    // Inline minimal schema if migration file not found
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      
      INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
      INSERT OR REPLACE INTO meta (key, value) VALUES ('db_id', 'test-db-id');
      
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        UNIQUE(channel_id, title)
      ) STRICT;
      
      CREATE INDEX IF NOT EXISTS idx_topics_channel ON topics(channel_id, updated_at DESC);
      
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        topic_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content_raw TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        deleted_by TEXT,
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
      ) STRICT;
      
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
      
      CREATE TABLE IF NOT EXISTS topic_attachments (
        id TEXT PRIMARY KEY NOT NULL,
        topic_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT,
        value_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
      ) STRICT;
      
      CREATE INDEX IF NOT EXISTS idx_attachments_topic ON topic_attachments(topic_id, created_at DESC);
    `);
  }
  
  return { dbPath, db };
}

/**
 * Seed database with test data.
 */
function seedTestData(db: Database): {
  channelId: string;
  topicId: string;
  messageIds: string[];
  attachmentId: string;
} {
  const channelId = "ch-test-001";
  const topicId = "tp-test-001";
  const now = new Date().toISOString();
  
  // Insert channel
  db.run(
    "INSERT INTO channels (id, name, description, created_at) VALUES (?, ?, ?, ?)",
    [channelId, "test-channel", "A test channel", now]
  );
  
  // Insert a second channel
  db.run(
    "INSERT INTO channels (id, name, description, created_at) VALUES (?, ?, ?, ?)",
    ["ch-test-002", "another-channel", null, now]
  );
  
  // Insert topic
  db.run(
    "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [topicId, channelId, "Test Topic", now, now]
  );
  
  // Insert messages
  const messageIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const msgId = `msg-test-${String(i).padStart(3, "0")}`;
    messageIds.push(msgId);
    db.run(
      "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [msgId, topicId, channelId, "test-user", `Test message ${i}`, 1, now]
    );
  }
  
  // Insert attachment
  const attachmentId = "att-test-001";
  db.run(
    `INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [attachmentId, topicId, "file", "readme.md", JSON.stringify({ path: "/readme.md", size: 1024 }), "file:readme.md", now]
  );
  
  // Insert another attachment (different kind)
  db.run(
    `INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["att-test-002", topicId, "link", "github", JSON.stringify({ url: "https://github.com" }), "link:github", now]
  );
  
  return { channelId, topicId, messageIds, attachmentId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CLI read-only commands", () => {
  let tempDir: string;
  let setupDb: Database;
  let channelId: string;
  let topicId: string;
  let messageIds: string[];
  let attachmentId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentchat-cli-test-"));
    const { db } = await createTestWorkspace(tempDir);
    setupDb = db;
    const seeded = seedTestData(db);
    channelId = seeded.channelId;
    topicId = seeded.topicId;
    messageIds = seeded.messageIds;
    attachmentId = seeded.attachmentId;
    setupDb.close();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("read-only enforcement", () => {
    test("openWorkspaceDbReadonly sets query_only=ON", async () => {
      const { db, workspaceRoot, dbPath } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        expect(isQueryOnly(db)).toBe(true);
        expect(workspaceRoot).toBe(tempDir);
        expect(dbPath).toContain("db.sqlite3");
      } finally {
        db.close();
      }
    });

    test("read-only database rejects INSERT", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        expect(() => {
          db.run("INSERT INTO channels (id, name, created_at) VALUES ('x', 'x', 'x')");
        }).toThrow();
      } finally {
        db.close();
      }
    });

    test("read-only database rejects UPDATE", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        expect(() => {
          db.run("UPDATE channels SET name = 'modified' WHERE id = ?", [channelId]);
        }).toThrow();
      } finally {
        db.close();
      }
    });
  });

  describe("channel list", () => {
    test("listChannels returns all channels", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const channels = listChannels(db);
        expect(channels.length).toBe(2);
        
        // Sorted by name
        expect(channels[0].name).toBe("another-channel");
        expect(channels[1].name).toBe("test-channel");
        expect(channels[1].id).toBe(channelId);
        expect(channels[1].description).toBe("A test channel");
      } finally {
        db.close();
      }
    });

    test("listChannels returns empty array when no channels", async () => {
      // Create empty workspace
      const emptyDir = await mkdtemp(join(tmpdir(), "agentchat-empty-"));
      try {
        const { db } = await createTestWorkspace(emptyDir);
        db.close();
        
        const { db: readDb } = await openWorkspaceDbReadonly({ workspace: emptyDir });
        try {
          const channels = listChannels(readDb);
          expect(channels.length).toBe(0);
        } finally {
          readDb.close();
        }
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe("topic list", () => {
    test("listTopicsByChannel returns topics for channel", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const result = listTopicsByChannel(db, channelId);
        expect(result.items.length).toBe(1);
        expect(result.items[0].id).toBe(topicId);
        expect(result.items[0].title).toBe("Test Topic");
        expect(result.hasMore).toBe(false);
      } finally {
        db.close();
      }
    });

    test("listTopicsByChannel returns empty for non-existent channel", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const result = listTopicsByChannel(db, "non-existent");
        expect(result.items.length).toBe(0);
        expect(result.hasMore).toBe(false);
      } finally {
        db.close();
      }
    });

    test("listTopicsByChannel respects pagination", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        // Create additional topics first via direct write before closing setup db
        // (We can't write here, so test with limit=1 on single topic)
        const result = listTopicsByChannel(db, channelId, { limit: 1 });
        expect(result.items.length).toBe(1);
        expect(result.hasMore).toBe(false); // Only 1 topic exists
      } finally {
        db.close();
      }
    });
  });

  describe("msg tail", () => {
    test("tailMessages returns latest messages", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const messages = tailMessages(db, topicId, 50);
        expect(messages.length).toBe(5);
        
        // Should be ordered by id DESC (latest first)
        expect(messages[0].id).toBe("msg-test-005");
        expect(messages[4].id).toBe("msg-test-001");
        
        // Check content
        expect(messages[0].content_raw).toBe("Test message 5");
        expect(messages[0].sender).toBe("test-user");
        expect(messages[0].topic_id).toBe(topicId);
        expect(messages[0].channel_id).toBe(channelId);
      } finally {
        db.close();
      }
    });

    test("tailMessages respects limit", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const messages = tailMessages(db, topicId, 2);
        expect(messages.length).toBe(2);
        expect(messages[0].id).toBe("msg-test-005");
        expect(messages[1].id).toBe("msg-test-004");
      } finally {
        db.close();
      }
    });

    test("tailMessages returns empty for non-existent topic", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const messages = tailMessages(db, "non-existent", 50);
        expect(messages.length).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe("msg page", () => {
    test("listMessages paginates with beforeId", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        // Get messages before msg-test-004
        const result = listMessages(db, {
          topicId,
          beforeId: "msg-test-004",
          limit: 50,
        });
        
        expect(result.items.length).toBe(3);
        expect(result.items[0].id).toBe("msg-test-003");
        expect(result.items[2].id).toBe("msg-test-001");
      } finally {
        db.close();
      }
    });

    test("listMessages paginates with afterId", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        // Get messages after msg-test-002
        const result = listMessages(db, {
          topicId,
          afterId: "msg-test-002",
          limit: 50,
        });
        
        expect(result.items.length).toBe(3);
        // Results should be in DESC order even when fetched with afterId
        expect(result.items[0].id).toBe("msg-test-005");
        expect(result.items[2].id).toBe("msg-test-003");
      } finally {
        db.close();
      }
    });

    test("listMessages hasMore flag works correctly", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        // Get 2 messages with limit 2 (should have more)
        const result = listMessages(db, {
          topicId,
          limit: 2,
        });
        
        expect(result.items.length).toBe(2);
        expect(result.hasMore).toBe(true);
        
        // Get all 5 messages with limit 5 (should not have more)
        const result2 = listMessages(db, {
          topicId,
          limit: 5,
        });
        
        expect(result2.items.length).toBe(5);
        expect(result2.hasMore).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  describe("attachment list", () => {
    test("listTopicAttachments returns all attachments", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const attachments = listTopicAttachments(db, topicId);
        expect(attachments.length).toBe(2);
        
        // Check first attachment (sorted by created_at DESC)
        const fileAtt = attachments.find(a => a.kind === "file");
        expect(fileAtt).toBeDefined();
        expect(fileAtt!.id).toBe(attachmentId);
        expect(fileAtt!.key).toBe("readme.md");
        expect(fileAtt!.value_json).toEqual({ path: "/readme.md", size: 1024 });
        
        const linkAtt = attachments.find(a => a.kind === "link");
        expect(linkAtt).toBeDefined();
        expect(linkAtt!.key).toBe("github");
      } finally {
        db.close();
      }
    });

    test("listTopicAttachments filters by kind", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const fileAtts = listTopicAttachments(db, topicId, "file");
        expect(fileAtts.length).toBe(1);
        expect(fileAtts[0].kind).toBe("file");
        
        const linkAtts = listTopicAttachments(db, topicId, "link");
        expect(linkAtts.length).toBe(1);
        expect(linkAtts[0].kind).toBe("link");
        
        const noAtts = listTopicAttachments(db, topicId, "nonexistent");
        expect(noAtts.length).toBe(0);
      } finally {
        db.close();
      }
    });

    test("listTopicAttachments returns empty for non-existent topic", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        const attachments = listTopicAttachments(db, "non-existent");
        expect(attachments.length).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe("isFtsAvailable", () => {
    test("returns false when FTS table does not exist", async () => {
      const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
      
      try {
        expect(isFtsAvailable(db)).toBe(false);
      } finally {
        db.close();
      }
    });

    test("returns true when FTS table exists", async () => {
      // Create workspace with FTS enabled
      const ftsDir = await mkdtemp(join(tmpdir(), "agentchat-fts-"));
      try {
        const { db } = await createTestWorkspace(ftsDir);
        
        // Try to create FTS table
        try {
          db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
              content_raw,
              content=messages,
              content_rowid=rowid
            );
          `);
        } catch {
          // FTS5 may not be available in this SQLite build - skip test
          db.close();
          return;
        }
        db.close();
        
        const { db: readDb } = await openWorkspaceDbReadonly({ workspace: ftsDir });
        try {
          expect(isFtsAvailable(readDb)).toBe(true);
        } finally {
          readDb.close();
        }
      } finally {
        await rm(ftsDir, { recursive: true, force: true });
      }
    });
  });
});

describe("CLI integration (via main function)", () => {
  let tempDir: string;
  let setupDb: Database;
  let channelId: string;
  let topicId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentchat-cli-integ-"));
    const { db } = await createTestWorkspace(tempDir);
    setupDb = db;
    const seeded = seedTestData(db);
    channelId = seeded.channelId;
    topicId = seeded.topicId;
    setupDb.close();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Note: Full CLI integration tests would require mocking process.exit
  // and capturing stdout. For now, we test the underlying functions directly.
  // The main() function is tested manually via CLI execution.
  
  test("kernel queries work with read-only workspace connection", async () => {
    const { db } = await openWorkspaceDbReadonly({ workspace: tempDir });
    
    try {
      // Verify all queries work in read-only mode
      const channels = listChannels(db);
      expect(channels.length).toBeGreaterThan(0);
      
      const topics = listTopicsByChannel(db, channelId);
      expect(topics.items.length).toBeGreaterThan(0);
      
      const messages = tailMessages(db, topicId);
      expect(messages.length).toBeGreaterThan(0);
      
      const attachments = listTopicAttachments(db, topicId);
      expect(attachments.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
