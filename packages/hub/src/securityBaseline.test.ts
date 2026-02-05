/**
 * Security baseline test suite for AgentChat Hub
 *
 * Coverage:
 * - Localhost bind validation (reject 0.0.0.0 unless allowUnsafeNetwork)
 * - Auth token generation (256-bit entropy, uniqueness)
 * - server.json permissions (mode 0600)
 * - SQL injection smoke tests via HTTP API
 * - Token leakage prevention in 401 responses
 *
 * @see bd-16d.6.4 security baseline task
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub, assertLocalhostBind, type HubServer } from "./index";
import { generateAuthToken } from "./authToken";
import { writeServerJson, readServerJson } from "./serverJson";

// ─────────────────────────────────────────────────────────────────────────────
// Localhost Bind Validation
// ─────────────────────────────────────────────────────────────────────────────

describe("assertLocalhostBind", () => {
  it("allows 127.0.0.1 (IPv4 localhost)", () => {
    expect(() => assertLocalhostBind("127.0.0.1")).not.toThrow();
  });

  it("allows localhost", () => {
    expect(() => assertLocalhostBind("localhost")).not.toThrow();
  });

  it("allows ::1 (IPv6 localhost)", () => {
    expect(() => assertLocalhostBind("::1")).not.toThrow();
  });

  it("allows [::1] (bracketed IPv6)", () => {
    expect(() => assertLocalhostBind("[::1]")).not.toThrow();
  });

  it("rejects 0.0.0.0 without allowUnsafeNetwork flag", () => {
    expect(() => assertLocalhostBind("0.0.0.0")).toThrow(/Refusing to bind/);
  });

  it("rejects :: without allowUnsafeNetwork flag", () => {
    expect(() => assertLocalhostBind("::")).toThrow(/Refusing to bind/);
  });

  it("rejects [::] without allowUnsafeNetwork flag", () => {
    expect(() => assertLocalhostBind("[::]")).toThrow(/Refusing to bind/);
  });

  it("allows 0.0.0.0 with allowUnsafeNetwork: true", () => {
    expect(() =>
      assertLocalhostBind("0.0.0.0", { allowUnsafeNetwork: true })
    ).not.toThrow();
  });

  it("allows :: with allowUnsafeNetwork: true", () => {
    expect(() =>
      assertLocalhostBind("::", { allowUnsafeNetwork: true })
    ).not.toThrow();
  });

  it("rejects arbitrary IP addresses", () => {
    expect(() => assertLocalhostBind("192.168.1.1")).toThrow(/Invalid bind host/);
    expect(() => assertLocalhostBind("10.0.0.1")).toThrow(/Invalid bind host/);
    expect(() => assertLocalhostBind("8.8.8.8")).toThrow(/Invalid bind host/);
  });

  it("rejects arbitrary non-localhost IP even with allowUnsafeNetwork: true", () => {
    // allowUnsafeNetwork only permits 0.0.0.0/:: (all interfaces), not specific IPs
    expect(() =>
      assertLocalhostBind("192.168.1.1", { allowUnsafeNetwork: true })
    ).toThrow(/Invalid bind host/);
  });

  it("handles whitespace in host string", () => {
    expect(() => assertLocalhostBind("  127.0.0.1  ")).not.toThrow();
    expect(() => assertLocalhostBind("  0.0.0.0  ")).toThrow(/Refusing to bind/);
  });

  it("is case-insensitive for localhost", () => {
    expect(() => assertLocalhostBind("LOCALHOST")).not.toThrow();
    expect(() => assertLocalhostBind("LocalHost")).not.toThrow();
  });
});

describe("startHub localhost binding", () => {
  let hub: HubServer | null = null;

  afterEach(async () => {
    if (hub) {
      await hub.stop();
      hub = null;
    }
  });

  it("throws when host is 0.0.0.0 without allowUnsafeNetwork", async () => {
    await expect(
      startHub({ host: "0.0.0.0", authToken: "test-token" })
    ).rejects.toThrow(/Refusing to bind/);
  });

  it("starts successfully with 0.0.0.0 when allowUnsafeNetwork: true", async () => {
    hub = await startHub({
      host: "0.0.0.0",
      allowUnsafeNetwork: true,
      authToken: "test-token",
    });
    expect(hub.host).toBe("0.0.0.0");
    expect(hub.port).toBeGreaterThan(0);
  });

  it("starts successfully with default localhost", async () => {
    hub = await startHub({ authToken: "test-token" });
    expect(hub.host).toBe("127.0.0.1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth Token Generation
// ─────────────────────────────────────────────────────────────────────────────

describe("generateAuthToken", () => {
  it("generates 64-character hex string (256-bit)", () => {
    const token = generateAuthToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens across multiple calls", () => {
    const tokens = new Set<string>();
    const sampleSize = 100;

    for (let i = 0; i < sampleSize; i++) {
      tokens.add(generateAuthToken());
    }

    // All tokens should be unique
    expect(tokens.size).toBe(sampleSize);
  });

  it("tokens do not start with predictable patterns", () => {
    const tokens: string[] = [];
    for (let i = 0; i < 50; i++) {
      tokens.push(generateAuthToken());
    }

    // Check that first 8 chars vary significantly
    const prefixes = new Set(tokens.map((t) => t.substring(0, 8)));
    // Should have at least 45 unique 8-char prefixes out of 50 tokens
    expect(prefixes.size).toBeGreaterThanOrEqual(45);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// server.json Permissions
// ─────────────────────────────────────────────────────────────────────────────

describe("server.json security", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentchat-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writeServerJson creates file with mode 0600", async () => {
    const serverData = {
      instance_id: "test-instance",
      db_id: "test-db",
      port: 8080,
      host: "127.0.0.1",
      auth_token: generateAuthToken(),
      pid: process.pid,
      started_at: new Date().toISOString(),
      protocol_version: "1.0",
    };

    await writeServerJson({ workspaceRoot: tempDir, data: serverData });

    const serverJsonPath = join(tempDir, ".zulip", "server.json");
    const fileStat = await stat(serverJsonPath);

    // mode & 0o777 masks out file type bits, leaving permission bits
    const permissions = fileStat.mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it("readServerJson parses written server.json correctly", async () => {
    const originalData = {
      instance_id: "test-instance-read",
      db_id: "test-db-read",
      port: 9090,
      host: "127.0.0.1",
      auth_token: generateAuthToken(),
      pid: process.pid,
      started_at: new Date().toISOString(),
      protocol_version: "1.0",
      schema_version: 5,
    };

    await writeServerJson({ workspaceRoot: tempDir, data: originalData });
    const readData = await readServerJson({ workspaceRoot: tempDir });

    expect(readData).not.toBeNull();
    expect(readData!.instance_id).toBe(originalData.instance_id);
    expect(readData!.db_id).toBe(originalData.db_id);
    expect(readData!.port).toBe(originalData.port);
    expect(readData!.host).toBe(originalData.host);
    expect(readData!.protocol_version).toBe(originalData.protocol_version);
    expect(readData!.schema_version).toBe(originalData.schema_version);
    // auth_token is present
    expect(readData!.auth_token).toBeTruthy();
    expect(readData!.auth_token.length).toBe(64);
  });

  it("readServerJson returns null for missing file", async () => {
    const readData = await readServerJson({
      workspaceRoot: join(tempDir, "nonexistent"),
    });
    expect(readData).toBeNull();
  });

  it("server.json directory is created with mode 0700", async () => {
    const serverData = {
      instance_id: "test-dir-perms",
      db_id: "test-db",
      port: 8080,
      host: "127.0.0.1",
      auth_token: generateAuthToken(),
      pid: process.pid,
      started_at: new Date().toISOString(),
      protocol_version: "1.0",
    };

    await writeServerJson({ workspaceRoot: tempDir, data: serverData });

    const zulipDir = join(tempDir, ".zulip");
    const dirStat = await stat(zulipDir);
    const permissions = dirStat.mode & 0o777;
    expect(permissions).toBe(0o700);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL Injection Smoke Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SQL injection resistance", () => {
  let hub: HubServer | null = null;
  const TEST_TOKEN = generateAuthToken();

  afterEach(async () => {
    if (hub) {
      await hub.stop();
      hub = null;
    }
  });

  it("channel name with SQL metacharacters is stored literally", async () => {
    hub = await startHub({ authToken: TEST_TOKEN, disableRateLimiting: true });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    // SQL injection payload in channel name
    const maliciousName = "test'; DROP TABLE channels; --";

    // Create channel with malicious name
    const createRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: maliciousName }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.channel.name).toBe(maliciousName);

    // Verify DB not corrupted: list channels should still work
    const listRes = await fetch(`${baseUrl}/api/v1/channels`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();

    // Find our malicious channel - it should exist with literal name
    const found = listBody.channels.find(
      (ch: { name: string }) => ch.name === maliciousName
    );
    expect(found).toBeDefined();
    expect(found.name).toBe(maliciousName);
  });

  it("topic title with SQL metacharacters is stored literally", async () => {
    hub = await startHub({ authToken: TEST_TOKEN, disableRateLimiting: true });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    // Create a channel first
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "sqli-test-channel" }),
    });
    const channelBody = await channelRes.json();
    const channelId = channelBody.channel.id;

    // SQL injection payload in topic title
    const maliciousTitle = "topic\"; DELETE FROM topics WHERE \"1\"=\"1";

    // Create topic with malicious title
    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel_id: channelId, title: maliciousTitle }),
    });

    expect(topicRes.status).toBe(201);
    const topicBody = await topicRes.json();
    expect(topicBody.topic.title).toBe(maliciousTitle);

    // Verify DB not corrupted: listing topics should still work
    const listRes = await fetch(
      `${baseUrl}/api/v1/channels/${channelId}/topics`
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();

    const found = listBody.topics.find(
      (t: { title: string }) => t.title === maliciousTitle
    );
    expect(found).toBeDefined();
    expect(found.title).toBe(maliciousTitle);
  });

  it("message content with SQL metacharacters is stored literally", async () => {
    hub = await startHub({ authToken: TEST_TOKEN, disableRateLimiting: true });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    // Create channel and topic
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "sqli-msg-channel" }),
    });
    const channelBody = await channelRes.json();
    const channelId = channelBody.channel.id;

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel_id: channelId, title: "sqli-msg-topic" }),
    });
    const topicBody = await topicRes.json();
    const topicId = topicBody.topic.id;

    // SQL injection payload in message content
    const maliciousContent =
      "'); INSERT INTO messages VALUES ('hacked', 'hacked', 'hacked', 'hacked', 'hacked', 1, 'now'); --";

    // Create message with malicious content
    const msgRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic_id: topicId,
        sender: "test-sender",
        content_raw: maliciousContent,
      }),
    });

    expect(msgRes.status).toBe(201);
    const msgBody = await msgRes.json();
    expect(msgBody.message.content_raw).toBe(maliciousContent);

    // Verify DB not corrupted: listing messages should work
    const listRes = await fetch(
      `${baseUrl}/api/v1/messages?topic_id=${topicId}`
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();

    // Should have exactly 1 message, not 2 (no injection)
    expect(listBody.messages.length).toBe(1);
    expect(listBody.messages[0].content_raw).toBe(maliciousContent);
  });

  it("query params with SQL metacharacters do not corrupt queries", async () => {
    hub = await startHub({ authToken: TEST_TOKEN, disableRateLimiting: true });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    // Create a channel and topic to query
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "sqli-query-channel" }),
    });
    const channelBody = await channelRes.json();
    const channelId = channelBody.channel.id;

    // Attempt SQL injection via query param
    const maliciousId = "' OR '1'='1";
    const listRes = await fetch(
      `${baseUrl}/api/v1/channels/${encodeURIComponent(maliciousId)}/topics`
    );

    // Should return 404 (channel not found), not expose all data
    expect(listRes.status).toBe(404);

    // Original channel should still be queryable
    const validRes = await fetch(
      `${baseUrl}/api/v1/channels/${channelId}/topics`
    );
    expect(validRes.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token Leakage Prevention
// ─────────────────────────────────────────────────────────────────────────────

describe("token leakage prevention", () => {
  let hub: HubServer | null = null;
  const EXPECTED_TOKEN = generateAuthToken();
  const PROVIDED_TOKEN = generateAuthToken();

  afterEach(async () => {
    if (hub) {
      await hub.stop();
      hub = null;
    }
  });

  it("401 response for missing auth does not contain expected token", async () => {
    hub = await startHub({ authToken: EXPECTED_TOKEN });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    const res = await fetch(`${baseUrl}/api/v1/_ping`, { method: "POST" });
    expect(res.status).toBe(401);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(EXPECTED_TOKEN);
  });

  it("401 response for invalid auth does not contain expected or provided tokens", async () => {
    hub = await startHub({ authToken: EXPECTED_TOKEN });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    const res = await fetch(`${baseUrl}/api/v1/_ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PROVIDED_TOKEN}` },
    });
    expect(res.status).toBe(401);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(EXPECTED_TOKEN);
    expect(bodyText).not.toContain(PROVIDED_TOKEN);
  });

  it("401 on channel creation does not leak tokens", async () => {
    hub = await startHub({ authToken: EXPECTED_TOKEN });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    const res = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PROVIDED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "test-channel" }),
    });
    expect(res.status).toBe(401);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(EXPECTED_TOKEN);
    expect(bodyText).not.toContain(PROVIDED_TOKEN);
  });

  it("401 on message creation does not leak tokens", async () => {
    hub = await startHub({ authToken: EXPECTED_TOKEN });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    const res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PROVIDED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic_id: "fake-topic",
        sender: "test",
        content_raw: "test",
      }),
    });
    expect(res.status).toBe(401);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(EXPECTED_TOKEN);
    expect(bodyText).not.toContain(PROVIDED_TOKEN);
  });

  it("error responses do not echo user-provided content verbatim", async () => {
    hub = await startHub({ authToken: EXPECTED_TOKEN });
    const baseUrl = `http://${hub.host}:${hub.port}`;

    // Send obviously malicious/identifying content
    const sensitivePayload = "SUPER_SECRET_USER_DATA_12345";

    const res = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EXPECTED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Missing required 'name' field, but has other content
        description: sensitivePayload,
      }),
    });
    expect(res.status).toBe(400); // Validation error

    const bodyText = await res.text();
    // User-provided sensitive data should not be echoed in error
    expect(bodyText).not.toContain(sensitivePayload);
  });
});
