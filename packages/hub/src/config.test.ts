/**
 * Tests for workspace config loader and schema validation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  validatePluginModulePath,
  type WorkspaceConfig,
} from "./config";

let testRoot: string;

beforeEach(async () => {
  // Create a unique test directory
  testRoot = join(
    tmpdir(),
    `agentlip-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  // Clean up test directory
  try {
    await fs.rm(testRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("loadWorkspaceConfig", () => {
  test("returns null when config file does not exist", async () => {
    const result = await loadWorkspaceConfig(testRoot);
    expect(result).toBeNull();
  });

  test("loads valid minimal config", async () => {
    // Create minimal valid config
    const configPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      configPath,
      `
      export default {
        plugins: []
      };
      `
    );

    const result = await loadWorkspaceConfig(testRoot);
    expect(result).not.toBeNull();
    expect(result!.config.plugins).toEqual([]);
    expect(result!.configPath).toBe(configPath);
  });

  test("loads valid config with all fields", async () => {
    const configPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      configPath,
      `
      export default {
        plugins: [
          {
            name: "test-plugin",
            type: "linkifier",
            enabled: true,
            config: { foo: "bar" }
          }
        ],
        rateLimits: {
          perConnection: 100,
          global: 1000
        },
        limits: {
          maxMessageSize: 65536,
          maxAttachmentSize: 16384
        },
        pluginDefaults: {
          timeout: 5000,
          memoryLimit: 134217728
        }
      };
      `
    );

    const result = await loadWorkspaceConfig(testRoot);
    expect(result).not.toBeNull();
    expect(result!.config.plugins).toHaveLength(1);
    expect(result!.config.plugins![0].name).toBe("test-plugin");
    expect(result!.config.rateLimits?.perConnection).toBe(100);
    expect(result!.config.limits?.maxMessageSize).toBe(65536);
    expect(result!.config.pluginDefaults?.timeout).toBe(5000);
  });

  test("throws on config with no default export", async () => {
    const configPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      configPath,
      `
      export const config = { plugins: [] };
      `
    );

    await expect(loadWorkspaceConfig(testRoot)).rejects.toThrow(
      "must have a default export"
    );
  });

  test("throws on config with syntax error", async () => {
    const configPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      configPath,
      `
      export default {
        plugins: [
          invalid syntax here
        ]
      };
      `
    );

    await expect(loadWorkspaceConfig(testRoot)).rejects.toThrow();
  });

  test("does NOT load config from parent directory when searching from child", async () => {
    // Create config in testRoot
    const parentConfigPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      parentConfigPath,
      `
      export default {
        plugins: [{ name: "parent", type: "linkifier", enabled: true }]
      };
      `
    );

    // Create child directory
    const childDir = join(testRoot, "child");
    await fs.mkdir(childDir);

    // Load from child - should return null (not traverse to parent)
    const result = await loadWorkspaceConfig(childDir);
    expect(result).toBeNull();
  });
});

describe("validateWorkspaceConfig", () => {
  test("accepts valid empty config", () => {
    const config = {};
    expect(() => validateWorkspaceConfig(config, testRoot)).not.toThrow();
  });

  test("accepts valid config with all fields", () => {
    const config: WorkspaceConfig = {
      plugins: [
        {
          name: "test",
          type: "linkifier",
          enabled: true,
          module: "./plugins/test.ts",
          config: { key: "value" },
        },
      ],
      rateLimits: {
        perConnection: 100,
        global: 1000,
      },
      limits: {
        maxMessageSize: 65536,
      },
      pluginDefaults: {
        timeout: 5000,
      },
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).not.toThrow();
  });

  test("rejects non-object config", () => {
    expect(() => validateWorkspaceConfig(null, testRoot)).toThrow(
      "Config must be an object"
    );
    expect(() => validateWorkspaceConfig("string", testRoot)).toThrow(
      "Config must be an object"
    );
    expect(() => validateWorkspaceConfig(123, testRoot)).toThrow(
      "Config must be an object"
    );
  });

  test("rejects invalid plugins array", () => {
    expect(() =>
      validateWorkspaceConfig({ plugins: "not-array" }, testRoot)
    ).toThrow("plugins must be an array");
  });

  test("rejects plugin with missing required fields", () => {
    const config = {
      plugins: [{ name: "test" }], // missing type, enabled
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).toThrow();
  });

  test("rejects plugin with invalid type", () => {
    const config = {
      plugins: [
        {
          name: "test",
          type: "invalid",
          enabled: true,
        },
      ],
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).toThrow(
      'type must be "linkifier" or "extractor"'
    );
  });

  test("rejects plugin with empty name", () => {
    const config = {
      plugins: [
        {
          name: "",
          type: "linkifier",
          enabled: true,
        },
      ],
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).toThrow(
      "must be a non-empty string"
    );
  });

  test("rejects plugin with non-boolean enabled", () => {
    const config = {
      plugins: [
        {
          name: "test",
          type: "linkifier",
          enabled: "true",
        },
      ],
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).toThrow(
      "enabled must be a boolean"
    );
  });

  test("rejects plugin with non-string module", () => {
    const config = {
      plugins: [
        {
          name: "test",
          type: "linkifier",
          enabled: true,
          module: 123,
        },
      ],
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).toThrow(
      "module must be a string"
    );
  });

  test("rejects plugin with path traversal in module", () => {
    const config = {
      plugins: [
        {
          name: "test",
          type: "linkifier",
          enabled: true,
          module: "../../../evil.ts",
        },
      ],
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).toThrow(
      "escapes workspace root"
    );
  });

  test("rejects plugin with non-object config", () => {
    const config = {
      plugins: [
        {
          name: "test",
          type: "linkifier",
          enabled: true,
          config: "not-object",
        },
      ],
    };

    expect(() => validateWorkspaceConfig(config, testRoot)).toThrow(
      "config must be an object"
    );
  });

  test("rejects invalid rateLimits", () => {
    expect(() =>
      validateWorkspaceConfig({ rateLimits: "not-object" }, testRoot)
    ).toThrow("rateLimits must be an object");

    expect(() =>
      validateWorkspaceConfig(
        { rateLimits: { perConnection: "not-number" } },
        testRoot
      )
    ).toThrow("perConnection must be a number");

    expect(() =>
      validateWorkspaceConfig(
        { rateLimits: { global: "not-number" } },
        testRoot
      )
    ).toThrow("global must be a number");
  });

  test("rejects invalid limits", () => {
    expect(() =>
      validateWorkspaceConfig({ limits: "not-object" }, testRoot)
    ).toThrow("limits must be an object");

    expect(() =>
      validateWorkspaceConfig(
        { limits: { maxMessageSize: "not-number" } },
        testRoot
      )
    ).toThrow("maxMessageSize must be a number");
  });

  test("rejects invalid pluginDefaults", () => {
    expect(() =>
      validateWorkspaceConfig({ pluginDefaults: "not-object" }, testRoot)
    ).toThrow("pluginDefaults must be an object");

    expect(() =>
      validateWorkspaceConfig(
        { pluginDefaults: { timeout: "not-number" } },
        testRoot
      )
    ).toThrow("timeout must be a number");

    expect(() =>
      validateWorkspaceConfig(
        { pluginDefaults: { memoryLimit: "not-number" } },
        testRoot
      )
    ).toThrow("memoryLimit must be a number");
  });
});

describe("validatePluginModulePath", () => {
  test("accepts relative path within workspace", () => {
    const modulePath = "./plugins/my-plugin.ts";
    const result = validatePluginModulePath(modulePath, testRoot);
    expect(result).toContain("plugins/my-plugin.ts");
  });

  test("accepts nested relative path within workspace", () => {
    const modulePath = "./deep/nested/path/plugin.ts";
    const result = validatePluginModulePath(modulePath, testRoot);
    expect(result).toContain("deep/nested/path/plugin.ts");
  });

  test("accepts absolute path within workspace", () => {
    const modulePath = join(testRoot, "plugins/my-plugin.ts");
    const result = validatePluginModulePath(modulePath, testRoot);
    expect(result).toBe(modulePath);
  });

  test("rejects path with .. that escapes workspace", () => {
    expect(() =>
      validatePluginModulePath("../evil.ts", testRoot)
    ).toThrow("escapes workspace root");

    expect(() =>
      validatePluginModulePath("../../evil.ts", testRoot)
    ).toThrow("escapes workspace root");

    expect(() =>
      validatePluginModulePath("./sub/../../../evil.ts", testRoot)
    ).toThrow("escapes workspace root");
  });

  test("rejects absolute path outside workspace", () => {
    const evilPath = "/tmp/evil.ts";
    expect(() =>
      validatePluginModulePath(evilPath, testRoot)
    ).toThrow("escapes workspace root");
  });

  test("accepts path with .. that stays within workspace", () => {
    const modulePath = "./sub/../plugins/ok.ts";
    const result = validatePluginModulePath(modulePath, testRoot);
    expect(result).toContain("plugins/ok.ts");
  });

  test("normalizes paths correctly", () => {
    const modulePath = "./sub/./nested/../plugin.ts";
    const result = validatePluginModulePath(modulePath, testRoot);
    expect(result).toContain("sub/plugin.ts");
  });
});

describe("integration: config loading with plugin path validation", () => {
  test("loads config with valid relative plugin path", async () => {
    // Create plugin file
    const pluginDir = join(testRoot, "plugins");
    await fs.mkdir(pluginDir);
    const pluginPath = join(pluginDir, "test-plugin.ts");
    await fs.writeFile(pluginPath, "export default {};");

    // Create config referencing plugin
    const configPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      configPath,
      `
      export default {
        plugins: [
          {
            name: "test",
            type: "linkifier",
            enabled: true,
            module: "./plugins/test-plugin.ts"
          }
        ]
      };
      `
    );

    const result = await loadWorkspaceConfig(testRoot);
    expect(result).not.toBeNull();
    expect(result!.config.plugins).toHaveLength(1);
    expect(result!.config.plugins![0].module).toBe("./plugins/test-plugin.ts");
  });

  test("rejects config with path traversal in plugin module", async () => {
    const configPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      configPath,
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

    await expect(loadWorkspaceConfig(testRoot)).rejects.toThrow(
      "escapes workspace root"
    );
  });

  test("accepts config with .. that stays within workspace", async () => {
    const configPath = join(testRoot, "agentlip.config.ts");
    await fs.writeFile(
      configPath,
      `
      export default {
        plugins: [
          {
            name: "ok",
            type: "linkifier",
            enabled: true,
            module: "./sub/../plugins/ok.ts"
          }
        ]
      };
      `
    );

    const result = await loadWorkspaceConfig(testRoot);
    expect(result).not.toBeNull();
  });
});
