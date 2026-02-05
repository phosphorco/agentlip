/**
 * Verification script for config loader
 * 
 * Tests that config types are exported and loader works correctly
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { loadWorkspaceConfig, type WorkspaceConfig } from "./src/index";

async function verify() {
  console.log("✓ Config types exported successfully");

  // Create test workspace
  const testRoot = join(
    tmpdir(),
    `verify-config-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(testRoot, { recursive: true });

  try {
    // Test 1: Missing config returns null
    console.log("\n[Test 1] Missing config file...");
    const result1 = await loadWorkspaceConfig(testRoot);
    if (result1 !== null) {
      throw new Error("Expected null for missing config");
    }
    console.log("✓ Returns null for missing config");

    // Test 2: Valid config loads
    console.log("\n[Test 2] Loading valid config...");
    const configPath = join(testRoot, "agentlip.config.ts");
    await writeFile(
      configPath,
      `
      export default {
        plugins: [
          {
            name: "test-plugin",
            type: "linkifier",
            enabled: true,
            module: "./plugins/test.ts",
            config: { foo: "bar" }
          }
        ],
        rateLimits: {
          perConnection: 100,
          global: 1000
        }
      };
      `
    );

    const result2 = await loadWorkspaceConfig(testRoot);
    if (!result2) {
      throw new Error("Expected config to load");
    }
    if (result2.config.plugins?.length !== 1) {
      throw new Error("Expected 1 plugin");
    }
    if (result2.config.plugins[0].name !== "test-plugin") {
      throw new Error("Expected plugin name to be 'test-plugin'");
    }
    if (result2.config.rateLimits?.perConnection !== 100) {
      throw new Error("Expected perConnection to be 100");
    }
    console.log("✓ Valid config loaded successfully");
    console.log(`  Plugin: ${result2.config.plugins[0].name}`);
    console.log(`  Type: ${result2.config.plugins[0].type}`);
    console.log(`  Rate limit: ${result2.config.rateLimits?.perConnection}/s`);

    // Test 3: Path traversal protection
    console.log("\n[Test 3] Path traversal protection...");
    // Clear module cache by using a separate test directory
    const testRoot2 = join(
      tmpdir(),
      `verify-config-evil-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testRoot2, { recursive: true });
    const evilConfigPath = join(testRoot2, "agentlip.config.ts");
    await writeFile(
      evilConfigPath,
      `
      export default {
        plugins: [
          {
            name: "evil",
            type: "linkifier",
            enabled: true,
            module: "../../../etc/passwd"
          }
        ]
      };
      `
    );

    try {
      await loadWorkspaceConfig(testRoot2);
      throw new Error("Expected path traversal to be rejected");
    } catch (err: any) {
      if (!err.message.includes("escapes workspace root")) {
        throw new Error(
          `Expected 'escapes workspace root' error, got: ${err.message}`
        );
      }
      console.log("✓ Path traversal rejected");
    } finally {
      await rm(testRoot2, { recursive: true, force: true });
    }

    console.log("\n✅ All verification tests passed!");
  } finally {
    // Cleanup
    await rm(testRoot, { recursive: true, force: true });
  }
}

verify().catch((err) => {
  console.error("\n❌ Verification failed:", err);
  process.exit(1);
});
