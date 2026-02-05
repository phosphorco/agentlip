#!/usr/bin/env bun
/**
 * Verification script for @agentchat/cli
 * 
 * Checks:
 * 1. Library exports work correctly
 * 2. CLI binary runs without errors
 * 3. Read-only mode is enforced
 */

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { $ } from "bun";

async function runVerification() {
  console.log("🔍 Verifying @agentchat/cli...\n");

  let tempDir: string | null = null;
  let passed = 0;
  let failed = 0;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "agentchat-verify-"));

    // Test 1: Library imports work
    console.log("1. Testing library imports...");
    const { 
      discoverWorkspaceRoot, 
      openWorkspaceDbReadonly, 
      isQueryOnly,
      WorkspaceNotFoundError 
    } = await import("./src/index.js");
    console.log("   ✓ All exports available\n");
    passed++;

    // Test 2: Discovery returns null for non-workspace
    console.log("2. Testing workspace discovery (no workspace)...");
    const noWorkspace = await discoverWorkspaceRoot(tempDir);
    if (noWorkspace === null) {
      console.log("   ✓ Returns null when no workspace exists\n");
      passed++;
    } else {
      console.log("   ✗ Expected null, got result\n");
      failed++;
    }

    // Test 3: Create workspace and verify discovery
    console.log("3. Testing workspace discovery (with workspace)...");
    const zulipDir = join(tempDir, ".zulip");
    await mkdir(zulipDir, { recursive: true });
    const dbPath = join(zulipDir, "db.sqlite3");

    // Create a valid SQLite database with meta table
    const initDb = new Database(dbPath, { create: true });
    initDb.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    initDb.run("INSERT INTO meta (key, value) VALUES ('db_id', 'test-db-id-123')");
    initDb.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    initDb.close();

    const discovered = await discoverWorkspaceRoot(tempDir);
    if (discovered && discovered.root === tempDir) {
      console.log("   ✓ Workspace discovered correctly\n");
      passed++;
    } else {
      console.log("   ✗ Failed to discover workspace\n");
      failed++;
    }

    // Test 4: Open DB read-only and verify query_only
    console.log("4. Testing read-only DB opening...");
    const { db, workspaceRoot } = await openWorkspaceDbReadonly({ workspace: tempDir });
    try {
      if (isQueryOnly(db)) {
        console.log("   ✓ query_only=ON confirmed\n");
        passed++;
      } else {
        console.log("   ✗ query_only is not ON\n");
        failed++;
      }

      // Test 5: Verify read works
      console.log("5. Testing read operations...");
      const row = db.query<{ value: string }, []>(
        "SELECT value FROM meta WHERE key = 'db_id'"
      ).get();
      if (row?.value === "test-db-id-123") {
        console.log("   ✓ Read operations work\n");
        passed++;
      } else {
        console.log("   ✗ Read failed or returned wrong value\n");
        failed++;
      }

      // Test 6: Verify write is blocked
      console.log("6. Testing write rejection...");
      try {
        db.run("INSERT INTO meta (key, value) VALUES ('test', 'should-fail')");
        console.log("   ✗ Write should have been rejected\n");
        failed++;
      } catch {
        console.log("   ✓ Write correctly rejected\n");
        passed++;
      }
    } finally {
      db.close();
    }

    // Test 7: CLI binary runs
    console.log("7. Testing CLI binary...");
    const cliPath = join(import.meta.dir, "src", "agentchat.ts");
    const result = await $`bun ${cliPath} doctor --workspace ${tempDir} --json`.quiet();
    const output = JSON.parse(result.stdout.toString());
    if (output.status === "ok" && output.db_id === "test-db-id-123") {
      console.log("   ✓ CLI doctor command works\n");
      passed++;
    } else {
      console.log("   ✗ CLI doctor failed\n");
      console.log("   Output:", output);
      failed++;
    }

  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\n❌ Verification FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ All verifications passed!");
    process.exit(0);
  }
}

runVerification().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
