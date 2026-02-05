/**
 * Integration tests for SDK mutation methods.
 *
 * Each test exercises real HTTP calls against a running hub instance.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createTempWorkspace, startTestHub, type TempWorkspace, type TestHub } from "../../hub/src/integrationHarness";
import {
  sendMessage,
  editMessage,
  deleteMessage,
  retopicMessage,
  addAttachment,
  createChannel,
  createTopic,
  renameTopic,
  HubApiError,
  type HubHttpClient,
} from "./mutations";

let workspace: TempWorkspace;
let hub: TestHub;
let client: HubHttpClient;

beforeAll(async () => {
  workspace = await createTempWorkspace();
  hub = await startTestHub({ workspaceRoot: workspace.root, authToken: "test-token" });
  client = { baseUrl: hub.url, authToken: "test-token" };
});

afterAll(async () => {
  await hub.stop();
  await workspace.cleanup();
});

test("createChannel + createTopic + sendMessage chain", async () => {
  const ch = await createChannel(client, { name: "mut-ch1" });
  expect(ch.channel.id).toMatch(/^ch_/);
  expect(ch.channel.name).toBe("mut-ch1");
  expect(ch.event_id).toBeGreaterThan(0);

  const topic = await createTopic(client, { channelId: ch.channel.id, title: "Topic One" });
  expect(topic.topic.id).toMatch(/^topic_/);
  expect(topic.topic.channel_id).toBe(ch.channel.id);
  expect(topic.topic.title).toBe("Topic One");

  const msg = await sendMessage(client, { topicId: topic.topic.id, sender: "alice", contentRaw: "Hi" });
  expect(msg.message.id).toMatch(/^msg_/);
  expect(msg.message.version).toBe(1);
  expect(msg.message.sender).toBe("alice");
  expect(msg.message.content_raw).toBe("Hi");
  expect(msg.event_id).toBeGreaterThan(0);
});

test("editMessage bumps version", async () => {
  const ch = await createChannel(client, { name: "edit-ch" });
  const tp = await createTopic(client, { channelId: ch.channel.id, title: "edit-tp" });
  const msg = await sendMessage(client, { topicId: tp.topic.id, sender: "bob", contentRaw: "v1" });
  expect(msg.message.version).toBe(1);

  const edited = await editMessage(client, { messageId: msg.message.id, contentRaw: "v2" });
  expect(edited.message.version).toBe(2);
  expect(edited.message.content_raw).toBe("v2");
  expect(edited.event_id).toBeGreaterThan(msg.event_id);
});

test("editMessage with expectedVersion conflict throws VERSION_CONFLICT", async () => {
  const ch = await createChannel(client, { name: "conflict-ch" });
  const tp = await createTopic(client, { channelId: ch.channel.id, title: "conflict-tp" });
  const msg = await sendMessage(client, { topicId: tp.topic.id, sender: "bob", contentRaw: "original" });

  // Edit once to bump version to 2
  await editMessage(client, { messageId: msg.message.id, contentRaw: "updated" });

  // Now try to edit with stale expectedVersion=1
  try {
    await editMessage(client, { messageId: msg.message.id, contentRaw: "conflict", expectedVersion: 1 });
    throw new Error("Should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HubApiError);
    const err = e as HubApiError;
    expect(err.code).toBe("VERSION_CONFLICT");
    expect(err.status).toBe(409);
  }
});

test("deleteMessage returns tombstone fields", async () => {
  const ch = await createChannel(client, { name: "delete-ch" });
  const tp = await createTopic(client, { channelId: ch.channel.id, title: "delete-tp" });
  const msg = await sendMessage(client, { topicId: tp.topic.id, sender: "carol", contentRaw: "to delete" });

  const deleted = await deleteMessage(client, { messageId: msg.message.id, actor: "admin" });
  expect(deleted.message.deleted_at).toBeTruthy();
  expect(deleted.message.deleted_by).toBe("admin");
});

test("retopicMessage moves message", async () => {
  const ch = await createChannel(client, { name: "retopic-ch" });
  const tp1 = await createTopic(client, { channelId: ch.channel.id, title: "source-tp" });
  const tp2 = await createTopic(client, { channelId: ch.channel.id, title: "dest-tp" });
  const msg = await sendMessage(client, { topicId: tp1.topic.id, sender: "dan", contentRaw: "move me" });

  const result = await retopicMessage(client, {
    messageId: msg.message.id,
    toTopicId: tp2.topic.id,
    mode: "one",
  });
  expect(result.affected_count).toBeGreaterThanOrEqual(1);
});

test("addAttachment + dedupe", async () => {
  const ch = await createChannel(client, { name: "attach-ch" });
  const tp = await createTopic(client, { channelId: ch.channel.id, title: "attach-tp" });

  const att1 = await addAttachment(client, {
    topicId: tp.topic.id,
    kind: "url",
    valueJson: { url: "https://example.com" },
    dedupeKey: "example-url",
  });
  expect(att1.attachment.id).toMatch(/^att_/);
  expect(att1.event_id).toBeGreaterThan(0);

  // Same dedupe_key → should be deduplicated (event_id is null)
  const att2 = await addAttachment(client, {
    topicId: tp.topic.id,
    kind: "url",
    valueJson: { url: "https://example.com" },
    dedupeKey: "example-url",
  });
  expect(att2.event_id).toBeNull();
});

test("renameTopic", async () => {
  const ch = await createChannel(client, { name: "rename-ch" });
  const tp = await createTopic(client, { channelId: ch.channel.id, title: "old-name" });

  const result = await renameTopic(client, { topicId: tp.topic.id, title: "new-name" });
  expect(result.topic.title).toBe("new-name");
  expect(result.event_id).toBeGreaterThan(0);
});

test("sendMessage to non-existent topic throws NOT_FOUND", async () => {
  try {
    await sendMessage(client, { topicId: "topic_nonexistent", sender: "a", contentRaw: "fail" });
    throw new Error("Should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HubApiError);
    const err = e as HubApiError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
  }
});

test("unauthenticated request throws UNAUTHORIZED", async () => {
  const noAuth: HubHttpClient = { baseUrl: hub.url, authToken: "wrong-token" };
  try {
    await createChannel(noAuth, { name: "fail" });
    throw new Error("Should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HubApiError);
    const err = e as HubApiError;
    expect(err.code).toBe("INVALID_AUTH");
    expect(err.status).toBe(401);
  }
});
