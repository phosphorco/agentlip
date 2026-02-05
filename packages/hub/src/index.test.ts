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
  });
});
