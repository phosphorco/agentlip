#!/usr/bin/env bun
/**
 * Verification script for agentlipd status command.
 *
 * Tests:
 * 1. status=not_running when server.json missing
 * 2. status=unreachable when server.json present but /health unreachable
 * 3. status=running when /health responds and db_id matches
 * 4. status=db_mismatch when db_id doesn't match
 * 5. JSON output format
 */

import { startHub } from "./src/index.js";
import {
  writeServerJson,
  removeServerJson,
  readServerJson,
} from "./src/serverJson.js";
import { checkStatus } from "./src/agentlipd.js";
import { discoverOrInitWorkspace } from "../workspace/src/index.js";
import { openDb, runMigrations } from "../kernel/src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`✓ ${message}`);
    passed++;
  } else {
    console.error(`✗ ${message}`);
    failed++;
  }
}

async function test() {
  console.log("=== Agentlip Status Command Verification ===\n");

  // Create temporary workspace
  const tmpRoot = await mkdtemp(join(tmpdir(), "agentlip-test-"));
  console.log(`Test workspace: ${tmpRoot}\n`);

  try {
    // Initialize workspace
    const { root, dbPath } = await discoverOrInitWorkspace(tmpRoot);
    assert(root === tmpRoot, `Workspace initialized at ${tmpRoot}`);

    // Initialize schema
    const db = openDb({ dbPath });
    const { MIGRATIONS_DIR } = await import("@agentlip/kernel");
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR });
    db.close();

    // Test 1: status=not_running when server.json missing
    console.log("Test 1: No server.json (hub not running)");
    await removeServerJson({ workspaceRoot: root });

    const result1 = await checkStatus({ workspace: root });
    assert(
      result1.status === "not_running",
      `Status is not_running (got: ${result1.status})`
    );
    assert(
      result1.error?.includes("server.json") ?? false,
      "Error mentions server.json"
    );
    console.log();

    // Test 2: status=unreachable when server.json present but /health unreachable
    console.log("Test 2: Stale server.json (hub unreachable)");

    // Write stale server.json (hub not actually running on this port)
    await writeServerJson({
      workspaceRoot: root,
      data: {
        instance_id: "stale-instance",
        db_id: "stale-db",
        port: 65432, // Likely nothing running here
        host: "127.0.0.1",
        auth_token: "fake-token",
        pid: 99999,
        started_at: new Date().toISOString(),
        protocol_version: "v1",
      },
    });

    const result2 = await checkStatus({ workspace: root });
    assert(
      result2.status === "unreachable",
      `Status is unreachable (got: ${result2.status})`
    );
    assert(result2.port === 65432, `Port preserved from server.json`);
    assert(result2.pid === 99999, `PID preserved from server.json`);
    assert(
      result2.error?.includes("unreachable") ?? false,
      "Error mentions unreachable"
    );
    console.log();

    // Test 3: status=running when /health responds and db_id matches
    console.log("Test 3: Running hub with valid db_id");

    // Read actual db_id from database
    const db2 = openDb({ dbPath, readonly: true });
    const dbIdRow = db2
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'db_id'")
      .get();
    const actualDbId = dbIdRow?.value ?? "unknown";
    db2.close();

    // Start real hub
    const hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      dbId: actualDbId,
      schemaVersion: 1,
    });

    // Write matching server.json
    await writeServerJson({
      workspaceRoot: root,
      data: {
        instance_id: hub.instanceId,
        db_id: actualDbId,
        port: hub.port,
        host: hub.host,
        auth_token: "valid-token-123",
        pid: process.pid,
        started_at: new Date().toISOString(),
        protocol_version: "v1",
        schema_version: 1,
      },
    });

    const result3 = await checkStatus({ workspace: root });
    assert(
      result3.status === "running",
      `Status is running (got: ${result3.status})`
    );
    assert(
      result3.instance_id === hub.instanceId,
      `Instance ID matches (got: ${result3.instance_id})`
    );
    assert(result3.db_id === actualDbId, `DB ID matches (got: ${result3.db_id})`);
    assert(result3.port === hub.port, `Port matches (got: ${result3.port})`);
    assert(result3.schema_version === 1, `Schema version is 1`);
    assert(result3.protocol_version === "v1", `Protocol version is v1`);
    assert(typeof result3.pid === "number", `PID is a number`);
    assert(
      typeof result3.uptime_seconds === "number",
      `Uptime is a number (got: ${result3.uptime_seconds})`
    );
    assert(!result3.error, "No error present");
    console.log();

    // Test 4: status=db_mismatch when hub reports different db_id than on-disk
    console.log("Test 4: DB ID mismatch (hub vs on-disk)");

    // Stop current hub and start one with DIFFERENT db_id
    await hub.stop();
    
    const mismatchedHub = await startHub({
      host: "127.0.0.1",
      port: 0,
      dbId: "mismatched-db-id-xyz", // Different from actualDbId
      schemaVersion: 1,
    });

    // Write server.json pointing to mismatched hub
    await writeServerJson({
      workspaceRoot: root,
      data: {
        instance_id: mismatchedHub.instanceId,
        db_id: "mismatched-db-id-xyz",
        port: mismatchedHub.port,
        host: mismatchedHub.host,
        auth_token: "valid-token-456",
        pid: process.pid,
        started_at: new Date().toISOString(),
        protocol_version: "v1",
      },
    });

    // Status should detect mismatch (hub reports mismatched-db-id-xyz, disk has actualDbId)
    const result4 = await checkStatus({ workspace: root });
    assert(
      result4.status === "db_mismatch",
      `Status is db_mismatch (got: ${result4.status})`
    );
    assert(
      result4.db_id === "mismatched-db-id-xyz",
      `Hub reports mismatched db_id (got: ${result4.db_id})`
    );
    assert(
      result4.error?.includes("mismatch") ?? false,
      `Error mentions mismatch (got: ${result4.error})`
    );
    assert(
      result4.error?.includes(actualDbId) ?? false,
      `Error mentions on-disk db_id (got: ${result4.error})`
    );
    console.log();

    // Restore original hub for remaining tests
    await mismatchedHub.stop();
    const restoredHub = await startHub({
      host: "127.0.0.1",
      port: 0,
      dbId: actualDbId,
      schemaVersion: 1,
    });

    // Test 5: JSON output verification
    console.log("Test 5: JSON output format");

    // Restore matching server.json
    await writeServerJson({
      workspaceRoot: root,
      data: {
        instance_id: restoredHub.instanceId,
        db_id: actualDbId,
        port: restoredHub.port,
        host: restoredHub.host,
        auth_token: "valid-token-789",
        pid: process.pid,
        started_at: new Date().toISOString(),
        protocol_version: "v1",
        schema_version: 1,
      },
    });

    const result5 = await checkStatus({ workspace: root, json: true });
    assert(typeof result5 === "object", "Result is an object");
    assert("status" in result5, "Result has status field");
    assert("instance_id" in result5, "Result has instance_id field");
    assert("db_id" in result5, "Result has db_id field");
    assert("schema_version" in result5, "Result has schema_version field");
    assert("protocol_version" in result5, "Result has protocol_version field");
    assert("port" in result5, "Result has port field");
    assert("pid" in result5, "Result has pid field");
    assert("uptime_seconds" in result5, "Result has uptime_seconds field");

    // Verify JSON is serializable
    const jsonStr = JSON.stringify(result5);
    assert(jsonStr.length > 0, "Result is JSON serializable");
    const parsed = JSON.parse(jsonStr);
    assert(parsed.status === "running", "Parsed JSON has correct status");
    console.log();

    // Test 6: Verify auth_token NOT leaked in output
    console.log("Test 6: Auth token security");

    const resultJson = JSON.stringify(result5);
    assert(
      !resultJson.includes("valid-token-789"),
      "Auth token NOT in JSON output"
    );
    assert(!resultJson.includes("auth_token"), "No auth_token field in output");
    console.log();

    // Cleanup
    await restoredHub.stop();
    await removeServerJson({ workspaceRoot: root });
  } finally {
    // Clean up temp workspace
    try {
      await rm(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Warning: Failed to clean up ${tmpRoot}:`, err);
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error("\n❌ Verification FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ All tests passed!");
    process.exit(0);
  }
}

test().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
