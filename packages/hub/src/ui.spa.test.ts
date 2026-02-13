/**
 * SPA behavior tests for Gate 3 parity verification
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startHub, type HubServer } from "./index";

describe("SPA security (malicious payload inert rendering)", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;
  let channelId: string;
  let topicId: string;

  beforeAll(async () => {
    authToken = "test-token-spa-security";
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      authToken,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;

    // Create test fixtures
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Test Channel" }),
    });
    const channelData = await channelRes.json();
    channelId = channelData.channel.id;

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channelId, title: "Test Topic" }),
    });
    const topicData = await topicRes.json();
    topicId = topicData.topic.id;
  });

  afterAll(async () => {
    await hub.stop();
  });

  test("SPA shell contains no inline scripts (CSP-ready)", async () => {
    const res = await fetch(`${baseUrl}/ui`);
    expect(res.status).toBe(200);

    const html = await res.text();

    // SPA shell should not have inline scripts
    expect(html).not.toContain("<script>"); // No opening script tag without src
    expect(html).not.toContain("javascript:"); // No javascript: protocol
    expect(html).not.toContain("onclick="); // No inline event handlers in HTML
  });

  test("Malicious channel name does not execute in API response", async () => {
    const maliciousName = '<script>alert("xss")</script><img src=x onerror=alert(1)>';

    const res = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: maliciousName }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();

    // Verify the malicious content is stored as-is (escaped at render time, not storage)
    expect(data.channel.name).toBe(maliciousName);

    // The SPA should render this via textContent, not innerHTML
    // (This is tested in browser smoke tests, here we verify API contract)
  });

  test("Malicious topic title does not execute in API response", async () => {
    const maliciousTitle = '"><script>alert(document.cookie)</script>';

    const res = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        channel_id: channelId,
        title: maliciousTitle,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.topic.title).toBe(maliciousTitle);
  });

  test("Malicious message content does not execute in API response", async () => {
    const maliciousContent = '<img src=x onerror="fetch(\'/steal?c=\'+document.cookie)">';

    const res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topicId,
        sender: "attacker",
        content_raw: maliciousContent,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.message.content_raw).toBe(maliciousContent);
  });

  test("Attachment URL validation prevents javascript: protocol at API layer", async () => {
    const msgRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topicId,
        sender: "test",
        content_raw: "test message",
      }),
    });

    const msgData = await msgRes.json();
    const messageId = msgData.message.id;

    // API rejects javascript: URLs
    const maliciousUrl = 'javascript:alert("xss")';

    const res = await fetch(`${baseUrl}/api/v1/topics/${topicId}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        source_message_id: messageId,
        kind: "url",
        value_json: { url: maliciousUrl },
      }),
    });

    // Hub API validates and rejects invalid URLs
    expect(res.status).toBe(400);
    const errorData = await res.json();
    expect(errorData.code).toBe("INVALID_INPUT");

    // Valid URLs are accepted and rendered
    const validRes = await fetch(`${baseUrl}/api/v1/topics/${topicId}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        source_message_id: messageId,
        kind: "url",
        value_json: { url: "https://example.com" },
      }),
    });

    expect(validRes.status).toBe(201);

    // The SPA client additionally validates URLs with isValidUrl() before creating links
    // (Verified in browser smoke tests)
  });
});

describe("SPA deep link behavior", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;

  beforeAll(async () => {
    authToken = "test-token-spa-deeplink";
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      authToken,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;
  });

  afterAll(async () => {
    await hub.stop();
  });

  test("Deep client routes return SPA shell with no-store cache", async () => {
    const routes = [
      "/ui/",
      "/ui/channels/ch123",
      "/ui/channels/ch123/",
      "/ui/topics/tp456",
      "/ui/topics/tp456/",
      "/ui/events",
      "/ui/events/",
    ];

    for (const route of routes) {
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      const html = await res.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain('<div id="app">'); // SPA mount point
    }
  });

  test("Message hash deep link (#msg_<id>) in URL returns shell", async () => {
    // The hash fragment is client-side only, hub serves shell
    const res = await fetch(`${baseUrl}/ui/topics/tp123#msg_msg456`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    // Hash navigation happens client-side after shell loads
  });
});

describe("WebSocket integration contracts (SPA mode)", () => {
  let hub: HubServer;
  let baseUrl: string;
  let wsUrl: string;
  let authToken: string;
  let topicId: string;

  beforeAll(async () => {
    authToken = "test-token-spa-ws";
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      authToken,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;
    wsUrl = `ws://${hub.host}:${hub.port}/ws`;

    // Create test topic
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "WS Test Channel" }),
    });
    const channelData = await channelRes.json();

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        channel_id: channelData.channel.id,
        title: "WS Test Topic",
      }),
    });
    const topicData = await topicRes.json();
    topicId = topicData.topic.id;
  });

  afterAll(async () => {
    await hub.stop();
  });

  test("WS hello/replay boundary handshake works", async () => {
    const ws = new WebSocket(`${wsUrl}?token=${authToken}`);

    const helloOk = await new Promise<any>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", after_event_id: 0 }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "hello_ok") {
          resolve(msg);
        }
      };

      ws.onerror = reject;

      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    expect(helloOk.type).toBe("hello_ok");
    expect(typeof helloOk.replay_until).toBe("number");

    ws.close();
  });

  test("WS sends events after hello for subscribed topics", async () => {
    const ws = new WebSocket(`${wsUrl}?token=${authToken}`);

    const eventReceived = new Promise<any>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { topics: [topicId] },
          })
        );

        // Create a message after subscribing
        setTimeout(async () => {
          await fetch(`${baseUrl}/api/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              topic_id: topicId,
              sender: "ws-test",
              content_raw: "test message",
            }),
          });
        }, 100);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "event" && msg.name === "message.created") {
          resolve(msg);
        }
      };

      ws.onerror = reject;

      setTimeout(() => reject(new Error("Timeout waiting for event")), 5000);
    });

    const event = await eventReceived;
    expect(event.type).toBe("event");
    expect(event.name).toBe("message.created");
    expect(event.scope.topic_id).toBe(topicId);

    ws.close();
  });

  test("WS received event_ids are unique within a session", async () => {
    // This test verifies the client-side behavior contract:
    // WS may deliver overlapping replay + live events; client must dedupe

    const ws = new WebSocket(`${wsUrl}?token=${authToken}`);

    const events: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", after_event_id: 0 }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "event") {
          events.push(msg);

          // Collect a few events then resolve
          if (events.length >= 2) {
            resolve();
          }
        }
      };

      ws.onerror = reject;

      setTimeout(() => resolve(), 2000); // Timeout is OK (may not have enough events)
    });

    ws.close();

    // Verify all event_ids are unique (hub doesn't send duplicates)
    const eventIds = events.map((e) => e.event_id);
    const uniqueIds = new Set(eventIds);
    expect(uniqueIds.size).toBe(eventIds.length);

    // Replay-overlap dedupe is handled in the SPA WsClient implementation.
  });
});

describe("Events page entity link generation", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;
  let channelId: string;
  let topicId: string;
  let messageId: string;

  beforeAll(async () => {
    authToken = "test-token-entity-links";
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      authToken,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;

    // Create test fixtures
    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Entity Test Channel" }),
    });
    const channelData = await channelRes.json();
    channelId = channelData.channel.id;

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        channel_id: channelId,
        title: "Entity Test Topic",
      }),
    });
    const topicData = await topicRes.json();
    topicId = topicData.topic.id;

    const msgRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        topic_id: topicId,
        sender: "test",
        content_raw: "test message",
      }),
    });
    const msgData = await msgRes.json();
    messageId = msgData.message.id;
  });

  afterAll(async () => {
    await hub.stop();
  });

  test("Events API returns entity metadata for navigation", async () => {
    const res = await fetch(`${baseUrl}/api/v1/events?tail=50`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Find topic.created event
    const topicEvent = data.events.find(
      (e: any) => e.name === "topic.created" && e.entity?.type === "topic"
    );

    expect(topicEvent).toBeDefined();
    expect(topicEvent.entity.type).toBe("topic");
    expect(topicEvent.entity.id).toBe(topicId);
    expect(topicEvent.scope.channel_id).toBe(channelId);

    // Client should generate link: #/topics/{topicId}

    // Find message.created event
    const msgEvent = data.events.find(
      (e: any) => e.name === "message.created" && e.entity?.type === "message"
    );

    expect(msgEvent).toBeDefined();
    expect(msgEvent.entity.type).toBe("message");
    expect(msgEvent.entity.id).toBe(messageId);
    expect(msgEvent.scope.topic_id).toBe(topicId);

    // Client should generate link: #/topics/{topicId}#msg_{messageId}
  });

  test("Events entity IDs in API payloads are safe for client link generation", async () => {
    const res = await fetch(`${baseUrl}/api/v1/events?tail=50`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    const idRegex = /^[a-zA-Z0-9_-]+$/;

    for (const event of data.events as Array<{ entity: { id: string } | null }>) {
      if (event.entity) {
        expect(idRegex.test(event.entity.id)).toBe(true);
      }
    }
  });
});
