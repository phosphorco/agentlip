import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempWorkspace } from "./integrationHarness";
import { startHub } from "./index";

const TEST_TOKEN = "test-token";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

describe("Plugin derived pipelines (hub integration)", () => {
  test("hub runs configured linkifier+extractor plugins after message.created", async () => {
    const ws = await createTempWorkspace();

    try {
      // Create plugin modules + config at workspace root
      const pluginDir = join(ws.root, "plugins");
      await mkdir(pluginDir, { recursive: true });

      const linkifierPath = join(pluginDir, "linkifier.ts");
      const extractorPath = join(pluginDir, "extractor.ts");

      await writeFile(
        linkifierPath,
        `export default {\n  name: "test-linkifier",\n  version: "1.0.0",\n  async enrich(input) {\n    return [{ kind: "test", span: { start: 0, end: 1 }, data: { marker: "ok" } }];\n  }\n};\n`,
        "utf-8"
      );

      await writeFile(
        extractorPath,
        `export default {\n  name: "test-extractor",\n  version: "1.0.0",\n  async extract(input) {\n    return [{ kind: "note", value_json: { note: "hello" }, dedupe_key: "note:hello" }];\n  }\n};\n`,
        "utf-8"
      );

      await writeFile(
        join(ws.root, "zulip.config.ts"),
        `export default {\n  pluginDefaults: { timeout: 2000 },\n  plugins: [\n    { name: "test-linkifier", type: "linkifier", enabled: true, module: "./plugins/linkifier.ts", config: {} },\n    { name: "test-extractor", type: "extractor", enabled: true, module: "./plugins/extractor.ts", config: {} }\n  ]\n};\n`,
        "utf-8"
      );

      const hub = await startHub({
        host: "127.0.0.1",
        port: 0,
        workspaceRoot: ws.root,
        dbPath: ws.dbPath,
        authToken: TEST_TOKEN,
        disableRateLimiting: true,
      });

      const baseUrl = `http://${hub.host}:${hub.port}`;

      try {
        // Create channel
        const { res: chRes, data: chData } = await fetchJson(
          `${baseUrl}/api/v1/channels`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${TEST_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "general", description: "" }),
          }
        );
        expect(chRes.status).toBe(201);
        const channelId = chData.channel.id;

        // Create topic
        const { res: tRes, data: tData } = await fetchJson(`${baseUrl}/api/v1/topics`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel_id: channelId, title: "t1" }),
        });
        expect(tRes.status).toBe(201);
        const topicId = tData.topic.id;

        // Create message (no URLs, so built-in URL extraction doesn't interfere)
        const { res: mRes, data: mData } = await fetchJson(`${baseUrl}/api/v1/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ topic_id: topicId, sender: "agent", content_raw: "hello" }),
        });
        expect(mRes.status).toBe(201);

        const messageId = mData.message.id as string;
        const messageEventId = mData.event_id as number;

        // Poll events until both derived events appear
        const deadline = Date.now() + 4000;
        let enrichedEvent: any = null;
        let attachmentEvent: any = null;

        while (Date.now() < deadline) {
          const { res: eRes, data: eData } = await fetchJson(
            `${baseUrl}/api/v1/events?after=${messageEventId}`
          );
          expect(eRes.status).toBe(200);

          const events = eData.events as any[];

          enrichedEvent ??= events.find(
            (e) => e.name === "message.enriched" && e.data_json?.message_id === messageId
          );

          attachmentEvent ??= events.find(
            (e) =>
              e.name === "topic.attachment_added" &&
              e.data_json?.attachment?.source_message_id === messageId
          );

          if (enrichedEvent && attachmentEvent) {
            break;
          }

          await sleep(50);
        }

        expect(enrichedEvent).not.toBeNull();
        expect(attachmentEvent).not.toBeNull();

        // Sanity: derived events come after message.created
        expect(enrichedEvent.event_id).toBeGreaterThan(messageEventId);
        expect(attachmentEvent.event_id).toBeGreaterThan(messageEventId);
      } finally {
        await hub.stop();
      }
    } finally {
      await ws.cleanup();
    }
  });

  test("Gate E: plugin hangs are bounded by timeout, hub continues ingesting", async () => {
    const ws = await createTempWorkspace();

    try {
      // Create plugin that hangs forever (never resolves)
      const pluginDir = join(ws.root, "plugins");
      await mkdir(pluginDir, { recursive: true });

      const hangingPluginPath = join(pluginDir, "hanging-linkifier.ts");
      await writeFile(
        hangingPluginPath,
        `export default {\n  name: "hanging-linkifier",\n  version: "1.0.0",\n  async enrich(input) {\n    // Hang forever - never resolve\n    await new Promise(() => {});\n    return [];\n  }\n};\n`,
        "utf-8"
      );

      // Configure with small timeout (100ms)
      await writeFile(
        join(ws.root, "zulip.config.ts"),
        `export default {\n  pluginDefaults: { timeout: 100 },\n  plugins: [\n    { name: "hanging-linkifier", type: "linkifier", enabled: true, module: "./plugins/hanging-linkifier.ts", config: {} }\n  ]\n};\n`,
        "utf-8"
      );

      const hub = await startHub({
        host: "127.0.0.1",
        port: 0,
        workspaceRoot: ws.root,
        dbPath: ws.dbPath,
        authToken: TEST_TOKEN,
        disableRateLimiting: true,
      });

      const baseUrl = `http://${hub.host}:${hub.port}`;

      try {
        // Create channel
        const { res: chRes, data: chData } = await fetchJson(
          `${baseUrl}/api/v1/channels`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${TEST_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "test-channel", description: "" }),
          }
        );
        expect(chRes.status).toBe(201);
        const channelId = chData.channel.id;

        // Create topic
        const { res: tRes, data: tData } = await fetchJson(`${baseUrl}/api/v1/topics`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel_id: channelId, title: "test-topic" }),
        });
        expect(tRes.status).toBe(201);
        const topicId = tData.topic.id;

        // Assertion 1: POST /api/v1/messages returns quickly (< 300ms)
        // Hub should not block waiting for plugin
        const msg1Start = Date.now();
        const { res: msg1Res, data: msg1Data } = await fetchJson(`${baseUrl}/api/v1/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic_id: topicId,
            sender: "agent-1",
            content_raw: "first message",
          }),
        });
        const msg1Duration = Date.now() - msg1Start;

        expect(msg1Res.status).toBe(201);
        expect(msg1Duration).toBeLessThan(300); // Should not wait for plugin
        const message1Id = msg1Data.message.id as string;
        const message1EventId = msg1Data.event_id as number;

        // Assertion 2: Second message can be sent immediately (hub continues ingesting)
        const msg2Start = Date.now();
        const { res: msg2Res, data: msg2Data } = await fetchJson(`${baseUrl}/api/v1/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic_id: topicId,
            sender: "agent-2",
            content_raw: "second message",
          }),
        });
        const msg2Duration = Date.now() - msg2Start;

        expect(msg2Res.status).toBe(201);
        expect(msg2Duration).toBeLessThan(300);
        const message2Id = msg2Data.message.id as string;

        // Assertion 3: Poll events and verify NO message.enriched appears
        // (plugin should timeout and not emit events)
        const pollDeadline = Date.now() + 2000; // Poll for 2s (generous window)
        let foundEnrichedEvent = false;

        while (Date.now() < pollDeadline) {
          const { res: eRes, data: eData } = await fetchJson(
            `${baseUrl}/api/v1/events?after=${message1EventId}`
          );
          expect(eRes.status).toBe(200);

          const events = eData.events as any[];
          const enrichedEvent = events.find(
            (e) =>
              e.name === "message.enriched" &&
              (e.data_json?.message_id === message1Id || e.data_json?.message_id === message2Id)
          );

          if (enrichedEvent) {
            foundEnrichedEvent = true;
            break;
          }

          await sleep(50);
        }

        // Should NOT find enriched event (plugin timed out)
        expect(foundEnrichedEvent).toBe(false);
      } finally {
        await hub.stop();
      }
    } finally {
      await ws.cleanup();
    }
  });
});
