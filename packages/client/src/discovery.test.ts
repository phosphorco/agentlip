/**
 * Tests for workspace discovery re-exports
 * 
 * Validates that @agentchat/client correctly re-exports workspace helpers.
 */

import { describe, test, expect } from "bun:test";
import { discoverWorkspaceRoot, ensureWorkspaceInitialized, discoverOrInitWorkspace } from "./discovery";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("discovery re-exports", () => {
  test("discoverWorkspaceRoot is a function", () => {
    expect(typeof discoverWorkspaceRoot).toBe("function");
  });

  test("ensureWorkspaceInitialized is a function", () => {
    expect(typeof ensureWorkspaceInitialized).toBe("function");
  });

  test("discoverOrInitWorkspace is a function", () => {
    expect(typeof discoverOrInitWorkspace).toBe("function");
  });

  test("can initialize workspace", async () => {
    const tempDir = join(tmpdir(), `agentchat-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const result = await ensureWorkspaceInitialized(tempDir);
      
      expect(result.root).toBe(tempDir);
      expect(result.created).toBe(true);
      expect(result.dbPath).toBe(join(tempDir, ".zulip", "db.sqlite3"));

      // Verify workspace was actually created
      const dbExists = await fs.access(result.dbPath).then(() => true).catch(() => false);
      expect(dbExists).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("can discover initialized workspace", async () => {
    const tempDir = join(tmpdir(), `agentchat-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      // Initialize workspace
      await ensureWorkspaceInitialized(tempDir);

      // Create a subdirectory
      const subDir = join(tempDir, "subdir");
      await fs.mkdir(subDir);

      // Discover from subdirectory should find parent workspace
      const result = await discoverWorkspaceRoot(subDir);
      
      expect(result).not.toBeNull();
      expect(result?.root).toBe(tempDir);
      expect(result?.discovered).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
