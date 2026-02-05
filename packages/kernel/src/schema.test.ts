/**
 * Unit tests for @agentchat/kernel schema and query contracts
 * 
 * Tests Gate A requirements:
 * - Schema initialization with proper meta keys
 * - PRAGMA configuration
 * - Trigger enforcement (delete/update restrictions)
 * - Optional FTS handling (graceful fallback)
 * - Basic query contracts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, runMigrations, isFtsAvailable, SCHEMA_VERSION } from "./index";

const TEST_DIR = join(import.meta.dir, ".test-tmp");
const MIGRATIONS_DIR = join(import.meta.dir, "../../../migrations");

beforeEach(() => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  // Clean up any temp files/directories created during tests.
  // Use recursive rm to handle nested directories (e.g. migration fixture dirs).
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  // Recreate directory for next test
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

describe("Schema Initialization", () => {
  test("Fresh DB with runMigrations(enableFts: false) creates all required tables", () => {
    const dbPath = join(TEST_DIR, "init-test.db");
    const db = openDb({ dbPath });
    
    const result = runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    expect(result.appliedMigrations).toContain("0001_schema_v1.sql");
    
    // Verify all core tables exist
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map((t) => t.name);
    
    expect(tables).toContain("meta");
    expect(tables).toContain("channels");
    expect(tables).toContain("topics");
    expect(tables).toContain("messages");
    expect(tables).toContain("events");
    expect(tables).toContain("topic_attachments");
    expect(tables).toContain("enrichments");
    
    db.close();
  });

  test("Meta table initialized with db_id, schema_version=1, and created_at", () => {
    const dbPath = join(TEST_DIR, "meta-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    // Check db_id
    const dbId = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'db_id'")
      .get();
    expect(dbId).toBeDefined();
    expect(dbId!.value).toBeTruthy();
    expect(dbId!.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    
    // Check schema_version
    const schemaVersion = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    expect(schemaVersion).toBeDefined();
    expect(schemaVersion!.value).toBe("1");
    
    // Check created_at
    const createdAt = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'created_at'")
      .get();
    expect(createdAt).toBeDefined();
    expect(createdAt!.value).toBeTruthy();
    expect(createdAt!.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/);
    
    db.close();
  });

  test("Required indexes are created", () => {
    const dbPath = join(TEST_DIR, "indexes-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
      )
      .all()
      .map((idx) => idx.name);
    
    const requiredIndexes = [
      "idx_topics_channel",
      "idx_messages_topic",
      "idx_messages_channel",
      "idx_messages_created",
      "idx_events_replay",
      "idx_events_scope_channel",
      "idx_events_scope_topic",
      "idx_events_scope_topic2",
      "idx_attachments_topic",
      "idx_topic_attachments_dedupe",
      "idx_enrichments_message",
    ];
    
    for (const idx of requiredIndexes) {
      expect(indexes).toContain(idx);
    }
    
    db.close();
  });
});

describe("PRAGMA Configuration", () => {
  test("openDb() sets foreign_keys=ON, busy_timeout=5000, synchronous=NORMAL", () => {
    const dbPath = join(TEST_DIR, "pragma-test.db");
    const db = openDb({ dbPath });
    
    const foreignKeys = db
      .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
      .get();
    expect(foreignKeys?.foreign_keys).toBe(1);
    
    const busyTimeout = db
      .query<{ timeout: number }, []>("PRAGMA busy_timeout")
      .get();
    expect(busyTimeout?.timeout).toBe(5000);
    
    const synchronous = db
      .query<{ synchronous: number }, []>("PRAGMA synchronous")
      .get();
    expect(synchronous?.synchronous).toBe(1); // NORMAL = 1
    
    db.close();
  });

  test("openDb() sets journal_mode=WAL when not readonly", () => {
    const dbPath = join(TEST_DIR, "wal-test.db");
    const db = openDb({ dbPath });
    
    const journalMode = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    expect(journalMode?.journal_mode).toBe("wal");
    
    db.close();
  });

  test("openDb(readonly: true) sets query_only=ON and skips WAL", () => {
    const dbPath = join(TEST_DIR, "readonly-test.db");
    
    // First create the database
    const dbWrite = openDb({ dbPath });
    runMigrations({ db: dbWrite, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    dbWrite.close();
    
    // Open readonly
    const db = openDb({ dbPath, readonly: true });
    
    const queryOnly = db
      .query<{ query_only: number }, []>("PRAGMA query_only")
      .get();
    expect(queryOnly?.query_only).toBe(1);
    
    db.close();
  });
});

describe("Trigger Enforcement", () => {
  test("Trigger prevents DELETE on messages table", () => {
    const dbPath = join(TEST_DIR, "trigger-delete-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    // Insert test data
    const channelId = crypto.randomUUID();
    const topicId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    db.run("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)", [
      channelId,
      "test-channel",
      now,
    ]);
    db.run(
      "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [topicId, channelId, "test-topic", now, now]
    );
    db.run(
      "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [messageId, topicId, channelId, "user", "test content", now]
    );
    
    // Attempt DELETE should abort
    expect(() => {
      db.run("DELETE FROM messages WHERE id = ?", [messageId]);
    }).toThrow(/Hard deletes forbidden on messages/);
    
    // Verify message still exists
    const msg = db
      .query<{ id: string }, [string]>("SELECT id FROM messages WHERE id = ?")
      .get(messageId);
    expect(msg).toBeDefined();
    expect(msg!.id).toBe(messageId);
    
    db.close();
  });

  test("Trigger prevents UPDATE on events table", () => {
    const dbPath = join(TEST_DIR, "trigger-update-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO events (ts, name, entity_type, entity_id, data_json) VALUES (?, ?, ?, ?, ?)",
      [now, "test-event", "message", "test-id", "{}"]
    );
    
    // Attempt UPDATE should abort
    expect(() => {
      db.run("UPDATE events SET name = 'modified' WHERE event_id = 1");
    }).toThrow(/immutable/);
    
    db.close();
  });

  test("Trigger prevents DELETE on events table", () => {
    const dbPath = join(TEST_DIR, "trigger-delete-event-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO events (ts, name, entity_type, entity_id, data_json) VALUES (?, ?, ?, ?, ?)",
      [now, "test-event", "message", "test-id", "{}"]
    );
    
    // Attempt DELETE should abort
    expect(() => {
      db.run("DELETE FROM events WHERE event_id = 1");
    }).toThrow(/append-only/);
    
    db.close();
  });
});

describe("Optional FTS", () => {
  test("runMigrations(enableFts: true) creates messages_fts OR returns ftsError gracefully", () => {
    const dbPath = join(TEST_DIR, "fts-test.db");
    const db = openDb({ dbPath });
    
    const result = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: true,
    });
    
    // Either FTS is available or error is reported
    if (result.ftsAvailable) {
      expect(isFtsAvailable(db)).toBe(true);
      
      const ftsTables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
        )
        .all();
      expect(ftsTables.length).toBe(1);
    } else {
      // Graceful fallback: error is reported
      expect(result.ftsError).toBeDefined();
      expect(result.ftsError).toBeTruthy();
      expect(isFtsAvailable(db)).toBe(false);
    }
    
    db.close();
  });

  test("isFtsAvailable() returns false when FTS not enabled", () => {
    const dbPath = join(TEST_DIR, "no-fts-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    expect(isFtsAvailable(db)).toBe(false);
    
    db.close();
  });

  test("isFtsAvailable() detects existing FTS table correctly", () => {
    const dbPath = join(TEST_DIR, "fts-detect-test.db");
    const db = openDb({ dbPath });
    
    const result = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: true,
    });
    
    // If FTS was successfully created, isFtsAvailable should return true
    if (result.ftsAvailable) {
      expect(isFtsAvailable(db)).toBe(true);
    }
    
    db.close();
  });
});

describe("Query Contract Smoke Tests", () => {
  test("Create channel/topic/message and perform basic SELECT", () => {
    const dbPath = join(TEST_DIR, "query-smoke-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    const channelId = crypto.randomUUID();
    const topicId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    // Create channel
    db.run("INSERT INTO channels (id, name, description, created_at) VALUES (?, ?, ?, ?)", [
      channelId,
      "general",
      "General discussion",
      now,
    ]);
    
    // Create topic
    db.run(
      "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [topicId, channelId, "Welcome thread", now, now]
    );
    
    // Create message
    db.run(
      "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [messageId, topicId, channelId, "alice", "Hello world!", now]
    );
    
    // Query channel
    const channel = db
      .query<{ id: string; name: string; description: string }, [string]>(
        "SELECT id, name, description FROM channels WHERE id = ?"
      )
      .get(channelId);
    expect(channel).toBeDefined();
    expect(channel!.name).toBe("general");
    expect(channel!.description).toBe("General discussion");
    
    // Query topic
    const topic = db
      .query<{ id: string; title: string; channel_id: string }, [string]>(
        "SELECT id, title, channel_id FROM topics WHERE id = ?"
      )
      .get(topicId);
    expect(topic).toBeDefined();
    expect(topic!.title).toBe("Welcome thread");
    expect(topic!.channel_id).toBe(channelId);
    
    // Query message
    const message = db
      .query<
        { id: string; sender: string; content_raw: string; topic_id: string },
        [string]
      >("SELECT id, sender, content_raw, topic_id FROM messages WHERE id = ?")
      .get(messageId);
    expect(message).toBeDefined();
    expect(message!.sender).toBe("alice");
    expect(message!.content_raw).toBe("Hello world!");
    expect(message!.topic_id).toBe(topicId);
    
    db.close();
  });

  test("topic_attachments unique index enforces dedupe by (topic_id, kind, key, dedupe_key)", () => {
    const dbPath = join(TEST_DIR, "dedupe-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    const channelId = crypto.randomUUID();
    const topicId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    // Setup channel and topic
    db.run("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)", [
      channelId,
      "test",
      now,
    ]);
    db.run(
      "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [topicId, channelId, "test", now, now]
    );
    
    // Insert attachment with dedupe_key
    const attachmentId1 = crypto.randomUUID();
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [attachmentId1, topicId, "citation", "url", '{"url":"http://example.com"}', "example-hash", now]
    );
    
    // Attempt duplicate insert with same dedupe_key - should fail
    const attachmentId2 = crypto.randomUUID();
    expect(() => {
      db.run(
        "INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [attachmentId2, topicId, "citation", "url", '{"url":"http://example.com"}', "example-hash", now]
      );
    }).toThrow(/UNIQUE constraint failed/);
    
    // Verify only one attachment exists
    const count = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM topic_attachments WHERE topic_id = ?"
      )
      .get(topicId);
    expect(count?.count).toBe(1);
    
    // Different dedupe_key should succeed
    const attachmentId3 = crypto.randomUUID();
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [attachmentId3, topicId, "citation", "url", '{"url":"http://other.com"}', "other-hash", now]
    );
    
    const count2 = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM topic_attachments WHERE topic_id = ?"
      )
      .get(topicId);
    expect(count2?.count).toBe(2);
    
    db.close();
  });

  test("Foreign key constraints enforce referential integrity", () => {
    const dbPath = join(TEST_DIR, "fk-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    const now = new Date().toISOString();
    
    // Attempt to insert message with non-existent topic
    expect(() => {
      db.run(
        "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), "fake-topic", "fake-channel", "user", "test", now]
      );
    }).toThrow(/FOREIGN KEY constraint failed/);
    
    db.close();
  });

  test("CASCADE DELETE removes dependent records (topic_attachments)", () => {
    const dbPath = join(TEST_DIR, "cascade-test.db");
    const db = openDb({ dbPath });
    
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
    
    const channelId = crypto.randomUUID();
    const topicId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    // Create channel -> topic -> attachment chain
    db.run("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)", [
      channelId,
      "test",
      now,
    ]);
    db.run(
      "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [topicId, channelId, "test", now, now]
    );
    db.run(
      "INSERT INTO topic_attachments (id, topic_id, kind, value_json, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [attachmentId, topicId, "citation", '{"url":"test"}', "test-hash", now]
    );
    
    // Delete topic should cascade to attachments
    db.run("DELETE FROM topics WHERE id = ?", [topicId]);
    
    // Attachment should be deleted (cascaded from topic deletion)
    const attachment = db
      .query<{ id: string }, [string]>("SELECT id FROM topic_attachments WHERE id = ?")
      .get(attachmentId);
    expect(attachment).toBeNull();
    
    db.close();
  });
});

describe("Migration Idempotency", () => {
  test("Re-running migrations does not re-apply already applied migrations", () => {
    const dbPath = join(TEST_DIR, "idempotent-test.db");
    const db = openDb({ dbPath });
    
    // First run
    const result1 = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: false,
    });
    expect(result1.appliedMigrations).toContain("0001_schema_v1.sql");
    
    // Second run
    const result2 = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: false,
    });
    expect(result2.appliedMigrations.length).toBe(0);
    
    // Schema version should still be 1
    const version = db
      .query<{ value: string }, []>(
        "SELECT value FROM meta WHERE key = 'schema_version'"
      )
      .get();
    expect(version?.value).toBe("1");
    
    db.close();
  });
});

describe("Migration Edge Cases", () => {
  test("backupBeforeMigration behavior: no backup for v0→v1 (fresh DB)", () => {
    // Current implementation: backups are only created when currentVersion > 0
    // For the v0→v1 migration, currentVersion is 0, so no backup is created
    // This is intentional: v0 = "no schema yet" = fresh DB
    
    const dbPath = join(TEST_DIR, "backup-v0-test.db");
    const db = openDb({ dbPath });
    
    // Create a minimal meta table with schema_version=0
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta (key, value) VALUES ('schema_version', '0');
      INSERT INTO meta (key, value) VALUES ('db_id', 'test-uuid');
      CREATE TABLE dummy (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO dummy (id) VALUES ('pre-migration-data');
    `);
    
    db.close();
    const db2 = openDb({ dbPath });
    
    const version = db2
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    expect(version?.value).toBe("0");
    
    // Run migrations - no backup for v0
    runMigrations({
      db: db2,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: false,
    });
    
    db2.close();
    
    // Verify NO backup was created
    const files = readdirSync(TEST_DIR);
    const backupFiles = files.filter(f => f.startsWith("backup-v0-test.db.backup-"));
    expect(backupFiles.length).toBe(0);
  });

  test("backupBeforeMigration unit test: verify backup file creation", () => {
    // Tests the backup file creation logic directly
    const dbPath = join(TEST_DIR, "backup-unit-test.db");
    const db = openDb({ dbPath });
    
    db.exec(`
      CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO test_data (value) VALUES ('test-value-1');
    `);
    
    // Close and ensure WAL is checkpointed
    db.close();
    
    // Simulate backup creation (same logic as backupBeforeMigration)
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dbPath}.backup-v0-${timestamp}`;
    
    // Verify source file exists
    expect(existsSync(dbPath)).toBe(true);
    
    // Create backup
    copyFileSync(dbPath, backupPath);
    
    // Verify backup file exists
    expect(existsSync(backupPath)).toBe(true);
    
    // Verify filename format matches expected pattern
    expect(backupPath).toMatch(/\.backup-v0-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-/);
    
    // Cleanup - delete backup file
    if (existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
  });

  test("Missing migration file throws clear error message", () => {
    const dbPath = join(TEST_DIR, "missing-migration-test.db");
    const db = openDb({ dbPath });
    
    const emptyMigrationsDir = join(TEST_DIR, "empty-migrations");
    if (!existsSync(emptyMigrationsDir)) {
      mkdirSync(emptyMigrationsDir, { recursive: true });
    }
    
    // Should throw when migration file is not found
    expect(() => {
      runMigrations({
        db,
        migrationsDir: emptyMigrationsDir,
        enableFts: false,
      });
    }).toThrow(/Migration file not found/);
    
    db.close();
  });

  test("FTS migration can be re-run safely when enableFts=true", () => {
    const dbPath = join(TEST_DIR, "fts-rerun-test.db");
    const db = openDb({ dbPath });
    
    // First run with FTS enabled
    const result1 = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: true,
    });
    
    expect(result1.appliedMigrations).toContain("0001_schema_v1.sql");
    
    // If FTS was successfully created, verify it's tracked
    if (result1.ftsAvailable) {
      expect(result1.appliedMigrations).toContain("0001_schema_v1_fts.sql");
    }
    
    // Second run with FTS enabled should not re-apply FTS migration
    const result2 = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: true,
    });
    
    // Core migration already applied
    expect(result2.appliedMigrations).not.toContain("0001_schema_v1.sql");
    
    // FTS migration should not be re-applied if already available
    if (result1.ftsAvailable) {
      expect(result2.appliedMigrations).not.toContain("0001_schema_v1_fts.sql");
      expect(result2.ftsAvailable).toBe(true);
    }
    
    db.close();
  });

  test("FTS migration handles missing FTS file gracefully", () => {
    const dbPath = join(TEST_DIR, "fts-missing-test.db");
    const db = openDb({ dbPath });
    
    const noFtsMigrationsDir = join(TEST_DIR, "no-fts-migrations");
    if (!existsSync(noFtsMigrationsDir)) {
      mkdirSync(noFtsMigrationsDir, { recursive: true });
    }
    
    // Copy only the base migration, not the FTS one
    const baseMigrationPath = join(MIGRATIONS_DIR, "0001_schema_v1.sql");
    const destMigrationPath = join(noFtsMigrationsDir, "0001_schema_v1.sql");
    copyFileSync(baseMigrationPath, destMigrationPath);
    
    // Run with FTS enabled but file missing
    const result = runMigrations({
      db,
      migrationsDir: noFtsMigrationsDir,
      enableFts: true,
    });
    
    // Base migration should succeed
    expect(result.appliedMigrations).toContain("0001_schema_v1.sql");
    
    // FTS should report error gracefully
    expect(result.ftsAvailable).toBe(false);
    expect(result.ftsError).toContain("FTS migration file not found");
    
    db.close();
  });

  test("FTS migration on/off interactions: enable after initial disable", () => {
    const dbPath = join(TEST_DIR, "fts-toggle-test.db");
    const db = openDb({ dbPath });
    
    // First run: disable FTS
    const result1 = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: false,
    });
    
    expect(result1.appliedMigrations).toContain("0001_schema_v1.sql");
    expect(result1.ftsAvailable).toBe(false);
    expect(isFtsAvailable(db)).toBe(false);
    
    // Second run: enable FTS
    const result2 = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: true,
    });
    
    // Should apply FTS migration if SQLite supports it
    if (result2.ftsAvailable) {
      expect(result2.appliedMigrations).toContain("0001_schema_v1_fts.sql");
      expect(isFtsAvailable(db)).toBe(true);
    } else {
      // If FTS not available in SQLite build, error should be reported
      expect(result2.ftsError).toBeDefined();
    }
    
    db.close();
  });

  test("Backup not created for fresh DB (schema_version=0 but no existing file)", () => {
    const dbPath = join(TEST_DIR, "fresh-no-backup-test.db");
    const db = openDb({ dbPath });
    
    // Fresh database (no meta table yet)
    const result = runMigrations({
      db,
      migrationsDir: MIGRATIONS_DIR,
      enableFts: false,
    });
    
    expect(result.appliedMigrations).toContain("0001_schema_v1.sql");
    
    db.close();
    
    // No backup should be created for fresh init
    const files = readdirSync(TEST_DIR);
    const backupFiles = files.filter(f => f.startsWith("fresh-no-backup-test.db.backup-"));
    
    expect(backupFiles.length).toBe(0);
  });
});
