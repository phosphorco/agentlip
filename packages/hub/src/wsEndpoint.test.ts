/**
 * Integration tests for WebSocket endpoint
 * 
 * Tests the full protocol:
 * - Token authentication
 * - Hello handshake
 * - Event replay with subscription filtering
 * - Live event streaming
 * - Backpressure handling
 * - Size validation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb, runMigrations, insertEvent } from "@agentchat/kernel";
import { createWsHub, createWsHandlers } from "./wsEndpoint";
import { generateAuthToken } from "./authToken";

const TEST_DIR = join(import.meta.dir, ".test-tmp-ws");
const MIGRATIONS_DIR = join(import.meta.dir, "../../../migrations");
const AUTH_TOKEN = generateAuthToken();

interface TestContext {
  db: Database;
  dbPath: string;
  server?: any;
  port?: number;
  baseWsUrl?: string;
  hub?: ReturnType<typeof createWsHub>;
}

function setupTestDb(): { db: Database; dbPath: string } {
  const dbPath = join(TEST_DIR, `ws-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  return { db, dbPath };
}

async function setupTestServer(db: Database): Promise<{
  server: any;
  port: number;
  baseWsUrl: string;
  hub: ReturnType<typeof createWsHub>;
}> {
  const hub = createWsHub({ db, instanceId: "test-instance" });
  const handlers = createWsHandlers({ db, authToken: AUTH_TOKEN, hub: hub as any });

  const server = Bun.serve({
    port: 0, // Random available port
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        return handlers.upgrade(req, server);
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open: handlers.open,
      message: handlers.message,
      close: handlers.close,
    },
  });

  const port = server.port!;
  const baseWsUrl = `ws://localhost:${port}/ws`;

  return { server, port, baseWsUrl, hub };
}

function createTestContext(): TestContext {
  const { db, dbPath } = setupTestDb();
  // Server will be set up in async beforeEach
  return { db, dbPath };
}

beforeEach(() => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    for (const file of readdirSync(TEST_DIR)) {
      const filePath = join(TEST_DIR, file);
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("WebSocket Authentication", () => {
  test("rejects connection without token", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      // Try to connect without token
      const ws = new WebSocket(ctx.baseWsUrl);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          throw new Error("Should not connect without token");
        };
        ws.onerror = () => {
          resolve(); // Expected error
        };
        ws.onclose = () => {
          resolve(); // Expected close
        };
      });
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("rejects connection with invalid token", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=invalid`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          throw new Error("Should not connect with invalid token");
        };
        ws.onerror = () => {
          resolve(); // Expected error
        };
        ws.onclose = () => {
          resolve(); // Expected close
        };
      });
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("accepts connection with valid token", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          resolve();
        };
        ws.onerror = (err) => {
          reject(new Error("Connection failed"));
        };
      });

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hello Handshake Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Hello Handshake", () => {
  test("responds with hello_ok after hello message", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      const helloOk = await new Promise<any>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"], topics: [] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "hello_ok") {
            resolve(msg);
          }
        };

        ws.onerror = reject;
      });

      expect(helloOk.type).toBe("hello_ok");
      expect(helloOk.instance_id).toBe("test-instance");
      expect(typeof helloOk.replay_until).toBe("number");
      expect(helloOk.replay_until).toBeGreaterThanOrEqual(0);

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("closes connection on invalid hello (missing after_event_id)", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            subscriptions: { channels: ["ch1"] },
            // Missing after_event_id
          }));
        };

        ws.onclose = (event) => {
          expect(event.code).toBe(1003);
          resolve();
        };

        ws.onerror = () => {
          resolve(); // Expected
        };
      });
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("closes connection on non-hello first message", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "ping" }));
        };

        ws.onclose = (event) => {
          expect(event.code).toBe(1003);
          resolve();
        };

        ws.onerror = () => {
          resolve(); // Expected
        };
      });
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Replay Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Event Replay", () => {
  test("replays events within boundary", async () => {
    const ctx = createTestContext();

    // Seed events
    insertEvent({
      db: ctx.db,
      name: "message.created",
      scopes: { channel_id: "ch1", topic_id: "t1" },
      entity: { type: "message", id: "msg1" },
      data: { message: { id: "msg1", content: "Hello" } },
    });
    insertEvent({
      db: ctx.db,
      name: "message.created",
      scopes: { channel_id: "ch1", topic_id: "t1" },
      entity: { type: "message", id: "msg2" },
      data: { message: { id: "msg2", content: "World" } },
    });
    insertEvent({
      db: ctx.db,
      name: "message.created",
      scopes: { channel_id: "ch2", topic_id: "t2" },
      entity: { type: "message", id: "msg3" },
      data: { message: { id: "msg3", content: "Other" } },
    });

    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      const messages: any[] = [];
      let helloOkReceived = false;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"], topics: [] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          messages.push(msg);

          if (msg.type === "hello_ok") {
            helloOkReceived = true;
            expect(msg.replay_until).toBe(3); // 3 events inserted
          } else if (msg.type === "event") {
            // Check if we've received all expected events
            if (messages.filter(m => m.type === "event").length === 2) {
              resolve();
            }
          }
        };

        ws.onerror = reject;

        setTimeout(() => reject(new Error("Timeout waiting for replay")), 5000);
      });

      expect(helloOkReceived).toBe(true);

      const events = messages.filter(m => m.type === "event");
      expect(events.length).toBe(2); // Only ch1 events
      expect(events[0].event_id).toBe(1);
      expect(events[0].name).toBe("message.created");
      expect(events[0].scope.channel_id).toBe("ch1");
      expect(events[1].event_id).toBe(2);
      expect(events[1].scope.channel_id).toBe("ch1");

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("filters replay by topic subscription", async () => {
    const ctx = createTestContext();

    // Seed events with different topics
    insertEvent({
      db: ctx.db,
      name: "message.created",
      scopes: { channel_id: "ch1", topic_id: "t1" },
      entity: { type: "message", id: "msg1" },
      data: { message: { id: "msg1", content: "Topic 1" } },
    });
    insertEvent({
      db: ctx.db,
      name: "message.created",
      scopes: { channel_id: "ch1", topic_id: "t2" },
      entity: { type: "message", id: "msg2" },
      data: { message: { id: "msg2", content: "Topic 2" } },
    });
    insertEvent({
      db: ctx.db,
      name: "message.created",
      scopes: { channel_id: "ch1", topic_id: "t3" },
      entity: { type: "message", id: "msg3" },
      data: { message: { id: "msg3", content: "Topic 3" } },
    });

    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      const messages: any[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          // Subscribe only to t1 and t3
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: [], topics: ["t1", "t3"] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          messages.push(msg);

          if (msg.type === "event") {
            const events = messages.filter(m => m.type === "event");
            if (events.length === 2) {
              resolve();
            }
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      const events = messages.filter(m => m.type === "event");
      expect(events.length).toBe(2);
      expect(events[0].scope.topic_id).toBe("t1");
      expect(events[1].scope.topic_id).toBe("t3");

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("replays events with topic_id2 (moved_topic semantics)", async () => {
    const ctx = createTestContext();

    // Seed move_topic event with scope_topic_id2
    insertEvent({
      db: ctx.db,
      name: "message.moved_topic",
      scopes: { channel_id: "ch1", topic_id: "t_new", topic_id2: "t_old" },
      entity: { type: "message", id: "msg1" },
      data: { message_id: "msg1", old_topic_id: "t_old", new_topic_id: "t_new" },
    });

    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      const messages: any[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          // Subscribe to old topic (should still receive move event via topic_id2)
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: [], topics: ["t_old"] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          messages.push(msg);

          if (msg.type === "event" && msg.name === "message.moved_topic") {
            resolve();
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      const events = messages.filter(m => m.type === "event");
      expect(events.length).toBe(1);
      expect(events[0].name).toBe("message.moved_topic");
      expect(events[0].scope.topic_id2).toBe("t_old");

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("respects after_event_id boundary", async () => {
    const ctx = createTestContext();

    // Seed 5 events
    for (let i = 1; i <= 5; i++) {
      insertEvent({
        db: ctx.db,
        name: "test.event",
        scopes: { channel_id: "ch1" },
        entity: { type: "test", id: `test${i}` },
        data: { index: i },
      });
    }

    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      const messages: any[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          // Start from event 2 (should get 3, 4, 5)
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 2,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          messages.push(msg);

          if (msg.type === "event") {
            const events = messages.filter(m => m.type === "event");
            if (events.length === 3) {
              resolve();
            }
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      const events = messages.filter(m => m.type === "event");
      expect(events.length).toBe(3);
      expect(events[0].event_id).toBe(3);
      expect(events[1].event_id).toBe(4);
      expect(events[2].event_id).toBe(5);

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Live Event Streaming Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Live Event Streaming", () => {
  test("receives live events after replay completes", async () => {
    const ctx = createTestContext();

    // Seed initial event
    insertEvent({
      db: ctx.db,
      name: "message.created",
      scopes: { channel_id: "ch1", topic_id: "t1" },
      entity: { type: "message", id: "msg1" },
      data: { message: { id: "msg1", content: "Initial" } },
    });

    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      const messages: any[] = [];
      let replayComplete = false;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          messages.push(msg);

          if (msg.type === "hello_ok") {
            expect(msg.replay_until).toBe(1);
          } else if (msg.type === "event" && msg.event_id === 1) {
            // Replay event received, now insert new event
            replayComplete = true;
            
            // Insert new event (will be live)
            const newEventId = insertEvent({
              db: ctx.db,
              name: "message.created",
              scopes: { channel_id: "ch1", topic_id: "t1" },
              entity: { type: "message", id: "msg2" },
              data: { message: { id: "msg2", content: "Live" } },
            });

            // Manually publish (simulating hub integration)
            const newEvent = {
              event_id: newEventId,
              ts: new Date().toISOString(),
              name: "message.created",
              scope: { channel_id: "ch1", topic_id: "t1", topic_id2: null },
              entity: { type: "message", id: "msg2" },
              data: { message: { id: "msg2", content: "Live" } },
            };
            ctx.hub!.publishEvent(newEvent);
          } else if (msg.type === "event" && msg.event_id === 2) {
            // Live event received
            resolve();
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout waiting for live event")), 5000);
      });

      expect(replayComplete).toBe(true);
      const events = messages.filter(m => m.type === "event");
      expect(events.length).toBe(2);
      expect(events[0].event_id).toBe(1); // Replay
      expect(events[1].event_id).toBe(2); // Live

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("does not send live events that don't match subscription", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      const messages: any[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          messages.push(msg);

          if (msg.type === "hello_ok") {
            // Send events to different channels
            const event1 = {
              event_id: 1,
              ts: new Date().toISOString(),
              name: "test.event",
              scope: { channel_id: "ch2", topic_id: null, topic_id2: null },
              entity: { type: "test", id: "test1" },
              data: {},
            };
            const event2 = {
              event_id: 2,
              ts: new Date().toISOString(),
              name: "test.event",
              scope: { channel_id: "ch1", topic_id: null, topic_id2: null },
              entity: { type: "test", id: "test2" },
              data: {},
            };

            ctx.hub!.publishEvent(event1); // Should not receive
            ctx.hub!.publishEvent(event2); // Should receive

            // Wait a bit for events to propagate
            setTimeout(resolve, 500);
          }
        };

        ws.onerror = reject;
      });

      const events = messages.filter(m => m.type === "event");
      expect(events.length).toBe(1);
      expect(events[0].scope.channel_id).toBe("ch1");

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Size Validation Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Message Size Validation", () => {
  test("closes connection on oversized hello message", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          // Create a message larger than SIZE_LIMITS.WS_MESSAGE (256KB)
          const largeArray = new Array(100000).fill("x".repeat(100));
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: largeArray },
          }));
        };

        ws.onclose = (event) => {
          expect(event.code).toBe(1009); // Message too large
          resolve();
        };

        ws.onerror = () => {
          resolve(); // Expected
        };
      });
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hub Management Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Hub Management", () => {
  test("tracks connection count", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    expect(ctx.hub.getConnectionCount()).toBe(0);

    try {
      const ws1 = new WebSocket(`${ctx.baseWsUrl!}?token=${AUTH_TOKEN}`);
      await new Promise<void>((resolve) => {
        ws1.onopen = () => resolve();
      });

      // Give it a moment to register
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctx.hub!.getConnectionCount()).toBe(1);

      const ws2 = new WebSocket(`${ctx.baseWsUrl!}?token=${AUTH_TOKEN}`);
      await new Promise<void>((resolve) => {
        ws2.onopen = () => resolve();
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctx.hub!.getConnectionCount()).toBe(2);

      ws1.close();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctx.hub!.getConnectionCount()).toBe(1);

      ws2.close();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctx.hub!.getConnectionCount()).toBe(0);
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("closeAll disconnects all clients", async () => {
    const ctx = createTestContext();
    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws1 = new WebSocket(`${ctx.baseWsUrl!}?token=${AUTH_TOKEN}`);
      const ws2 = new WebSocket(`${ctx.baseWsUrl!}?token=${AUTH_TOKEN}`);

      await Promise.all([
        new Promise<void>((resolve) => { ws1.onopen = () => resolve(); }),
        new Promise<void>((resolve) => { ws2.onopen = () => resolve(); }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctx.hub!.getConnectionCount()).toBe(2);

      // Close all
      ctx.hub!.closeAll();

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctx.hub!.getConnectionCount()).toBe(0);
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});
