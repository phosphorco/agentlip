/**
 * Tests for extractor plugin derived pipeline
 * 
 * Test coverage:
 * - Basic extraction: plugin runs, attachments inserted, events emitted
 * - Deduplication: second run with same dedupe_key does not emit duplicate events
 * - Staleness guard: discard results if message edited/deleted during processing
 * - Size limits: reject attachments exceeding 16KB
 * - Validation: reject malformed attachments
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, runMigrations } from "@agentchat/kernel";
import { runExtractorPluginsForMessage } from "./extractorDerived";
import type { WorkspaceConfig } from "./config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Test Setup Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let db: Database;

beforeEach(() => {
  // Create temp directory for test workspace
  tempDir = mkdtempSync(join(tmpdir(), "extractor-derived-test-"));

  // Setup in-memory database with schema
  db = openDb({ dbPath: ":memory:" });
  const migrationsDir = join(__dirname, "../../../migrations");
  runMigrations({ db, migrationsDir });
});

afterEach(() => {
  // Cleanup
  db.close();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function setupTestData() {
  // Insert channel
  db.run(
    "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
    ["chan_1", "test-channel", new Date().toISOString()]
  );

  // Insert topic
  db.run(
    "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [
      "topic_1",
      "chan_1",
      "test-topic",
      new Date().toISOString(),
      new Date().toISOString(),
    ]
  );

  // Insert message
  db.run(
    `
    INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    [
      "msg_1",
      "topic_1",
      "chan_1",
      "agent@local",
      "Check out https://example.com/article",
      1,
      new Date().toISOString(),
    ]
  );
}

function createSimpleExtractorPlugin(tempDir: string): void {
  const pluginCode = `
// Simple extractor plugin that returns one attachment
export default {
  name: "url-extractor",
  version: "1.0.0",
  async extract(input) {
    const { message } = input;
    
    // Extract URL from content
    const urlMatch = message.content_raw.match(/https?:\\/\\/[^\\s]+/);
    if (!urlMatch) return [];
    
    return [
      {
        kind: "url",
        key: urlMatch[0],
        value_json: {
          url: urlMatch[0],
          title: "Example Article",
          fetched_at: new Date().toISOString(),
        },
        dedupe_key: urlMatch[0], // Dedupe by URL
      }
    ];
  }
};
`;

  writeFileSync(join(tempDir, "url-extractor.ts"), pluginCode);
}

function createMultiAttachmentExtractor(tempDir: string): void {
  const pluginCode = `
// Extractor that returns multiple attachments
export default {
  name: "multi-extractor",
  version: "1.0.0",
  async extract(input) {
    const { message } = input;
    
    return [
      {
        kind: "sentiment",
        value_json: { score: 0.8, label: "positive" },
      },
      {
        kind: "language",
        value_json: { code: "en", confidence: 0.95 },
      }
    ];
  }
};
`;

  writeFileSync(join(tempDir, "multi-extractor.ts"), pluginCode);
}

function createOversizedAttachmentExtractor(tempDir: string): void {
  const pluginCode = `
// Extractor that returns attachment exceeding 16KB
export default {
  name: "oversized-extractor",
  version: "1.0.0",
  async extract(input) {
    const largeData = {};
    // Generate ~20KB of data
    for (let i = 0; i < 2000; i++) {
      largeData[\`field_\${i}\`] = "x".repeat(10);
    }
    
    return [
      {
        kind: "large",
        value_json: largeData,
      }
    ];
  }
};
`;

  writeFileSync(join(tempDir, "oversized-extractor.ts"), pluginCode);
}

function createInvalidAttachmentExtractor(tempDir: string): void {
  const pluginCode = `
// Extractor that returns invalid attachments
export default {
  name: "invalid-extractor",
  version: "1.0.0",
  async extract(input) {
    return [
      {
        // Missing kind
        value_json: { test: "data" },
      },
      {
        kind: "",  // Empty kind
        value_json: { test: "data" },
      },
      {
        kind: "test",
        value_json: null,  // Invalid value_json (null)
      },
      {
        kind: "test",
        value_json: ["array"],  // Invalid value_json (array)
      }
    ];
  }
};
`;

  writeFileSync(join(tempDir, "invalid-extractor.ts"), pluginCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runExtractorPluginsForMessage", () => {
  test("returns null if message doesn't exist", async () => {
    const config: WorkspaceConfig = {
      plugins: [],
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "nonexistent",
    });

    expect(result).toBeNull();
  });

  test("returns null if message is tombstoned", async () => {
    setupTestData();

    // Tombstone the message
    db.run(
      "UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?",
      [new Date().toISOString(), "test", "msg_1"]
    );

    const config: WorkspaceConfig = {
      plugins: [],
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result).toBeNull();
  });

  test("returns empty result if no extractor plugins configured", async () => {
    setupTestData();

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "linkifier",
          type: "linkifier",
          enabled: true,
        },
      ],
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result).toEqual({
      pluginsExecuted: 0,
      attachmentsInserted: 0,
      attachmentsDeduplicated: 0,
      pluginsFailed: 0,
      eventIds: [],
    });
  });

  test("extracts and inserts attachments from plugin", async () => {
    setupTestData();
    createSimpleExtractorPlugin(tempDir);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "url-extractor",
          type: "extractor",
          enabled: true,
          module: "url-extractor.ts",
        },
      ],
    };

    const eventIds: number[] = [];
    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
      onEventIds: (ids) => eventIds.push(...ids),
    });

    expect(result).not.toBeNull();
    expect(result!.pluginsExecuted).toBe(1);
    expect(result!.attachmentsInserted).toBe(1);
    expect(result!.attachmentsDeduplicated).toBe(0);
    expect(result!.pluginsFailed).toBe(0);
    expect(result!.eventIds.length).toBe(1);
    expect(eventIds.length).toBe(1);

    // Verify attachment in database
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all("topic_1");
    expect(attachments.length).toBe(1);

    const attachment = attachments[0] as any;
    expect(attachment.kind).toBe("url");
    expect(attachment.key).toBe("https://example.com/article");
    expect(attachment.source_message_id).toBe("msg_1");
    expect(attachment.dedupe_key).toBe("https://example.com/article");

    const valueJson = JSON.parse(attachment.value_json);
    expect(valueJson.url).toBe("https://example.com/article");
    expect(valueJson.title).toBe("Example Article");

    // Verify event emitted
    const events = db.query("SELECT * FROM events WHERE event_id = ?").all(result!.eventIds[0]);
    expect(events.length).toBe(1);

    const event = events[0] as any;
    expect(event.name).toBe("topic.attachment_added");
    expect(event.scope_channel_id).toBe("chan_1");
    expect(event.scope_topic_id).toBe("topic_1");
    expect(event.entity_type).toBe("attachment");
  });

  test("deduplicates attachments on second run (no duplicate events)", async () => {
    setupTestData();
    createSimpleExtractorPlugin(tempDir);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "url-extractor",
          type: "extractor",
          enabled: true,
          module: "url-extractor.ts",
        },
      ],
    };

    // First run
    const result1 = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result1!.attachmentsInserted).toBe(1);
    expect(result1!.attachmentsDeduplicated).toBe(0);
    expect(result1!.eventIds.length).toBe(1);

    // Second run (should deduplicate)
    const result2 = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result2!.attachmentsInserted).toBe(0);
    expect(result2!.attachmentsDeduplicated).toBe(1);
    expect(result2!.eventIds.length).toBe(0);

    // Verify only one attachment in database
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all("topic_1");
    expect(attachments.length).toBe(1);

    // Verify only one event emitted
    const events = db
      .query("SELECT * FROM events WHERE name = ?")
      .all("topic.attachment_added");
    expect(events.length).toBe(1);
  });

  test("handles multiple attachments from single plugin", async () => {
    setupTestData();
    createMultiAttachmentExtractor(tempDir);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "multi-extractor",
          type: "extractor",
          enabled: true,
          module: "multi-extractor.ts",
        },
      ],
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result!.attachmentsInserted).toBe(2);
    expect(result!.eventIds.length).toBe(2);

    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ? ORDER BY kind")
      .all("topic_1");
    expect(attachments.length).toBe(2);

    const kinds = attachments.map((a: any) => a.kind);
    expect(kinds).toEqual(["language", "sentiment"]);
  });

  test("discards results if message edited during processing", async () => {
    setupTestData();

    // Create plugin that simulates slow processing
    const pluginCode = `
export default {
  name: "slow-extractor",
  version: "1.0.0",
  async extract(input) {
    // Simulate slow processing (give time for message edit)
    await new Promise(resolve => setTimeout(resolve, 50));
    
    return [
      {
        kind: "test",
        value_json: { processed: true },
      }
    ];
  }
};
`;
    writeFileSync(join(tempDir, "slow-extractor.ts"), pluginCode);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "slow-extractor",
          type: "extractor",
          enabled: true,
          module: "slow-extractor.ts",
        },
      ],
    };

    // Start extraction in background
    const extractionPromise = runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    // Edit message while plugin is processing
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.run(
      "UPDATE messages SET content_raw = ?, version = version + 1 WHERE id = ?",
      ["Updated content", "msg_1"]
    );

    // Wait for extraction to complete
    const result = await extractionPromise;

    // Result should be null (stale)
    expect(result).toBeNull();

    // Verify no attachments inserted
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all("topic_1");
    expect(attachments.length).toBe(0);

    // Verify no events emitted
    const events = db
      .query("SELECT * FROM events WHERE name = ?")
      .all("topic.attachment_added");
    expect(events.length).toBe(0);
  });

  test("discards results if message deleted during processing", async () => {
    setupTestData();

    // Create plugin that simulates slow processing
    const pluginCode = `
export default {
  name: "slow-extractor",
  version: "1.0.0",
  async extract(input) {
    await new Promise(resolve => setTimeout(resolve, 50));
    
    return [
      {
        kind: "test",
        value_json: { processed: true },
      }
    ];
  }
};
`;
    writeFileSync(join(tempDir, "slow-extractor.ts"), pluginCode);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "slow-extractor",
          type: "extractor",
          enabled: true,
          module: "slow-extractor.ts",
        },
      ],
    };

    // Start extraction in background
    const extractionPromise = runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    // Delete message while plugin is processing
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.run(
      "UPDATE messages SET deleted_at = ?, deleted_by = ?, version = version + 1 WHERE id = ?",
      [new Date().toISOString(), "test", "msg_1"]
    );

    // Wait for extraction to complete
    const result = await extractionPromise;

    // Result should be null (stale)
    expect(result).toBeNull();

    // Verify no attachments inserted
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all("topic_1");
    expect(attachments.length).toBe(0);
  });

  test("rejects attachments exceeding 16KB size limit", async () => {
    setupTestData();
    createOversizedAttachmentExtractor(tempDir);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "oversized-extractor",
          type: "extractor",
          enabled: true,
          module: "oversized-extractor.ts",
        },
      ],
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result!.attachmentsInserted).toBe(0);
    expect(result!.eventIds.length).toBe(0);

    // Verify no attachments inserted
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all("topic_1");
    expect(attachments.length).toBe(0);
  });

  test("rejects invalid attachments (validation)", async () => {
    setupTestData();
    createInvalidAttachmentExtractor(tempDir);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "invalid-extractor",
          type: "extractor",
          enabled: true,
          module: "invalid-extractor.ts",
        },
      ],
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result!.attachmentsInserted).toBe(0);
    expect(result!.eventIds.length).toBe(0);

    // Verify no attachments inserted
    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all("topic_1");
    expect(attachments.length).toBe(0);
  });

  test("uses default dedupe_key if not provided", async () => {
    setupTestData();

    // Plugin that doesn't provide dedupe_key
    const pluginCode = `
export default {
  name: "default-dedupe",
  version: "1.0.0",
  async extract(input) {
    return [
      {
        kind: "sentiment",
        value_json: { score: 0.8, label: "positive" },
        // No dedupe_key - should use JSON.stringify(value_json)
      }
    ];
  }
};
`;
    writeFileSync(join(tempDir, "default-dedupe.ts"), pluginCode);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "default-dedupe",
          type: "extractor",
          enabled: true,
          module: "default-dedupe.ts",
        },
      ],
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result!.attachmentsInserted).toBe(1);

    const attachments = db
      .query("SELECT * FROM topic_attachments WHERE topic_id = ?")
      .all("topic_1");
    expect(attachments.length).toBe(1);

    const attachment = attachments[0] as any;
    const expectedDedupeKey = JSON.stringify({
      score: 0.8,
      label: "positive",
    });
    expect(attachment.dedupe_key).toBe(expectedDedupeKey);
  });

  test("respects plugin timeout from config", async () => {
    setupTestData();

    // Create plugin that times out
    const pluginCode = `
export default {
  name: "timeout-extractor",
  version: "1.0.0",
  async extract(input) {
    await new Promise(resolve => setTimeout(resolve, 10000)); // 10s
    return [];
  }
};
`;
    writeFileSync(join(tempDir, "timeout-extractor.ts"), pluginCode);

    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "timeout-extractor",
          type: "extractor",
          enabled: true,
          module: "timeout-extractor.ts",
        },
      ],
      pluginDefaults: {
        timeout: 100, // 100ms timeout
      },
    };

    const result = await runExtractorPluginsForMessage({
      db,
      workspaceRoot: tempDir,
      workspaceConfig: config,
      messageId: "msg_1",
    });

    expect(result!.pluginsExecuted).toBe(1);
    expect(result!.pluginsFailed).toBe(1);
    expect(result!.attachmentsInserted).toBe(0);
  });
});
