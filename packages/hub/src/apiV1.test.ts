/**
 * Tests for API v1 handler
 * 
 * Tests all endpoints with:
 * - Happy paths
 * - Auth requirements
 * - Invalid JSON / content-type handling
 * - Size limits (413)
 * - Version conflicts (409)
 * - Attachment dedupe
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { handleApiV1, type ApiV1Context } from "./apiV1";
import { HubRateLimiter } from "./rateLimiter";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an in-memory SQLite DB with schema applied.
 */
function createTestDb(): Database {
  const db = new Database(":memory:");
  
  // Apply schema (from migrations/0001_schema_v1.sql)
  db.exec(`
    BEGIN TRANSACTION;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;

    INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
    INSERT OR IGNORE INTO meta (key, value)
      VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    INSERT OR IGNORE INTO meta (key, value) VALUES (
      'db_id',
      lower(hex(randomblob(4))) || '-' ||
      lower(hex(randomblob(2))) || '-' ||
      '4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
      lower(hex(randomblob(6)))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL,
      CHECK (length(name) > 0 AND length(name) <= 100)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      UNIQUE(channel_id, title),
      CHECK (length(title) > 0 AND length(title) <= 200)
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
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
      CHECK (length(sender) > 0),
      CHECK (length(content_raw) <= 65536),
      CHECK (version >= 1)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

    CREATE TRIGGER IF NOT EXISTS prevent_message_delete
    BEFORE DELETE ON messages
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'Hard deletes forbidden on messages; use tombstone');
    END;

    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      name TEXT NOT NULL,
      scope_channel_id TEXT,
      scope_topic_id TEXT,
      scope_topic_id2 TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      CHECK (length(name) > 0)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_events_replay ON events(event_id);
    CREATE INDEX IF NOT EXISTS idx_events_scope_channel ON events(scope_channel_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_events_scope_topic ON events(scope_topic_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_events_scope_topic2 ON events(scope_topic_id2, event_id);

    CREATE TRIGGER IF NOT EXISTS prevent_event_mutation
    BEFORE UPDATE ON events
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'Events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS prevent_event_delete
    BEFORE DELETE ON events
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'Events are append-only');
    END;

    CREATE TABLE IF NOT EXISTS topic_attachments (
      id TEXT PRIMARY KEY NOT NULL,
      topic_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT,
      value_json TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      source_message_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
      FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
      CHECK (length(kind) > 0),
      CHECK (length(dedupe_key) > 0),
      CHECK (length(value_json) <= 16384)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_attachments_topic ON topic_attachments(topic_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_attachments_dedupe
      ON topic_attachments(topic_id, kind, COALESCE(key, ''), dedupe_key);

    CREATE TABLE IF NOT EXISTS enrichments (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      span_start INTEGER NOT NULL,
      span_end INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      CHECK (span_start >= 0),
      CHECK (span_end > span_start),
      CHECK (length(kind) > 0)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_enrichments_message ON enrichments(message_id, created_at DESC);

    COMMIT;
  `);

  return db;
}

/**
 * Create test context with DB and auth token.
 */
function createTestContext(db: Database): ApiV1Context {
  return {
    db,
    authToken: "test-token-12345",
    instanceId: "test-instance",
  };
}

/**
 * Helper to create a test Request with JSON body.
 */
function createRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Request {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return new Request(url, init);
}

/**
 * Helper to parse JSON response.
 */
async function parseResponse(response: Response): Promise<unknown> {
  return await response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("API v1 - Channels", () => {
  let db: Database;
  let ctx: ApiV1Context;

  beforeEach(() => {
    db = createTestDb();
    ctx = createTestContext(db);
  });

  test("GET /api/v1/channels returns empty list", async () => {
    const req = createRequest("GET", "/api/v1/channels");
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data = await parseResponse(response);
    expect(data).toEqual({ channels: [] });
  });

  test("POST /api/v1/channels creates channel (with auth)", async () => {
    const req = createRequest(
      "POST",
      "/api/v1/channels",
      { name: "general", description: "General chat" },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.channel.name).toBe("general");
    expect(data.channel.description).toBe("General chat");
    expect(data.event_id).toBeGreaterThan(0);
  });

  test("POST /api/v1/channels requires auth", async () => {
    const req = createRequest("POST", "/api/v1/channels", { name: "general" });
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(401);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("MISSING_AUTH");
  });

  test("POST /api/v1/channels rejects duplicate name", async () => {
    // Create first channel
    await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/channels",
        { name: "general" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Try to create duplicate
    const req = createRequest(
      "POST",
      "/api/v1/channels",
      { name: "general" },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("already exists");
  });
});

describe("API v1 - Topics", () => {
  let db: Database;
  let ctx: ApiV1Context;
  let channelId: string;

  beforeEach(async () => {
    db = createTestDb();
    ctx = createTestContext(db);

    // Create a channel
    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/channels",
        { name: "general" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const data: any = await parseResponse(response);
    channelId = data.channel.id;
  });

  test("GET /api/v1/channels/:channel_id/topics returns empty list", async () => {
    const req = createRequest("GET", `/api/v1/channels/${channelId}/topics`);
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.topics).toEqual([]);
  });

  test("POST /api/v1/topics creates topic (with auth)", async () => {
    const req = createRequest(
      "POST",
      "/api/v1/topics",
      { channel_id: channelId, title: "Bug reports" },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.topic.title).toBe("Bug reports");
    expect(data.topic.channel_id).toBe(channelId);
    expect(data.event_id).toBeGreaterThan(0);
  });

  test("POST /api/v1/topics requires auth", async () => {
    const req = createRequest("POST", "/api/v1/topics", {
      channel_id: channelId,
      title: "Bug reports",
    });
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(401);
  });

  test("PATCH /api/v1/topics/:topic_id renames topic", async () => {
    // Create topic
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/topics",
        { channel_id: channelId, title: "Old Title" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const topicId = createData.topic.id;

    // Rename topic
    const req = createRequest(
      "PATCH",
      `/api/v1/topics/${topicId}`,
      { title: "New Title" },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.topic.title).toBe("New Title");
    expect(data.event_id).toBeGreaterThan(0);
  });
});

describe("API v1 - Messages", () => {
  let db: Database;
  let ctx: ApiV1Context;
  let channelId: string;
  let topicId: string;

  beforeEach(async () => {
    db = createTestDb();
    ctx = createTestContext(db);

    // Create channel
    const channelResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/channels",
        { name: "general" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const channelData: any = await parseResponse(channelResponse);
    channelId = channelData.channel.id;

    // Create topic
    const topicResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/topics",
        { channel_id: channelId, title: "Test Topic" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const topicData: any = await parseResponse(topicResponse);
    topicId = topicData.topic.id;
  });

  test("GET /api/v1/messages requires channel_id or topic_id", async () => {
    const req = createRequest("GET", "/api/v1/messages");
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
  });

  test("GET /api/v1/messages returns messages by topic", async () => {
    const req = createRequest("GET", `/api/v1/messages?topic_id=${topicId}`);
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.messages).toEqual([]);
  });

  test("POST /api/v1/messages creates message (with auth)", async () => {
    const req = createRequest(
      "POST",
      "/api/v1/messages",
      {
        topic_id: topicId,
        sender: "agent-1",
        content_raw: "Hello, world!",
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.message.content_raw).toBe("Hello, world!");
    expect(data.message.sender).toBe("agent-1");
    expect(data.message.version).toBe(1);
    expect(data.event_id).toBeGreaterThan(0);
  });

  test("POST /api/v1/messages requires auth", async () => {
    const req = createRequest("POST", "/api/v1/messages", {
      topic_id: topicId,
      sender: "agent-1",
      content_raw: "Hello",
    });
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(401);
  });

  test("POST /api/v1/messages rejects oversized content (>64KB)", async () => {
    const largeContent = "x".repeat(65537); // 64KB + 1
    const req = createRequest(
      "POST",
      "/api/v1/messages",
      {
        topic_id: topicId,
        sender: "agent-1",
        content_raw: largeContent,
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    // Body parser rejects with 413 before handler validates
    expect(response.status).toBe(413);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("PATCH /api/v1/messages/:message_id edits message", async () => {
    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "Original content",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Edit message
    const req = createRequest(
      "PATCH",
      `/api/v1/messages/${messageId}`,
      {
        op: "edit",
        content_raw: "Updated content",
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.message.content_raw).toBe("Updated content");
    expect(data.message.version).toBe(2);
    expect(data.message.edited_at).not.toBeNull();
    expect(data.event_id).toBeGreaterThan(0);
  });

  test("PATCH /api/v1/messages/:message_id version conflict returns 409", async () => {
    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "Original",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Edit to bump version to 2
    await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "edit",
          content_raw: "Updated",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Try to edit with stale version (expected_version=1, but current is 2)
    const req = createRequest(
      "PATCH",
      `/api/v1/messages/${messageId}`,
      {
        op: "edit",
        content_raw: "Another update",
        expected_version: 1,
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(409);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("VERSION_CONFLICT");
    expect(data.details.current).toBe(2);
  });

  test("PATCH /api/v1/messages/:message_id tombstone delete", async () => {
    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "To be deleted",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Delete message
    const req = createRequest(
      "PATCH",
      `/api/v1/messages/${messageId}`,
      {
        op: "delete",
        actor: "agent-1",
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.message.deleted_at).not.toBeNull();
    expect(data.message.deleted_by).toBe("agent-1");
    expect(data.message.content_raw).toBe("[deleted]");
    expect(data.message.version).toBe(2);
    expect(data.event_id).toBeGreaterThan(0);
  });

  test("PATCH /api/v1/messages/:message_id move_topic (one)", async () => {
    // Create second topic
    const topic2Response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/topics",
        { channel_id: channelId, title: "Topic 2" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const topic2Data: any = await parseResponse(topic2Response);
    const topicId2 = topic2Data.topic.id;

    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "Message to move",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Move message
    const req = createRequest(
      "PATCH",
      `/api/v1/messages/${messageId}`,
      {
        op: "move_topic",
        to_topic_id: topicId2,
        mode: "one",
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.affected_count).toBe(1);
    expect(data.event_ids.length).toBe(1);
  });
});

describe("API v1 - Attachments", () => {
  let db: Database;
  let ctx: ApiV1Context;
  let channelId: string;
  let topicId: string;

  beforeEach(async () => {
    db = createTestDb();
    ctx = createTestContext(db);

    // Create channel and topic
    const channelResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/channels",
        { name: "general" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const channelData: any = await parseResponse(channelResponse);
    channelId = channelData.channel.id;

    const topicResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/topics",
        { channel_id: channelId, title: "Test Topic" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const topicData: any = await parseResponse(topicResponse);
    topicId = topicData.topic.id;
  });

  test("GET /api/v1/topics/:topic_id/attachments returns empty list", async () => {
    const req = createRequest("GET", `/api/v1/topics/${topicId}/attachments`);
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.attachments).toEqual([]);
  });

  test("POST /api/v1/topics/:topic_id/attachments creates attachment", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "https://example.com", title: "Example" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.attachment.kind).toBe("url");
    expect(data.attachment.value_json.url).toBe("https://example.com");
    expect(data.event_id).toBeGreaterThan(0);
  });

  test("POST /api/v1/topics/:topic_id/attachments deduplicates (event_id null)", async () => {
    // Create first attachment
    await handleApiV1(
      createRequest(
        "POST",
        `/api/v1/topics/${topicId}/attachments`,
        {
          kind: "url",
          value_json: { url: "https://example.com" },
          dedupe_key: "url:https://example.com",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Try to create duplicate
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "https://example.com" },
        dedupe_key: "url:https://example.com",
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.event_id).toBeNull();
  });

  test("Idempotency (ADR-0007): retry insert with explicit dedupe_key returns same attachment.id, no new event", async () => {
    // Count attachments and events before
    const attachmentCountBefore = db
      .query("SELECT COUNT(*) as count FROM topic_attachments")
      .get() as any;
    const eventCountBefore = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    // First insert
    const firstResponse = await handleApiV1(
      createRequest(
        "POST",
        `/api/v1/topics/${topicId}/attachments`,
        {
          kind: "file",
          key: "readme.md",
          value_json: { path: "/tmp/readme.md", size: 1024 },
          dedupe_key: "file:/tmp/readme.md",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(firstResponse.status).toBe(201);
    const firstData: any = await parseResponse(firstResponse);
    const firstAttachmentId = firstData.attachment.id;
    expect(firstData.event_id).toBeGreaterThan(0);

    // Verify counts after first insert
    const attachmentCountAfterFirst = db
      .query("SELECT COUNT(*) as count FROM topic_attachments")
      .get() as any;
    const eventCountAfterFirst = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    expect(attachmentCountAfterFirst.count).toBe(attachmentCountBefore.count + 1);
    expect(eventCountAfterFirst.count).toBe(eventCountBefore.count + 1);

    // Second insert (retry with same dedupe_key)
    const secondResponse = await handleApiV1(
      createRequest(
        "POST",
        `/api/v1/topics/${topicId}/attachments`,
        {
          kind: "file",
          key: "readme.md",
          value_json: { path: "/tmp/readme.md", size: 1024 },
          dedupe_key: "file:/tmp/readme.md",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(secondResponse.status).toBe(200);
    const secondData: any = await parseResponse(secondResponse);

    // Verify same attachment.id returned
    expect(secondData.attachment.id).toBe(firstAttachmentId);

    // Verify event_id is null (no new event)
    expect(secondData.event_id).toBeNull();

    // Verify counts unchanged (no new attachment or event)
    const attachmentCountAfterSecond = db
      .query("SELECT COUNT(*) as count FROM topic_attachments")
      .get() as any;
    const eventCountAfterSecond = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    expect(attachmentCountAfterSecond.count).toBe(attachmentCountAfterFirst.count);
    expect(eventCountAfterSecond.count).toBe(eventCountAfterFirst.count);

    // Verify attachment data matches
    expect(secondData.attachment.value_json).toEqual(firstData.attachment.value_json);
    expect(secondData.attachment.dedupe_key).toBe("file:/tmp/readme.md");
  });

  test("Idempotency (ADR-0007): retry insert without dedupe_key uses computed hash and dedupes correctly", async () => {
    // Count attachments and events before
    const attachmentCountBefore = db
      .query("SELECT COUNT(*) as count FROM topic_attachments")
      .get() as any;
    const eventCountBefore = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    const attachmentValue = { url: "https://api.example.com/resource", method: "GET" };

    // First insert (no dedupe_key provided)
    const firstResponse = await handleApiV1(
      createRequest(
        "POST",
        `/api/v1/topics/${topicId}/attachments`,
        {
          kind: "api_call",
          value_json: attachmentValue,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(firstResponse.status).toBe(201);
    const firstData: any = await parseResponse(firstResponse);
    const firstAttachmentId = firstData.attachment.id;
    const computedDedupeKey = firstData.attachment.dedupe_key;

    // Verify computed dedupe_key is JSON of value_json
    expect(computedDedupeKey).toBe(JSON.stringify(attachmentValue));
    expect(firstData.event_id).toBeGreaterThan(0);

    // Verify counts after first insert
    const attachmentCountAfterFirst = db
      .query("SELECT COUNT(*) as count FROM topic_attachments")
      .get() as any;
    const eventCountAfterFirst = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    expect(attachmentCountAfterFirst.count).toBe(attachmentCountBefore.count + 1);
    expect(eventCountAfterFirst.count).toBe(eventCountBefore.count + 1);

    // Second insert (same value_json, no dedupe_key)
    const secondResponse = await handleApiV1(
      createRequest(
        "POST",
        `/api/v1/topics/${topicId}/attachments`,
        {
          kind: "api_call",
          value_json: attachmentValue,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(secondResponse.status).toBe(200);
    const secondData: any = await parseResponse(secondResponse);

    // Verify same attachment.id returned
    expect(secondData.attachment.id).toBe(firstAttachmentId);

    // Verify event_id is null (no new event)
    expect(secondData.event_id).toBeNull();

    // Verify computed dedupe_key matches
    expect(secondData.attachment.dedupe_key).toBe(computedDedupeKey);

    // Verify counts unchanged
    const attachmentCountAfterSecond = db
      .query("SELECT COUNT(*) as count FROM topic_attachments")
      .get() as any;
    const eventCountAfterSecond = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    expect(attachmentCountAfterSecond.count).toBe(attachmentCountAfterFirst.count);
    expect(eventCountAfterSecond.count).toBe(eventCountAfterSecond.count);
  });

  test("Idempotency (ADR-0007): onEventIds hook not called when attachment is deduped", async () => {
    // Track event IDs published via hook
    const publishedEventIds: number[] = [];
    const contextWithHook: ApiV1Context = {
      ...ctx,
      onEventIds: (eventIds: number[]) => {
        publishedEventIds.push(...eventIds);
      },
    };

    const attachmentValue = { tag: "important", priority: 1 };

    // First insert (should call hook)
    const firstResponse = await handleApiV1(
      createRequest(
        "POST",
        `/api/v1/topics/${topicId}/attachments`,
        {
          kind: "metadata",
          value_json: attachmentValue,
          dedupe_key: "metadata:important:1",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      contextWithHook
    );

    expect(firstResponse.status).toBe(201);
    const firstData: any = await parseResponse(firstResponse);
    expect(firstData.event_id).toBeGreaterThan(0);

    // Verify hook was called with the event ID
    expect(publishedEventIds.length).toBe(1);
    expect(publishedEventIds[0]).toBe(firstData.event_id);

    // Clear tracked event IDs
    publishedEventIds.length = 0;

    // Second insert (should NOT call hook)
    const secondResponse = await handleApiV1(
      createRequest(
        "POST",
        `/api/v1/topics/${topicId}/attachments`,
        {
          kind: "metadata",
          value_json: attachmentValue,
          dedupe_key: "metadata:important:1",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      contextWithHook
    );

    expect(secondResponse.status).toBe(200);
    const secondData: any = await parseResponse(secondResponse);
    expect(secondData.event_id).toBeNull();

    // Verify hook was NOT called (no new event IDs published)
    expect(publishedEventIds.length).toBe(0);
  });

  test("POST /api/v1/topics/:topic_id/attachments rejects oversized value_json (>16KB)", async () => {
    const largeValue = { data: "x".repeat(20000) };
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "large",
        value_json: largeValue,
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    // Body parser rejects with 413 before handler validates
    expect(response.status).toBe(413);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("POST /api/v1/topics/:topic_id/attachments requires auth", async () => {
    const req = createRequest("POST", `/api/v1/topics/${topicId}/attachments`, {
      kind: "url",
      value_json: { url: "https://example.com" },
    });
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(401);
  });

  test("POST url attachment accepts valid http URL", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "http://example.com/path?query=1" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.attachment.value_json.url).toBe("http://example.com/path?query=1");
  });

  test("POST url attachment accepts valid https URL", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "https://example.com" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
  });

  test("POST url attachment rejects javascript: protocol", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "javascript:alert('xss')" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("invalid characters or patterns");
  });

  test("POST url attachment rejects ftp: protocol", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "ftp://example.com/file" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("protocol must be http or https");
  });

  test("POST url attachment rejects file: protocol", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "file:///etc/passwd" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
  });

  test("POST url attachment rejects overly long URL (>2048)", async () => {
    const longUrl = "https://example.com/" + "x".repeat(2100);
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: longUrl },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("exceeds maximum length");
  });

  test("POST url attachment rejects malformed URL", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "not a valid url" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("not a valid URL format");
  });

  test("POST url attachment rejects missing url field", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { title: "No URL here" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("url field is required");
  });

  test("POST url attachment accepts valid title and description", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: {
          url: "https://example.com",
          title: "Example Site",
          description: "A sample website for testing",
        },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.attachment.value_json.title).toBe("Example Site");
    expect(data.attachment.value_json.description).toBe("A sample website for testing");
  });

  test("POST url attachment rejects title with <script> tag", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: {
          url: "https://example.com",
          title: "Malicious <script>alert('xss')</script>",
        },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("title");
    expect(data.error).toContain("invalid characters or patterns");
  });

  test("POST url attachment rejects description with HTML tags", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: {
          url: "https://example.com",
          description: "Evil <img src=x onerror=alert(1)>",
        },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("description");
  });

  test("POST url attachment rejects overly long title (>500)", async () => {
    const longTitle = "x".repeat(501);
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: {
          url: "https://example.com",
          title: longTitle,
        },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.error).toContain("title");
    expect(data.error).toContain("exceeds maximum length");
  });

  test("POST url attachment rejects control characters in description", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: {
          url: "https://example.com",
          description: "Bad\x00control\x01chars",
        },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
  });

  test("POST link attachment applies same validation as url", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "link",
        value_json: { url: "javascript:void(0)" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
  });

  test("POST unknown kind accepts arbitrary object (backwards compat)", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "custom-metadata",
        value_json: { foo: "bar", nested: { key: "value" } },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.attachment.kind).toBe("custom-metadata");
    expect(data.attachment.value_json.foo).toBe("bar");
  });

  test("POST data: URL with script is rejected", async () => {
    const req = createRequest(
      "POST",
      `/api/v1/topics/${topicId}/attachments`,
      {
        kind: "url",
        value_json: { url: "data:text/html,<script>alert('xss')</script>" },
      },
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
  });
});

describe("API v1 - Events", () => {
  let db: Database;
  let ctx: ApiV1Context;

  beforeEach(() => {
    db = createTestDb();
    ctx = createTestContext(db);
  });

  test("GET /api/v1/events returns empty list", async () => {
    const req = createRequest("GET", "/api/v1/events?after=0");
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.events).toEqual([]);
  });

  test("GET /api/v1/events returns events after creating entities", async () => {
    // Create channel (generates event)
    await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/channels",
        { name: "general" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Query events
    const req = createRequest("GET", "/api/v1/events?after=0&limit=10");
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(200);
    const data: any = await parseResponse(response);
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.events[0].name).toBe("channel.created");
  });
});

describe("API v1 - Input Validation", () => {
  let db: Database;
  let ctx: ApiV1Context;

  beforeEach(() => {
    db = createTestDb();
    ctx = createTestContext(db);
  });

  test("POST with invalid JSON returns 400", async () => {
    const req = new Request("http://localhost/api/v1/channels", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token-12345",
      },
      body: "{ invalid json",
    });
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(400);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
  });

  test("POST with wrong Content-Type returns 415", async () => {
    const req = new Request("http://localhost/api/v1/channels", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: "Bearer test-token-12345",
      },
      body: JSON.stringify({ name: "test" }),
    });
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(415);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("INVALID_INPUT");
  });

  test("POST with oversized body returns 413", async () => {
    const largeBody = { data: "x".repeat(100000) }; // >64KB
    const req = createRequest(
      "POST",
      "/api/v1/channels",
      largeBody,
      { Authorization: "Bearer test-token-12345" }
    );
    const response = await handleApiV1(req, ctx);

    expect(response.status).toBe(413);
    const data: any = await parseResponse(response);
    expect(data.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("Failure injection: API conflict scenarios", () => {
  let db: Database;
  let ctx: ApiV1Context;
  let channelId: string;
  let topicId: string;

  beforeEach(async () => {
    db = createTestDb();
    ctx = createTestContext(db);

    // Setup channel and topic
    const channelResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/channels",
        { name: "general" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const channelData: any = await parseResponse(channelResponse);
    channelId = channelData.channel.id;

    const topicResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/topics",
        { channel_id: channelId, title: "Test Topic" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const topicData: any = await parseResponse(topicResponse);
    topicId = topicData.topic.id;
  });

  test("edit conflict: stale version prevents state change and event insertion", async () => {
    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "Original content",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Edit to bump version to 2
    await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "edit",
          content_raw: "Updated content",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Get current state
    const messageBefore = db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as any;
    const eventsCountBefore = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    // Attempt edit with stale version
    const conflictResponse = await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "edit",
          content_raw: "Stale update",
          expected_version: 1, // Stale!
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Verify 409 conflict response
    expect(conflictResponse.status).toBe(409);
    const conflictData: any = await parseResponse(conflictResponse);
    expect(conflictData.code).toBe("VERSION_CONFLICT");
    expect(conflictData.details.current).toBe(2);

    // Verify message state unchanged
    const messageAfter = db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as any;
    expect(messageAfter.content_raw).toBe(messageBefore.content_raw);
    expect(messageAfter.version).toBe(messageBefore.version);
    expect(messageAfter.edited_at).toBe(messageBefore.edited_at);

    // Verify no new events inserted
    const eventsCountAfter = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;
    expect(eventsCountAfter.count).toBe(eventsCountBefore.count);
  });

  test("delete conflict: stale version prevents state change and event insertion", async () => {
    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "To be deleted",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Edit to bump version to 2
    await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "edit",
          content_raw: "Updated",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Get current state
    const messageBefore = db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as any;
    const eventsCountBefore = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    // Attempt delete with stale version
    const conflictResponse = await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "delete",
          actor: "agent-1",
          expected_version: 1, // Stale!
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Verify 409 conflict response
    expect(conflictResponse.status).toBe(409);
    const conflictData: any = await parseResponse(conflictResponse);
    expect(conflictData.code).toBe("VERSION_CONFLICT");

    // Verify message NOT deleted (state unchanged)
    const messageAfter = db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as any;
    expect(messageAfter.deleted_at).toBeNull();
    expect(messageAfter.deleted_by).toBeNull();
    expect(messageAfter.content_raw).toBe(messageBefore.content_raw);
    expect(messageAfter.version).toBe(messageBefore.version);

    // Verify no new events
    const eventsCountAfter = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;
    expect(eventsCountAfter.count).toBe(eventsCountBefore.count);
  });

  test("retopic conflict: stale version prevents state change and event insertion", async () => {
    // Create second topic
    const topic2Response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/topics",
        { channel_id: channelId, title: "Topic 2" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const topic2Data: any = await parseResponse(topic2Response);
    const topicId2 = topic2Data.topic.id;

    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "Message to move",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Edit to bump version to 2
    await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "edit",
          content_raw: "Updated",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Get current state
    const messageBefore = db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as any;
    const eventsCountBefore = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    // Attempt retopic with stale version
    const conflictResponse = await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "move_topic",
          to_topic_id: topicId2,
          mode: "one",
          expected_version: 1, // Stale!
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    // Verify 409 conflict response
    expect(conflictResponse.status).toBe(409);
    const conflictData: any = await parseResponse(conflictResponse);
    expect(conflictData.code).toBe("VERSION_CONFLICT");

    // Verify message NOT moved (still in original topic)
    const messageAfter = db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as any;
    expect(messageAfter.topic_id).toBe(messageBefore.topic_id);
    expect(messageAfter.version).toBe(messageBefore.version);

    // Verify no new events
    const eventsCountAfter = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;
    expect(eventsCountAfter.count).toBe(eventsCountBefore.count);
  });

  test("concurrent edit conflict: second edit fails without changing state", async () => {
    // Create message
    const createResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "Original",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const createData: any = await parseResponse(createResponse);
    const messageId = createData.message.id;

    // Simulate concurrent edits: both clients read version 1
    const edit1Response = await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "edit",
          content_raw: "Edit by client 1",
          expected_version: 1,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(edit1Response.status).toBe(200);
    const edit1Data: any = await parseResponse(edit1Response);
    expect(edit1Data.message.version).toBe(2);

    // Second client tries to edit with version 1 (should fail)
    const eventsCountBefore = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;

    const edit2Response = await handleApiV1(
      createRequest(
        "PATCH",
        `/api/v1/messages/${messageId}`,
        {
          op: "edit",
          content_raw: "Edit by client 2",
          expected_version: 1,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(edit2Response.status).toBe(409);

    // Verify client 1's edit persisted
    const messageAfter = db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as any;
    expect(messageAfter.content_raw).toBe("Edit by client 1");
    expect(messageAfter.version).toBe(2);

    // Verify only one edit event was created
    const eventsCountAfter = db
      .query("SELECT COUNT(*) as count FROM events")
      .get() as any;
    expect(eventsCountAfter.count).toBe(eventsCountBefore.count);
  });
});

describe("API v1 - Rate Limiting", () => {
  let db: Database;
  let ctx: ApiV1Context;

  beforeEach(() => {
    db = createTestDb();
    const rateLimiter = new HubRateLimiter(
      { limit: 10, windowMs: 1000 }, // Global: 10/s
      { limit: 5, windowMs: 1000 } // Per-client: 5/s
    );
    ctx = { ...createTestContext(db), rateLimiter };
  });

  test("Rate limiter enforces per-client limits", async () => {
    // Make 6 requests quickly (limit is 5)
    const requests = Array.from({ length: 6 }, () =>
      createRequest("GET", "/api/v1/channels")
    );

    const responses = [];
    for (const req of requests) {
      responses.push(await handleApiV1(req, ctx));
    }

    // First 5 requests should be allowed; 6th should be rate limited
    for (let i = 0; i < 5; i++) {
      expect(responses[i].status).toBe(200);
    }
    expect(responses[5].status).toBe(429);
    const data: any = await parseResponse(responses[5]);
    expect(data.code).toBe("RATE_LIMITED");
  });
});

describe("API v1 - URL Extraction", () => {
  let db: Database;
  let ctx: ApiV1Context;
  let channelId: string;
  let topicId: string;

  beforeEach(async () => {
    db = createTestDb();
    ctx = createTestContext(db);

    // Create channel
    const channelResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/channels",
        { name: "general" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const channelData: any = await parseResponse(channelResponse);
    channelId = channelData.channel.id;

    // Create topic
    const topicResponse = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/topics",
        { channel_id: channelId, title: "Links" },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );
    const topicData: any = await parseResponse(topicResponse);
    topicId = topicData.topic.id;
  });

  test("Message with URLs auto-creates attachments", async () => {
    const eventIds: number[] = [];
    ctx.onEventIds = (ids) => eventIds.push(...ids);

    const content = "Check out https://example.com and http://test.org/path";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);
    const data: any = await parseResponse(response);
    expect(data.message.content_raw).toBe(content);

    // Verify attachments were created
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ? ORDER BY id")
      .all(topicId) as any[];

    expect(attachments.length).toBe(2);
    
    // Extract URLs (order may vary)
    const urls = attachments.map((a: any) => JSON.parse(a.value_json).url).sort();
    expect(urls).toEqual(["http://test.org/path", "https://example.com"]);
    
    // Verify common properties
    expect(attachments[0].kind).toBe("url");
    expect(attachments[0].source_message_id).toBe(data.message.id);
    expect(attachments[1].kind).toBe("url");
    expect(attachments[1].source_message_id).toBe(data.message.id);

    // Verify events: message.created + 2x topic.attachment_added
    expect(eventIds.length).toBe(3);
    const events = db
      .query("SELECT * FROM events WHERE event_id IN (?, ?, ?) ORDER BY event_id")
      .all(...eventIds) as any[];

    expect(events[0].name).toBe("message.created");
    expect(events[1].name).toBe("topic.attachment_added");
    expect(events[2].name).toBe("topic.attachment_added");
  });

  test("Duplicate URLs in same topic do not create extra attachments", async () => {
    const eventIds: number[] = [];
    ctx.onEventIds = (ids) => eventIds.push(...ids);

    // First message with URL
    const response1 = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "See https://example.com",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response1.status).toBe(201);

    // Should have 2 events: message.created + attachment_added
    expect(eventIds.length).toBe(2);
    const firstMessageEventIds = [...eventIds];
    eventIds.length = 0;

    // Second message with same URL
    const response2 = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-2",
          content_raw: "Also check https://example.com",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response2.status).toBe(201);

    // Should only have 1 event: message.created (no duplicate attachment)
    expect(eventIds.length).toBe(1);
    const events = db
      .query("SELECT * FROM events WHERE event_id = ?")
      .all(eventIds[0]) as any[];
    expect(events[0].name).toBe("message.created");

    // Verify only one attachment exists
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all(topicId) as any[];
    expect(attachments.length).toBe(1);
    expect(JSON.parse(attachments[0].value_json).url).toBe("https://example.com");
  });

  test("URL extraction with blocklist", async () => {
    // Configure blocklist
    ctx.urlExtraction = {
      blocklist: [/blocked\.example\.com/],
    };

    const content = "See https://example.com and https://blocked.example.com";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    // Verify only allowed URL was created
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all(topicId) as any[];

    expect(attachments.length).toBe(1);
    expect(JSON.parse(attachments[0].value_json).url).toBe("https://example.com");
  });

  test("URL extraction with allowlist", async () => {
    // Configure allowlist
    ctx.urlExtraction = {
      allowlist: [/allowed\.example\.com/],
    };

    const content = "See https://allowed.example.com and https://other.com";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    // Verify only allowed URL was created
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all(topicId) as any[];

    expect(attachments.length).toBe(1);
    expect(JSON.parse(attachments[0].value_json).url).toBe("https://allowed.example.com");
  });

  test("Blocklist takes precedence over allowlist", async () => {
    ctx.urlExtraction = {
      allowlist: [/example\.com/],
      blocklist: [/blocked\.example\.com/],
    };

    const content = "See https://example.com and https://blocked.example.com";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all(topicId) as any[];

    expect(attachments.length).toBe(1);
    expect(JSON.parse(attachments[0].value_json).url).toBe("https://example.com");
  });

  test("Message without URLs creates no attachments", async () => {
    const eventIds: number[] = [];
    ctx.onEventIds = (ids) => eventIds.push(...ids);

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: "Just plain text, no links here",
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    // Verify no attachments created
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all(topicId) as any[];
    expect(attachments.length).toBe(0);

    // Only message.created event
    expect(eventIds.length).toBe(1);
  });

  test("URL extraction handles multiple URLs in same message", async () => {
    const content = "Links: https://a.com, https://b.com, https://c.com and https://a.com again";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    // Should dedupe within same message (a.com appears twice)
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ? ORDER BY created_at")
      .all(topicId) as any[];

    expect(attachments.length).toBe(3);
    const urls = attachments.map((a: any) => JSON.parse(a.value_json).url);
    expect(urls).toContain("https://a.com");
    expect(urls).toContain("https://b.com");
    expect(urls).toContain("https://c.com");
  });

  test("URL extraction ignores non-http(s) protocols", async () => {
    const content = "Links: https://safe.com, ftp://unsafe.com, javascript:alert(1), data:text/html,test";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    // Only http(s) URLs should be extracted
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all(topicId) as any[];

    expect(attachments.length).toBe(1);
    expect(JSON.parse(attachments[0].value_json).url).toBe("https://safe.com");
  });

  test("URL extraction handles URLs with query params and fragments", async () => {
    const content = "Check https://example.com/path?foo=bar&baz=qux#section";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all(topicId) as any[];

    expect(attachments.length).toBe(1);
    expect(JSON.parse(attachments[0].value_json).url).toBe("https://example.com/path?foo=bar&baz=qux#section");
  });

  test("URL extraction cleans trailing punctuation", async () => {
    const content = "See https://example.com. and https://test.org!";

    const response = await handleApiV1(
      createRequest(
        "POST",
        "/api/v1/messages",
        {
          topic_id: topicId,
          sender: "agent-1",
          content_raw: content,
        },
        { Authorization: "Bearer test-token-12345" }
      ),
      ctx
    );

    expect(response.status).toBe(201);

    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ? ORDER BY id")
      .all(topicId) as any[];

    expect(attachments.length).toBe(2);
    const urls = attachments.map((a: any) => JSON.parse(a.value_json).url).sort();
    expect(urls).toEqual(["https://example.com", "https://test.org"]);
  });
});
