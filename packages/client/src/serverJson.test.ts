/**
 * Tests for server.json reading and health validation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readServerJson, validateHub, discoverAndValidateHub } from "./serverJson";
import { ensureWorkspaceInitialized } from "./discovery";
import { PROTOCOL_VERSION, type HealthResponse } from "@agentlip/protocol";
import type { ServerJsonData } from "./types";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("readServerJson", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `agentlip-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await ensureWorkspaceInitialized(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("returns null when server.json doesn't exist", async () => {
    const result = await readServerJson(tempDir);
    expect(result).toBeNull();
  });

  test("reads valid server.json", async () => {
    const serverJson: ServerJsonData = {
      instance_id: "test-instance-123",
      db_id: "test-db-456",
      port: 8080,
      host: "localhost",
      auth_token: "test-token-abc",
      pid: 12345,
      started_at: new Date().toISOString(),
      protocol_version: PROTOCOL_VERSION,
      schema_version: 1,
    };

    const serverJsonPath = join(tempDir, ".agentlip", "server.json");
    await fs.writeFile(serverJsonPath, JSON.stringify(serverJson, null, 2));

    const result = await readServerJson(tempDir);
    
    expect(result).not.toBeNull();
    expect(result?.instance_id).toBe("test-instance-123");
    expect(result?.db_id).toBe("test-db-456");
    expect(result?.port).toBe(8080);
    expect(result?.auth_token).toBe("test-token-abc");
  });

  test("throws on invalid JSON", async () => {
    const serverJsonPath = join(tempDir, ".agentlip", "server.json");
    await fs.writeFile(serverJsonPath, "{ invalid json }");

    await expect(readServerJson(tempDir)).rejects.toThrow();
  });

  test("throws on missing required fields", async () => {
    const serverJsonPath = join(tempDir, ".agentlip", "server.json");
    await fs.writeFile(serverJsonPath, JSON.stringify({ port: 8080 }));

    await expect(readServerJson(tempDir)).rejects.toThrow("missing required fields");
  });
});

describe("validateHub", () => {
  test("validates successful health check", async () => {
    // Start a minimal test server
    const server = Bun.serve({
      port: 0, // Random port
      fetch(req) {
        const health: HealthResponse = {
          status: "ok",
          instance_id: "test-instance",
          db_id: "test-db",
          schema_version: 1,
          protocol_version: PROTOCOL_VERSION,
          pid: 12345,
          uptime_seconds: 100,
        };
        return new Response(JSON.stringify(health), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const serverJson: ServerJsonData = {
        instance_id: "test-instance",
        db_id: "test-db",
        port: server.port!,
        host: "localhost",
        auth_token: "test-token",
        pid: 12345,
        started_at: new Date().toISOString(),
        protocol_version: PROTOCOL_VERSION,
      };

      const result = await validateHub(serverJson);

      expect(result.valid).toBe(true);
      expect(result.health).toBeDefined();
      expect(result.health?.status).toBe("ok");
      expect(result.health?.protocol_version).toBe(PROTOCOL_VERSION);
      expect(result.health?.schema_version).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("fails on protocol version mismatch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const health: HealthResponse = {
          status: "ok",
          instance_id: "test-instance",
          db_id: "test-db",
          schema_version: 1,
          protocol_version: "v999" as any, // Wrong version
          pid: 12345,
          uptime_seconds: 100,
        };
        return new Response(JSON.stringify(health));
      },
    });

    try {
      const serverJson: ServerJsonData = {
        instance_id: "test-instance",
        db_id: "test-db",
        port: server.port!,
        host: "localhost",
        auth_token: "test-token",
        pid: 12345,
        started_at: new Date().toISOString(),
        protocol_version: PROTOCOL_VERSION,
      };

      const result = await validateHub(serverJson);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Protocol version mismatch");
    } finally {
      server.stop();
    }
  });

  test("fails on invalid schema version", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const health: HealthResponse = {
          status: "ok",
          instance_id: "test-instance",
          db_id: "test-db",
          schema_version: 0, // Invalid
          protocol_version: PROTOCOL_VERSION,
          pid: 12345,
          uptime_seconds: 100,
        };
        return new Response(JSON.stringify(health));
      },
    });

    try {
      const serverJson: ServerJsonData = {
        instance_id: "test-instance",
        db_id: "test-db",
        port: server.port!,
        host: "localhost",
        auth_token: "test-token",
        pid: 12345,
        started_at: new Date().toISOString(),
        protocol_version: PROTOCOL_VERSION,
      };

      const result = await validateHub(serverJson);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Invalid schema version");
    } finally {
      server.stop();
    }
  });

  test("fails on HTTP error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response("Unauthorized", { status: 401 });
      },
    });

    try {
      const serverJson: ServerJsonData = {
        instance_id: "test-instance",
        db_id: "test-db",
        port: server.port!,
        host: "localhost",
        auth_token: "wrong-token",
        pid: 12345,
        started_at: new Date().toISOString(),
        protocol_version: PROTOCOL_VERSION,
      };

      const result = await validateHub(serverJson);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("HTTP 401");
    } finally {
      server.stop();
    }
  });

  test("fails on connection error", async () => {
    const serverJson: ServerJsonData = {
      instance_id: "test-instance",
      db_id: "test-db",
      port: 9999, // Non-existent server
      host: "localhost",
      auth_token: "test-token",
      pid: 12345,
      started_at: new Date().toISOString(),
      protocol_version: PROTOCOL_VERSION,
    };

    const result = await validateHub(serverJson);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Connection failed");
  });
});

describe("discoverAndValidateHub", () => {
  let tempDir: string;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `agentlip-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await ensureWorkspaceInitialized(tempDir);

    // Start test server
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const health: HealthResponse = {
          status: "ok",
          instance_id: "test-instance",
          db_id: "test-db",
          schema_version: 1,
          protocol_version: PROTOCOL_VERSION,
          pid: 12345,
          uptime_seconds: 100,
        };
        return new Response(JSON.stringify(health));
      },
    });
  });

  afterEach(async () => {
    server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("discovers and validates hub successfully", async () => {
    const serverJson: ServerJsonData = {
      instance_id: "test-instance",
      db_id: "test-db",
      port: server.port!,
      host: "localhost",
      auth_token: "test-token",
      pid: 12345,
      started_at: new Date().toISOString(),
      protocol_version: PROTOCOL_VERSION,
    };

    const serverJsonPath = join(tempDir, ".agentlip", "server.json");
    await fs.writeFile(serverJsonPath, JSON.stringify(serverJson));

    const result = await discoverAndValidateHub(tempDir);

    expect(result).not.toBeNull();
    expect(result?.workspaceRoot).toBe(tempDir);
    expect(result?.serverJson.port).toBe(server.port);
    expect(result?.health.status).toBe("ok");
  });

  test("returns null when workspace not found", async () => {
    // Create a temp directory that exists but has no workspace
    const nonWorkspacePath = join(tmpdir(), `agentlip-no-workspace-${Date.now()}`);
    await fs.mkdir(nonWorkspacePath, { recursive: true });
    
    try {
      const result = await discoverAndValidateHub(nonWorkspacePath);
      expect(result).toBeNull();
    } finally {
      await fs.rm(nonWorkspacePath, { recursive: true, force: true });
    }
  });

  test("returns null when server.json missing", async () => {
    // Workspace exists but no server.json
    const result = await discoverAndValidateHub(tempDir);
    expect(result).toBeNull();
  });

  test("returns null when validation fails", async () => {
    // Stop server to cause validation failure
    server.stop();

    const serverJson: ServerJsonData = {
      instance_id: "test-instance",
      db_id: "test-db",
      port: 9999, // Server not running
      host: "localhost",
      auth_token: "test-token",
      pid: 12345,
      started_at: new Date().toISOString(),
      protocol_version: PROTOCOL_VERSION,
    };

    const serverJsonPath = join(tempDir, ".agentlip", "server.json");
    await fs.writeFile(serverJsonPath, JSON.stringify(serverJson));

    const result = await discoverAndValidateHub(tempDir);
    expect(result).toBeNull();
  });
});
