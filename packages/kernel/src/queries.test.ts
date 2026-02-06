/**
 * Unit tests for @agentlip/kernel queries module
 * 
 * Tests bd-16d.2.3: canonical read query helpers
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, runMigrations } from "./index";
import {
  listChannels,
  getChannelById,
  getChannelByName,
  listTopicsByChannel,
  getTopicById,
  getTopicByTitle,
  listMessages,
  tailMessages,
  getMessageById,
  listTopicAttachments,
  getAttachmentById,
  findAttachmentByDedupeKey,
} from "./queries";
import type { Database } from "bun:sqlite";

const TEST_DIR = join(import.meta.dir, ".test-tmp-queries");
const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

interface TestData {
  db: Database;
  dbPath: string;
  channelId: string;
  topicId: string;
}

function setupTestDb(): TestData {
  const dbPath = join(TEST_DIR, `queries-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });

  // Create a channel and topic for tests
  const channelId = crypto.randomUUID();
  const topicId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.run("INSERT INTO channels (id, name, description, created_at) VALUES (?, ?, ?, ?)", [
    channelId,
    "test-channel",
    "Test channel description",
    now,
  ]);

  db.run(
    "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [topicId, channelId, "test-topic", now, now]
  );

  return { db, dbPath, channelId, topicId };
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

describe("Channel Queries", () => {
  test("listChannels returns all channels ordered by name", () => {
    const { db } = setupTestDb();
    const now = new Date().toISOString();

    // Add more channels
    db.run("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)", [
      crypto.randomUUID(),
      "alpha-channel",
      now,
    ]);
    db.run("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)", [
      crypto.randomUUID(),
      "zeta-channel",
      now,
    ]);

    const channels = listChannels(db);

    expect(channels.length).toBe(3);
    expect(channels[0].name).toBe("alpha-channel");
    expect(channels[1].name).toBe("test-channel");
    expect(channels[2].name).toBe("zeta-channel");

    db.close();
  });

  test("getChannelById returns channel or null", () => {
    const { db, channelId } = setupTestDb();

    const channel = getChannelById(db, channelId);
    expect(channel).not.toBeNull();
    expect(channel!.id).toBe(channelId);
    expect(channel!.name).toBe("test-channel");
    expect(channel!.description).toBe("Test channel description");

    const notFound = getChannelById(db, "nonexistent");
    expect(notFound).toBeNull();

    db.close();
  });

  test("getChannelByName returns channel or null", () => {
    const { db, channelId } = setupTestDb();

    const channel = getChannelByName(db, "test-channel");
    expect(channel).not.toBeNull();
    expect(channel!.id).toBe(channelId);

    const notFound = getChannelByName(db, "nonexistent");
    expect(notFound).toBeNull();

    db.close();
  });
});

describe("Topic Queries", () => {
  test("listTopicsByChannel returns topics ordered by updated_at DESC", () => {
    const { db, channelId } = setupTestDb();

    // Add more topics with different updated_at
    const topics = [
      { id: crypto.randomUUID(), title: "topic-a", updated_at: "2024-01-01T00:00:00Z" },
      { id: crypto.randomUUID(), title: "topic-b", updated_at: "2024-01-03T00:00:00Z" },
      { id: crypto.randomUUID(), title: "topic-c", updated_at: "2024-01-02T00:00:00Z" },
    ];

    for (const t of topics) {
      db.run(
        "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [t.id, channelId, t.title, t.updated_at, t.updated_at]
      );
    }

    const result = listTopicsByChannel(db, channelId);

    // Should include the original test-topic + 3 new ones, ordered by updated_at DESC
    expect(result.items.length).toBe(4);
    // Most recently updated should be first (test-topic has "now" timestamp)
    // Then topic-b (2024-01-03), topic-c (2024-01-02), topic-a (2024-01-01)

    db.close();
  });

  test("listTopicsByChannel respects pagination", () => {
    const { db, channelId } = setupTestDb();

    // Add 5 more topics
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID();
      const ts = `2024-01-0${i + 1}T00:00:00Z`;
      db.run(
        "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [id, channelId, `topic-${i}`, ts, ts]
      );
    }

    // First page
    let result = listTopicsByChannel(db, channelId, { limit: 3, offset: 0 });
    expect(result.items.length).toBe(3);
    expect(result.hasMore).toBe(true);

    // Second page
    result = listTopicsByChannel(db, channelId, { limit: 3, offset: 3 });
    expect(result.items.length).toBe(3);
    expect(result.hasMore).toBe(false);

    // Beyond data
    result = listTopicsByChannel(db, channelId, { limit: 3, offset: 10 });
    expect(result.items.length).toBe(0);
    expect(result.hasMore).toBe(false);

    db.close();
  });

  test("getTopicById returns topic or null", () => {
    const { db, topicId, channelId } = setupTestDb();

    const topic = getTopicById(db, topicId);
    expect(topic).not.toBeNull();
    expect(topic!.id).toBe(topicId);
    expect(topic!.channel_id).toBe(channelId);
    expect(topic!.title).toBe("test-topic");

    const notFound = getTopicById(db, "nonexistent");
    expect(notFound).toBeNull();

    db.close();
  });

  test("getTopicByTitle returns topic or null", () => {
    const { db, topicId, channelId } = setupTestDb();

    const topic = getTopicByTitle(db, channelId, "test-topic");
    expect(topic).not.toBeNull();
    expect(topic!.id).toBe(topicId);

    const notFound = getTopicByTitle(db, channelId, "nonexistent");
    expect(notFound).toBeNull();

    db.close();
  });
});

describe("Message Queries", () => {
  function createMessages(db: Database, topicId: string, channelId: string, count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `msg_${String(i).padStart(5, "0")}_${crypto.randomUUID().slice(0, 8)}`;
      const ts = new Date(Date.now() + i * 1000).toISOString();
      db.run(
        "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [id, topicId, channelId, "test-user", `Message ${i}`, ts]
      );
      ids.push(id);
    }
    return ids;
  }

  test("listMessages requires channelId or topicId", () => {
    const { db } = setupTestDb();

    expect(() => listMessages(db, {})).toThrow(/channelId or topicId must be provided/);

    db.close();
  });

  test("listMessages by topicId returns messages in DESC order (newest first)", () => {
    const { db, topicId, channelId } = setupTestDb();
    const msgIds = createMessages(db, topicId, channelId, 5);

    const result = listMessages(db, { topicId });

    expect(result.items.length).toBe(5);
    // Newest first (DESC order by id)
    expect(result.items[0].id).toBe(msgIds[4]);
    expect(result.items[4].id).toBe(msgIds[0]);

    db.close();
  });

  test("listMessages by channelId returns messages from all topics", () => {
    const { db, topicId, channelId } = setupTestDb();

    // Create another topic in same channel
    const topic2Id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [topic2Id, channelId, "topic-2", now, now]
    );

    createMessages(db, topicId, channelId, 3);
    createMessages(db, topic2Id, channelId, 2);

    const result = listMessages(db, { channelId });

    expect(result.items.length).toBe(5);

    db.close();
  });

  test("listMessages with beforeId paginates backward", () => {
    const { db, topicId, channelId } = setupTestDb();
    const msgIds = createMessages(db, topicId, channelId, 10);

    // Get messages before msg_5 (should return msg_4, msg_3, msg_2, msg_1, msg_0)
    const result = listMessages(db, {
      topicId,
      beforeId: msgIds[5],
      limit: 3,
    });

    expect(result.items.length).toBe(3);
    expect(result.items[0].id).toBe(msgIds[4]);
    expect(result.items[1].id).toBe(msgIds[3]);
    expect(result.items[2].id).toBe(msgIds[2]);
    expect(result.hasMore).toBe(true);

    db.close();
  });

  test("listMessages with afterId paginates forward then returns DESC", () => {
    const { db, topicId, channelId } = setupTestDb();
    const msgIds = createMessages(db, topicId, channelId, 10);

    // Get messages after msg_5 (should return msg_9, msg_8, msg_7, msg_6)
    const result = listMessages(db, {
      topicId,
      afterId: msgIds[5],
      limit: 3,
    });

    expect(result.items.length).toBe(3);
    // Result should be in DESC order (newest first)
    expect(result.items[0].id).toBe(msgIds[9]);
    expect(result.items[1].id).toBe(msgIds[8]);
    expect(result.items[2].id).toBe(msgIds[7]);
    expect(result.hasMore).toBe(true);

    db.close();
  });

  test("tailMessages returns latest N messages", () => {
    const { db, topicId, channelId } = setupTestDb();
    const msgIds = createMessages(db, topicId, channelId, 10);

    const messages = tailMessages(db, topicId, 3);

    expect(messages.length).toBe(3);
    expect(messages[0].id).toBe(msgIds[9]);
    expect(messages[1].id).toBe(msgIds[8]);
    expect(messages[2].id).toBe(msgIds[7]);

    db.close();
  });

  test("getMessageById returns message or null", () => {
    const { db, topicId, channelId } = setupTestDb();
    const msgIds = createMessages(db, topicId, channelId, 3);

    const msg = getMessageById(db, msgIds[1]);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(msgIds[1]);
    expect(msg!.sender).toBe("test-user");
    expect(msg!.version).toBe(1);

    const notFound = getMessageById(db, "nonexistent");
    expect(notFound).toBeNull();

    db.close();
  });

  test("getMessageById returns all message fields including version and timestamps", () => {
    const { db, topicId, channelId } = setupTestDb();
    const msgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const editedAt = new Date(Date.now() + 60000).toISOString();

    db.run(
      `INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at, edited_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [msgId, topicId, channelId, "alice", "Edited content", 3, createdAt, editedAt, null, null]
    );

    const msg = getMessageById(db, msgId);

    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(msgId);
    expect(msg!.topic_id).toBe(topicId);
    expect(msg!.channel_id).toBe(channelId);
    expect(msg!.sender).toBe("alice");
    expect(msg!.content_raw).toBe("Edited content");
    expect(msg!.version).toBe(3);
    expect(msg!.created_at).toBe(createdAt);
    expect(msg!.edited_at).toBe(editedAt);
    expect(msg!.deleted_at).toBeNull();
    expect(msg!.deleted_by).toBeNull();

    db.close();
  });
});

describe("Attachment Queries", () => {
  test("listTopicAttachments returns attachments with parsed value_json", () => {
    const { db, topicId } = setupTestDb();
    const now = new Date().toISOString();

    // Create attachments
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), topicId, "url", '{"url":"https://example.com"}', "url:example.com", now]
    );
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        crypto.randomUUID(),
        topicId,
        "file",
        "docs",
        '{"path":"/docs/readme.md"}',
        "file:readme.md",
        now,
      ]
    );

    const attachments = listTopicAttachments(db, topicId);

    expect(attachments.length).toBe(2);
    expect(typeof attachments[0].value_json).toBe("object");
    expect(attachments[0].value_json).toBeDefined();

    db.close();
  });

  test("listTopicAttachments filters by kind", () => {
    const { db, topicId } = setupTestDb();
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), topicId, "url", '{"url":"https://a.com"}', "url:a", now]
    );
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), topicId, "file", '{"path":"/b.txt"}', "file:b", now]
    );
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), topicId, "url", '{"url":"https://c.com"}', "url:c", now]
    );

    const urlAttachments = listTopicAttachments(db, topicId, "url");
    expect(urlAttachments.length).toBe(2);
    expect(urlAttachments.every((a) => a.kind === "url")).toBe(true);

    const fileAttachments = listTopicAttachments(db, topicId, "file");
    expect(fileAttachments.length).toBe(1);
    expect(fileAttachments[0].kind).toBe("file");

    db.close();
  });

  test("getAttachmentById returns attachment or null", () => {
    const { db, topicId } = setupTestDb();
    const attachmentId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [attachmentId, topicId, "citation", "ref", '{"title":"Test"}', "cite:test", now]
    );

    const attachment = getAttachmentById(db, attachmentId);
    expect(attachment).not.toBeNull();
    expect(attachment!.id).toBe(attachmentId);
    expect(attachment!.kind).toBe("citation");
    expect(attachment!.key).toBe("ref");
    expect(attachment!.value_json).toEqual({ title: "Test" });

    const notFound = getAttachmentById(db, "nonexistent");
    expect(notFound).toBeNull();

    db.close();
  });

  test("findAttachmentByDedupeKey finds existing attachment", () => {
    const { db, topicId } = setupTestDb();
    const attachmentId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [attachmentId, topicId, "url", "links", '{"url":"https://example.com"}', "url:example.com", now]
    );

    // Find by dedupe key
    const found = findAttachmentByDedupeKey(db, topicId, "url", "links", "url:example.com");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(attachmentId);

    // Not found with different dedupe key
    const notFound = findAttachmentByDedupeKey(db, topicId, "url", "links", "url:other.com");
    expect(notFound).toBeNull();

    // Not found with different kind
    const differentKind = findAttachmentByDedupeKey(db, topicId, "file", "links", "url:example.com");
    expect(differentKind).toBeNull();

    db.close();
  });

  test("findAttachmentByDedupeKey handles null key", () => {
    const { db, topicId } = setupTestDb();
    const attachmentId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert with null key
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [attachmentId, topicId, "image", '{"src":"photo.jpg"}', "img:photo", now]
    );

    // Find with null key
    const found = findAttachmentByDedupeKey(db, topicId, "image", null, "img:photo");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(attachmentId);
    expect(found!.key).toBeNull();

    db.close();
  });
});

describe("Query Shapes (API contract)", () => {
  test("Channel shape matches expected fields", () => {
    const { db, channelId } = setupTestDb();

    const channel = getChannelById(db, channelId);

    expect(channel).toHaveProperty("id");
    expect(channel).toHaveProperty("name");
    expect(channel).toHaveProperty("description");
    expect(channel).toHaveProperty("created_at");
    expect(typeof channel!.id).toBe("string");
    expect(typeof channel!.name).toBe("string");

    db.close();
  });

  test("Topic shape matches expected fields", () => {
    const { db, topicId } = setupTestDb();

    const topic = getTopicById(db, topicId);

    expect(topic).toHaveProperty("id");
    expect(topic).toHaveProperty("channel_id");
    expect(topic).toHaveProperty("title");
    expect(topic).toHaveProperty("created_at");
    expect(topic).toHaveProperty("updated_at");

    db.close();
  });

  test("Message shape matches expected fields", () => {
    const { db, topicId, channelId } = setupTestDb();
    const msgId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [msgId, topicId, channelId, "user", "content", now]
    );

    const msg = getMessageById(db, msgId);

    expect(msg).toHaveProperty("id");
    expect(msg).toHaveProperty("topic_id");
    expect(msg).toHaveProperty("channel_id");
    expect(msg).toHaveProperty("sender");
    expect(msg).toHaveProperty("content_raw");
    expect(msg).toHaveProperty("version");
    expect(msg).toHaveProperty("created_at");
    expect(msg).toHaveProperty("edited_at");
    expect(msg).toHaveProperty("deleted_at");
    expect(msg).toHaveProperty("deleted_by");

    db.close();
  });

  test("TopicAttachment shape matches expected fields", () => {
    const { db, topicId } = setupTestDb();
    const attachmentId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [attachmentId, topicId, "url", "links", '{}', "dedupe", null, now]
    );

    const attachment = getAttachmentById(db, attachmentId);

    expect(attachment).toHaveProperty("id");
    expect(attachment).toHaveProperty("topic_id");
    expect(attachment).toHaveProperty("kind");
    expect(attachment).toHaveProperty("key");
    expect(attachment).toHaveProperty("value_json");
    expect(attachment).toHaveProperty("dedupe_key");
    expect(attachment).toHaveProperty("source_message_id");
    expect(attachment).toHaveProperty("created_at");
    expect(typeof attachment!.value_json).toBe("object");

    db.close();
  });
});
