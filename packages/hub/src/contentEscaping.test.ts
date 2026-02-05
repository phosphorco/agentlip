/**
 * Content escaping tests
 * 
 * Verify that user content is properly handled:
 * 1. API returns raw strings (no execution)
 * 2. Content-Type headers are always set correctly
 * 3. No MIME sniffing (X-Content-Type-Options: nosniff)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startHub, type HubServer } from "./index";

describe("Content Escaping & Content-Type", () => {
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

  test("Message with XSS payload is stored and returned as-is", async () => {
    const xssPayload = "<script>alert('xss')</script>";

    // Create channel and topic
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "XSS Test Channel" }),
    });
    const { channel } = await channelRes.json();

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channel.id, title: "XSS Test Topic" }),
    });
    const { topic } = await topicRes.json();

    // Create message with XSS payload
    const messageRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topic.id,
        sender: "test-user",
        content_raw: xssPayload,
      }),
    });
    expect(messageRes.status).toBe(201);
    const { message } = await messageRes.json();

    // Verify content_raw contains the raw string (not executed)
    expect(message.content_raw).toBe(xssPayload);

    // Fetch via API and verify
    const messagesRes = await fetch(`${baseUrl}/api/v1/messages?topic_id=${topic.id}`);
    expect(messagesRes.status).toBe(200);
    const { messages } = await messagesRes.json();

    expect(messages).toHaveLength(1);
    expect(messages[0].content_raw).toBe(xssPayload);
  });

  test("Channel with HTML in name is stored and returned as-is", async () => {
    const htmlName = "<b>bold</b>";

    const response = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: htmlName }),
    });
    expect(response.status).toBe(201);
    const { channel } = await response.json();

    // Verify name is raw string
    expect(channel.name).toBe(htmlName);

    // Fetch via API and verify
    const channelsRes = await fetch(`${baseUrl}/api/v1/channels`);
    const { channels } = await channelsRes.json();

    const found = channels.find((c: any) => c.id === channel.id);
    expect(found).toBeDefined();
    expect(found.name).toBe(htmlName);
  });

  test("Topic with HTML in title is stored and returned as-is", async () => {
    const htmlTitle = "<i>italic</i>";

    // Create channel first
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "HTML Topic Test Channel" }),
    });
    const { channel } = await channelRes.json();

    // Create topic with HTML in title
    const response = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channel.id, title: htmlTitle }),
    });
    expect(response.status).toBe(201);
    const { topic } = await response.json();

    // Verify title is raw string
    expect(topic.title).toBe(htmlTitle);

    // Fetch via API and verify
    const topicsRes = await fetch(`${baseUrl}/api/v1/channels/${channel.id}/topics`);
    const { topics } = await topicsRes.json();

    const found = topics.find((t: any) => t.id === topic.id);
    expect(found).toBeDefined();
    expect(found.title).toBe(htmlTitle);
  });

  test("Attachment with malicious URL is rejected", async () => {
    const maliciousUrl = "javascript:alert(1)";

    // Create channel and topic
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Malicious URL Test Channel" }),
    });
    const { channel } = await channelRes.json();

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channel.id, title: "Malicious URL Test Topic" }),
    });
    const { topic } = await topicRes.json();

    // Attempt to create attachment with malicious URL
    const response = await fetch(`${baseUrl}/api/v1/topics/${topic.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        kind: "url",
        value_json: { url: maliciousUrl },
      }),
    });

    // Should be rejected with 400
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.error).toContain("url");
  });

  test("Attachment with http URL is accepted", async () => {
    const validUrl = "https://example.com/test";

    // Create channel and topic
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Valid URL Test Channel" }),
    });
    const { channel } = await channelRes.json();

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channel.id, title: "Valid URL Test Topic" }),
    });
    const { topic } = await topicRes.json();

    // Create attachment with valid URL
    const response = await fetch(`${baseUrl}/api/v1/topics/${topic.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        kind: "url",
        value_json: { url: validUrl },
      }),
    });

    expect(response.status).toBe(201);
    const { attachment } = await response.json();
    expect(attachment.value_json.url).toBe(validUrl);
  });

  test("API responses have correct Content-Type: application/json", async () => {
    const endpoints = [
      "/api/v1/channels",
      "/api/v1/events",
      "/health",
    ];

    for (const endpoint of endpoints) {
      const response = await fetch(`${baseUrl}${endpoint}`);
      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type");
      expect(contentType).toContain("application/json");
    }
  });

  test("UI responses have correct Content-Type: text/html", async () => {
    const response = await fetch(`${baseUrl}/ui`);
    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("text/html");
    expect(contentType).toContain("charset=utf-8");
  });

  test("X-Content-Type-Options prevents MIME sniffing", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("Message content with embedded null bytes is handled", async () => {
    const contentWithNull = "Hello\x00World";

    // Create channel and topic
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Null Byte Test Channel" }),
    });
    const { channel } = await channelRes.json();

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channel.id, title: "Null Byte Test Topic" }),
    });
    const { topic } = await topicRes.json();

    // Create message with null byte
    const messageRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topic.id,
        sender: "test-user",
        content_raw: contentWithNull,
      }),
    });
    expect(messageRes.status).toBe(201);
    const { message } = await messageRes.json();

    // Verify content is stored correctly
    expect(message.content_raw).toBe(contentWithNull);
  });

  test("Attachment with XSS in title is rejected", async () => {
    const xssTitle = "<script>alert('xss')</script>";

    // Create channel and topic
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "XSS Title Test Channel" }),
    });
    const { channel } = await channelRes.json();

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channel.id, title: "XSS Title Test Topic" }),
    });
    const { topic } = await topicRes.json();

    // Attempt to create attachment with XSS in title
    const response = await fetch(`${baseUrl}/api/v1/topics/${topic.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        kind: "url",
        value_json: {
          url: "https://example.com",
          title: xssTitle,
        },
      }),
    });

    // Should be rejected with 400
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.error).toContain("title");
  });
});
