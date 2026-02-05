// Ring 1: Kernel (SQLite schema + migrations + invariants)
// Implemented in Phase 0.
//
// Exports:
// - openDb, runMigrations, isFtsAvailable (schema management)
// - insertEvent, getLatestEventId, replayEvents, etc. (events.ts)
// - listChannels, listTopicsByChannel, listMessages, etc. (queries.ts)

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Re-export events module
export {
  insertEvent,
  getLatestEventId,
  replayEvents,
  getEventById,
  countEventsInRange,
  type EventScopes,
  type EventEntity,
  type InsertEventOptions,
  type EventRow,
  type ParsedEvent,
  type ReplayEventsOptions,
} from "./events";

// Re-export queries module
export {
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
  type Channel,
  type Topic,
  type Message,
  type TopicAttachment,
  type PaginationOptions,
  type MessageQueryOptions,
  type ListResult,
} from "./queries";

// Re-export message mutations module
export {
  editMessage,
  tombstoneDeleteMessage,
  retopicMessage,
  VersionConflictError,
  MessageNotFoundError,
  CrossChannelMoveError,
  TopicNotFoundError,
  type EditMessageOptions,
  type EditMessageResult,
  type TombstoneDeleteOptions,
  type TombstoneDeleteResult,
  type RetopicMode,
  type RetopicMessageOptions,
  type RetopicMessageResult,
} from "./messageMutations";

export const SCHEMA_VERSION = 1;

interface OpenDbOptions {
  dbPath: string;
  readonly?: boolean;
}

interface RunMigrationsOptions {
  db: Database;
  migrationsDir: string;
  enableFts?: boolean;
}

interface MigrationResult {
  appliedMigrations: string[];
  ftsAvailable: boolean;
  ftsError?: string;
}

/**
 * Open SQLite database with required PRAGMAs.
 * 
 * Sets:
 * - WAL mode (concurrent reads + single writer)
 * - foreign_keys = ON
 * - busy_timeout = 5000ms
 * - synchronous = NORMAL (balance safety/performance)
 * - query_only = ON (for readonly mode)
 * 
 * @param options - Database path and readonly flag
 * @returns Configured Database instance
 */
export function openDb({ dbPath, readonly = false }: OpenDbOptions): Database {
  const db = new Database(dbPath, { 
    create: !readonly,
    readonly 
  });

  // Set PRAGMAs
  if (!readonly) {
    db.run("PRAGMA journal_mode = WAL");
  }
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");

  if (readonly) {
    db.run("PRAGMA query_only = ON");
  }

  return db;
}

/**
 * Ensure meta table has required keys initialized.
 * 
 * Required keys:
 * - db_id: UUIDv4 generated at init, never changes
 * - schema_version: integer, current version (initially '0')
 * - created_at: ISO8601 timestamp
 * 
 * @param db - Database instance
 */
export function ensureMetaInitialized(db: Database): void {
  // Check if meta table exists
  const metaExists = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='meta'"
    )
    .get();

  if (!metaExists || metaExists.count === 0) {
    return; // Meta table doesn't exist yet; will be created by migration
  }

  // Check for required keys
  const checkKey = db.prepare<{ value: string }, [string]>(
    "SELECT value FROM meta WHERE key = ?"
  );

  const dbId = checkKey.get("db_id");
  if (!dbId) {
    // Generate UUIDv4
    const uuid = randomUUID();
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", ["db_id", uuid]);
  }

  const schemaVersion = checkKey.get("schema_version");
  if (!schemaVersion) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      "schema_version",
      "0",
    ]);
  }

  const createdAt = checkKey.get("created_at");
  if (!createdAt) {
    const timestamp = new Date().toISOString();
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      "created_at",
      timestamp,
    ]);
  }
}

/**
 * Create timestamped backup of database before migration.
 * 
 * Backup filename: {dbPath}.backup-v{fromVersion}-{timestamp}
 * 
 * @param dbPath - Path to database file
 * @param fromVersion - Current schema version before migration
 */
export function backupBeforeMigration(dbPath: string, fromVersion: number): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.backup-v${fromVersion}-${timestamp}`;

  copyFileSync(dbPath, backupPath);

  // Also backup WAL if it exists
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath)) {
    copyFileSync(walPath, `${backupPath}-wal`);
  }
}

/**
 * Run forward-only migrations tracked by meta.schema_version.
 * 
 * Applies migrations in order:
 * 1. 0001_schema_v1.sql (if schema_version is 0 or missing)
 * 2. 0001_schema_v1_fts.sql (if enableFts=true, opportunistic, non-fatal)
 * 
 * Before applying migrations, creates timestamped backup.
 * 
 * @param options - Database, migrations directory, and FTS flag
 * @returns Migration result with applied migrations and FTS status
 */
export function runMigrations({
  db,
  migrationsDir,
  enableFts = false,
}: RunMigrationsOptions): MigrationResult {
  const result: MigrationResult = {
    appliedMigrations: [],
    ftsAvailable: false,
  };

  // Ensure meta table exists or will be created
  ensureMetaInitialized(db);

  // Get current schema version
  const getCurrentVersion = (): number => {
    try {
      const row = db
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
        .get();
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  };

  const currentVersion = getCurrentVersion();

  // Apply schema_v1 if needed
  if (currentVersion < 1) {
    const migrationPath = join(migrationsDir, "0001_schema_v1.sql");

    if (!existsSync(migrationPath)) {
      throw new Error(`Migration file not found: ${migrationPath}`);
    }

    // Create backup before migration
    const dbPath = db.filename;
    if (dbPath && currentVersion > 0) {
      backupBeforeMigration(dbPath, currentVersion);
    }

    // Apply migration
    const sql = readFileSync(migrationPath, "utf-8");
    db.exec(sql);

    // Update schema version
    db.run(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')"
    );

    result.appliedMigrations.push("0001_schema_v1.sql");

    // Initialize other required meta keys after schema is created
    ensureMetaInitialized(db);
  }

  // Opportunistically apply FTS schema if requested
  if (enableFts) {
    // Check if FTS is already applied
    const ftsExists = isFtsAvailable(db);
    
    if (!ftsExists) {
      const ftsPath = join(migrationsDir, "0001_schema_v1_fts.sql");

      if (existsSync(ftsPath)) {
        try {
          const sql = readFileSync(ftsPath, "utf-8");
          db.exec(sql);
          result.ftsAvailable = true;
          result.appliedMigrations.push("0001_schema_v1_fts.sql");
        } catch (err) {
          // Non-fatal: FTS may not be available in this SQLite build
          result.ftsAvailable = false;
          result.ftsError =
            err instanceof Error ? err.message : String(err);
        }
      } else {
        result.ftsError = "FTS migration file not found";
      }
    } else {
      // FTS already available
      result.ftsAvailable = true;
    }
  }

  return result;
}

/**
 * Check if FTS is available in the database.
 * 
 * @param db - Database instance
 * @returns true if messages_fts table exists
 */
export function isFtsAvailable(db: Database): boolean {
  try {
    const row = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='messages_fts'"
      )
      .get();
    return row ? row.count > 0 : false;
  } catch {
    return false;
  }
}
