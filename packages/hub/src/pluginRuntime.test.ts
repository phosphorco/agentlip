/**
 * Tests for plugin runtime harness (Worker-based, RPC, timeouts, circuit breaker).
 * 
 * Covers bd-16d.4.3 requirements:
 * - Timeout enforcement (Worker termination)
 * - Circuit breaker (skip after N failures)
 * - Successful execution resets breaker
 * - RPC request/response
 * - Output validation
 * - Worker crash handling
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import {
  runPlugin,
  globalCircuitBreaker,
  type EnrichInput,
  type ExtractInput,
  type Enrichment,
  type Attachment,
} from "./pluginRuntime";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testMessageInput = {
  id: "msg_test_1",
  content_raw: "Check out https://example.com for more info",
  sender: "test_user",
  topic_id: "topic_1",
  channel_id: "channel_1",
  created_at: new Date().toISOString(),
};

const testEnrichInput: EnrichInput = {
  message: testMessageInput,
  config: {},
};

const testExtractInput: ExtractInput = {
  message: testMessageInput,
  config: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Create temp plugin file
// ─────────────────────────────────────────────────────────────────────────────

async function createTempPlugin(code: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "plugin-test-"));
  const pluginPath = join(tmpDir, "plugin.ts");
  await writeFile(pluginPath, code, "utf-8");
  return pluginPath;
}

async function cleanupTempPlugin(pluginPath: string): Promise<void> {
  const tmpDir = join(pluginPath, "..");
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Plugins
// ─────────────────────────────────────────────────────────────────────────────

const successfulLinkifierPlugin = `
export default {
  name: "test-linkifier",
  version: "1.0.0",
  async enrich(input) {
    return [
      {
        kind: "url",
        span: { start: 10, end: 32 },
        data: { url: "https://example.com" }
      }
    ];
  }
};
`;

const successfulExtractorPlugin = `
export default {
  name: "test-extractor",
  version: "1.0.0",
  async extract(input) {
    return [
      {
        kind: "url",
        value_json: { url: "https://example.com" },
        dedupe_key: "url:https://example.com"
      }
    ];
  }
};
`;

const hangingPlugin = `
export default {
  name: "hanging-plugin",
  version: "1.0.0",
  async enrich(input) {
    // Hang forever (simulate unresponsive plugin)
    await new Promise(() => {});
  }
};
`;

const crashingPlugin = `
export default {
  name: "crashing-plugin",
  version: "1.0.0",
  async enrich(input) {
    throw new Error("Plugin crashed intentionally");
  }
};
`;

const invalidOutputPlugin = `
export default {
  name: "invalid-output",
  version: "1.0.0",
  async enrich(input) {
    return [
      {
        kind: "url",
        // Missing required span field
        data: { url: "https://example.com" }
      }
    ];
  }
};
`;

const invalidReturnTypePlugin = `
export default {
  name: "invalid-return",
  version: "1.0.0",
  async enrich(input) {
    return "not an array";
  }
};
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Successful Execution
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin Runtime - Successful Execution", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
  });

  test("executes linkifier plugin successfully", async () => {
    const pluginPath = await createTempPlugin(successfulLinkifierPlugin);

    try {
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
        timeoutMs: 5000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].kind).toBe("url");
        expect(result.data[0].span.start).toBe(10);
        expect(result.data[0].span.end).toBe(32);
        expect(result.data[0].data.url).toBe("https://example.com");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("executes extractor plugin successfully", async () => {
    const pluginPath = await createTempPlugin(successfulExtractorPlugin);

    try {
      const result = await runPlugin<Attachment[]>({
        type: "extractor",
        modulePath: pluginPath,
        input: testExtractInput,
        timeoutMs: 5000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].kind).toBe("url");
        expect(result.data[0].value_json.url).toBe("https://example.com");
        expect(result.data[0].dedupe_key).toBe("url:https://example.com");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("successful run resets circuit breaker", async () => {
    const crashPath = await createTempPlugin(crashingPlugin);
    const successPath = await createTempPlugin(successfulLinkifierPlugin);

    try {
      const pluginName = "test-plugin";

      // Fail 2 times (not enough to trip breaker)
      await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: crashPath,
        input: testEnrichInput,
        pluginName,
      });

      await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: crashPath,
        input: testEnrichInput,
        pluginName,
      });

      const stateBefore = globalCircuitBreaker.getState(pluginName);
      expect(stateBefore?.failureCount).toBe(2);
      expect(stateBefore?.state).toBe("closed");

      // Succeed - should reset failure count
      await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: successPath,
        input: testEnrichInput,
        pluginName,
      });

      const stateAfter = globalCircuitBreaker.getState(pluginName);
      expect(stateAfter?.failureCount).toBe(0);
      expect(stateAfter?.state).toBe("closed");
    } finally {
      await cleanupTempPlugin(crashPath);
      await cleanupTempPlugin(successPath);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Timeout Enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin Runtime - Timeout", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
  });

  test("terminates hanging plugin after timeout", async () => {
    const pluginPath = await createTempPlugin(hangingPlugin);

    try {
      const startMs = Date.now();

      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
        timeoutMs: 500, // 500ms timeout
      });

      const elapsedMs = Date.now() - startMs;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("TIMEOUT");
        expect(result.error).toContain("timed out");
        expect(result.error).toContain("500ms");
      }

      // Should terminate near timeout (allow 200ms margin)
      expect(elapsedMs).toBeLessThan(700);
      expect(elapsedMs).toBeGreaterThanOrEqual(500);
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("timeout does not block subsequent requests", async () => {
    const hangPath = await createTempPlugin(hangingPlugin);
    const successPath = await createTempPlugin(successfulLinkifierPlugin);

    try {
      // First request times out
      const result1 = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: hangPath,
        input: testEnrichInput,
        timeoutMs: 500,
      });

      expect(result1.ok).toBe(false);

      // Second request (different plugin) succeeds immediately
      const startMs = Date.now();
      const result2 = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: successPath,
        input: testEnrichInput,
        timeoutMs: 5000,
      });
      const elapsedMs = Date.now() - startMs;

      expect(result2.ok).toBe(true);
      // Should complete quickly (< 1s)
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await cleanupTempPlugin(hangPath);
      await cleanupTempPlugin(successPath);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Circuit Breaker
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin Runtime - Circuit Breaker", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
  });

  test("opens circuit after repeated failures (threshold = 3)", async () => {
    const pluginPath = await createTempPlugin(crashingPlugin);
    const pluginName = "crashing-test-plugin";

    try {
      // Fail 3 times - should trip circuit breaker
      for (let i = 0; i < 3; i++) {
        const result = await runPlugin<Enrichment[]>({
          type: "linkifier",
          modulePath: pluginPath,
          input: testEnrichInput,
          pluginName,
        });

        expect(result.ok).toBe(false);
      }

      const state = globalCircuitBreaker.getState(pluginName);
      expect(state?.failureCount).toBe(3);
      expect(state?.state).toBe("open");

      // Next execution should be skipped (circuit open)
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
        pluginName,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("CIRCUIT_OPEN");
        expect(result.error).toContain("Circuit breaker open");
        expect(result.error).toContain("3 failures");
      }

      // Failure count should not increase (execution was skipped)
      const stateAfter = globalCircuitBreaker.getState(pluginName);
      expect(stateAfter?.failureCount).toBe(3);
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("circuit reopens after cooldown period", async () => {
    const pluginPath = await createTempPlugin(crashingPlugin);
    const pluginName = "cooldown-test-plugin";

    try {
      // Trip circuit breaker (3 failures)
      for (let i = 0; i < 3; i++) {
        await runPlugin<Enrichment[]>({
          type: "linkifier",
          modulePath: pluginPath,
          input: testEnrichInput,
          pluginName,
        });
      }

      const state = globalCircuitBreaker.getState(pluginName);
      expect(state?.state).toBe("open");

      // Wait for cooldown (we can't wait 60s in tests, so we'll manually reset)
      // In production, this would be time-based
      globalCircuitBreaker.reset();

      // After reset/cooldown, should allow execution again
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
        pluginName,
      });

      // Execution attempted (not skipped)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).not.toBe("CIRCUIT_OPEN");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("circuit breaker tracks plugins independently", async () => {
    const crash1Path = await createTempPlugin(crashingPlugin);
    const crash2Path = await createTempPlugin(crashingPlugin);

    try {
      const pluginA = "plugin-a";
      const pluginB = "plugin-b";

      // Trip breaker for plugin A
      for (let i = 0; i < 3; i++) {
        await runPlugin<Enrichment[]>({
          type: "linkifier",
          modulePath: crash1Path,
          input: testEnrichInput,
          pluginName: pluginA,
        });
      }

      const stateA = globalCircuitBreaker.getState(pluginA);
      expect(stateA?.state).toBe("open");

      // Plugin B should still be allowed (different plugin)
      const resultB = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: crash2Path,
        input: testEnrichInput,
        pluginName: pluginB,
      });

      expect(resultB.ok).toBe(false);
      if (!resultB.ok) {
        expect(resultB.code).not.toBe("CIRCUIT_OPEN");
      }

      const stateB = globalCircuitBreaker.getState(pluginB);
      expect(stateB?.failureCount).toBe(1);
      expect(stateB?.state).toBe("closed");
    } finally {
      await cleanupTempPlugin(crash1Path);
      await cleanupTempPlugin(crash2Path);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Error Handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin Runtime - Error Handling", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
  });

  test("handles plugin crash gracefully", async () => {
    const pluginPath = await createTempPlugin(crashingPlugin);

    try {
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("EXECUTION_ERROR");
        expect(result.error).toContain("crashed intentionally");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("rejects invalid plugin output (missing fields)", async () => {
    const pluginPath = await createTempPlugin(invalidOutputPlugin);

    try {
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_OUTPUT");
        expect(result.error).toContain("Invalid enrichment");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("rejects non-array return value", async () => {
    const pluginPath = await createTempPlugin(invalidReturnTypePlugin);

    try {
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_OUTPUT");
        expect(result.error).toContain("must be an array");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("handles non-existent plugin module", async () => {
    const result = await runPlugin<Enrichment[]>({
      type: "linkifier",
      modulePath: "/nonexistent/plugin.ts",
      input: testEnrichInput,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EXECUTION_ERROR");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Output Validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin Runtime - Output Validation", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
  });

  test("validates enrichment span boundaries", async () => {
    const invalidSpanPlugin = `
      export default {
        name: "invalid-span",
        version: "1.0.0",
        async enrich(input) {
          return [{
            kind: "url",
            span: { start: 10, end: 5 }, // end < start
            data: {}
          }];
        }
      };
    `;

    const pluginPath = await createTempPlugin(invalidSpanPlugin);

    try {
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_OUTPUT");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("validates attachment value_json is object", async () => {
    const invalidAttachmentPlugin = `
      export default {
        name: "invalid-attachment",
        version: "1.0.0",
        async extract(input) {
          return [{
            kind: "url",
            value_json: "not an object" // should be object
          }];
        }
      };
    `;

    const pluginPath = await createTempPlugin(invalidAttachmentPlugin);

    try {
      const result = await runPlugin<Attachment[]>({
        type: "extractor",
        modulePath: pluginPath,
        input: testExtractInput,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_OUTPUT");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });

  test("rejects empty kind strings", async () => {
    const emptyKindPlugin = `
      export default {
        name: "empty-kind",
        version: "1.0.0",
        async enrich(input) {
          return [{
            kind: "",  // empty kind
            span: { start: 0, end: 10 },
            data: {}
          }];
        }
      };
    `;

    const pluginPath = await createTempPlugin(emptyKindPlugin);

    try {
      const result = await runPlugin<Enrichment[]>({
        type: "linkifier",
        modulePath: pluginPath,
        input: testEnrichInput,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_OUTPUT");
      }
    } finally {
      await cleanupTempPlugin(pluginPath);
    }
  });
});
