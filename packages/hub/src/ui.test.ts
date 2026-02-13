import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startHub, type HubServer } from "./index";

function extractAssetPaths(html: string): string[] {
  const paths: string[] = [];

  const scriptPattern = /<script[^>]+src="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    const src = match[1];
    if (src.startsWith("/ui/assets/")) {
      paths.push(src.substring("/ui/assets/".length));
    }
  }

  const linkPattern = /<link[^>]+href="([^"]+)"/g;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    if (href.startsWith("/ui/assets/")) {
      paths.push(href.substring("/ui/assets/".length));
    }
  }

  return paths;
}

describe("UI endpoints (SPA mode)", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;
  let channelId: string;
  let topicId: string;
  let previousSpaEnv: string | undefined;

  beforeAll(async () => {
    previousSpaEnv = process.env.HUB_UI_SPA_ENABLED;
    process.env.HUB_UI_SPA_ENABLED = "true";

    authToken = "test-token-ui-spa";
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      authToken,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;

    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Test Channel" }),
    });
    expect(channelRes.status).toBe(201);
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
        title: "Test Topic",
      }),
    });
    expect(topicRes.status).toBe(201);
    const topicData = await topicRes.json();
    topicId = topicData.topic.id;
  });

  afterAll(async () => {
    await hub.stop();
    if (previousSpaEnv === undefined) {
      delete process.env.HUB_UI_SPA_ENABLED;
    } else {
      process.env.HUB_UI_SPA_ENABLED = previousSpaEnv;
    }
  });

  test("GET /ui/bootstrap returns runtime config with no-store cache", async () => {
    const res = await fetch(`${baseUrl}/ui/bootstrap`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const data = await res.json();
    expect(data.baseUrl).toBe(baseUrl);
    expect(data.wsUrl).toBe(baseUrl.replace("http://", "ws://") + "/ws");
    expect(data.authToken).toBe(authToken);
  });

  test("SPA shell routes return HTML with no-store", async () => {
    const routes = [
      "/ui",
      "/ui/",
      `/ui/topics/${topicId}`,
      `/ui/channels/${channelId}`,
      "/ui/events",
      "/ui/some/client/route",
    ];

    for (const route of routes) {
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("<!DOCTYPE html>");
    }
  });

  test("Discovered asset returns 200 with immutable cache for hashed files", async () => {
    const shellRes = await fetch(`${baseUrl}/ui`);
    expect(shellRes.status).toBe(200);
    const html = await shellRes.text();

    const assetPaths = extractAssetPaths(html);
    expect(assetPaths.length).toBeGreaterThan(0);

    const hashed = assetPaths.find((p) => /[.-][A-Za-z0-9_-]{8,}\./.test(p));
    const assetPath = hashed ?? assetPaths[0];

    const assetRes = await fetch(`${baseUrl}/ui/assets/${assetPath}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("Content-Type")).toBeDefined();

    if (/[.-][A-Za-z0-9_-]{8,}\./.test(assetPath)) {
      const cacheControl = assetRes.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("immutable");
      expect(cacheControl).toContain("max-age=31536000");
    }
  });

  test("Missing /ui/assets/* returns 404 (never SPA fallback)", async () => {
    const missingFileRes = await fetch(`${baseUrl}/ui/assets/nonexistent-file-12345.js`);
    expect(missingFileRes.status).toBe(404);
    const missingFileText = await missingFileRes.text();
    expect(missingFileText).not.toContain("<!DOCTYPE html>");

    const bareAssetsRootRes = await fetch(`${baseUrl}/ui/assets`);
    expect(bareAssetsRootRes.status).toBe(404);
    const bareAssetsRootText = await bareAssetsRootRes.text();
    expect(bareAssetsRootText).not.toContain("<!DOCTYPE html>");
  });
});

describe("UI endpoints (no-auth mode)", () => {
  let hub: HubServer;
  let baseUrl: string;
  let previousSpaEnv: string | undefined;

  beforeAll(async () => {
    previousSpaEnv = process.env.HUB_UI_SPA_ENABLED;
    process.env.HUB_UI_SPA_ENABLED = "true";

    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;
  });

  afterAll(async () => {
    await hub.stop();
    if (previousSpaEnv === undefined) {
      delete process.env.HUB_UI_SPA_ENABLED;
    } else {
      process.env.HUB_UI_SPA_ENABLED = previousSpaEnv;
    }
  });

  test("All /ui/* routes return 503 without auth token", async () => {
    const paths = [
      "/ui",
      "/ui/",
      "/ui/bootstrap",
      "/ui/events",
      "/ui/topics/test-topic-id",
      "/ui/assets/anything.js",
      "/ui/assets/missing.js",
    ];

    for (const path of paths) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(503);
    }
  });
});

describe("UI endpoints (legacy mode)", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;
  let channelId: string;
  let topicId: string;
  let previousSpaEnv: string | undefined;

  beforeAll(async () => {
    previousSpaEnv = process.env.HUB_UI_SPA_ENABLED;
    process.env.HUB_UI_SPA_ENABLED = "false";

    authToken = "test-token-ui-legacy";
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      authToken,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;

    const channelRes = await fetch(`${baseUrl}/api/v1/channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name: "Legacy Channel" }),
    });
    expect(channelRes.status).toBe(201);
    const channelData = await channelRes.json();
    channelId = channelData.channel.id;

    const topicRes = await fetch(`${baseUrl}/api/v1/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ channel_id: channelId, title: "Legacy Topic" }),
    });
    expect(topicRes.status).toBe(201);
    const topicData = await topicRes.json();
    topicId = topicData.topic.id;
  });

  afterAll(async () => {
    await hub.stop();
    if (previousSpaEnv === undefined) {
      delete process.env.HUB_UI_SPA_ENABLED;
    } else {
      process.env.HUB_UI_SPA_ENABLED = previousSpaEnv;
    }
  });

  test("/ui/bootstrap and /ui/assets/* are 404 in legacy mode", async () => {
    const bootstrapRes = await fetch(`${baseUrl}/ui/bootstrap`);
    expect(bootstrapRes.status).toBe(404);

    const assetRes = await fetch(`${baseUrl}/ui/assets/anything.js`);
    expect(assetRes.status).toBe(404);

    const bareAssetsRootRes = await fetch(`${baseUrl}/ui/assets`);
    expect(bareAssetsRootRes.status).toBe(404);
  });

  test("Legacy /ui routes render legacy page markers", async () => {
    const channelsRes = await fetch(`${baseUrl}/ui`);
    const channelsHtml = await channelsRes.text();
    expect(channelsRes.status).toBe(200);
    expect(channelsHtml).toContain("loadChannels");

    const topicsRes = await fetch(`${baseUrl}/ui/channels/${channelId}`);
    const topicsHtml = await topicsRes.text();
    expect(topicsRes.status).toBe(200);
    expect(topicsHtml).toContain("loadTopics");

    const messagesRes = await fetch(`${baseUrl}/ui/topics/${topicId}`);
    const messagesHtml = await messagesRes.text();
    expect(messagesRes.status).toBe(200);
    expect(messagesHtml).toContain("loadMessages");

    const eventsRes = await fetch(`${baseUrl}/ui/events`);
    const eventsHtml = await eventsRes.text();
    expect(eventsRes.status).toBe(200);
    expect(eventsHtml).toContain("loadEvents");
  });
});
