#!/usr/bin/env bun
/**
 * Demo script showing agentlipd status command usage.
 *
 * This demonstrates:
 * 1. Starting a hub
 * 2. Writing server.json
 * 3. Running status command
 * 4. Stopping hub and checking status again
 */

import { startHub } from "./src/index.js";
import { writeServerJson, removeServerJson } from "./src/serverJson.js";
import { discoverOrInitWorkspace } from "../workspace/src/index.js";
import { openDb, runMigrations } from "../kernel/src/index.js";
import { main as statusMain } from "./src/agentlipd.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function demo() {
  console.log("=== Agentlip Status Command Demo ===\n");

  // Create temporary workspace
  const tmpRoot = await mkdtemp(join(tmpdir(), "agentlip-demo-"));
  console.log(`📁 Demo workspace: ${tmpRoot}\n`);

  try {
    // Initialize workspace and schema
    console.log("1. Initializing workspace...");
    const { root, dbPath } = await discoverOrInitWorkspace(tmpRoot);
    const db = openDb({ dbPath });
    const migrationsDir = join(import.meta.dir, "../../migrations");
    runMigrations({ db, migrationsDir });

    // Read db_id from meta
    const dbIdRow = db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'db_id'")
      .get();
    const dbId = dbIdRow?.value ?? "unknown";
    db.close();
    console.log(`   ✓ Workspace initialized (db_id: ${dbId})\n`);

    // Start hub
    console.log("2. Starting hub...");
    const hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      dbId,
      schemaVersion: 1,
    });
    console.log(`   ✓ Hub started on port ${hub.port}\n`);

    // Write server.json
    await writeServerJson({
      workspaceRoot: root,
      data: {
        instance_id: hub.instanceId,
        db_id: dbId,
        port: hub.port,
        host: hub.host,
        auth_token: "demo-token-12345",
        pid: process.pid,
        started_at: new Date().toISOString(),
        protocol_version: "v1",
        schema_version: 1,
      },
    });
    console.log("3. Wrote server.json\n");

    // Run status command (human-readable)
    console.log("4. Running 'agentlipd status' (human-readable):");
    console.log("---");
    try {
      await statusMain(["--workspace", root]);
    } catch (err) {
      // Ignore exit (status command exits with code 0)
    }
    console.log("---\n");

    // Run status command (JSON)
    console.log("5. Running 'agentlipd status --json':");
    console.log("---");
    try {
      await statusMain(["--workspace", root, "--json"]);
    } catch (err) {
      // Ignore exit
    }
    console.log("---\n");

    // Stop hub
    console.log("6. Stopping hub...");
    await hub.stop();
    console.log("   ✓ Hub stopped\n");

    // Run status again (should show not running/unreachable)
    console.log("7. Running 'agentlipd status' after hub stopped:");
    console.log("---");
    try {
      await statusMain(["--workspace", root]);
    } catch (err) {
      // Ignore exit (status command exits with code 3)
    }
    console.log("---\n");

    // Clean up server.json
    await removeServerJson({ workspaceRoot: root });
    console.log("8. Removed server.json");

    // Run status one more time (should show not running)
    console.log("\n9. Running 'agentlipd status' after server.json removed:");
    console.log("---");
    try {
      await statusMain(["--workspace", root]);
    } catch (err) {
      // Ignore exit (status command exits with code 3)
    }
    console.log("---\n");
  } finally {
    // Clean up
    try {
      await rm(tmpRoot, { recursive: true, force: true });
      console.log(`🗑️  Cleaned up demo workspace`);
    } catch (err) {
      console.warn(`Warning: Failed to clean up ${tmpRoot}:`, err);
    }
  }

  console.log("\n✅ Demo complete!");
}

demo().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
