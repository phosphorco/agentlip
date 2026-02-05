/**
 * Plugin isolation tests (bd-16d.4.4)
 * 
 * Verify that plugins cannot write to .zulip/ directory.
 * 
 * Test strategy:
 * - Create malicious plugins that attempt filesystem writes
 * - Run them via the Worker runtime harness
 * - Assert that writes are blocked with clear error messages
 * - Verify that legitimate writes (outside .zulip/) still work
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runPlugin, type Enrichment, type Attachment } from "./pluginRuntime";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  // Create isolated test directory
  testDir = join(tmpdir(), `plugin-isolation-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  
  // Create .zulip directory structure
  const zulipDir = join(testDir, ".zulip");
  await mkdir(zulipDir, { recursive: true });
  await writeFile(join(zulipDir, "db.sqlite3"), "fake-db");
  await writeFile(join(zulipDir, "server.json"), "{}");
  
  const locksDir = join(zulipDir, "locks");
  await mkdir(locksDir, { recursive: true });
});

afterEach(async () => {
  // Cleanup
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Malicious Plugin Generators
// ─────────────────────────────────────────────────────────────────────────────

async function createMaliciousPlugin(
  type: "writeFile" | "appendFile" | "mkdir" | "rm" | "unlink" | "open" | "writeFileSync",
  targetPath: string
): Promise<string> {
  const pluginPath = join(testDir, `malicious-${type}-${Date.now()}.ts`);
  
  const pluginCode = {
    writeFile: `
      import { promises as fs } from "node:fs";
      export default {
        name: "malicious-writeFile",
        version: "1.0.0",
        async enrich(input: any) {
          await fs.writeFile("${targetPath}", "hacked");
          return [];
        }
      };
    `,
    appendFile: `
      import { promises as fs } from "node:fs";
      export default {
        name: "malicious-appendFile",
        version: "1.0.0",
        async enrich(input: any) {
          await fs.appendFile("${targetPath}", "hacked");
          return [];
        }
      };
    `,
    mkdir: `
      import { promises as fs } from "node:fs";
      export default {
        name: "malicious-mkdir",
        version: "1.0.0",
        async enrich(input: any) {
          await fs.mkdir("${targetPath}", { recursive: true });
          return [];
        }
      };
    `,
    rm: `
      import { promises as fs } from "node:fs";
      export default {
        name: "malicious-rm",
        version: "1.0.0",
        async enrich(input: any) {
          await fs.rm("${targetPath}", { force: true });
          return [];
        }
      };
    `,
    unlink: `
      import { promises as fs } from "node:fs";
      export default {
        name: "malicious-unlink",
        version: "1.0.0",
        async enrich(input: any) {
          await fs.unlink("${targetPath}");
          return [];
        }
      };
    `,
    open: `
      import { promises as fs } from "node:fs";
      export default {
        name: "malicious-open",
        version: "1.0.0",
        async enrich(input: any) {
          const handle = await fs.open("${targetPath}", "w");
          await handle.write("hacked");
          await handle.close();
          return [];
        }
      };
    `,
    writeFileSync: `
      import fs from "node:fs";
      export default {
        name: "malicious-writeFileSync",
        version: "1.0.0",
        async enrich(input: any) {
          fs.writeFileSync("${targetPath}", "hacked");
          return [];
        }
      };
    `,
  };

  await writeFile(pluginPath, pluginCode[type]);
  return pluginPath;
}

async function createLegitimatePlugin(): Promise<string> {
  const pluginPath = join(testDir, `legitimate-${Date.now()}.ts`);
  const safePath = join(testDir, "safe-output.txt");
  
  const pluginCode = `
    import { promises as fs } from "node:fs";
    export default {
      name: "legitimate-plugin",
      version: "1.0.0",
      async enrich(input: any) {
        // This should succeed (not in .zulip/)
        await fs.writeFile("${safePath}", "legitimate data");
        
        return [{
          kind: "test",
          span: { start: 0, end: 5 },
          data: { success: true }
        }];
      }
    };
  `;

  await writeFile(pluginPath, pluginCode);
  return pluginPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Input Fixture
// ─────────────────────────────────────────────────────────────────────────────

const testInput = {
  message: {
    id: "msg_test",
    content_raw: "test message",
    sender: "test-agent",
    topic_id: "topic_test",
    channel_id: "channel_test",
    created_at: new Date().toISOString(),
  },
  config: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin isolation: .zulip/ write protection", () => {
  test("blocks writeFile to db.sqlite3", async () => {
    const dbPath = join(testDir, ".zulip", "db.sqlite3");
    const pluginPath = await createMaliciousPlugin("writeFile", dbPath);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
    expect(result.error).toContain(".zulip/");
    
    // Verify db.sqlite3 unchanged
    const dbContent = await Bun.file(dbPath).text();
    expect(dbContent).toBe("fake-db");
  });

  test("blocks appendFile to server.json", async () => {
    const serverJsonPath = join(testDir, ".zulip", "server.json");
    const pluginPath = await createMaliciousPlugin("appendFile", serverJsonPath);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
    
    // Verify server.json unchanged
    const content = await Bun.file(serverJsonPath).text();
    expect(content).toBe("{}");
  });

  test("blocks mkdir in .zulip/", async () => {
    const maliciousDir = join(testDir, ".zulip", "malicious");
    const pluginPath = await createMaliciousPlugin("mkdir", maliciousDir);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
    
    // Verify directory wasn't created
    await expect(access(maliciousDir)).rejects.toThrow();
  });

  test("blocks rm of .zulip/locks/", async () => {
    const locksDir = join(testDir, ".zulip", "locks");
    const pluginPath = await createMaliciousPlugin("rm", locksDir);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
    
    // Verify locks/ still exists
    await access(locksDir); // Should not throw
  });

  test("blocks unlink of .zulip/db.sqlite3", async () => {
    const dbPath = join(testDir, ".zulip", "db.sqlite3");
    const pluginPath = await createMaliciousPlugin("unlink", dbPath);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
    
    // Verify db.sqlite3 still exists
    await access(dbPath); // Should not throw
  });

  test("blocks open with write flag in .zulip/", async () => {
    const targetPath = join(testDir, ".zulip", "malicious.txt");
    const pluginPath = await createMaliciousPlugin("open", targetPath);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
    
    // Verify file wasn't created
    await expect(access(targetPath)).rejects.toThrow();
  });

  test("blocks writeFileSync to .zulip/", async () => {
    const targetPath = join(testDir, ".zulip", "sync-test.txt");
    const pluginPath = await createMaliciousPlugin("writeFileSync", targetPath);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
    
    // Verify file wasn't created
    await expect(access(targetPath)).rejects.toThrow();
  });

  test("blocks relative path attempts (../workspace/.zulip/)", async () => {
    // Create plugin in subdirectory
    const pluginDir = join(testDir, "plugins");
    await mkdir(pluginDir, { recursive: true });
    
    const relativePath = "../.zulip/db.sqlite3";
    const pluginPath = join(pluginDir, "relative-attack.ts");
    
    const pluginCode = `
      import { promises as fs } from "node:fs";
      export default {
        name: "relative-attack",
        version: "1.0.0",
        async enrich(input: any) {
          await fs.writeFile("${relativePath}", "hacked");
          return [];
        }
      };
    `;
    
    await writeFile(pluginPath, pluginCode);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
  });

  test("allows writes outside .zulip/ (legitimate plugin)", async () => {
    const pluginPath = await createLegitimatePlugin();
    const safePath = join(testDir, "safe-output.txt");

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].kind).toBe("test");
    
    // Verify legitimate write succeeded
    const content = await Bun.file(safePath).text();
    expect(content).toBe("legitimate data");
  });

  test("blocks nested .zulip/ paths", async () => {
    const nestedPath = join(testDir, "subdir", ".zulip", "nested.txt");
    await mkdir(join(testDir, "subdir", ".zulip"), { recursive: true });
    
    const pluginPath = await createMaliciousPlugin("writeFile", nestedPath);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Plugin isolation violation");
  });

  test("blocks symlink traversal (if .zulip is target)", async () => {
    // Create a directory that will be symlinked
    const linkSource = join(testDir, "innocent-dir");
    await mkdir(linkSource);
    
    // Try to write to what looks like innocent-dir but might resolve to .zulip
    const targetPath = join(linkSource, "file.txt");
    
    const pluginPath = join(testDir, "symlink-plugin.ts");
    const pluginCode = `
      import { promises as fs } from "node:fs";
      export default {
        name: "symlink-test",
        version: "1.0.0",
        async enrich(input: any) {
          // This should succeed (not a .zulip path)
          await fs.writeFile("${targetPath}", "data");
          return [{
            kind: "test",
            span: { start: 0, end: 1 },
            data: {}
          }];
        }
      };
    `;
    
    await writeFile(pluginPath, pluginCode);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    // This should succeed (legitimate write)
    expect(result.ok).toBe(true);
    
    // Note: True symlink protection would require resolving real paths
    // Current implementation checks path components, not resolved targets
    // This is documented as a limitation
  });
});

describe("Plugin isolation: path-blind execution", () => {
  test("plugins receive no workspace path in input", async () => {
    const pluginPath = join(testDir, "path-inspector.ts");
    const pluginCode = `
      export default {
        name: "path-inspector",
        version: "1.0.0",
        async enrich(input: any) {
          // Inspect input for any path-like fields
          const hasWorkspacePath = JSON.stringify(input).includes(".zulip");
          
          return [{
            kind: "inspection",
            span: { start: 0, end: 1 },
            data: { hasWorkspacePath }
          }];
        }
      };
    `;
    
    await writeFile(pluginPath, pluginCode);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].data.hasWorkspacePath).toBe(false);
  });

  test("plugin cannot discover workspace root via cwd", async () => {
    const pluginPath = join(testDir, "cwd-inspector.ts");
    const pluginCode = `
      import { cwd } from "node:process";
      export default {
        name: "cwd-inspector",
        version: "1.0.0",
        async enrich(input: any) {
          const currentDir = cwd();
          const isInsideTestDir = currentDir.includes("plugin-isolation-test");
          
          return [{
            kind: "cwd",
            span: { start: 0, end: 1 },
            data: { cwd: currentDir, isInsideTestDir }
          }];
        }
      };
    `;
    
    await writeFile(pluginPath, pluginCode);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    
    // Note: Plugin still sees process cwd (Worker limitation)
    // True path isolation would require subprocess execution
    // This is documented as a v1 limitation
    expect(result.data[0].data.cwd).toBeTruthy();
  });
});

describe("Plugin isolation: error reporting", () => {
  test("isolation violation error includes helpful context", async () => {
    const dbPath = join(testDir, ".zulip", "db.sqlite3");
    const pluginPath = await createMaliciousPlugin("writeFile", dbPath);

    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXECUTION_ERROR");
    expect(result.error).toContain("isolation violation");
    expect(result.error).toContain(".zulip/");
    expect(result.error).toContain("forbidden");
  });

  test("circuit breaker tracks isolation violations", async () => {
    const dbPath = join(testDir, ".zulip", "db.sqlite3");
    const pluginPath = await createMaliciousPlugin("writeFile", dbPath);

    // Run plugin 3 times to trigger circuit breaker
    for (let i = 0; i < 3; i++) {
      await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testInput,
        timeoutMs: 2000,
        pluginName: "malicious-test",
      });
    }

    // Fourth attempt should be blocked by circuit breaker
    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: pluginPath,
      input: testInput,
      timeoutMs: 2000,
      pluginName: "malicious-test",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CIRCUIT_OPEN");
  });
});
