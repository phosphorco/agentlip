/**
 * Plugin + Derived Data Edge Case Test Suite
 * 
 * Implements bd-16d.6.9: comprehensive edge-case testing for plugin-driven
 * derived pipelines (linkifierDerived + extractorDerived).
 * 
 * Coverage:
 * 1. ABA problem: content changes back to original, version differs → staleness guard works
 * 2. Concurrent plugins: linkifier + extractor running simultaneously without deadlock
 * 3. Timeout at derived layer: hanging plugin produces no derived rows/events
 * 4. Restart mid-plugin: DB state remains consistent (no partial commits)
 * 5. Deduplication: concurrent extractor runs don't emit duplicate events
 * 
 * Test strategy:
 * - Use real Worker-based plugins (not mocks) for authentic behavior
 * - File-backed DB (not in-memory) for restart simulation
 * - Polling with timeouts for deterministic async verification
 * - Explicit transaction boundaries to test atomicity
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDb } from "@agentlip/kernel";
import type { Database } from "bun:sqlite";
import { createTempWorkspace } from "./integrationHarness";
import { runLinkifierPluginsForMessage } from "./linkifierDerived";
import { runExtractorPluginsForMessage } from "./extractorDerived";
import type { WorkspaceConfig } from "./config";
import { globalCircuitBreaker } from "./pluginRuntime";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sleep helper for polling loops
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Insert a test message and return its ID
 */
function insertTestMessage(
  db: Database,
  options: {
    topicId: string;
    channelId: string;
    sender: string;
    contentRaw: string;
  }
): string {
  const { topicId, channelId, sender, contentRaw } = options;
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at, edited_at, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL)`,
    [messageId, topicId, channelId, sender, contentRaw, now]
  );

  return messageId;
}

/**
 * Update message content and increment version
 */
function updateMessageContent(
  db: Database,
  messageId: string,
  newContent: string
): void {
  const now = new Date().toISOString();

  db.run(
    `UPDATE messages 
     SET content_raw = ?, version = version + 1, edited_at = ?
     WHERE id = ?`,
    [newContent, now, messageId]
  );
}

/**
 * Get current message version
 */
function getMessageVersion(db: Database, messageId: string): number {
  const row = db
    .query<{ version: number }, [string]>("SELECT version FROM messages WHERE id = ?")
    .get(messageId);
  return row?.version ?? 0;
}

/**
 * Count enrichments for a message
 */
function countEnrichments(db: Database, messageId: string): number {
  const row = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM enrichments WHERE message_id = ?"
    )
    .get(messageId);
  return row?.count ?? 0;
}

/**
 * Count attachments for a message
 */
function countAttachments(db: Database, messageId: string): number {
  const row = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM topic_attachments WHERE source_message_id = ?"
    )
    .get(messageId);
  return row?.count ?? 0;
}

/**
 * Count events of a specific type related to a message
 */
function countEventsForMessage(
  db: Database,
  eventName: string,
  messageId: string
): number {
  const row = db
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) as count FROM events 
       WHERE name = ? AND json_extract(data_json, '$.message_id') = ?`
    )
    .get(eventName, messageId);
  return row?.count ?? 0;
}

/**
 * Create test workspace with channel + topic
 */
async function setupTestWorkspace(): Promise<{
  ws: Awaited<ReturnType<typeof createTempWorkspace>>;
  db: Database;
  channelId: string;
  topicId: string;
  config: WorkspaceConfig;
  pluginDir: string;
}> {
  const ws = await createTempWorkspace();
  const db = openDb({ dbPath: ws.dbPath });

  // Create channel
  const channelId = `ch_${Date.now()}`;
  db.run(
    `INSERT INTO channels (id, name, description, created_at) VALUES (?, 'test', '', ?)`,
    [channelId, new Date().toISOString()]
  );

  // Create topic
  const topicId = `top_${Date.now()}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, 'test-topic', ?, ?)`,
    [topicId, channelId, now, now]
  );

  // Setup plugin directory
  const pluginDir = join(ws.root, "plugins");
  await mkdir(pluginDir, { recursive: true });

  // Default empty config
  const config: WorkspaceConfig = {
    pluginDefaults: { timeout: 2000 },
    plugins: [],
  };

  return { ws, db, channelId, topicId, config, pluginDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge Case 1: ABA Problem
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin derived edge cases", () => {
  beforeEach(() => {
    // Reset circuit breaker between tests
    globalCircuitBreaker.reset();
  });

  test("ABA: content changes back to original but version differs → staleness guard discards", async () => {
    const { ws, db, channelId, topicId, config, pluginDir } = await setupTestWorkspace();

    try {
      // Create slow linkifier plugin (delays to allow ABA sequence)
      const linkifierPath = join(pluginDir, "slow-linkifier.ts");
      await writeFile(
        linkifierPath,
        `export default {
  name: "slow-linkifier",
  version: "1.0.0",
  async enrich(input) {
    // Simulate slow processing
    await new Promise(resolve => setTimeout(resolve, 500));
    return [{ kind: "test", span: { start: 0, end: 5 }, data: { marker: "slow" } }];
  }
};`,
        "utf-8"
      );

      config.plugins = [
        {
          name: "slow-linkifier",
          type: "linkifier",
          enabled: true,
          module: "./plugins/slow-linkifier.ts",
          config: {},
        },
      ];

      // Original content
      const originalContent = "hello";
      const messageId = insertTestMessage(db, {
        topicId,
        channelId,
        sender: "alice",
        contentRaw: originalContent,
      });

      const originalVersion = getMessageVersion(db, messageId);
      expect(originalVersion).toBe(1);

      // Start plugin execution (doesn't await immediately)
      const pluginPromise = runLinkifierPluginsForMessage({
        db,
        workspaceRoot: ws.root,
        workspaceConfig: config,
        messageId,
      });

      // While plugin is running, perform ABA sequence:
      // 1. Edit to different content (version → 2)
      await sleep(100); // Give plugin time to read original snapshot
      updateMessageContent(db, messageId, "changed");
      expect(getMessageVersion(db, messageId)).toBe(2);

      // 2. Edit back to original content (version → 3, but content matches original)
      await sleep(100);
      updateMessageContent(db, messageId, originalContent);
      expect(getMessageVersion(db, messageId)).toBe(3);

      // Now content_raw matches original, but version changed: 1 → 3
      const row = db
        .query<{ content_raw: string; version: number }, [string]>(
          "SELECT content_raw, version FROM messages WHERE id = ?"
        )
        .get(messageId);
      expect(row?.content_raw).toBe(originalContent);
      expect(row?.version).toBe(3);

      // Wait for plugin to complete
      await pluginPromise;

      // Verify staleness guard discarded the results (version mismatch)
      const enrichmentCount = countEnrichments(db, messageId);
      const eventCount = countEventsForMessage(db, "message.enriched", messageId);

      expect(enrichmentCount).toBe(0); // No enrichments committed
      expect(eventCount).toBe(0); // No events emitted
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case 2: Concurrent Plugins
  // ─────────────────────────────────────────────────────────────────────────────

  test("Concurrent plugins: linkifier + extractor run simultaneously without deadlock", async () => {
    const { ws, db, channelId, topicId, config, pluginDir } = await setupTestWorkspace();

    try {
      // Create linkifier plugin
      const linkifierPath = join(pluginDir, "linkifier.ts");
      await writeFile(
        linkifierPath,
        `export default {
  name: "test-linkifier",
  version: "1.0.0",
  async enrich(input) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return [{ kind: "link", span: { start: 0, end: 5 }, data: { url: "http://example.com" } }];
  }
};`,
        "utf-8"
      );

      // Create extractor plugin
      const extractorPath = join(pluginDir, "extractor.ts");
      await writeFile(
        extractorPath,
        `export default {
  name: "test-extractor",
  version: "1.0.0",
  async extract(input) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return [{ kind: "tag", value_json: { tag: "urgent" }, dedupe_key: "tag:urgent" }];
  }
};`,
        "utf-8"
      );

      config.plugins = [
        {
          name: "test-linkifier",
          type: "linkifier",
          enabled: true,
          module: "./plugins/linkifier.ts",
          config: {},
        },
        {
          name: "test-extractor",
          type: "extractor",
          enabled: true,
          module: "./plugins/extractor.ts",
          config: {},
        },
      ];

      const messageId = insertTestMessage(db, {
        topicId,
        channelId,
        sender: "bob",
        contentRaw: "hello world",
      });

      // Run both pipelines concurrently
      const [linkifierEventIds, extractorResult] = await Promise.all([
        runLinkifierPluginsForMessage({
          db,
          workspaceRoot: ws.root,
          workspaceConfig: config,
          messageId,
        }),
        runExtractorPluginsForMessage({
          db,
          workspaceRoot: ws.root,
          workspaceConfig: config,
          messageId,
        }),
      ]);

      // Verify both succeeded
      expect(linkifierEventIds.length).toBeGreaterThan(0);
      expect(extractorResult).not.toBeNull();
      expect(extractorResult!.attachmentsInserted).toBe(1);

      // Verify derived outputs committed
      expect(countEnrichments(db, messageId)).toBe(1);
      expect(countAttachments(db, messageId)).toBe(1);

      // Verify events emitted
      expect(countEventsForMessage(db, "message.enriched", messageId)).toBe(1);
      expect(
        db
          .query<{ count: number }, [string, string]>(
            `SELECT COUNT(*) as count FROM events 
             WHERE name = ? AND json_extract(data_json, '$.attachment.source_message_id') = ?`
          )
          .get("topic.attachment_added", messageId)?.count ?? 0
      ).toBe(1);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case 3: Timeout at Derived Layer
  // ─────────────────────────────────────────────────────────────────────────────

  test("Timeout: hanging plugin produces no derived rows or events", async () => {
    const { ws, db, channelId, topicId, config, pluginDir } = await setupTestWorkspace();

    try {
      // Create hanging linkifier plugin (never resolves)
      const linkifierPath = join(pluginDir, "hanging-linkifier.ts");
      await writeFile(
        linkifierPath,
        `export default {
  name: "hanging-linkifier",
  version: "1.0.0",
  async enrich(input) {
    // Hang indefinitely
    await new Promise(() => {});
    return [];
  }
};`,
        "utf-8"
      );

      config.plugins = [
        {
          name: "hanging-linkifier",
          type: "linkifier",
          enabled: true,
          module: "./plugins/hanging-linkifier.ts",
          config: {},
        },
      ];

      // Set short timeout
      config.pluginDefaults = { timeout: 500 };

      const messageId = insertTestMessage(db, {
        topicId,
        channelId,
        sender: "carol",
        contentRaw: "test timeout",
      });

      // Run plugin (should timeout)
      const eventIds = await runLinkifierPluginsForMessage({
        db,
        workspaceRoot: ws.root,
        workspaceConfig: config,
        messageId,
      });

      // Verify no outputs committed
      expect(eventIds.length).toBe(0);
      expect(countEnrichments(db, messageId)).toBe(0);
      expect(countEventsForMessage(db, "message.enriched", messageId)).toBe(0);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case 4: Restart Mid-Plugin (DB Consistency)
  // ─────────────────────────────────────────────────────────────────────────────

  test("Restart simulation: DB closed before commit → no partial derived inserts", async () => {
    const { ws, db, channelId, topicId, config, pluginDir } = await setupTestWorkspace();

    try {
      // Create slow extractor plugin
      const extractorPath = join(pluginDir, "slow-extractor.ts");
      await writeFile(
        extractorPath,
        `export default {
  name: "slow-extractor",
  version: "1.0.0",
  async extract(input) {
    await new Promise(resolve => setTimeout(resolve, 300));
    return [{ kind: "metadata", value_json: { key: "value" }, dedupe_key: "meta:1" }];
  }
};`,
        "utf-8"
      );

      config.plugins = [
        {
          name: "slow-extractor",
          type: "extractor",
          enabled: true,
          module: "./plugins/slow-extractor.ts",
          config: {},
        },
      ];

      const messageId = insertTestMessage(db, {
        topicId,
        channelId,
        sender: "dave",
        contentRaw: "test restart",
      });

      // Start plugin execution
      const pluginPromise = runExtractorPluginsForMessage({
        db,
        workspaceRoot: ws.root,
        workspaceConfig: config,
        messageId,
      });

      // Simulate abrupt shutdown: close DB while plugin is running
      await sleep(100); // Let plugin start processing
      db.close();

      // Wait for plugin to complete (will fail to commit)
      try {
        await pluginPromise;
      } catch {
        // Expected: DB closed error
      }

      // Reopen DB and verify no partial state
      const db2 = openDb({ dbPath: ws.dbPath });
      try {
        const attachmentCount = countAttachments(db2, messageId);
        const eventCount = db2
          .query<{ count: number }, [string, string]>(
            `SELECT COUNT(*) as count FROM events 
             WHERE name = ? AND json_extract(data_json, '$.attachment.source_message_id') = ?`
          )
          .get("topic.attachment_added", messageId)?.count ?? 0;

        expect(attachmentCount).toBe(0); // No attachments committed
        expect(eventCount).toBe(0); // No events emitted
      } finally {
        db2.close();
      }
    } finally {
      // DB already closed in test
      await ws.cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case 5: Deduplication (Concurrent Extractor Runs)
  // ─────────────────────────────────────────────────────────────────────────────

  test("Deduplication: concurrent extractor runs with same dedupe_key → only one attachment", async () => {
    const { ws, db, channelId, topicId, config, pluginDir } = await setupTestWorkspace();

    try {
      // Create extractor plugin that produces same dedupe_key
      const extractorPath = join(pluginDir, "deduping-extractor.ts");
      await writeFile(
        extractorPath,
        `export default {
  name: "deduping-extractor",
  version: "1.0.0",
  async extract(input) {
    await new Promise(resolve => setTimeout(resolve, 50));
    return [{ kind: "tag", value_json: { tag: "duplicate" }, dedupe_key: "tag:duplicate" }];
  }
};`,
        "utf-8"
      );

      config.plugins = [
        {
          name: "deduping-extractor",
          type: "extractor",
          enabled: true,
          module: "./plugins/deduping-extractor.ts",
          config: {},
        },
      ];

      const messageId = insertTestMessage(db, {
        topicId,
        channelId,
        sender: "eve",
        contentRaw: "test dedupe",
      });

      // Run extractor twice concurrently (simulating race condition or retry)
      const [result1, result2] = await Promise.all([
        runExtractorPluginsForMessage({
          db,
          workspaceRoot: ws.root,
          workspaceConfig: config,
          messageId,
        }),
        runExtractorPluginsForMessage({
          db,
          workspaceRoot: ws.root,
          workspaceConfig: config,
          messageId,
        }),
      ]);

      // Verify exactly one attachment inserted (idempotency)
      const attachmentCount = countAttachments(db, messageId);
      expect(attachmentCount).toBe(1);

      // Verify deduplication stats
      const totalInserted = (result1?.attachmentsInserted ?? 0) + (result2?.attachmentsInserted ?? 0);
      const totalDeduplicated =
        (result1?.attachmentsDeduplicated ?? 0) + (result2?.attachmentsDeduplicated ?? 0);

      expect(totalInserted).toBe(1); // One successful insert
      expect(totalDeduplicated).toBe(1); // One deduped

      // Verify only one event emitted
      const eventCount = db
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) as count FROM events 
           WHERE name = ? AND json_extract(data_json, '$.attachment.source_message_id') = ?`
        )
        .get("topic.attachment_added", messageId)?.count ?? 0;

      expect(eventCount).toBe(1); // Only one event for the first insert
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case 6: Content Change During Plugin Execution
  // ─────────────────────────────────────────────────────────────────────────────

  test("Content change during execution: staleness guard prevents commit", async () => {
    const { ws, db, channelId, topicId, config, pluginDir } = await setupTestWorkspace();

    try {
      // Create slow linkifier
      const linkifierPath = join(pluginDir, "slow-linkifier.ts");
      await writeFile(
        linkifierPath,
        `export default {
  name: "slow-linkifier",
  version: "1.0.0",
  async enrich(input) {
    await new Promise(resolve => setTimeout(resolve, 400));
    return [{ kind: "test", span: { start: 0, end: 4 }, data: { marker: "old" } }];
  }
};`,
        "utf-8"
      );

      config.plugins = [
        {
          name: "slow-linkifier",
          type: "linkifier",
          enabled: true,
          module: "./plugins/slow-linkifier.ts",
          config: {},
        },
      ];

      const messageId = insertTestMessage(db, {
        topicId,
        channelId,
        sender: "frank",
        contentRaw: "original",
      });

      // Start plugin
      const pluginPromise = runLinkifierPluginsForMessage({
        db,
        workspaceRoot: ws.root,
        workspaceConfig: config,
        messageId,
      });

      // Edit message while plugin is running
      await sleep(150);
      updateMessageContent(db, messageId, "edited content");

      // Wait for plugin to complete
      await pluginPromise;

      // Verify staleness guard discarded results
      expect(countEnrichments(db, messageId)).toBe(0);
      expect(countEventsForMessage(db, "message.enriched", messageId)).toBe(0);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Case 7: Message Deleted During Plugin Execution
  // ─────────────────────────────────────────────────────────────────────────────

  test("Message deleted during execution: staleness guard prevents commit", async () => {
    const { ws, db, channelId, topicId, config, pluginDir } = await setupTestWorkspace();

    try {
      // Create slow extractor
      const extractorPath = join(pluginDir, "slow-extractor.ts");
      await writeFile(
        extractorPath,
        `export default {
  name: "slow-extractor",
  version: "1.0.0",
  async extract(input) {
    await new Promise(resolve => setTimeout(resolve, 400));
    return [{ kind: "note", value_json: { note: "test" }, dedupe_key: "note:test" }];
  }
};`,
        "utf-8"
      );

      config.plugins = [
        {
          name: "slow-extractor",
          type: "extractor",
          enabled: true,
          module: "./plugins/slow-extractor.ts",
          config: {},
        },
      ];

      const messageId = insertTestMessage(db, {
        topicId,
        channelId,
        sender: "grace",
        contentRaw: "to be deleted",
      });

      // Start plugin
      const pluginPromise = runExtractorPluginsForMessage({
        db,
        workspaceRoot: ws.root,
        workspaceConfig: config,
        messageId,
      });

      // Delete message while plugin is running
      await sleep(150);
      const now = new Date().toISOString();
      db.run(
        `UPDATE messages SET deleted_at = ?, deleted_by = 'admin' WHERE id = ?`,
        [now, messageId]
      );

      // Wait for plugin to complete
      const result = await pluginPromise;

      // Verify staleness guard detected deletion
      expect(result).toBeNull(); // runExtractorPluginsForMessage returns null for stale/deleted messages
      expect(countAttachments(db, messageId)).toBe(0);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });
});
