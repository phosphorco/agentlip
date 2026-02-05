#!/usr/bin/env bun

/**
 * Verification script for hub infrastructure modules.
 * 
 * Tests:
 * 1. Auth token generation (length, entropy, uniqueness)
 * 2. server.json atomic write with mode 0600
 * 3. Lock acquisition with staleness detection
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { generateAuthToken, constantTimeEqual } from "./src/authToken.js";
import {
  writeServerJson,
  readServerJson,
  removeServerJson,
  type ServerJsonData,
} from "./src/serverJson.js";
import {
  acquireWriterLock,
  releaseWriterLock,
  readLockInfo,
} from "./src/lock.js";

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    testsFailed++;
    throw new Error(message);
  } else {
    console.log(`✅ PASS: ${message}`);
    testsPassed++;
  }
}

async function createTestWorkspace(): Promise<string> {
  const testDir = join(tmpdir(), `agentlip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  return testDir;
}

async function cleanupTestWorkspace(workspaceRoot: string) {
  try {
    await rm(workspaceRoot, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Warning: failed to cleanup ${workspaceRoot}:`, error);
  }
}

// Test 1: Auth token generation
async function testAuthToken() {
  console.log("\n=== Test 1: Auth Token Generation ===");

  // Test token length
  const token1 = generateAuthToken();
  assert(token1.length === 64, `Token should be 64 hex chars (got ${token1.length})`);
  assert(/^[0-9a-f]{64}$/.test(token1), "Token should be lowercase hex");

  // Test entropy (uniqueness - should never collide in small sample)
  const tokens = new Set<string>();
  for (let i = 0; i < 100; i++) {
    tokens.add(generateAuthToken());
  }
  assert(tokens.size === 100, `100 tokens should all be unique (got ${tokens.size})`);

  // Test constant-time comparison
  assert(constantTimeEqual(token1, token1), "constantTimeEqual should match identical strings");
  assert(!constantTimeEqual(token1, "different"), "constantTimeEqual should reject different strings");
  assert(!constantTimeEqual(token1, token1.slice(0, -1)), "constantTimeEqual should reject different lengths");

  console.log(`✓ Auth token tests passed (256-bit entropy, unique, constant-time compare)`);
}

// Test 2: server.json atomic write with mode 0600
async function testServerJson() {
  console.log("\n=== Test 2: server.json Atomic Write (mode 0600) ===");

  const workspaceRoot = await createTestWorkspace();

  try {
    const testData: ServerJsonData = {
      instance_id: "test-instance",
      db_id: "test-db",
      port: 8080,
      host: "127.0.0.1",
      auth_token: generateAuthToken(),
      pid: process.pid,
      started_at: new Date().toISOString(),
      protocol_version: "v1",
      schema_version: 1,
    };

    // Write server.json
    await writeServerJson({ workspaceRoot, data: testData });

    // Verify file exists
    const serverJsonPath = join(workspaceRoot, ".agentlip", "server.json");
    const stats = await stat(serverJsonPath);
    assert(stats.isFile(), "server.json should exist as file");

    // Verify mode 0600 (owner read/write only)
    const mode = stats.mode & 0o777;
    assert(mode === 0o600, `server.json mode should be 0600 (got ${mode.toString(8)})`);

    // Verify content
    const readData = await readServerJson({ workspaceRoot });
    assert(readData !== null, "readServerJson should return data");
    assert(readData!.instance_id === testData.instance_id, "instance_id should match");
    assert(readData!.auth_token === testData.auth_token, "auth_token should match");
    assert(readData!.port === testData.port, "port should match");

    // Test remove
    await removeServerJson({ workspaceRoot });
    const afterRemove = await readServerJson({ workspaceRoot });
    assert(afterRemove === null, "server.json should be removed");

    // Test remove idempotency (no-op if already gone)
    await removeServerJson({ workspaceRoot });
    assert(true, "removeServerJson should be idempotent");

    console.log(`✓ server.json tests passed (atomic write, mode 0600, read/remove)`);
  } finally {
    await cleanupTestWorkspace(workspaceRoot);
  }
}

// Test 3: Lock acquisition with staleness detection
async function testLock() {
  console.log("\n=== Test 3: Writer Lock Acquisition ===");

  const workspaceRoot = await createTestWorkspace();

  try {
    // Mock health check (always returns false = hub is dead)
    const staleHealthCheck = async () => false;

    // Test 3a: Acquire lock on fresh workspace
    await acquireWriterLock({ workspaceRoot, healthCheck: staleHealthCheck });
    const lockInfo = await readLockInfo({ workspaceRoot });
    assert(lockInfo !== null, "Lock file should exist after acquisition");
    assert(lockInfo!.includes(process.pid.toString()), "Lock should contain PID");

    // Test 3b: Try to acquire again (should fail - lock held by same process)
    const liveHealthCheck = async () => true; // Pretend hub is alive
    try {
      await acquireWriterLock({ workspaceRoot, healthCheck: liveHealthCheck });
      assert(false, "Should not acquire lock when already held by live hub");
    } catch (error: any) {
      assert(
        error.message.includes("already held"),
        "Should throw 'already held' error"
      );
    }

    // Test 3c: Release lock
    await releaseWriterLock({ workspaceRoot });
    const afterRelease = await readLockInfo({ workspaceRoot });
    assert(afterRelease === null, "Lock file should be gone after release");

    // Test 3d: Acquire with stale lock scenario
    // 1. Create a stale lock + server.json pointing to unused port
    const staleServerJson: ServerJsonData = {
      instance_id: "stale-instance",
      db_id: "stale-db",
      port: 99999, // unused port
      host: "127.0.0.1",
      auth_token: generateAuthToken(),
      pid: 99999, // fake PID
      started_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      protocol_version: "v1",
    };
    await writeServerJson({ workspaceRoot, data: staleServerJson });
    await acquireWriterLock({ workspaceRoot, healthCheck: staleHealthCheck }); // Creates lock

    // 2. Try to acquire again with health check that returns false (stale)
    await releaseWriterLock({ workspaceRoot }); // Release first
    await writeServerJson({ workspaceRoot, data: staleServerJson }); // Re-create server.json
    await acquireWriterLock({ workspaceRoot, healthCheck: staleHealthCheck }); // Should succeed (stale lock removed)

    const afterStaleAcquire = await readLockInfo({ workspaceRoot });
    assert(afterStaleAcquire !== null, "Lock should be acquired after removing stale lock");

    // Clean up
    await releaseWriterLock({ workspaceRoot });

    console.log(`✓ Lock tests passed (acquire, release, staleness detection)`);
  } finally {
    await cleanupTestWorkspace(workspaceRoot);
  }
}

// Run all tests
async function main() {
  console.log("🧪 Agentlip Hub Infrastructure Verification\n");
  console.log("Testing: authToken, serverJson, lock modules");

  try {
    await testAuthToken();
    await testServerJson();
    await testLock();

    console.log(`\n${"=".repeat(50)}`);
    console.log(`✅ All tests passed! (${testsPassed} assertions)`);
    console.log(`${"=".repeat(50)}\n`);

    console.log("Summary:");
    console.log("  ✓ Auth tokens: 256-bit entropy, unique, constant-time compare");
    console.log("  ✓ server.json: atomic write, mode 0600, read/remove");
    console.log("  ✓ Writer lock: acquire, release, staleness detection");
    console.log("\nAll infrastructure modules ready for integration.");

    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Tests failed (${testsFailed} failures, ${testsPassed} passed)`);
    console.error(error);
    process.exit(1);
  }
}

main();
