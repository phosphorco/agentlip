/**
 * Tests for integration test harness utilities
 * 
 * Verifies:
 * - createTempWorkspace: creates temp dir + DB + runs migrations
 * - startTestHub: starts hub with random port, health check works
 * - startTestHub: authenticated endpoints respect authToken
 * - wsConnect: prepared for future WS support (skipped until bd-16d.2.17)
 */

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { openDb } from "@agentchat/kernel";
import { createTempWorkspace, startTestHub, wsConnect } from "./integrationHarness";

const TEST_TOKEN = "test_harness_token_xyz123";

describe("createTempWorkspace", () => {
  const workspaces: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    // Clean up all created workspaces
    for (const ws of workspaces) {
      await ws.cleanup();
    }
    workspaces.length = 0;
  });

  it("creates temp directory with .zulip/db.sqlite3", async () => {
    const workspace = await createTempWorkspace();
    workspaces.push(workspace);

    // Verify directory exists
    expect(existsSync(workspace.root)).toBe(true);
    expect(existsSync(workspace.dbPath)).toBe(true);

    // Verify dbPath is correct relative to root
    expect(workspace.dbPath).toContain(".zulip");
    expect(workspace.dbPath).toContain("db.sqlite3");
  });

  it("runs kernel migrations successfully", async () => {
    const workspace = await createTempWorkspace();
    workspaces.push(workspace);

    // Open DB and verify schema
    const db = openDb({ dbPath: workspace.dbPath });

    try {
      // Check schema_version meta key
      const version = db
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
        .get();
      expect(version).toBeDefined();
      expect(version!.value).toBe("1");

      // Check core tables exist
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('channels', 'topics', 'messages', 'events')"
        )
        .all()
        .map((t) => t.name);

      expect(tables).toContain("channels");
      expect(tables).toContain("topics");
      expect(tables).toContain("messages");
      expect(tables).toContain("events");
    } finally {
      db.close();
    }
  });

  it("cleanup() removes workspace directory", async () => {
    const workspace = await createTempWorkspace();

    // Verify exists before cleanup
    expect(existsSync(workspace.root)).toBe(true);

    // Cleanup
    await workspace.cleanup();

    // Verify removed
    expect(existsSync(workspace.root)).toBe(false);
  });

  it("can create multiple workspaces without conflicts", async () => {
    const ws1 = await createTempWorkspace();
    const ws2 = await createTempWorkspace();
    workspaces.push(ws1, ws2);

    // Verify different paths
    expect(ws1.root).not.toBe(ws2.root);
    expect(ws1.dbPath).not.toBe(ws2.dbPath);

    // Both should exist
    expect(existsSync(ws1.root)).toBe(true);
    expect(existsSync(ws2.root)).toBe(true);
  });
});

describe("startTestHub", () => {
  const hubs: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    // Stop all hubs
    for (const hub of hubs) {
      await hub.stop();
    }
    hubs.length = 0;
  });

  it("starts hub on random port and /health works", async () => {
    const hub = await startTestHub({ authToken: TEST_TOKEN });
    hubs.push(hub);

    // Verify server is running
    expect(hub.server.port).toBeGreaterThan(0);
    expect(hub.url).toContain("127.0.0.1");
    expect(hub.url).toContain(String(hub.server.port));

    // Call /health endpoint
    const res = await fetch(`${hub.url}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.instance_id).toBeDefined();
  });

  it("routes /api/v1/channels via startHub", async () => {
    const hub = await startTestHub({ authToken: TEST_TOKEN });
    hubs.push(hub);

    const res = await fetch(`${hub.url}/api/v1/channels`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.channels)).toBe(true);
  });

  it("returns 503 from authenticated endpoints when authToken not provided", async () => {
    const hub = await startTestHub(); // No authToken
    hubs.push(hub);

    // Try calling authenticated endpoint
    const res = await fetch(`${hub.url}/api/v1/_ping`, {
      method: "POST",
    });

    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.code).toBe("NO_AUTH_CONFIGURED");
  });

  it("authenticated endpoint works with valid token", async () => {
    const hub = await startTestHub({ authToken: TEST_TOKEN });
    hubs.push(hub);

    const res = await fetch(`${hub.url}/api/v1/_ping`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
    });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pong).toBe(true);
    expect(body.instance_id).toBe(hub.server.instanceId);
  });

  it("authenticated endpoint rejects invalid token", async () => {
    const hub = await startTestHub({ authToken: TEST_TOKEN });
    hubs.push(hub);

    const res = await fetch(`${hub.url}/api/v1/_ping`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong_token_123",
      },
    });

    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("INVALID_AUTH");
  });

  it("stop() shuts down server cleanly", async () => {
    const hub = await startTestHub({ authToken: TEST_TOKEN });

    // Verify server works
    const res1 = await fetch(`${hub.url}/health`);
    expect(res1.status).toBe(200);

    // Stop server
    await hub.stop();

    // Verify server is stopped (connection should fail)
    await expect(fetch(`${hub.url}/health`)).rejects.toThrow();
  });

  it("rateLimitDisabled allows unlimited requests", async () => {
    const hub = await startTestHub({
      authToken: TEST_TOKEN,
      rateLimitDisabled: true,
    });
    hubs.push(hub);

    // Make many requests - should all succeed
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${hub.url}/api/v1/_ping`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
      });
      expect(res.status).toBe(200);
    }
  });

  it("multiple hubs can run simultaneously on different ports", async () => {
    const hub1 = await startTestHub({ authToken: "token1" });
    const hub2 = await startTestHub({ authToken: "token2" });
    hubs.push(hub1, hub2);

    // Verify different ports
    expect(hub1.server.port).not.toBe(hub2.server.port);

    // Both should respond to health checks
    const res1 = await fetch(`${hub1.url}/health`);
    const res2 = await fetch(`${hub2.url}/health`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = await res1.json();
    const body2 = await res2.json();

    // Different instance IDs
    expect(body1.instance_id).not.toBe(body2.instance_id);
  });
});

describe("wsConnect", () => {
  it("connects to WebSocket endpoint (hello handshake)", async () => {
    const hub = await startTestHub({ authToken: TEST_TOKEN });

    try {
      // Convert http:// to ws://
      const wsUrl = hub.url.replace("http://", "ws://") + "/ws";

      const client = await wsConnect({
        url: wsUrl,
        token: TEST_TOKEN,
      });

      client.sendJson({
        type: "hello",
        after_event_id: 0,
        subscriptions: { channels: [], topics: [] },
      });

      const msg = await client.waitForMessage(1000);
      const data = JSON.parse(String(msg.data));

      expect(data.type).toBe("hello_ok");
      expect(typeof data.replay_until).toBe("number");
      expect(typeof data.instance_id).toBe("string");

      client.close();
    } finally {
      await hub.stop();
    }
  });

  it("rejects connection without token", async () => {
    const hub = await startTestHub({ authToken: TEST_TOKEN });

    try {
      const wsUrl = hub.url.replace("http://", "ws://") + "/ws";

      // Should reject when token missing
      await expect(wsConnect({ url: wsUrl })).rejects.toThrow();
    } finally {
      await hub.stop();
    }
  });
});
