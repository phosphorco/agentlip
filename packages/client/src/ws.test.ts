/**
 * Integration tests for WebSocket client
 *
 * Tests WS connection, replay, reconnection, and deduplication against a real hub instance.
 * Uses the standard API flow: create channel → create topic → send message → receive events via WS.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTempWorkspace, startTestHub, type TempWorkspace, type TestHub } from "../../hub/src/integrationHarness";
import { wsConnect, type WsConnection } from "./ws";
import { createChannel, createTopic, sendMessage, type HubHttpClient } from "./mutations";
import type { EventEnvelope } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for WebSocket injection
// ─────────────────────────────────────────────────────────────────────────────

describe("WebSocket injection (unit)", () => {
  // Simple close event interface for testing
  interface TestCloseEvent {
    code: number;
    reason: string;
  }

  test("wsConnect throws clear error when no WebSocket available", async () => {
    // Save original
    const originalWs = globalThis.WebSocket;

    try {
      // Temporarily remove global WebSocket
      (globalThis as any).WebSocket = undefined;

      // Should throw clear error
      await expect(
        wsConnect({
          url: "ws://localhost:9999/ws",
          authToken: "test",
          afterEventId: 0,
        }),
      ).rejects.toThrow("WebSocket not available. Pass webSocketImpl option or use Node 22+.");
    } finally {
      // Restore
      globalThis.WebSocket = originalWs;
    }
  });

  test("wsConnect uses injected webSocketImpl for construction", async () => {
    const constructorCalls: string[] = [];

    // Fake WebSocket implementation that records constructor calls
    class FakeWebSocket {
      onopen: ((event: any) => void) | null = null;
      onclose: ((event: TestCloseEvent) => void) | null = null;
      onmessage: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;

      constructor(url: string) {
        constructorCalls.push(url);

        // Simulate successful connection
        setTimeout(() => {
          if (this.onopen) {
            this.onopen({});
          }
        }, 10);
      }

      send(data: string): void {
        // Parse hello message and respond with hello_ok
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage({
              data: JSON.stringify({
                type: "hello_ok",
                replay_until: 0,
                instance_id: "test-instance",
              }),
            });
          }
        }, 10);
      }

      close(_code?: number, _reason?: string): void {
        setTimeout(() => {
          if (this.onclose) {
            this.onclose({ code: 1000, reason: "test close" });
          }
        }, 10);
      }
    }

    const conn = await wsConnect({
      url: "ws://test-host:8080/ws",
      authToken: "injected-token",
      afterEventId: 0,
      webSocketImpl: FakeWebSocket as any,
    });

    // Should have called constructor once for initial connection
    expect(constructorCalls.length).toBe(1);
    expect(constructorCalls[0]).toContain("ws://test-host:8080/ws?token=injected-token");

    conn.close();
  });

  test("reconnect uses injected webSocketImpl", async () => {
    const constructorCalls: string[] = [];
    const callbacks = {
      onclose: null as ((event: TestCloseEvent) => void) | null,
    };

    // Fake WebSocket that can trigger reconnect
    class FakeWebSocketWithReconnect {
      onopen: ((event: any) => void) | null = null;
      onclose: ((event: TestCloseEvent) => void) | null = null;
      onmessage: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;

      constructor(url: string) {
        constructorCalls.push(url);

        // Open connection
        setTimeout(() => {
          if (this.onopen) {
            this.onopen({});
          }
        }, 10);
      }

      send(data: string): void {
        // Always respond with hello_ok
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage({
              data: JSON.stringify({
                type: "hello_ok",
                replay_until: 0,
                instance_id: "test-instance",
              }),
            });
          }

          // Store close callback for test to trigger reconnect
          if (constructorCalls.length === 1 && this.onclose) {
            callbacks.onclose = this.onclose;
          }
        }, 10);
      }

      close(_code?: number, _reason?: string): void {
        if (this.onclose) {
          this.onclose({ code: 1000, reason: "normal close" });
        }
      }
    }

    const conn = await wsConnect({
      url: "ws://test-reconnect:9999/ws",
      authToken: "token",
      afterEventId: 0,
      reconnectDelay: 50,
      webSocketImpl: FakeWebSocketWithReconnect as any,
    });

    // Should have 1 constructor call initially
    expect(constructorCalls.length).toBe(1);

    // Wait for hello handshake
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Trigger a reconnect by simulating server going away (code 1001)
    if (callbacks.onclose) {
      callbacks.onclose({ code: 1001, reason: "going away" });
    }

    // Wait for reconnect delay + connection
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should now have 2 constructor calls (initial + reconnect)
    expect(constructorCalls.length).toBe(2);
    expect(constructorCalls[1]).toContain("ws://test-reconnect:9999/ws?token=token");

    conn.close();
  }, 10000);
});

describe("WebSocket client integration", () => {
  let workspace: TempWorkspace;
  let hub: TestHub;
  let httpClient: HubHttpClient;
  let connections: WsConnection[] = [];

  beforeEach(async () => {
    workspace = await createTempWorkspace();
    hub = await startTestHub({
      workspaceRoot: workspace.root,
      authToken: "test-token",
    });
    httpClient = {
      baseUrl: hub.url,
      authToken: "test-token",
    };
  });

  afterEach(async () => {
    for (const conn of connections) {
      conn.close();
    }
    connections = [];
    await hub.stop();
    await workspace.cleanup();
  });

  function wsUrl(): string {
    return hub.url.replace("http://", "ws://") + "/ws";
  }

  /** Helper: create a channel + topic + send a message, returns the message event_id */
  async function seedMessage(
    channelName: string,
    topicTitle: string,
    content: string,
    sender = "test-agent",
  ): Promise<{ channelId: string; topicId: string; messageId: string; eventId: number }> {
    const ch = await createChannel(httpClient, { name: channelName });
    const tp = await createTopic(httpClient, { channelId: ch.channel.id, title: topicTitle });
    const msg = await sendMessage(httpClient, { topicId: tp.topic.id, sender, contentRaw: content });
    return {
      channelId: ch.channel.id,
      topicId: tp.topic.id,
      messageId: msg.message.id,
      eventId: msg.event_id,
    };
  }

  /** Helper: read next event with timeout */
  async function nextEvent(
    iter: AsyncIterableIterator<EventEnvelope>,
    timeoutMs = 5000,
  ): Promise<EventEnvelope> {
    const result = await Promise.race([
      iter.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out waiting for event (${timeoutMs}ms)`)), timeoutMs),
      ),
    ]);
    if (result.done) throw new Error("Iterator ended unexpectedly");
    return result.value;
  }

  test("connect + hello handshake + receive events via replay", async () => {
    // Seed data before connecting
    const seed = await seedMessage("ws-ch1", "topic1", "hello from replay");

    // Connect from event 0 → should replay all events
    const conn = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: 0,
    });
    connections.push(conn);

    const events = conn.events();

    // We should get channel.created, topic.created, message.created in order
    const e1 = await nextEvent(events);
    expect(e1.name).toBe("channel.created");

    const e2 = await nextEvent(events);
    expect(e2.name).toBe("topic.created");

    const e3 = await nextEvent(events);
    expect(e3.name).toBe("message.created");
    expect((e3.data as any).message.content_raw).toBe("hello from replay");
    expect(conn.lastEventId()).toBe(e3.event_id);
  }, 10000);

  test("receive live events after initial replay", async () => {
    // Seed initial data
    const seed = await seedMessage("ws-ch2", "topic2", "initial msg");

    // Connect and consume replay events
    const conn = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: 0,
    });
    connections.push(conn);

    const events = conn.events();
    // Drain the 3 replay events (channel, topic, message)
    await nextEvent(events);
    await nextEvent(events);
    await nextEvent(events);

    // Now send a live message
    const liveMsg = await sendMessage(httpClient, {
      topicId: seed.topicId,
      sender: "live-sender",
      contentRaw: "live message!",
    });

    // Should receive the live event
    const live = await nextEvent(events);
    expect(live.name).toBe("message.created");
    expect((live.data as any).message.content_raw).toBe("live message!");
    expect(live.event_id).toBe(liveMsg.event_id);
  }, 10000);

  test("close() stops reconnection and terminates iterator", async () => {
    const conn = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: 0,
      reconnectDelay: 100,
    });
    connections.push(conn);

    // Close immediately
    conn.close();

    // Wait a bit to ensure no reconnect happens
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Iterator should be closed
    const events = conn.events();
    const result = await events.next();
    expect(result.done).toBe(true);
    expect(conn.connected).toBe(false);
  }, 5000);

  test("subscription filtering - only matching channel events received", async () => {
    // Create two channels with messages
    const ch1 = await createChannel(httpClient, { name: "filtered-ch1" });
    const ch2 = await createChannel(httpClient, { name: "filtered-ch2" });
    const tp1 = await createTopic(httpClient, { channelId: ch1.channel.id, title: "tp1" });
    const tp2 = await createTopic(httpClient, { channelId: ch2.channel.id, title: "tp2" });
    const msg1 = await sendMessage(httpClient, { topicId: tp1.topic.id, sender: "a", contentRaw: "ch1 msg" });
    const msg2 = await sendMessage(httpClient, { topicId: tp2.topic.id, sender: "a", contentRaw: "ch2 msg" });

    // Connect subscribing only to ch1
    const conn = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: 0,
      subscriptions: { channels: [ch1.channel.id] },
    });
    connections.push(conn);

    const events = conn.events();

    // Should receive only ch1 events: channel.created, topic.created, message.created
    const e1 = await nextEvent(events);
    expect(e1.name).toBe("channel.created");
    expect(e1.scope.channel_id).toBe(ch1.channel.id);

    const e2 = await nextEvent(events);
    expect(e2.name).toBe("topic.created");
    expect(e2.scope.channel_id).toBe(ch1.channel.id);

    const e3 = await nextEvent(events);
    expect(e3.name).toBe("message.created");
    expect(e3.scope.channel_id).toBe(ch1.channel.id);

    // Now send a live message to ch2 (should NOT receive) then ch1 (should receive)
    await sendMessage(httpClient, { topicId: tp2.topic.id, sender: "a", contentRaw: "ch2 live - should not see" });
    const liveMsg = await sendMessage(httpClient, { topicId: tp1.topic.id, sender: "a", contentRaw: "ch1 live" });

    const e4 = await nextEvent(events);
    expect(e4.name).toBe("message.created");
    expect((e4.data as any).message.content_raw).toBe("ch1 live");
  }, 10000);

  test("resume from afterEventId skips already-seen events", async () => {
    // Seed 2 messages
    const ch = await createChannel(httpClient, { name: "resume-ch" });
    const tp = await createTopic(httpClient, { channelId: ch.channel.id, title: "resume-tp" });
    const msg1 = await sendMessage(httpClient, { topicId: tp.topic.id, sender: "a", contentRaw: "msg1" });
    const msg2 = await sendMessage(httpClient, { topicId: tp.topic.id, sender: "a", contentRaw: "msg2" });

    // Connect starting after msg1's event_id → should only get msg2 events
    const conn = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: msg1.event_id,
    });
    connections.push(conn);

    const events = conn.events();
    const e1 = await nextEvent(events);

    // The first event should be msg2 (event_id > msg1.event_id)
    expect(e1.name).toBe("message.created");
    expect((e1.data as any).message.content_raw).toBe("msg2");
    expect(e1.event_id).toBe(msg2.event_id);
  }, 10000);

  test("unauthorized token gives up after consecutive failures", async () => {
    const conn = await wsConnect({
      url: wsUrl(),
      authToken: "wrong-token",
      afterEventId: 0,
      reconnectDelay: 50, // Fast retries for testing
    });
    connections.push(conn);

    // Should give up after consecutive failures (5 attempts)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(conn.connected).toBe(false);

    // Iterator should produce an error or be done
    const events = conn.events();
    try {
      const result = await events.next();
      // If it resolves, it should be done
      expect(result.done).toBe(true);
    } catch (err) {
      // Error from consecutive failure is also acceptable
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Connection failed");
    }
  }, 5000);
});
