import { describe, it, expect, afterEach } from "bun:test";
import { startHub, type HubServer } from "./index";

const TEST_TOKEN = "test_auth_token_12345abcdef";

describe("startHub", () => {
  let hub: HubServer | null = null;

  afterEach(async () => {
    if (hub) {
      await hub.stop();
      hub = null;
    }
  });

  describe("GET /health", () => {
    it("returns health response without auth", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      const res = await fetch(`http://${hub.host}:${hub.port}/health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.instance_id).toBe(hub.instanceId);
    });

    it("is not affected by rate limiting", async () => {
      // Use very low rate limit
      hub = await startHub({
        authToken: TEST_TOKEN,
        rateLimitGlobal: { limit: 2, windowMs: 1000 },
        rateLimitPerClient: { limit: 2, windowMs: 1000 },
      });

      // Make many requests to /health - should all succeed
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`http://${hub.host}:${hub.port}/health`);
        expect(res.status).toBe(200);
      }
    });
  });

  describe("POST /api/v1/_ping (authenticated)", () => {
    it("returns 503 when hub started without authToken", async () => {
      hub = await startHub({}); // No authToken

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
      });
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.code).toBe("NO_AUTH_CONFIGURED");
    });

    it("returns 401 when Authorization header missing", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.code).toBe("MISSING_AUTH");
      // Ensure token not leaked
      expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
    });

    it("returns 401 for wrong token", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong_token" },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.code).toBe("INVALID_AUTH");
      // Ensure tokens not leaked
      expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
      expect(JSON.stringify(body)).not.toContain("wrong_token");
    });

    it("returns pong for valid token", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.pong).toBe(true);
      expect(body.instance_id).toBe(hub.instanceId);
    });

    it("echoes body content when provided", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ echo: "hello" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.pong).toBe(true);
      expect(body.echo).toBe("hello");
    });

    it("includes rate limit headers on success", async () => {
      hub = await startHub({
        authToken: TEST_TOKEN,
        rateLimitPerClient: { limit: 100, windowMs: 1000 },
      });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(200);

      expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
      expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
    });
  });

  describe("rate limiting", () => {
    it("returns 429 after exceeding per-client limit", async () => {
      hub = await startHub({
        authToken: TEST_TOKEN,
        rateLimitGlobal: { limit: 1000, windowMs: 1000 },
        rateLimitPerClient: { limit: 3, windowMs: 1000 },
      });

      // Exhaust per-client limit
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(res.status).toBe(200);
      }

      // Next request should be rate limited
      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body.code).toBe("RATE_LIMITED");
      expect(res.headers.get("Retry-After")).toBeDefined();
    });

    it("returns 429 after exceeding global limit", async () => {
      hub = await startHub({
        authToken: TEST_TOKEN,
        rateLimitGlobal: { limit: 3, windowMs: 1000 },
        rateLimitPerClient: { limit: 1000, windowMs: 1000 },
      });

      // Exhaust global limit with different "clients" (anonymous)
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(res.status).toBe(200);
      }

      // Next request should hit global limit
      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(429);
    });

    it("can disable rate limiting for testing", async () => {
      hub = await startHub({
        authToken: TEST_TOKEN,
        disableRateLimiting: true,
      });

      // Make many requests - should all succeed
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(res.status).toBe(200);
      }
    });
  });

  describe("input validation / size limits", () => {
    it("rejects oversized JSON body", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      // Create body larger than 64KB
      const largeBody = JSON.stringify({ data: "x".repeat(70 * 1024) });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: largeBody,
      });
      expect(res.status).toBe(413);

      const body = await res.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
      // Ensure user content not echoed
      expect(JSON.stringify(body)).not.toContain("xxxx");
    });

    it("rejects invalid JSON body", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{ invalid json content here }",
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe("INVALID_INPUT");
      expect(body.error).toBe("Invalid JSON");
      // Ensure invalid content not echoed
      expect(JSON.stringify(body)).not.toContain("invalid json");
    });

    it("accepts request without body (ping is optional)", async () => {
      hub = await startHub({ authToken: TEST_TOKEN });

      const res = await fetch(`http://${hub.host}:${hub.port}/api/v1/_ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.pong).toBe(true);
    });
  });
});
