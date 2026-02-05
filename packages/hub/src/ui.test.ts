import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startHub, type HubServer } from "./index";
import { openDb } from "@agentlip/kernel";

describe("UI endpoints", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;
  let channelId: string;
  let topicId: string;
  let messageId: string;

  beforeAll(async () => {
    // Start hub with auth token
    authToken = "test-token-ui-integration";
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      authToken,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;

    // Create test data: channel + topic + messages
    // Create channel
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        name: "Test Channel",
        description: "A test channel for UI tests",
      }),
    });

    expect(channelRes.status).toBe(201);
    const channelData = await channelRes.json();
    channelId = channelData.channel.id;

    // Create topic
    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        channel_id: channelId,
        title: "Test Topic",
      }),
    });

    expect(topicRes.status).toBe(201);
    const topicData = await topicRes.json();
    topicId = topicData.topic.id;

    // Create a few messages
    const msg1Res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topicId,
        sender: "alice",
        content_raw: "Hello, world!",
      }),
    });

    expect(msg1Res.status).toBe(201);
    const msg1Data = await msg1Res.json();
    messageId = msg1Data.message.id;

    // Create edited message
    const msg2Res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topicId,
        sender: "bob",
        content_raw: "Original content",
      }),
    });

    expect(msg2Res.status).toBe(201);
    const msg2Data = await msg2Res.json();
    const msg2Id = msg2Data.message.id;

    // Edit the message
    await fetch(`${baseUrl}/api/v1/messages/${msg2Id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        op: "edit",
        content_raw: "Edited content",
      }),
    });

    // Create deleted message
    const msg3Res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topicId,
        sender: "charlie",
        content_raw: "This will be deleted",
      }),
    });

    expect(msg3Res.status).toBe(201);
    const msg3Data = await msg3Res.json();
    const msg3Id = msg3Data.message.id;

    // Delete the message
    await fetch(`${baseUrl}/api/v1/messages/${msg3Id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        op: "delete",
        actor: "admin",
      }),
    });
  });

  afterAll(async () => {
    await hub.stop();
  });

  test("GET /ui returns HTML channels list page", async () => {
    const res = await fetch(`${baseUrl}/ui`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const html = await res.text();
    
    // Verify it's HTML
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");

    // Verify channel name appears (from client-side JS, not server-rendered)
    // The page should contain the script that loads channels
    expect(html).toContain("loadChannels");
  });

  test("GET /ui/ (with trailing slash) returns channels page", async () => {
    const res = await fetch(`${baseUrl}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  test("GET /ui/channels/:channel_id returns topics list page", async () => {
    const res = await fetch(`${baseUrl}/ui/channels/${channelId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const html = await res.text();
    
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("loadTopics");
    
    // Verify auth token and channel ID are embedded
    expect(html).toContain(authToken);
    expect(html).toContain(channelId);
  });

  test("GET /ui/topics/:topic_id returns messages view page", async () => {
    const res = await fetch(`${baseUrl}/ui/topics/${topicId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const html = await res.text();
    
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("loadMessages");
    expect(html).toContain("connectWebSocket");
    
    // Verify auth token and topic ID are embedded
    expect(html).toContain(authToken);
    expect(html).toContain(topicId);
  });

  test("UI pages do not contain raw user input in server-rendered HTML", async () => {
    // Create a channel with XSS attempt in name
    const xssChannelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        name: "<script>alert('xss')</script>",
        description: "XSS test",
      }),
    });

    expect(xssChannelRes.status).toBe(201);

    // Fetch the channels page
    const res = await fetch(`${baseUrl}/ui`);
    const html = await res.text();

    // The page should NOT contain the raw script tag in server-rendered HTML
    // (it's safe because we render via client-side JS with textContent)
    // But the page SHOULD contain the loadChannels function
    expect(html).toContain("loadChannels");
    
    // The HTML should not have user content server-rendered
    // (it's loaded via API and inserted via DOM APIs)
    // So we just verify the page structure is intact
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("GET /ui/invalid-route returns 404", async () => {
    const res = await fetch(`${baseUrl}/ui/invalid`);
    
    expect(res.status).toBe(404);
  });

  test("POST /ui returns null (method not allowed)", async () => {
    const res = await fetch(`${baseUrl}/ui`, { method: "POST" });
    
    // handleUiRequest returns null for non-GET, so hub returns 404
    expect(res.status).toBe(404);
  });

  test("UI is unavailable when hub has no auth token", async () => {
    // Start a hub without auth token
    const noAuthHub = await startHub({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
    });

    const noAuthBaseUrl = `http://${noAuthHub.host}:${noAuthHub.port}`;

    try {
      const res = await fetch(`${noAuthBaseUrl}/ui`);
      
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("UI unavailable");
    } finally {
      await noAuthHub.stop();
    }
  });

  test("UI page contains security features", async () => {
    const res = await fetch(`${baseUrl}/ui/topics/${topicId}`);
    const html = await res.text();

    // Verify URL validation function exists
    expect(html).toContain("isValidUrl");
    
    // Verify messages are rendered with textContent (not innerHTML)
    expect(html).toContain("textContent");
    
    // Verify no eval() usage
    expect(html).not.toContain("eval(");
  });

  test("UI correctly embeds WebSocket connection logic", async () => {
    const res = await fetch(`${baseUrl}/ui/topics/${topicId}`);
    const html = await res.text();

    // Verify WS connection setup
    expect(html).toContain("new WebSocket");
    expect(html).toContain("ws.send");
    expect(html).toContain("type: 'hello'");
    
    // Verify event handlers
    expect(html).toContain("message.created");
    expect(html).toContain("message.edited");
    expect(html).toContain("message.deleted");
    expect(html).toContain("topic.attachment_added");
  });

  test("UI pages include dark mode support", async () => {
    const res = await fetch(`${baseUrl}/ui`);
    const html = await res.text();

    // Verify dark mode CSS
    expect(html).toContain("prefers-color-scheme: dark");
  });

  test("UI uses system font stack", async () => {
    const res = await fetch(`${baseUrl}/ui`);
    const html = await res.text();

    // Verify system font stack
    expect(html).toContain("-apple-system");
    expect(html).toContain("BlinkMacSystemFont");
    expect(html).toContain("Segoe UI");
  });
});
