/**
 * @agentlip/cli - CLI utilities for Agentlip
 * 
 * Provides:
 * - Workspace discovery (reusing @agentlip/workspace)
 * - Read-only DB opening with query_only=ON
 */

import { discoverWorkspaceRoot } from "@agentlip/workspace";
import { openDb } from "@agentlip/kernel";
import type { Database } from "bun:sqlite";

// Re-export workspace discovery for convenience
export { discoverWorkspaceRoot } from "@agentlip/workspace";

/**
 * Error thrown when no workspace is found
 */
export class WorkspaceNotFoundError extends Error {
  constructor(startPath: string) {
    super(`No workspace found (no .agentlip/db.sqlite3 in directory tree starting from ${startPath})`);
    this.name = "WorkspaceNotFoundError";
  }
}

/**
 * Error thrown when DB does not exist at expected path
 */
export class DatabaseNotFoundError extends Error {
  constructor(dbPath: string) {
    super(`Database not found at ${dbPath}`);
    this.name = "DatabaseNotFoundError";
  }
}

/**
 * Result of opening workspace DB in read-only mode
 */
export interface WorkspaceDbResult {
  /** Database instance (readonly, query_only=ON) */
  db: Database;
  /** Absolute path to workspace root directory */
  workspaceRoot: string;
  /** Absolute path to db.sqlite3 file */
  dbPath: string;
}

/**
 * Options for opening workspace DB in read-only mode
 */
export interface OpenWorkspaceDbReadonlyOptions {
  /** Explicit workspace path (otherwise auto-discover from cwd) */
  workspace?: string;
}

/**
 * Open workspace database in read-only mode.
 * 
 * This function:
 * 1. Discovers workspace root by walking upward from workspace (or cwd)
 * 2. Opens the database with readonly=true
 * 3. Sets PRAGMA query_only=ON (via @agentlip/kernel)
 * 
 * The database is opened read-only and cannot be mutated.
 * This is safe for CLI queries while hub may be running.
 * 
 * @param options - Optional workspace path override
 * @returns Database instance, workspace root, and DB path
 * @throws WorkspaceNotFoundError if no workspace found
 * @throws DatabaseNotFoundError if DB file doesn't exist
 */
export async function openWorkspaceDbReadonly(
  options: OpenWorkspaceDbReadonlyOptions = {}
): Promise<WorkspaceDbResult> {
  const startPath = options.workspace ?? process.cwd();

  // Discover workspace root
  const discovered = await discoverWorkspaceRoot(startPath);
  
  if (!discovered) {
    throw new WorkspaceNotFoundError(startPath);
  }

  const { root: workspaceRoot, dbPath } = discovered;

  // Verify DB file exists before attempting to open
  const { existsSync } = await import("node:fs");
  if (!existsSync(dbPath)) {
    throw new DatabaseNotFoundError(dbPath);
  }

  // Open database in read-only mode
  // @agentlip/kernel openDb sets query_only=ON when readonly=true
  const db = openDb({ dbPath, readonly: true });

  return {
    db,
    workspaceRoot,
    dbPath,
  };
}

/**
 * Verify that a database has query_only=ON.
 * 
 * Useful for testing that the DB is truly read-only.
 * 
 * @param db - Database instance to check
 * @returns true if query_only is enabled
 */
export function isQueryOnly(db: Database): boolean {
  const result = db.query<{ query_only: number }, []>("PRAGMA query_only").get();
  return result?.query_only === 1;
}
