#!/usr/bin/env bun
/**
 * Verification script for hub health endpoint and localhost bind validation.
 * 
 * Tests:
 * 1. Server starts on random port
 * 2. GET /health returns correct JSON shape
 * 3. Binding to 0.0.0.0 fails by default
 * 4. Binding to 0.0.0.0 succeeds with allowUnsafeNetwork flag
 */

import { startHub, assertLocalhostBind } from "./src/index.js";
import type { HealthResponse } from "@agentlip/protocol";

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
  console.log("=== Agentlip Hub Health Endpoint Verification ===\n");
  
  // Test 1: assertLocalhostBind validation
  console.log("Test 1: Host validation");
  try {
    assertLocalhostBind("127.0.0.1");
    assert(true, "Accepts 127.0.0.1");
  } catch (e) {
    assert(false, `Should accept 127.0.0.1: ${e}`);
  }
  
  try {
    assertLocalhostBind("::1");
    assert(true, "Accepts ::1");
  } catch (e) {
    assert(false, `Should accept ::1: ${e}`);
  }
  
  try {
    assertLocalhostBind("localhost");
    assert(true, "Accepts localhost");
  } catch (e) {
    assert(false, `Should accept localhost: ${e}`);
  }
  
  try {
    assertLocalhostBind("0.0.0.0");
    assert(false, "Should reject 0.0.0.0 by default");
  } catch (e) {
    assert(true, "Rejects 0.0.0.0 by default");
  }
  
  try {
    assertLocalhostBind("0.0.0.0", { allowUnsafeNetwork: true });
    assert(true, "Accepts 0.0.0.0 with allowUnsafeNetwork flag");
  } catch (e) {
    assert(false, `Should accept 0.0.0.0 with flag: ${e}`);
  }
  
  try {
    assertLocalhostBind("192.168.1.1");
    assert(false, "Should reject arbitrary IP");
  } catch (e) {
    assert(true, "Rejects arbitrary IP addresses");
  }
  
  console.log();
  
  // Test 2: Start server and verify /health endpoint
  console.log("Test 2: Server startup and /health endpoint");
  
  const hub = await startHub({
    host: "127.0.0.1",
    port: 0, // Random port
    instanceId: "test-instance-123",
    dbId: "test-db-456",
    schemaVersion: 1,
  });
  
  assert(hub.port > 0, `Server bound to port ${hub.port}`);
  assert(hub.instanceId === "test-instance-123", "Instance ID set correctly");
  
  // Test /health endpoint
  const healthUrl = `http://127.0.0.1:${hub.port}/health`;
  console.log(`Fetching ${healthUrl}`);
  
  try {
    const response = await fetch(healthUrl);
    assert(response.status === 200, "Health endpoint returns 200");
    
    const data = await response.json() as HealthResponse;
    
    // Verify response shape
    assert(data.status === "ok", `status is "ok" (got: ${data.status})`);
    assert(data.instance_id === "test-instance-123", `instance_id correct (got: ${data.instance_id})`);
    assert(data.db_id === "test-db-456", `db_id correct (got: ${data.db_id})`);
    assert(data.schema_version === 1, `schema_version correct (got: ${data.schema_version})`);
    assert(data.protocol_version === "v1", `protocol_version is "v1" (got: ${data.protocol_version})`);
    assert(typeof data.pid === "number" && data.pid > 0, `pid is valid number (got: ${data.pid})`);
    assert(typeof data.uptime_seconds === "number" && data.uptime_seconds >= 0, `uptime_seconds is valid (got: ${data.uptime_seconds})`);
    
    console.log("\nHealth response:", JSON.stringify(data, null, 2));
  } catch (e) {
    assert(false, `Failed to fetch /health: ${e}`);
  }
  
  await hub.stop();
  assert(true, "Server stopped cleanly");
  
  console.log();
  
  // Test 3: Verify 0.0.0.0 binding fails by default
  console.log("Test 3: Network binding safety");
  
  try {
    await startHub({ host: "0.0.0.0" });
    assert(false, "Should not allow binding to 0.0.0.0 by default");
  } catch (e) {
    assert(true, "Prevents 0.0.0.0 binding by default");
  }
  
  // Test 4: Verify 0.0.0.0 binding succeeds with flag
  try {
    const unsafeHub = await startHub({
      host: "0.0.0.0",
      allowUnsafeNetwork: true,
    });
    assert(true, "Allows 0.0.0.0 binding with allowUnsafeNetwork flag");
    await unsafeHub.stop();
    assert(true, "Unsafe server stopped cleanly");
  } catch (e) {
    assert(false, `Should allow 0.0.0.0 with flag: ${e}`);
  }
  
  // Test 5: Verify 404 for unknown routes
  console.log();
  console.log("Test 5: Unknown routes");
  
  const testHub = await startHub({ port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${testHub.port}/unknown`);
    assert(response.status === 404, `Unknown route returns 404 (got: ${response.status})`);
  } catch (e) {
    assert(false, `Failed to test 404: ${e}`);
  }
  await testHub.stop();
  
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
