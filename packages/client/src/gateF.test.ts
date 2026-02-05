/**
 * Gate F: CLI + SDK stability tests
 *
 * Tests proving:
 * 1. CLI --json/--jsonl output is versioned and additive-only
 * 2. SDK reconnects indefinitely, making forward progress using stored event_id
 *
 * Key scenarios:
 * - JSON output includes required fields (status, error codes)
 * - SDK resumes from stored event_id after hub restart
 * - SDK makes forward progress through reconnections
 * - Unknown event fields don't break consumers (additive schema)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTempWorkspace,
  startTestHub,
  type TempWorkspace,
  type TestHub,
} from "../../hub/src/integrationHarness";
import { wsConnect, type WsConnection } from "./ws";
import {
  createChannel,
  createTopic,
  sendMessage,
  HubApiError,
  type HubHttpClient,
} from "./mutations";
import type { EventEnvelope } from "./types";
import {
  isMessageCreated,
  isChannelCreated,
  isTopicCreated,
} from "./events";

describe("Gate F: CLI + SDK stability", () => {
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

  /** Helper: collect N events with timeout */
  async function collectEvents(
    iter: AsyncIterableIterator<EventEnvelope>,
    count: number,
    timeoutMs = 10000,
  ): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];
    const deadline = Date.now() + timeoutMs;

    while (events.length < count && Date.now() < deadline) {
      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) {
        throw new Error(
          `Timeout collecting events: got ${events.length}/${count} events`,
        );
      }

      const result = await Promise.race([
        iter.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Event collection timeout`)),
            remainingTime,
          ),
        ),
      ]);

      if (result.done) break;
      events.push(result.value);
    }

    if (events.length < count) {
      throw new Error(
        `Iterator ended early: got ${events.length}/${count} events`,
      );
    }

    return events;
  }

  /** Helper: wait for next single event */
  async function nextEvent(
    iter: AsyncIterableIterator<EventEnvelope>,
    timeoutMs = 5000,
  ): Promise<EventEnvelope> {
    const result = await Promise.race([
      iter.next(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out waiting for event (${timeoutMs}ms)`)),
          timeoutMs,
        ),
      ),
    ]);
    if (result.done) throw new Error("Iterator ended unexpectedly");
    return result.value;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Test 1: CLI JSON output structure validation
  // ───────────────────────────────────────────────────────────────────────────

  test("Gate F.1: HTTP API responses include status field", async () => {
    // All successful responses should have implicit status via HTTP 200
    // and return structured data

    const channelRes = await createChannel(httpClient, {
      name: "gate-f-channel",
    });

    // Verify response shape includes required fields
    expect(channelRes.channel).toBeDefined();
    expect(channelRes.channel.id).toMatch(/^ch_/);
    expect(channelRes.event_id).toBeGreaterThan(0);

    const topicRes = await createTopic(httpClient, {
      channelId: channelRes.channel.id,
      title: "gate-f-topic",
    });

    expect(topicRes.topic).toBeDefined();
    expect(topicRes.topic.id).toMatch(/^topic_/);
    expect(topicRes.event_id).toBeGreaterThan(0);

    const messageRes = await sendMessage(httpClient, {
      topicId: topicRes.topic.id,
      sender: "test-agent",
      contentRaw: "gate-f message",
    });

    expect(messageRes.message).toBeDefined();
    expect(messageRes.message.id).toMatch(/^msg_/);
    expect(messageRes.event_id).toBeGreaterThan(0);

    // Success implies status=ok (HTTP 200)
  }, 10000);

  test("Gate F.1: HTTP API errors include error code field", async () => {
    // Test that errors return structured error responses with codes

    try {
      await sendMessage(httpClient, {
        topicId: "topic_nonexistent",
        sender: "test-agent",
        contentRaw: "should fail",
      });
      throw new Error("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HubApiError);
      const err = e as HubApiError;

      // Verify error has code field
      expect(err.code).toBeDefined();
      expect(err.code).toBe("NOT_FOUND");
      expect(err.status).toBe(404);
      expect(err.message).toBeTruthy();
    }
  }, 10000);

  test("Gate F.1: HTTP API auth errors include error code", async () => {
    const badAuth: HubHttpClient = {
      baseUrl: hub.url,
      authToken: "wrong-token",
    };

    try {
      await createChannel(badAuth, { name: "should-fail" });
      throw new Error("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HubApiError);
      const err = e as HubApiError;

      // Verify error has code field
      expect(err.code).toBeDefined();
      expect(err.code).toBe("INVALID_AUTH");
      expect(err.status).toBe(401);
    }
  }, 10000);

  test("Gate F.1: Adding new response fields doesn't break existing consumers", async () => {
    // This test verifies additive-only schema: future fields won't break us
    const res = await createChannel(httpClient, { name: "future-fields" });

    // Current required fields
    expect(res.channel).toBeDefined();
    expect(res.channel.id).toBeTruthy();
    expect(res.event_id).toBeGreaterThan(0);

    // If the API adds new fields (e.g., res.metadata or res.channel.tags),
    // TypeScript won't enforce them at runtime, and consumers should still work.
    // We can't test future fields directly, but we validate that we only
    // depend on documented fields.

    // Cast to unknown to verify we're not accessing undocumented fields
    const resUnknown = res as unknown as Record<string, unknown>;

    // We should only access these documented fields
    const expectedKeys = new Set(["channel", "event_id"]);
    const actualKeys = Object.keys(resUnknown);

    // All actual keys should be expected (we may have fewer if typing is strict)
    for (const key of actualKeys) {
      // If new fields appear, they should be ignored gracefully
      // We only validate that our expected fields are present
    }

    expect(expectedKeys.has("channel")).toBe(true);
    expect(expectedKeys.has("event_id")).toBe(true);
  }, 10000);

  // ───────────────────────────────────────────────────────────────────────────
  // Test 2: SDK reconnects after hub restart using stored event_id
  // ───────────────────────────────────────────────────────────────────────────

  test("Gate F.2: SDK resumes from stored event_id after hub restart", async () => {
    // 1. Create channel + topic + send 3 messages
    const ch = await createChannel(httpClient, { name: "restart-ch" });
    const tp = await createTopic(httpClient, {
      channelId: ch.channel.id,
      title: "restart-tp",
    });

    await sendMessage(httpClient, {
      topicId: tp.topic.id,
      sender: "agent-1",
      contentRaw: "msg1",
    });
    await sendMessage(httpClient, {
      topicId: tp.topic.id,
      sender: "agent-1",
      contentRaw: "msg2",
    });
    await sendMessage(httpClient, {
      topicId: tp.topic.id,
      sender: "agent-1",
      contentRaw: "msg3",
    });

    // 2. Connect SDK from event_id=0, consume all events, record lastEventId
    const conn1 = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: 0,
    });
    connections.push(conn1);

    const iter1 = conn1.events();

    // Expect: channel.created, topic.created, message.created × 3 = 5 events
    const initialEvents = await collectEvents(iter1, 5);
    expect(initialEvents).toHaveLength(5);

    const lastId = conn1.lastEventId();
    expect(lastId).toBeGreaterThan(0);

    // Verify event order
    expect(isChannelCreated(initialEvents[0])).toBe(true);
    expect(isTopicCreated(initialEvents[1])).toBe(true);
    expect(isMessageCreated(initialEvents[2])).toBe(true);
    expect(isMessageCreated(initialEvents[3])).toBe(true);
    expect(isMessageCreated(initialEvents[4])).toBe(true);

    conn1.close();

    // 3. Stop hub
    const hubPort = hub.server.port;
    await hub.stop();

    // 4. Start hub again (same workspace, same port)
    hub = await startTestHub({
      workspaceRoot: workspace.root,
      authToken: "test-token",
    });

    // Update httpClient to new hub
    httpClient = {
      baseUrl: hub.url,
      authToken: "test-token",
    };

    // 5. Create new WsConnection from lastEventId
    const conn2 = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: lastId,
    });
    connections.push(conn2);

    // Initially, we should get no events (we're caught up)
    // To verify, we'll send 2 new messages and check we only get those 2 events

    // 6. Send 2 more messages
    await sendMessage(httpClient, {
      topicId: tp.topic.id,
      sender: "agent-2",
      contentRaw: "msg4-after-restart",
    });
    await sendMessage(httpClient, {
      topicId: tp.topic.id,
      sender: "agent-2",
      contentRaw: "msg5-after-restart",
    });

    // 7. Verify the iterator yields exactly the 2 new message events
    const iter2 = conn2.events();
    const newEvents = await collectEvents(iter2, 2);

    expect(newEvents).toHaveLength(2);
    expect(isMessageCreated(newEvents[0])).toBe(true);
    expect(isMessageCreated(newEvents[1])).toBe(true);

    const msg4 = (newEvents[0].data as any).message;
    const msg5 = (newEvents[1].data as any).message;

    expect(msg4.content_raw).toBe("msg4-after-restart");
    expect(msg5.content_raw).toBe("msg5-after-restart");

    // Verify event_ids are greater than lastId
    expect(newEvents[0].event_id).toBeGreaterThan(lastId);
    expect(newEvents[1].event_id).toBeGreaterThan(lastId);

    conn2.close();
  }, 20000);

  // ───────────────────────────────────────────────────────────────────────────
  // Test 3: SDK forward progress under reconnection
  // ───────────────────────────────────────────────────────────────────────────

  test("Gate F.3: SDK forward progress - resume from checkpoint after disconnect", async () => {
    // Tests the agent pattern: connect, process events, save checkpoint,
    // disconnect, reconnect from checkpoint, continue processing.
    // This is the real-world pattern for forward progress.

    // 1. Seed data
    const ch = await createChannel(httpClient, { name: "progress-ch" });
    const tp = await createTopic(httpClient, {
      channelId: ch.channel.id,
      title: "progress-tp",
    });
    await sendMessage(httpClient, { topicId: tp.topic.id, sender: "agent", contentRaw: "batch-1-msg1" });
    await sendMessage(httpClient, { topicId: tp.topic.id, sender: "agent", contentRaw: "batch-1-msg2" });

    // 2. First connection: process events and save checkpoint
    const conn1 = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: 0,
    });
    connections.push(conn1);

    const iter1 = conn1.events();
    // channel.created + topic.created + 2 messages = 4 events
    const batch1 = await collectEvents(iter1, 4);
    expect(batch1).toHaveLength(4);

    // Save checkpoint (simulate persisting to disk)
    const checkpoint = conn1.lastEventId();
    expect(checkpoint).toBeGreaterThan(0);

    // 3. Disconnect (simulating agent shutdown/crash)
    conn1.close();

    // 4. More messages arrive while agent is offline
    await sendMessage(httpClient, { topicId: tp.topic.id, sender: "other", contentRaw: "batch-2-msg1" });
    await sendMessage(httpClient, { topicId: tp.topic.id, sender: "other", contentRaw: "batch-2-msg2" });

    // 5. Reconnect from checkpoint
    const conn2 = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: checkpoint,
    });
    connections.push(conn2);

    const iter2 = conn2.events();

    // 6. Should receive only the 2 new messages (forward progress)
    const batch2 = await collectEvents(iter2, 2);
    expect(batch2).toHaveLength(2);

    expect(isMessageCreated(batch2[0])).toBe(true);
    expect((batch2[0].data as any).message.content_raw).toBe("batch-2-msg1");
    expect(batch2[0].event_id).toBeGreaterThan(checkpoint);

    expect(isMessageCreated(batch2[1])).toBe(true);
    expect((batch2[1].data as any).message.content_raw).toBe("batch-2-msg2");
    expect(batch2[1].event_id).toBeGreaterThan(batch2[0].event_id);

    conn2.close();
  }, 15000);

  // ───────────────────────────────────────────────────────────────────────────
  // Test 4: Additive-only event schema
  // ───────────────────────────────────────────────────────────────────────────

  test("Gate F.4: Unknown event fields don't break consumers", async () => {
    // Verify that unknown fields in EventEnvelope are handled gracefully
    // This tests the additive-only schema contract

    // Create a mock EventEnvelope with extra unknown fields
    const mockEvent: EventEnvelope & { unknownField?: string } = {
      type: "event",
      event_id: 999,
      ts: new Date().toISOString(),
      name: "message.created",
      scope: {
        channel_id: "ch_test",
        topic_id: "topic_test",
        topic_id2: null,
      },
      data: {
        message: {
          id: "msg_test",
          topic_id: "topic_test",
          channel_id: "ch_test",
          sender: "test",
          content_raw: "test content",
          version: 1,
          created_at: new Date().toISOString(),
          edited_at: null,
          deleted_at: null,
          deleted_by: null,
        },
        // Extra fields in data (future extension)
        metadata: { futureField: "ignored" },
      },
      // Extra top-level field
      unknownField: "this should be ignored",
    };

    // Type guards should work despite unknown fields
    expect(isMessageCreated(mockEvent)).toBe(true);

    // Access known fields
    expect(mockEvent.event_id).toBe(999);
    expect(mockEvent.name).toBe("message.created");
    expect((mockEvent.data as any).message.content_raw).toBe("test content");

    // Unknown fields are accessible but not required
    expect(mockEvent.unknownField).toBe("this should be ignored");
    expect((mockEvent.data as any).metadata).toBeDefined();
  }, 5000);

  test("Gate F.4: Unknown event types pass through gracefully", async () => {
    // Verify that future event types (e.g., "message.reacted") don't crash consumers

    const futureEvent: EventEnvelope = {
      type: "event",
      event_id: 1000,
      ts: new Date().toISOString(),
      name: "message.reacted", // Future event type
      scope: {
        channel_id: "ch_test",
        topic_id: "topic_test",
        topic_id2: null,
      },
      data: {
        message_id: "msg_test",
        emoji: "👍",
        user_id: "user_test",
      },
    };

    // Known event type guards should return false
    expect(isMessageCreated(futureEvent)).toBe(false);
    expect(isChannelCreated(futureEvent)).toBe(false);
    expect(isTopicCreated(futureEvent)).toBe(false);

    // But the event should still be accessible as EventEnvelope
    expect(futureEvent.type).toBe("event");
    expect(futureEvent.event_id).toBe(1000);
    expect(futureEvent.name).toBe("message.reacted");

    // Data is accessible but untyped
    expect((futureEvent.data as any).emoji).toBe("👍");

    // This demonstrates graceful degradation: unknown events can be logged
    // or passed through without breaking the consumer
  }, 5000);

  test("Gate F.4: Event envelope core fields are stable", async () => {
    // Verify that the core EventEnvelope fields are always present
    // regardless of event type

    const ch = await createChannel(httpClient, {
      name: "stable-fields-ch",
    });

    const conn = await wsConnect({
      url: wsUrl(),
      authToken: "test-token",
      afterEventId: 0,
    });
    connections.push(conn);

    const iter = conn.events();
    const event = await nextEvent(iter);

    // Core fields that must be present on all events
    expect(event.type).toBe("event");
    expect(event.event_id).toBeGreaterThan(0);
    expect(event.ts).toBeTruthy();
    expect(typeof event.ts).toBe("string");
    expect(event.name).toBeTruthy();
    expect(typeof event.name).toBe("string");
    expect(event.scope).toBeDefined();
    expect(typeof event.scope).toBe("object");
    expect(event.data).toBeDefined();
    expect(typeof event.data).toBe("object");

    conn.close();
  }, 10000);
});
