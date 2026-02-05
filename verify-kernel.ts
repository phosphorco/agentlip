#!/usr/bin/env bun
/**
 * Verification script for @agentchat/kernel package
 * 
 * Tests:
 * 1. Database initialization with proper PRAGMAs
 * 2. Schema v1 migration (DDL contract)
 * 3. Optional FTS migration (graceful fallback)
 * 4. Meta table initialization
 * 5. Trigger enforcement (no hard deletes, immutable events)
 * 6. Backup creation during upgrades
 * 7. Readonly mode
 * 8. Migration idempotency
 * 
 * Run: bun verify-kernel.ts
 */

import { openDb, ensureMetaInitialized, runMigrations, isFtsAvailable, backupBeforeMigration, SCHEMA_VERSION } from "./packages/kernel/src/index.ts";
import { unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".verify-tmp");
const TEST_DB_PATH = join(TEST_DIR, "test.sqlite3");
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

// Setup: Create test directory
if (!existsSync(TEST_DIR)) {
  mkdirSync(TEST_DIR);
}

// Cleanup function
function cleanup() {
  if (existsSync(TEST_DIR)) {
    for (const file of readdirSync(TEST_DIR)) {
      const filePath = join(TEST_DIR, file);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
  }
}

// Clean start
cleanup();

console.log("🔍 Verifying @agentchat/kernel implementation\n");
console.log("=" .repeat(60));

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => {
        console.log(`✅ ${name}`);
        testsPassed++;
      }).catch((err) => {
        console.log(`❌ ${name}`);
        console.log(`   Error: ${err.message}`);
        testsFailed++;
      });
    } else {
      console.log(`✅ ${name}`);
      testsPassed++;
    }
  } catch (err) {
    console.log(`❌ ${name}`);
    if (err instanceof Error) {
      console.log(`   Error: ${err.message}`);
    }
    testsFailed++;
  }
}

// Test 1: Open database with PRAGMAs
test("Open database with required PRAGMAs", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  
  const journalMode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  const foreignKeys = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  const busyTimeout = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
  const synchronous = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
  
  if (journalMode?.journal_mode !== "wal") throw new Error("journal_mode not WAL");
  if (foreignKeys?.foreign_keys !== 1) throw new Error("foreign_keys not enabled");
  if (busyTimeout?.timeout !== 5000) throw new Error("busy_timeout not 5000");
  if (synchronous?.synchronous !== 1) throw new Error("synchronous not NORMAL");
  
  db.close();
});

// Test 2: Run migrations
test("Apply schema_v1 migration", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  const result = runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  
  if (!result.appliedMigrations.includes("0001_schema_v1.sql")) {
    throw new Error("schema_v1 migration not applied");
  }
  
  db.close();
});

// Test 3: Verify meta table initialization
test("Meta table initialized with required keys", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  
  const dbId = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'db_id'").get();
  const schemaVersion = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const createdAt = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'created_at'").get();
  
  if (!dbId?.value) throw new Error("db_id not set");
  if (schemaVersion?.value !== "1") throw new Error(`schema_version is ${schemaVersion?.value}, expected 1`);
  if (!createdAt?.value) throw new Error("created_at not set");
  
  db.close();
});

// Test 4: Verify core tables exist
test("Core tables created (channels, topics, messages, events, attachments, enrichments)", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(t => t.name);
  
  const required = ["channels", "topics", "messages", "events", "topic_attachments", "enrichments", "meta"];
  for (const table of required) {
    if (!tables.includes(table)) throw new Error(`Missing table: ${table}`);
  }
  
  db.close();
});

// Test 5: Verify indexes created
test("Required indexes created", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  
  const indexes = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
  ).all().map(idx => idx.name);
  
  const required = [
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
    "idx_enrichments_message"
  ];
  
  for (const idx of required) {
    if (!indexes.includes(idx)) throw new Error(`Missing index: ${idx}`);
  }
  
  db.close();
});

// Test 6: Verify triggers prevent hard deletes and mutations
test("Trigger prevents hard delete on messages", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  
  // Insert test data
  const channelId = crypto.randomUUID();
  const topicId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  
  db.run("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)", [channelId, "test", now]);
  db.run("INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", 
    [topicId, channelId, "test", now, now]);
  db.run("INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [messageId, topicId, channelId, "user", "test", now]);
  
  // Try to delete - should fail
  try {
    db.run("DELETE FROM messages WHERE id = ?", [messageId]);
    throw new Error("Delete should have been prevented");
  } catch (err) {
    if (err instanceof Error && !err.message.includes("Hard deletes forbidden")) {
      throw err;
    }
  }
  
  db.close();
});

// Test 7: Verify trigger prevents event mutations
test("Trigger prevents update/delete on events", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  
  const now = new Date().toISOString();
  db.run("INSERT INTO events (ts, name, entity_type, entity_id, data_json) VALUES (?, ?, ?, ?, ?)",
    [now, "test", "test", "test", "{}"]);
  
  // Try to update - should fail
  try {
    db.run("UPDATE events SET name = 'modified' WHERE event_id = 1");
    throw new Error("Update should have been prevented");
  } catch (err) {
    if (err instanceof Error && !err.message.includes("immutable")) {
      throw err;
    }
  }
  
  // Try to delete - should fail
  try {
    db.run("DELETE FROM events WHERE event_id = 1");
    throw new Error("Delete should have been prevented");
  } catch (err) {
    if (err instanceof Error && !err.message.includes("append-only")) {
      throw err;
    }
  }
  
  db.close();
});

// Test 8: Optional FTS migration
test("FTS migration applies when enabled", () => {
  cleanup();
  const db = openDb({ dbPath: TEST_DB_PATH });
  const result = runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: true });
  
  if (!result.ftsAvailable) {
    console.log("   ⚠️  FTS not available (may not be compiled in SQLite)");
    if (result.ftsError) {
      console.log(`   FTS error: ${result.ftsError}`);
    }
  } else if (!result.appliedMigrations.includes("0001_schema_v1_fts.sql")) {
    throw new Error("FTS migration not applied");
  }
  
  db.close();
});

// Test 9: FTS detection
test("isFtsAvailable correctly detects FTS", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  const ftsAvailable = isFtsAvailable(db);
  
  const tableExists = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='messages_fts'"
  ).get();
  
  if (ftsAvailable !== (tableExists && tableExists.count > 0)) {
    throw new Error("isFtsAvailable returned incorrect result");
  }
  
  db.close();
});

// Test 10: Readonly mode
test("Readonly mode prevents writes", () => {
  const dbRo = openDb({ dbPath: TEST_DB_PATH, readonly: true });
  
  const queryOnly = dbRo.query<{ query_only: number }, []>("PRAGMA query_only").get();
  if (queryOnly?.query_only !== 1) throw new Error("query_only not set");
  
  try {
    dbRo.run("INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
      [crypto.randomUUID(), "fail", new Date().toISOString()]);
    throw new Error("Write should have been prevented in readonly mode");
  } catch (err) {
    if (err instanceof Error && err.message.includes("prevented")) {
      throw err;
    }
  }
  
  dbRo.close();
});

// Test 11: Migration idempotency
test("Re-running migrations is idempotent", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  const result = runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: true });
  
  if (result.appliedMigrations.length > 0) {
    throw new Error(`Re-run should not apply migrations again, but applied: ${result.appliedMigrations.join(", ")}`);
  }
  
  db.close();
});

// Test 12: Backup functionality
test("backupBeforeMigration creates timestamped backup", () => {
  backupBeforeMigration(TEST_DB_PATH, 1);
  
  const backupFiles = readdirSync(TEST_DIR).filter(
    (f) => f.includes(".backup-v1-") && !f.endsWith("-wal")
  );
  if (backupFiles.length === 0) {
    throw new Error("No backup file created");
  }
  
  // Verify backup is readable
  const backupPath = join(TEST_DIR, backupFiles[0]);
  const backupDb = openDb({ dbPath: backupPath, readonly: true });
  const version = backupDb.query<{ value: string }, []>(
    "SELECT value FROM meta WHERE key = 'schema_version'"
  ).get();
  backupDb.close();
  
  if (version?.value !== "1") {
    throw new Error(`Backup has wrong version: ${version?.value}`);
  }
});

// Test 13: Foreign key constraints
test("Foreign key constraints enforced", () => {
  const db = openDb({ dbPath: TEST_DB_PATH });
  
  // Try to insert message with non-existent topic
  try {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), "fake-topic", "fake-channel", "user", "test", now]
    );
    throw new Error("Foreign key constraint should have been enforced");
  } catch (err) {
    if (err instanceof Error && !err.message.includes("FOREIGN KEY")) {
      throw err;
    }
  }
  
  db.close();
});

// Summary
console.log("\n" + "=".repeat(60));
console.log(`\n📊 Test Results: ${testsPassed} passed, ${testsFailed} failed\n`);

if (testsFailed > 0) {
  console.log("❌ Verification FAILED\n");
  cleanup();
  process.exit(1);
}

console.log("✅ All verifications passed!\n");
console.log("📋 Verified functionality:");
console.log("   • Database initialization with PRAGMAs (WAL, foreign_keys, busy_timeout, synchronous)");
console.log("   • Schema v1 migration with DDL contract");
console.log("   • Meta table initialization (db_id, schema_version, created_at)");
console.log("   • Core tables: channels, topics, messages, events, attachments, enrichments");
console.log("   • Required indexes for query performance");
console.log("   • Triggers preventing hard deletes and event mutations");
console.log("   • Optional FTS migration (graceful fallback)");
console.log("   • Readonly mode support");
console.log("   • Migration idempotency");
console.log("   • Backup creation for upgrades");
console.log("   • Foreign key constraint enforcement");

// Cleanup
cleanup();
console.log("\n✨ Cleanup complete\n");
