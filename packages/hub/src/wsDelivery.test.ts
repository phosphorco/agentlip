/**
 * WebSocket Delivery Guarantees Test Suite
 * 
 * Tests critical edge cases for WS event delivery:
 * - Disconnect mid-replay with clean resume
 * - Replay boundary semantics (ADR-0003)
 * - Mid-batch send failures
 * - Stale client pagination
 * - Hub restart behavior
 * 
 * Maps to Gate C (replay equivalence) verification.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb, runMigrations, insertEvent, MIGRATIONS_DIR } from "@agentlip/kernel";
import { createWsHub, createWsHandlers } from "./wsEndpoint";
import { generateAuthToken } from "./authToken";

const TEST_DIR = join(import.meta.dir, ".test-tmp-ws-delivery");
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
  const dbPath = join(TEST_DIR, `ws-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  return { db, dbPath };
}

async function setupTestServer(db: Database, instanceId?: string): Promise<{
  server: any;
  port: number;
  baseWsUrl: string;
  hub: ReturnType<typeof createWsHub>;
}> {
  const hub = createWsHub({ db, instanceId: instanceId ?? `test-${Date.now()}` });
  const handlers = createWsHandlers({ db, authToken: AUTH_TOKEN, hub: hub as any });

  const server = Bun.serve({
    port: 0,
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
// Disconnect Mid-Replay Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Disconnect Mid-Replay", () => {
  test("client disconnects during replay, reconnects with after_event_id, resumes cleanly", async () => {
    const ctx = createTestContext();

    // Seed 100 events
    for (let i = 1; i <= 100; i++) {
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
      // First connection: receive first 50 events, then disconnect
      const ws1 = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);
      const received1: any[] = [];

      await new Promise<void>((resolve, reject) => {
        let handshakeComplete = false;

        ws1.onopen = () => {
          ws1.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws1.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          received1.push(msg);

          if (msg.type === "hello_ok") {
            handshakeComplete = true;
            expect(msg.replay_until).toBe(100);
          } else if (msg.type === "event") {
            // Disconnect after receiving 50 events
            if (received1.filter(m => m.type === "event").length === 50) {
              ws1.close();
              resolve();
            }
          }
        };

        ws1.onerror = reject;
        ws1.onclose = () => {
          if (handshakeComplete && received1.filter(m => m.type === "event").length === 50) {
            resolve();
          }
        };

        setTimeout(() => reject(new Error("Timeout in first connection")), 5000);
      });

      const events1 = received1.filter(m => m.type === "event");
      expect(events1.length).toBe(50);
      expect(events1[0].event_id).toBe(1);
      expect(events1[49].event_id).toBe(50);

      // Second connection: resume from event 50
      const ws2 = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);
      const received2: any[] = [];

      await new Promise<void>((resolve, reject) => {
        ws2.onopen = () => {
          ws2.send(JSON.stringify({
            type: "hello",
            after_event_id: 50, // Resume from last received
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws2.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          received2.push(msg);

          if (msg.type === "hello_ok") {
            expect(msg.replay_until).toBe(100);
          } else if (msg.type === "event") {
            // Receive remaining 50 events
            if (received2.filter(m => m.type === "event").length === 50) {
              resolve();
            }
          }
        };

        ws2.onerror = reject;
        setTimeout(() => reject(new Error("Timeout in second connection")), 5000);
      });

      const events2 = received2.filter(m => m.type === "event");
      expect(events2.length).toBe(50);
      expect(events2[0].event_id).toBe(51); // Continues from where we left off
      expect(events2[49].event_id).toBe(100);

      // Verify no gaps: events1 + events2 should cover 1..100
      const allEventIds = [
        ...events1.map(e => e.event_id),
        ...events2.map(e => e.event_id),
      ].sort((a, b) => a - b);

      expect(allEventIds.length).toBe(100);
      expect(allEventIds[0]).toBe(1);
      expect(allEventIds[99]).toBe(100);
      
      // Verify strictly increasing (no duplicates)
      for (let i = 1; i < allEventIds.length; i++) {
        expect(allEventIds[i]).toBe(allEventIds[i - 1] + 1);
      }

      ws2.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("server continues without crash when client disconnects mid-replay", async () => {
    const ctx = createTestContext();

    // Seed many events to ensure replay takes time
    for (let i = 1; i <= 200; i++) {
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
      const ws1 = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve, reject) => {
        ws1.onopen = () => {
          ws1.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));

          // Immediately close after sending hello (mid-replay)
          setTimeout(() => {
            ws1.close();
          }, 10);
        };

        ws1.onclose = () => resolve();
        ws1.onerror = () => resolve(); // Expected

        setTimeout(() => reject(new Error("Timeout")), 2000);
      });

      // Verify server still healthy: new connection should work
      const ws2 = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve, reject) => {
        ws2.onopen = () => {
          ws2.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws2.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "hello_ok") {
            expect(msg.replay_until).toBe(200);
            resolve();
          }
        };

        ws2.onerror = reject;
        setTimeout(() => reject(new Error("Server not responsive after client disconnect")), 5000);
      });

      expect(ctx.hub.getConnectionCount()).toBe(1); // Only ws2 connected

      ws2.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Replay Boundary Semantics (ADR-0003)
// ─────────────────────────────────────────────────────────────────────────────

describe("Replay Boundary Semantics (ADR-0003)", () => {
  test("replay_until boundary remains stable even if new events inserted during replay", async () => {
    const ctx = createTestContext();

    // Seed initial 50 events
    for (let i = 1; i <= 50; i++) {
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
      let replayUntil: number | null = null;

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
            replayUntil = msg.replay_until;
            expect(replayUntil).toBe(50);

            // Insert new events DURING replay phase
            // These should NOT appear in replay (only in live stream)
            for (let i = 51; i <= 100; i++) {
              const eventId = insertEvent({
                db: ctx.db,
                name: "test.event",
                scopes: { channel_id: "ch1" },
                entity: { type: "test", id: `test${i}` },
                data: { index: i },
              });

              // Publish to live stream
              const newEvent = {
                event_id: eventId,
                ts: new Date().toISOString(),
                name: "test.event",
                scope: { channel_id: "ch1", topic_id: null, topic_id2: null },
                entity: { type: "test", id: `test${i}` },
                data: { index: i },
              };
              ctx.hub!.publishEvent(newEvent);
            }
          } else if (msg.type === "event") {
            // Check if we've received all events (replay + live)
            const events = messages.filter(m => m.type === "event");
            if (events.length === 100) {
              resolve();
            }
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout waiting for all events")), 5000);
      });

      const events = messages.filter(m => m.type === "event");
      expect(events.length).toBe(100);

      // Verify replay boundary: events 1-50 came from replay
      const replayEvents = events.filter(e => e.event_id <= replayUntil!);
      expect(replayEvents.length).toBe(50);
      expect(replayEvents[0].event_id).toBe(1);
      expect(replayEvents[49].event_id).toBe(50);

      // Events 51-100 came from live stream (inserted during replay)
      const liveEvents = events.filter(e => e.event_id > replayUntil!);
      expect(liveEvents.length).toBe(50);
      expect(liveEvents[0].event_id).toBe(51);
      expect(liveEvents[49].event_id).toBe(100);

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("replay boundary prevents duplicates: same event never in both replay and live", async () => {
    const ctx = createTestContext();

    // Seed 30 events
    for (let i = 1; i <= 30; i++) {
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
      const eventIds: number[] = [];

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

          if (msg.type === "event") {
            eventIds.push(msg.event_id);

            if (eventIds.length === 30) {
              resolve();
            }
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      // Verify no duplicates
      const uniqueIds = new Set(eventIds);
      expect(uniqueIds.size).toBe(eventIds.length);

      // Verify strictly increasing
      for (let i = 1; i < eventIds.length; i++) {
        expect(eventIds[i]).toBeGreaterThan(eventIds[i - 1]);
      }

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mid-Batch Send Failure Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Mid-Batch Send Failure", () => {
  test("connection closes gracefully on send error during replay", async () => {
    const ctx = createTestContext();

    // Seed events
    for (let i = 1; i <= 50; i++) {
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

      await new Promise<void>((resolve, reject) => {
        let receivedCount = 0;

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.type === "event") {
            receivedCount++;
            
            // Simulate client closing connection mid-replay (after receiving a few events)
            if (receivedCount === 10) {
              ws.close();
            }
          }
        };

        ws.onclose = (event) => {
          // Connection closed (either by client or server backpressure)
          expect(receivedCount).toBeGreaterThan(0);
          resolve();
        };

        ws.onerror = () => {
          resolve(); // Expected
        };

        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      // Verify server still responsive (wait for connection cleanup)
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctx.hub.getConnectionCount()).toBe(0);
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("client reconnects after mid-batch failure and receives remaining events", async () => {
    const ctx = createTestContext();

    // Seed 100 events
    for (let i = 1; i <= 100; i++) {
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
      // First connection: receive some events, then fail
      const ws1 = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);
      let lastProcessed = 0;

      await new Promise<void>((resolve) => {
        ws1.onopen = () => {
          ws1.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws1.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.type === "event") {
            lastProcessed = msg.event_id;
            
            if (lastProcessed === 25) {
              ws1.close(); // Simulate failure
            }
          }
        };

        ws1.onclose = () => resolve();
        ws1.onerror = () => resolve();
      });

      expect(lastProcessed).toBe(25);

      // Second connection: resume from last processed
      const ws2 = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);
      const received: number[] = [];

      await new Promise<void>((resolve, reject) => {
        ws2.onopen = () => {
          ws2.send(JSON.stringify({
            type: "hello",
            after_event_id: lastProcessed,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws2.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.type === "event") {
            received.push(msg.event_id);
            
            if (received.length === 75) { // 100 - 25 = 75 remaining
              resolve();
            }
          }
        };

        ws2.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      // Verify we got the remaining events
      expect(received.length).toBe(75);
      expect(received[0]).toBe(26);
      expect(received[74]).toBe(100);

      // Verify no gaps
      for (let i = 1; i < received.length; i++) {
        expect(received[i]).toBe(received[i - 1] + 1);
      }

      ws2.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale Client Pagination Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Stale Client Pagination", () => {
  test("client far behind (after_event_id=0 with many events) receives ordered replay", async () => {
    const ctx = createTestContext();

    // Seed 500 events
    for (let i = 1; i <= 500; i++) {
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
      const eventIds: number[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0, // Far behind
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.type === "event") {
            eventIds.push(msg.event_id);
            
            if (eventIds.length === 500) {
              resolve();
            }
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout waiting for replay")), 10000);
      });

      // Verify we received all events in order
      expect(eventIds.length).toBe(500);
      expect(eventIds[0]).toBe(1);
      expect(eventIds[499]).toBe(500);

      // Verify strict ordering (no gaps, no duplicates)
      for (let i = 1; i < eventIds.length; i++) {
        expect(eventIds[i]).toBe(eventIds[i - 1] + 1);
      }

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });

  test("stale client receives events with correct filtering", async () => {
    const ctx = createTestContext();

    // Seed 200 events across multiple channels
    for (let i = 1; i <= 200; i++) {
      const channelId = i % 2 === 0 ? "ch1" : "ch2";
      insertEvent({
        db: ctx.db,
        name: "test.event",
        scopes: { channel_id: channelId },
        entity: { type: "test", id: `test${i}` },
        data: { index: i, channel: channelId },
      });
    }

    const serverCtx = await setupTestServer(ctx.db);
    ctx.server = serverCtx.server;
    ctx.port = serverCtx.port;
    ctx.baseWsUrl = serverCtx.baseWsUrl;
    ctx.hub = serverCtx.hub;

    try {
      const ws = new WebSocket(`${ctx.baseWsUrl}?token=${AUTH_TOKEN}`);
      const eventIds: number[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] }, // Only ch1
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.type === "event") {
            eventIds.push(msg.event_id);
            expect(msg.scope.channel_id).toBe("ch1"); // Verify filtering
            
            if (eventIds.length === 100) { // Should get 100 events (half of 200)
              resolve();
            }
          }
        };

        ws.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 10000);
      });

      expect(eventIds.length).toBe(100);

      // Verify all are even IDs (ch1 events)
      for (const id of eventIds) {
        expect(id % 2).toBe(0);
      }

      ws.close();
    } finally {
      ctx.server.stop();
      ctx.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hub Restart Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Hub Restart Behavior", () => {
  test("hub restart: clients reconnect and resume from last processed event_id", async () => {
    const ctx = createTestContext();

    // Seed initial events
    for (let i = 1; i <= 50; i++) {
      insertEvent({
        db: ctx.db,
        name: "test.event",
        scopes: { channel_id: "ch1" },
        entity: { type: "test", id: `test${i}` },
        data: { index: i },
      });
    }

    // Start first hub instance
    const serverCtx1 = await setupTestServer(ctx.db, "instance-1");
    const server1 = serverCtx1.server;
    const baseWsUrl = serverCtx1.baseWsUrl;

    let lastProcessed = 0;

    try {
      // Connect client and receive some events
      const ws1 = new WebSocket(`${baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve, reject) => {
        ws1.onopen = () => {
          ws1.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws1.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.type === "hello_ok") {
            expect(msg.instance_id).toBe("instance-1");
          } else if (msg.type === "event") {
            lastProcessed = msg.event_id;
            
            if (lastProcessed === 30) {
              resolve();
            }
          }
        };

        ws1.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      expect(lastProcessed).toBe(30);

      // Close connection before stopping server
      ws1.close();
      
      // Wait for connection to close
      await new Promise<void>((resolve) => {
        ws1.onclose = () => resolve();
        setTimeout(resolve, 500);
      });

      // Stop first hub instance
      server1.stop();
    } catch (err) {
      server1.stop();
      throw err;
    }

    // Insert more events while hub is down
    for (let i = 51; i <= 100; i++) {
      insertEvent({
        db: ctx.db,
        name: "test.event",
        scopes: { channel_id: "ch1" },
        entity: { type: "test", id: `test${i}` },
        data: { index: i },
      });
    }

    // Start new hub instance (different instance_id)
    const serverCtx2 = await setupTestServer(ctx.db, "instance-2");
    const server2 = serverCtx2.server;
    const baseWsUrl2 = serverCtx2.baseWsUrl;

    try {
      // Reconnect client with last processed event_id
      const ws2 = new WebSocket(`${baseWsUrl2}?token=${AUTH_TOKEN}`);
      const received: number[] = [];

      await new Promise<void>((resolve, reject) => {
        ws2.onopen = () => {
          ws2.send(JSON.stringify({
            type: "hello",
            after_event_id: lastProcessed, // Resume from where we left off
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws2.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.type === "hello_ok") {
            expect(msg.instance_id).toBe("instance-2"); // New instance
            expect(msg.replay_until).toBe(100);
          } else if (msg.type === "event") {
            received.push(msg.event_id);
            
            if (received.length === 70) { // 100 - 30 = 70 remaining
              resolve();
            }
          }
        };

        ws2.onerror = reject;
        setTimeout(() => reject(new Error("Timeout after hub restart")), 5000);
      });

      // Verify we got all remaining events
      expect(received.length).toBe(70);
      expect(received[0]).toBe(31);
      expect(received[69]).toBe(100);

      // Verify no gaps
      for (let i = 1; i < received.length; i++) {
        expect(received[i]).toBe(received[i - 1] + 1);
      }

      ws2.close();
    } finally {
      server2.stop();
      ctx.db.close();
    }
  });

  test("instance_id changes on hub restart but protocol still works", async () => {
    const ctx = createTestContext();

    insertEvent({
      db: ctx.db,
      name: "test.event",
      scopes: { channel_id: "ch1" },
      entity: { type: "test", id: "test1" },
      data: { index: 1 },
    });

    // First instance
    const serverCtx1 = await setupTestServer(ctx.db, "instance-old");
    let instance1Id: string | null = null;

    try {
      const ws1 = new WebSocket(`${serverCtx1.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve, reject) => {
        ws1.onopen = () => {
          ws1.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws1.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "hello_ok") {
            instance1Id = msg.instance_id;
            expect(instance1Id).toBe("instance-old");
            resolve();
          }
        };

        ws1.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      ws1.close();
      serverCtx1.server.stop();
    } catch (err) {
      serverCtx1.server.stop();
      throw err;
    }

    // Second instance with different ID
    const serverCtx2 = await setupTestServer(ctx.db, "instance-new");

    try {
      const ws2 = new WebSocket(`${serverCtx2.baseWsUrl}?token=${AUTH_TOKEN}`);

      await new Promise<void>((resolve, reject) => {
        ws2.onopen = () => {
          ws2.send(JSON.stringify({
            type: "hello",
            after_event_id: 0,
            subscriptions: { channels: ["ch1"] },
          }));
        };

        ws2.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "hello_ok") {
            expect(msg.instance_id).toBe("instance-new");
            expect(msg.instance_id).not.toBe(instance1Id);
            resolve();
          }
        };

        ws2.onerror = reject;
        setTimeout(() => reject(new Error("Timeout")), 5000);
      });

      ws2.close();
    } finally {
      serverCtx2.server.stop();
      ctx.db.close();
    }
  });
});
