/**
 * Tests for linkifierDerived.ts (bd-16d.4.5)
 * 
 * Coverage:
 * - Happy path: plugin executes, enrichments inserted, event emitted
 * - Staleness detection: message edited during plugin execution
 * - Plugin failure: timeout, invalid output, missing module
 * - Empty output: plugin returns empty array
 * - Multiple plugins: sequential execution, partial failures
 * - Deleted messages: skip processing
 * - Circuit breaker: plugin failures tracked
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { WorkspaceConfig } from "./config";
import { runLinkifierPluginsForMessage } from "./linkifierDerived";
import { getEventById, runMigrations, MIGRATIONS_DIR } from "@agentlip/kernel";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TestContext {
  db: Database;
  workspaceRoot: string;
  channelId: string;
  topicId: string;
}

async function setupTestContext(): Promise<TestContext> {
  // Create in-memory DB with schema
  const db = new Database(":memory:");
  
  // Run migrations to create schema
  runMigrations({ 
    db, 
    migrationsDir: MIGRATIONS_DIR,
    enableFts: false 
  });
  
  // Create temp workspace directory
  const workspaceRoot = await mkdtemp(join(tmpdir(), "linkifier-test-"));
  
  // Insert test channel and topic
  const channelId = "ch_test";
  const topicId = "topic_test";
  const now = new Date().toISOString();
  
  db.prepare("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)").run(
    channelId,
    "Test Channel",
    now
  );
  
  db.prepare(
    "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(topicId, channelId, "Test Topic", now, now);
  
  return { db, workspaceRoot, channelId, topicId };
}

async function teardownTestContext(ctx: TestContext): Promise<void> {
  ctx.db.close();
  await rm(ctx.workspaceRoot, { recursive: true, force: true });
}

function insertTestMessage(
  db: Database,
  options: {
    id: string;
    topicId: string;
    channelId: string;
    content: string;
    sender?: string;
  }
): string {
  const { id, topicId, channelId, content, sender = "test_user" } = options;
  const now = new Date().toISOString();
  
  db.prepare(`
    INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, topicId, channelId, sender, content, now);
  
  return id;
}

async function createTestPlugin(
  workspaceRoot: string,
  filename: string,
  pluginCode: string
): Promise<string> {
  const pluginPath = join(workspaceRoot, filename);
  await writeFile(pluginPath, pluginCode);
  return pluginPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Happy Path
// ─────────────────────────────────────────────────────────────────────────────

describe("linkifierDerived - Happy Path", () => {
  let ctx: TestContext;
  
  beforeEach(async () => {
    ctx = await setupTestContext();
  });
  
  afterEach(async () => {
    await teardownTestContext(ctx);
  });
  
  test("should execute plugin, insert enrichments, and emit event", async () => {
    // Create plugin that returns a single enrichment
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "test-linkifier.ts",
      `
        export default {
          name: "test-linkifier",
          version: "1.0.0",
          async enrich(input) {
            return [
              {
                kind: "url",
                span: { start: 0, end: 10 },
                data: { url: "https://example.com" }
              }
            ];
          }
        };
      `
    );
    
    // Insert test message
    const messageId = "msg_001";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Check out https://example.com",
    });
    
    // Run pipeline
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "test-linkifier",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    // Assertions
    expect(eventIds).toHaveLength(1);
    
    // Check enrichment row
    const enrichments = ctx.db
      .query<any, [string]>("SELECT * FROM enrichments WHERE message_id = ?")
      .all(messageId);
    
    expect(enrichments).toHaveLength(1);
    expect(enrichments[0].kind).toBe("url");
    expect(enrichments[0].span_start).toBe(0);
    expect(enrichments[0].span_end).toBe(10);
    expect(JSON.parse(enrichments[0].data_json)).toEqual({ url: "https://example.com" });
    
    // Check event
    const event = getEventById(ctx.db, eventIds[0]);
    expect(event).not.toBeNull();
    expect(event!.name).toBe("message.enriched");
    expect(event!.scope.channel_id).toBe(ctx.channelId);
    expect(event!.scope.topic_id).toBe(ctx.topicId);
    expect(event!.entity.type).toBe("message");
    expect(event!.entity.id).toBe(messageId);
    expect(event!.data.message_id).toBe(messageId);
    expect(event!.data.plugin_name).toBe("test-linkifier");
    expect(event!.data.enrichments).toHaveLength(1);
  });
  
  test("should handle multiple enrichments from single plugin", async () => {
    // Plugin returns multiple enrichments
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "multi-enrichment.ts",
      `
        export default {
          name: "multi-enrichment",
          version: "1.0.0",
          async enrich(input) {
            return [
              { kind: "url", span: { start: 0, end: 5 }, data: { url: "http://a.com" } },
              { kind: "url", span: { start: 10, end: 15 }, data: { url: "http://b.com" } },
            ];
          }
        };
      `
    );
    
    const messageId = "msg_002";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Multiple URLs",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "multi-enrichment",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(1);
    
    const enrichments = ctx.db
      .query<any, [string]>("SELECT * FROM enrichments WHERE message_id = ?")
      .all(messageId);
    
    expect(enrichments).toHaveLength(2);
  });
  
  test("should call onEventIds callback with emitted event IDs", async () => {
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "callback-test.ts",
      `
        export default {
          name: "callback-test",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "test", span: { start: 0, end: 1 }, data: {} }];
          }
        };
      `
    );
    
    const messageId = "msg_003";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "callback-test",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    let callbackEventIds: number[] = [];
    
    await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
      onEventIds: (ids) => {
        callbackEventIds = ids;
      },
    });
    
    expect(callbackEventIds).toHaveLength(1);
    expect(callbackEventIds[0]).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Staleness Detection
// ─────────────────────────────────────────────────────────────────────────────

describe("linkifierDerived - Staleness Detection", () => {
  let ctx: TestContext;
  
  beforeEach(async () => {
    ctx = await setupTestContext();
  });
  
  afterEach(async () => {
    await teardownTestContext(ctx);
  });
  
  test("should discard enrichments if message edited during plugin execution", async () => {
    // Plugin sleeps briefly to allow message edit
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "slow-plugin.ts",
      `
        export default {
          name: "slow-plugin",
          version: "1.0.0",
          async enrich(input) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return [{ kind: "slow", span: { start: 0, end: 1 }, data: {} }];
          }
        };
      `
    );
    
    const messageId = "msg_004";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Original content",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "slow-plugin",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    // Run pipeline in background
    const pipelinePromise = runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    // Edit message during plugin execution
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctx.db
      .prepare("UPDATE messages SET content_raw = ?, version = version + 1 WHERE id = ?")
      .run("Edited content", messageId);
    
    // Wait for pipeline to complete
    const eventIds = await pipelinePromise;
    
    // Should emit no events (staleness detected)
    expect(eventIds).toHaveLength(0);
    
    // Should have no enrichments
    const enrichments = ctx.db
      .query<any, [string]>("SELECT * FROM enrichments WHERE message_id = ?")
      .all(messageId);
    
    expect(enrichments).toHaveLength(0);
  });
  
  test("should discard enrichments if message deleted during plugin execution", async () => {
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "slow-plugin2.ts",
      `
        export default {
          name: "slow-plugin2",
          version: "1.0.0",
          async enrich(input) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return [{ kind: "slow", span: { start: 0, end: 1 }, data: {} }];
          }
        };
      `
    );
    
    const messageId = "msg_005";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Will be deleted",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "slow-plugin2",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const pipelinePromise = runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    // Tombstone delete during execution
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "UPDATE messages SET deleted_at = ?, deleted_by = ?, version = version + 1 WHERE id = ?"
      )
      .run(now, "test_user", messageId);
    
    const eventIds = await pipelinePromise;
    
    expect(eventIds).toHaveLength(0);
    
    const enrichments = ctx.db
      .query<any, [string]>("SELECT * FROM enrichments WHERE message_id = ?")
      .all(messageId);
    
    expect(enrichments).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Plugin Failures
// ─────────────────────────────────────────────────────────────────────────────

describe("linkifierDerived - Plugin Failures", () => {
  let ctx: TestContext;
  
  beforeEach(async () => {
    ctx = await setupTestContext();
  });
  
  afterEach(async () => {
    await teardownTestContext(ctx);
  });
  
  test("should skip plugin with missing module", async () => {
    const messageId = "msg_006";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "missing-plugin",
          type: "linkifier",
          enabled: true,
          module: "/nonexistent/plugin.ts",
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(0);
  });
  
  test("should skip plugin with invalid output", async () => {
    // Plugin returns invalid enrichment (missing required fields)
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "invalid-output.ts",
      `
        export default {
          name: "invalid-output",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "bad" }]; // Missing span
          }
        };
      `
    );
    
    const messageId = "msg_007";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "invalid-output",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(0);
  });
  
  test("should handle plugin timeout", async () => {
    // Plugin that exceeds timeout
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "timeout-plugin.ts",
      `
        export default {
          name: "timeout-plugin",
          version: "1.0.0",
          async enrich(input) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            return [];
          }
        };
      `
    );
    
    const messageId = "msg_008";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "timeout-plugin",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
      pluginDefaults: {
        timeout: 100, // Very short timeout
      },
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Multiple Plugins
// ─────────────────────────────────────────────────────────────────────────────

describe("linkifierDerived - Multiple Plugins", () => {
  let ctx: TestContext;
  
  beforeEach(async () => {
    ctx = await setupTestContext();
  });
  
  afterEach(async () => {
    await teardownTestContext(ctx);
  });
  
  test("should execute multiple plugins sequentially", async () => {
    const plugin1Path = await createTestPlugin(
      ctx.workspaceRoot,
      "plugin1.ts",
      `
        export default {
          name: "plugin1",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "p1", span: { start: 0, end: 1 }, data: { source: "plugin1" } }];
          }
        };
      `
    );
    
    const plugin2Path = await createTestPlugin(
      ctx.workspaceRoot,
      "plugin2.ts",
      `
        export default {
          name: "plugin2",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "p2", span: { start: 5, end: 10 }, data: { source: "plugin2" } }];
          }
        };
      `
    );
    
    const messageId = "msg_009";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Multi-plugin test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "plugin1",
          type: "linkifier",
          enabled: true,
          module: plugin1Path,
        },
        {
          name: "plugin2",
          type: "linkifier",
          enabled: true,
          module: plugin2Path,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    // Should emit 2 events (one per plugin)
    expect(eventIds).toHaveLength(2);
    
    // Should have 2 enrichments
    const enrichments = ctx.db
      .query<any, [string]>("SELECT * FROM enrichments WHERE message_id = ?")
      .all(messageId);
    
    expect(enrichments).toHaveLength(2);
    
    // Check that each event has correct plugin_name
    const event1 = getEventById(ctx.db, eventIds[0]);
    const event2 = getEventById(ctx.db, eventIds[1]);
    
    expect(event1!.data.plugin_name).toBe("plugin1");
    expect(event2!.data.plugin_name).toBe("plugin2");
  });
  
  test("should continue if one plugin fails", async () => {
    const workingPluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "working.ts",
      `
        export default {
          name: "working",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "ok", span: { start: 0, end: 1 }, data: {} }];
          }
        };
      `
    );
    
    const failingPluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "failing.ts",
      `
        export default {
          name: "failing",
          version: "1.0.0",
          async enrich(input) {
            throw new Error("Plugin error");
          }
        };
      `
    );
    
    const messageId = "msg_010";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Partial failure test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "failing",
          type: "linkifier",
          enabled: true,
          module: failingPluginPath,
        },
        {
          name: "working",
          type: "linkifier",
          enabled: true,
          module: workingPluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    // Should emit 1 event (from working plugin)
    expect(eventIds).toHaveLength(1);
    
    const enrichments = ctx.db
      .query<any, [string]>("SELECT * FROM enrichments WHERE message_id = ?")
      .all(messageId);
    
    expect(enrichments).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe("linkifierDerived - Edge Cases", () => {
  let ctx: TestContext;
  
  beforeEach(async () => {
    ctx = await setupTestContext();
  });
  
  afterEach(async () => {
    await teardownTestContext(ctx);
  });
  
  test("should skip deleted messages", async () => {
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "test.ts",
      `
        export default {
          name: "test",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "test", span: { start: 0, end: 1 }, data: {} }];
          }
        };
      `
    );
    
    const messageId = "msg_011";
    const now = new Date().toISOString();
    
    // Insert deleted message
    ctx.db
      .prepare(`
        INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at, deleted_at, deleted_by)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `)
      .run(messageId, ctx.topicId, ctx.channelId, "test_user", "Deleted", now, now, "test_user");
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "test",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(0);
  });
  
  test("should skip missing messages", async () => {
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "test.ts",
      `
        export default {
          name: "test",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "test", span: { start: 0, end: 1 }, data: {} }];
          }
        };
      `
    );
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "test",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId: "nonexistent",
    });
    
    expect(eventIds).toHaveLength(0);
  });
  
  test("should handle empty plugin output", async () => {
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "empty.ts",
      `
        export default {
          name: "empty",
          version: "1.0.0",
          async enrich(input) {
            return [];
          }
        };
      `
    );
    
    const messageId = "msg_012";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "empty",
          type: "linkifier",
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(0);
  });
  
  test("should skip disabled plugins", async () => {
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "disabled.ts",
      `
        export default {
          name: "disabled",
          version: "1.0.0",
          async enrich(input) {
            return [{ kind: "test", span: { start: 0, end: 1 }, data: {} }];
          }
        };
      `
    );
    
    const messageId = "msg_013";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "disabled",
          type: "linkifier",
          enabled: false, // Disabled!
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(0);
  });
  
  test("should skip extractor plugins", async () => {
    const pluginPath = await createTestPlugin(
      ctx.workspaceRoot,
      "extractor.ts",
      `
        export default {
          name: "extractor",
          version: "1.0.0",
          async extract(input) {
            return [{ kind: "attachment", key: "test", value_json: {} }];
          }
        };
      `
    );
    
    const messageId = "msg_014";
    insertTestMessage(ctx.db, {
      id: messageId,
      topicId: ctx.topicId,
      channelId: ctx.channelId,
      content: "Test",
    });
    
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "extractor",
          type: "extractor", // Not a linkifier!
          enabled: true,
          module: pluginPath,
        },
      ],
    };
    
    const eventIds = await runLinkifierPluginsForMessage({
      db: ctx.db,
      workspaceRoot: ctx.workspaceRoot,
      workspaceConfig: config,
      messageId,
    });
    
    expect(eventIds).toHaveLength(0);
  });
});
