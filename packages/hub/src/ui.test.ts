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

describe("UI endpoints (SPA)", () => {
  let hub: HubServer;
  let baseUrl: string;
  let authToken: string;
  let channelId: string;
  let topicId: string;

  beforeAll(async () => {
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

  test("CSP header does not contain unsafe-inline", async () => {
    const res = await fetch(`${baseUrl}/ui`);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).not.toContain("unsafe-inline");
  });

  test("HUB_UI_SPA_ENABLED=false at startup does not disable SPA contracts", async () => {
    const previous = process.env.HUB_UI_SPA_ENABLED;
    process.env.HUB_UI_SPA_ENABLED = "false";

    let hubWithFlag: HubServer | null = null;

    try {
      const authTokenWithFlag = "test-token-ui-spa-flag-false";
      hubWithFlag = await startHub({
        host: "127.0.0.1",
        port: 0,
        authToken: authTokenWithFlag,
        dbPath: ":memory:",
      });

      const baseUrlWithFlag = `http://${hubWithFlag.host}:${hubWithFlag.port}`;

      const bootstrapRes = await fetch(`${baseUrlWithFlag}/ui/bootstrap`);
      expect(bootstrapRes.status).toBe(200);
      expect(bootstrapRes.headers.get("Content-Type")).toContain("application/json");

      const deepRouteRes = await fetch(`${baseUrlWithFlag}/ui/topics/topic-test`);
      expect(deepRouteRes.status).toBe(200);
      expect(deepRouteRes.headers.get("Content-Type")).toContain("text/html");
    } finally {
      if (hubWithFlag) {
        await hubWithFlag.stop();
      }

      if (previous === undefined) {
        delete process.env.HUB_UI_SPA_ENABLED;
      } else {
        process.env.HUB_UI_SPA_ENABLED = previous;
      }
    }
  });
});

describe("UI endpoints (no-auth mode)", () => {
  let hub: HubServer;
  let baseUrl: string;

  beforeAll(async () => {
    hub = await startHub({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
    });

    baseUrl = `http://${hub.host}:${hub.port}`;
  });

  afterAll(async () => {
    await hub.stop();
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
