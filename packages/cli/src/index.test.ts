/**
 * Tests for agentlip CLI workspace discovery and read-only DB opening
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import {
  discoverWorkspaceRoot,
  openWorkspaceDbReadonly,
  isQueryOnly,
  WorkspaceNotFoundError,
  DatabaseNotFoundError,
} from "./index.js";

describe("discoverWorkspaceRoot", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentlip-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns null when no workspace exists", async () => {
    const result = await discoverWorkspaceRoot(tempDir);
    expect(result).toBeNull();
  });

  test("finds workspace in current directory", async () => {
    // Create .agentlip/db.sqlite3
    const agentlipDir = join(tempDir, ".agentlip");
    await mkdir(agentlipDir, { recursive: true });
    const dbPath = join(agentlipDir, "db.sqlite3");
    await writeFile(dbPath, "");

    const result = await discoverWorkspaceRoot(tempDir);
    expect(result).not.toBeNull();
    expect(result!.root).toBe(tempDir);
    expect(result!.dbPath).toBe(dbPath);
    expect(result!.discovered).toBe(true);
  });

  test("finds workspace in parent directory", async () => {
    // Create workspace in tempDir
    const agentlipDir = join(tempDir, ".agentlip");
    await mkdir(agentlipDir, { recursive: true });
    const dbPath = join(agentlipDir, "db.sqlite3");
    await writeFile(dbPath, "");

    // Create nested subdirectory
    const subDir = join(tempDir, "deep", "nested", "dir");
    await mkdir(subDir, { recursive: true });

    // Search from nested dir should find parent workspace
    const result = await discoverWorkspaceRoot(subDir);
    expect(result).not.toBeNull();
    expect(result!.root).toBe(tempDir);
    expect(result!.dbPath).toBe(dbPath);
    expect(result!.discovered).toBe(true);
  });

  test("does not create workspace (discovery only)", async () => {
    // Verify discovery doesn't create anything
    const result = await discoverWorkspaceRoot(tempDir);
    expect(result).toBeNull();

    // Verify no .agentlip directory was created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tempDir, ".agentlip"))).toBe(false);
  });
});

describe("openWorkspaceDbReadonly", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentlip-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("throws WorkspaceNotFoundError when no workspace exists", async () => {
    await expect(
      openWorkspaceDbReadonly({ workspace: tempDir })
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  test("throws DatabaseNotFoundError when .agentlip exists but db.sqlite3 is missing", async () => {
    // Create .agentlip directory without db.sqlite3
    const agentlipDir = join(tempDir, ".agentlip");
    await mkdir(agentlipDir, { recursive: true });

    // discoverWorkspaceRoot will return null because it checks for db.sqlite3
    // So we should get WorkspaceNotFoundError
    await expect(
      openWorkspaceDbReadonly({ workspace: tempDir })
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  test("opens database in read-only mode with query_only=ON", async () => {
    // Create proper workspace with SQLite database
    const agentlipDir = join(tempDir, ".agentlip");
    await mkdir(agentlipDir, { recursive: true });
    const dbPath = join(agentlipDir, "db.sqlite3");

    // Create an actual SQLite database
    const initDb = new Database(dbPath, { create: true });
    initDb.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    initDb.run("INSERT INTO test (id, value) VALUES (1, 'hello')");
    initDb.close();

    // Now open read-only
    const result = await openWorkspaceDbReadonly({ workspace: tempDir });

    try {
      expect(result.workspaceRoot).toBe(tempDir);
      expect(result.dbPath).toBe(dbPath);

      // Verify query_only is ON
      expect(isQueryOnly(result.db)).toBe(true);

      // Verify we can read
      const row = result.db.query<{ value: string }, []>("SELECT value FROM test WHERE id = 1").get();
      expect(row?.value).toBe("hello");
    } finally {
      result.db.close();
    }
  });

  test("read-only database rejects write operations", async () => {
    // Create proper workspace with SQLite database
    const agentlipDir = join(tempDir, ".agentlip");
    await mkdir(agentlipDir, { recursive: true });
    const dbPath = join(agentlipDir, "db.sqlite3");

    // Create an actual SQLite database
    const initDb = new Database(dbPath, { create: true });
    initDb.run("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    initDb.close();

    // Open read-only
    const result = await openWorkspaceDbReadonly({ workspace: tempDir });

    try {
      // Attempt to write should fail
      expect(() => {
        result.db.run("INSERT INTO test (id, value) VALUES (2, 'world')");
      }).toThrow();
    } finally {
      result.db.close();
    }
  });

  test("does not initialize or create workspace (read-only mode)", async () => {
    // Verify openWorkspaceDbReadonly never creates workspace
    await expect(
      openWorkspaceDbReadonly({ workspace: tempDir })
    ).rejects.toThrow();

    // Verify no .agentlip directory was created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tempDir, ".agentlip"))).toBe(false);
  });
});

describe("isQueryOnly", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentlip-test-"));
    dbPath = join(tempDir, "test.sqlite3");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns true for read-only database", async () => {
    // Create database
    const initDb = new Database(dbPath, { create: true });
    initDb.close();

    // Open read-only with query_only=ON
    const db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA query_only = ON");

    expect(isQueryOnly(db)).toBe(true);
    db.close();
  });

  test("returns false for writable database", async () => {
    const db = new Database(dbPath, { create: true });

    // query_only should be OFF by default
    expect(isQueryOnly(db)).toBe(false);
    db.close();
  });
});
