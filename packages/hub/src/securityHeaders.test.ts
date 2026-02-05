/**
 * Security headers tests
 * 
 * Verify that all HTTP responses include required security headers:
 * - X-Frame-Options: DENY
 * - X-Content-Type-Options: nosniff
 * - X-XSS-Protection: 1; mode=block
 * - Content-Security-Policy: (see spec)
 * - Referrer-Policy: no-referrer
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startHub, type HubServer } from "./index";

describe("Security Headers", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;

  beforeAll(async () => {
    authToken = "test-token-" + Math.random().toString(36).substring(7);
    hub = await startHub({
      dbPath: ":memory:",
      authToken,
    });
    baseUrl = `http://${hub.host}:${hub.port}`;
  });

  afterAll(async () => {
    await hub.stop();
  });

  const EXPECTED_HEADERS = {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "x-xss-protection": "1; mode=block",
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  } as const;

  function verifySecurityHeaders(response: Response): void {
    for (const [key, expectedValue] of Object.entries(EXPECTED_HEADERS)) {
      const actualValue = response.headers.get(key);
      expect(actualValue).toBe(expectedValue);
    }
  }

  test("GET /health includes security headers", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    verifySecurityHeaders(response);
  });

  test("GET /api/v1/channels includes security headers", async () => {
    const response = await fetch(`${baseUrl}/api/v1/channels`);
    expect(response.status).toBe(200);
    verifySecurityHeaders(response);
  });

  test("POST /api/v1/channels (success) includes security headers", async () => {
    const response = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Test Channel" }),
    });
    expect(response.status).toBe(201);
    verifySecurityHeaders(response);
  });

  test("POST /api/v1/channels (no auth) includes security headers on error", async () => {
    const response = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Test Channel" }),
    });
    expect(response.status).toBe(401);
    verifySecurityHeaders(response);
  });

  test("GET /ui (auth token configured) includes security headers", async () => {
    const response = await fetch(`${baseUrl}/ui`);
    expect(response.status).toBe(200);
    verifySecurityHeaders(response);
  });

  test("404 response includes security headers", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    expect(response.status).toBe(404);
    verifySecurityHeaders(response);
  });

  test("GET /api/v1/events includes security headers", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events`);
    expect(response.status).toBe(200);
    verifySecurityHeaders(response);
  });

  test("POST /api/v1/messages (success) includes security headers", async () => {
    // Create channel and topic first
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Security Test Channel" }),
    });
    const { channel } = await channelRes.json();

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channel.id, title: "Security Test Topic" }),
    });
    const { topic } = await topicRes.json();

    // Create message
    const response = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topic.id,
        sender: "test-user",
        content_raw: "Test message",
      }),
    });
    expect(response.status).toBe(201);
    verifySecurityHeaders(response);
  });
});
