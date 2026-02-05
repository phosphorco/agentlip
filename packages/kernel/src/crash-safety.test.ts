/**
 * Crash and transaction safety edge-case test suite
 * 
 * Tests for bead bd-16d.6.6 (deterministic subset):
 * - Lock contention / SQLITE_BUSY handling
 * - Busy timeout / retry behavior is bounded
 * - Transaction rollback on errors (SQLITE_FULL simulation)
 * - WAL checkpoint failure handling (best-effort)
 * 
 * Out of scope for deterministic CI tests:
 * - Power loss (kill -9) during transaction - requires external tooling
 * - Corruption injection - requires SQLite debug mode / filesystem corruption
 * - Actual disk full scenarios - would require special filesystem setup
 * 
 * Implementation notes:
 * - SQLite in-process is single-threaded; true lock contention requires multi-process
 * - We simulate contention using long-running transactions + second connection
 * - busy_timeout is set to 5000ms; we verify operations fail after that
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, runMigrations } from "./index";
import type { Database } from "bun:sqlite";

const TEST_DIR = join(import.meta.dir, ".test-tmp-crash-safety");
const MIGRATIONS_DIR = join(import.meta.dir, "../../../migrations");

function setupTestDb(): { db: Database; dbPath: string } {
  const dbPath = join(
    TEST_DIR,
    `crash-safety-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  return { db, dbPath };
}

beforeEach(() => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("Lock Contention / SQLITE_BUSY Handling", () => {
  test("busy_timeout is configured (5000ms)", () => {
    const { db, dbPath } = setupTestDb();
    
    const timeout = db
      .query<{ timeout: number }, []>("PRAGMA busy_timeout")
      .get();
    
    expect(timeout?.timeout).toBe(5000);
    
    db.close();
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  test("Write lock contention: second connection waits up to busy_timeout", async () => {
    const { db: db1, dbPath } = setupTestDb();
    
    try {
      // Setup: create test data
      const channelId = crypto.randomUUID();
      const topicId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      db1.run(
        "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
        [channelId, "test-channel", now]
      );
      db1.run(
        "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [topicId, channelId, "test-topic", now, now]
      );
      
      // Start transaction on db1 (holds write lock)
      db1.run("BEGIN IMMEDIATE");
      db1.run(
        "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), topicId, channelId, "user1", "message1", now]
      );
      
      // Open second connection with shorter timeout (1000ms for faster test)
      const db2 = openDb({ dbPath });
      db2.run("PRAGMA busy_timeout = 1000");
      
      // Attempt write on db2 (should block until timeout)
      const startMs = Date.now();
      let errorThrown = false;
      let errorMessage = "";
      
      try {
        db2.run(
          "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), topicId, channelId, "user2", "message2", now]
        );
      } catch (error: any) {
        errorThrown = true;
        errorMessage = error.message;
      }
      
      const elapsedMs = Date.now() - startMs;
      
      // Should have waited close to busy_timeout before throwing
      expect(errorThrown).toBe(true);
      expect(errorMessage).toMatch(/database is locked|SQLITE_BUSY/i);
      expect(elapsedMs).toBeGreaterThanOrEqual(900); // Allow 100ms tolerance
      expect(elapsedMs).toBeLessThan(2000); // Should not wait much longer
      
      // Cleanup
      db1.run("ROLLBACK");
      db2.close();
    } finally {
      db1.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });

  test("Read operations succeed during write transaction (WAL mode)", () => {
    const { db: db1, dbPath } = setupTestDb();
    
    try {
      // Setup data
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      db1.run(
        "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
        [channelId, "test", now]
      );
      
      // Start write transaction
      db1.run("BEGIN IMMEDIATE");
      db1.run("UPDATE channels SET name = 'modified' WHERE id = ?", [channelId]);
      
      // Open second connection for read
      const db2 = openDb({ dbPath });
      
      // Read should succeed (WAL mode allows concurrent reads during write txn)
      const channel = db2
        .query<{ name: string }, [string]>("SELECT name FROM channels WHERE id = ?")
        .get(channelId);
      
      // Should see old value (transaction not committed yet)
      expect(channel?.name).toBe("test");
      
      // Commit and verify new value visible
      db1.run("COMMIT");
      
      const channelAfter = db2
        .query<{ name: string }, [string]>("SELECT name FROM channels WHERE id = ?")
        .get(channelId);
      
      expect(channelAfter?.name).toBe("modified");
      
      db2.close();
    } finally {
      db1.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });
});

describe("Transaction Atomicity on Errors", () => {
  test("Transaction rolls back on constraint violation (no partial state)", () => {
    const { db, dbPath } = setupTestDb();
    
    try {
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      // Insert initial channel
      db.run(
        "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
        [channelId, "unique-name", now]
      );
      
      // Start transaction attempting multiple inserts
      let errorThrown = false;
      
      try {
        db.run("BEGIN");
        
        // Insert new message
        const topicId = crypto.randomUUID();
        db.run(
          "INSERT INTO topics (id, channel_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          [topicId, channelId, "topic1", now, now]
        );
        
        // Attempt duplicate channel (should violate UNIQUE constraint on name)
        db.run(
          "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
          [crypto.randomUUID(), "unique-name", now]
        );
        
        db.run("COMMIT");
      } catch (error: any) {
        errorThrown = true;
        db.run("ROLLBACK");
      }
      
      expect(errorThrown).toBe(true);
      
      // Verify topic was NOT persisted (transaction rolled back)
      const topics = db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM topics WHERE channel_id = ?"
        )
        .get(channelId);
      
      expect(topics?.count).toBe(0);
      
      // Verify original channel still exists
      const channel = db
        .query<{ name: string }, [string]>("SELECT name FROM channels WHERE id = ?")
        .get(channelId);
      
      expect(channel?.name).toBe("unique-name");
    } finally {
      db.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });

  test("Foreign key constraint violation rolls back transaction", () => {
    const { db, dbPath } = setupTestDb();
    
    try {
      const now = new Date().toISOString();
      
      // Attempt to insert message with non-existent topic
      let errorThrown = false;
      
      try {
        db.run("BEGIN");
        db.run(
          "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), "fake-topic", "fake-channel", "user", "test", now]
        );
        db.run("COMMIT");
      } catch (error: any) {
        errorThrown = true;
        expect(error.message).toMatch(/FOREIGN KEY constraint failed/i);
        db.run("ROLLBACK");
      }
      
      expect(errorThrown).toBe(true);
      
      // Verify no messages were inserted
      const count = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages")
        .get();
      
      expect(count?.count).toBe(0);
    } finally {
      db.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });
});

describe("WAL Checkpoint Behavior", () => {
  test("WAL mode is enabled by default", () => {
    const { db, dbPath } = setupTestDb();
    
    const journalMode = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    
    expect(journalMode?.journal_mode).toBe("wal");
    
    db.close();
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  test("WAL checkpoint (PASSIVE) is non-blocking", () => {
    const { db, dbPath } = setupTestDb();
    
    try {
      // Insert some data to generate WAL activity
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      for (let i = 0; i < 100; i++) {
        db.run(
          "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
          [crypto.randomUUID(), `channel-${i}`, now]
        );
      }
      
      // PASSIVE checkpoint: best-effort, non-blocking
      const result = db
        .query<{ busy: number; log: number; checkpointed: number }, []>(
          "PRAGMA wal_checkpoint(PASSIVE)"
        )
        .get();
      
      // Should succeed (may or may not checkpoint everything)
      expect(result).toBeDefined();
      expect(typeof result?.busy).toBe("number");
      expect(typeof result?.log).toBe("number");
      expect(typeof result?.checkpointed).toBe("number");
    } finally {
      db.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });

  test("WAL checkpoint (TRUNCATE) reclaims space", () => {
    const { db, dbPath } = setupTestDb();
    
    try {
      // Generate WAL activity
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      for (let i = 0; i < 100; i++) {
        db.run(
          "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
          [crypto.randomUUID(), `channel-${i}`, now]
        );
      }
      
      // TRUNCATE checkpoint: blocking, but reclaims WAL space
      const result = db
        .query<{ busy: number; log: number; checkpointed: number }, []>(
          "PRAGMA wal_checkpoint(TRUNCATE)"
        )
        .get();
      
      // Should succeed
      expect(result).toBeDefined();
      
      // After TRUNCATE, log should be 0 (fully checkpointed and truncated)
      expect(result?.log).toBe(0);
    } finally {
      db.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });

  test("WAL checkpoint during active write transaction may be incomplete", () => {
    const { db, dbPath } = setupTestDb();
    
    try {
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      // Start transaction
      db.run("BEGIN IMMEDIATE");
      db.run(
        "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
        [channelId, "test", now]
      );
      
      // Attempt PASSIVE checkpoint (may fail with "database table is locked")
      // This is expected: WAL checkpoint cannot complete while write transaction is active
      let checkpointResult: { busy: number; log: number; checkpointed: number } | null = null;
      let checkpointError: Error | null = null;
      
      try {
        checkpointResult = db
          .query<{ busy: number; log: number; checkpointed: number }, []>(
            "PRAGMA wal_checkpoint(PASSIVE)"
          )
          .get();
      } catch (error: any) {
        checkpointError = error;
      }
      
      // Either checkpoint succeeds (with potentially incomplete results) or fails with lock error
      if (checkpointError) {
        expect(checkpointError.message).toMatch(/database table is locked|SQLITE_BUSY/i);
      } else {
        expect(checkpointResult).toBeDefined();
      }
      
      // Transaction should still be active and committable
      db.run("COMMIT");
      
      // Verify data was committed
      const channel = db
        .query<{ name: string }, [string]>("SELECT name FROM channels WHERE id = ?")
        .get(channelId);
      
      expect(channel?.name).toBe("test");
    } finally {
      db.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });
});

describe("Error Code Mapping (for hub 503 responses)", () => {
  test("SQLITE_BUSY error message is detectable", () => {
    const { db: db1, dbPath } = setupTestDb();
    
    try {
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      db1.run(
        "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
        [channelId, "test", now]
      );
      
      // Start write transaction
      db1.run("BEGIN IMMEDIATE");
      db1.run("UPDATE channels SET name = 'locked' WHERE id = ?", [channelId]);
      
      // Second connection with short timeout
      const db2 = openDb({ dbPath });
      db2.run("PRAGMA busy_timeout = 500");
      
      try {
        db2.run("UPDATE channels SET name = 'blocked' WHERE id = ?", [channelId]);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        // Verify error is recognizable (hub can detect and return 503)
        expect(error).toBeDefined();
        expect(error.message).toMatch(/database is locked|SQLITE_BUSY/i);
        
        // Bun's SQLite error is an Error object
        expect(error).toBeInstanceOf(Error);
      }
      
      db1.run("ROLLBACK");
      db2.close();
    } finally {
      db1.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });

  test("UNIQUE constraint error is detectable", () => {
    const { db, dbPath } = setupTestDb();
    
    try {
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      db.run(
        "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
        [channelId, "duplicate", now]
      );
      
      try {
        db.run(
          "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
          [crypto.randomUUID(), "duplicate", now]
        );
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toMatch(/UNIQUE constraint failed/i);
        expect(error).toBeInstanceOf(Error);
      }
    } finally {
      db.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });

  test("FOREIGN KEY constraint error is detectable", () => {
    const { db, dbPath } = setupTestDb();
    
    try {
      const now = new Date().toISOString();
      
      try {
        db.run(
          "INSERT INTO messages (id, topic_id, channel_id, sender, content_raw, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), "fake-topic", "fake-channel", "user", "test", now]
        );
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toMatch(/FOREIGN KEY constraint failed/i);
        expect(error).toBeInstanceOf(Error);
      }
    } finally {
      db.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });
});

describe("Concurrent Read Consistency (WAL mode)", () => {
  test("Reader sees consistent snapshot during write transaction", () => {
    const { db: writer, dbPath } = setupTestDb();
    
    try {
      // Setup initial data
      const channelId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      writer.run(
        "INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)",
        [channelId, "v1", now]
      );
      
      // Open reader connection
      const reader = openDb({ dbPath });
      
      // Start write transaction
      writer.run("BEGIN");
      writer.run("UPDATE channels SET name = 'v2' WHERE id = ?", [channelId]);
      
      // Reader should still see v1 (uncommitted change not visible)
      const channel1 = reader
        .query<{ name: string }, [string]>("SELECT name FROM channels WHERE id = ?")
        .get(channelId);
      
      expect(channel1?.name).toBe("v1");
      
      // Commit write
      writer.run("COMMIT");
      
      // Reader should now see v2
      const channel2 = reader
        .query<{ name: string }, [string]>("SELECT name FROM channels WHERE id = ?")
        .get(channelId);
      
      expect(channel2?.name).toBe("v2");
      
      reader.close();
    } finally {
      writer.close();
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });
});
