/**
 * Agentlip Hub UI handler
 * 
 * Serves SPA (Svelte 5) for /ui/* routes with runtime bootstrap and static assets.
 * 
 * Security: all user content escaped via textContent, URLs validated.
 */

import { UI_ASSETS, UI_ENTRY_HTML } from "./uiAssets.generated";

export interface UiContext {
  baseUrl: string;
  authToken: string;
}

export interface BootstrapResponse {
  baseUrl: string;
  wsUrl: string;
  authToken: string;
  buildVersion: string;
}

/**
 * Handle UI requests.
 * Returns Response if route matches, null if not found.
 */
export function handleUiRequest(req: Request, ctx: UiContext): Response | null {
  const url = new URL(req.url);
  const path = url.pathname;

  // Only accept GET requests
  if (req.method !== "GET") {
    return null;
  }

  // GET /ui/bootstrap → Runtime config JSON
  if (path === "/ui/bootstrap") {
    return handleBootstrapRequest(ctx);
  }

  // GET /ui/assets (bare root) → 404 (reserved namespace, no SPA fallback)
  if (path === "/ui/assets") {
    return new Response("Not Found", { status: 404 });
  }

  // GET /ui/assets/* → Static assets from generated map
  if (path.startsWith("/ui/assets/")) {
    const assetPath = path.substring("/ui/assets/".length);
    return handleAssetRequest(assetPath);
  }

  // GET /ui or deep client routes → SPA shell (fallback)
  if (path === "/ui" || path === "/ui/" || path.startsWith("/ui/")) {
    return handleSpaShellRequest();
  }

  // No match
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPA Mode Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle /ui/bootstrap request.
 * Returns runtime configuration as JSON with no-store cache policy.
 */
function handleBootstrapRequest(ctx: UiContext): Response {
  // Derive WS URL from base URL
  const wsUrl = ctx.baseUrl.replace(/^http/, "ws") + "/ws";

  const bootstrap: BootstrapResponse = {
    baseUrl: ctx.baseUrl,
    wsUrl,
    authToken: ctx.authToken,
    buildVersion: "0.1.0", // TODO: derive from package.json or build metadata
  };

  return new Response(JSON.stringify(bootstrap), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Handle /ui/assets/* request.
 * Serves static assets from generated map with immutable cache for hashed files.
 * Returns 404 if asset not found (never falls back to SPA shell).
 */
function handleAssetRequest(assetPath: string): Response {
  const asset = UI_ASSETS.get(assetPath);

  if (!asset) {
    // Asset not found → 404 (explicit: never SPA fallback for /ui/assets/*)
    return new Response("Not Found", { status: 404 });
  }

  // Decode base64 content
  const content = Buffer.from(asset.content, "base64");

  // Determine cache policy: hashed assets get immutable cache
  const isHashedAsset = /[.-][A-Za-z0-9_-]{8,}\./.test(assetPath);
  const cacheControl = isHashedAsset
    ? "public, max-age=31536000, immutable"
    : "no-store";

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": cacheControl,
    },
  });
}

/**
 * Handle SPA shell request (index.html).
 * Serves the entry HTML for all unmatched /ui/* routes (SPA client-side routing).
 * Returns no-store cache policy.
 */
function handleSpaShellRequest(): Response {
  const shellAsset = UI_ASSETS.get(UI_ENTRY_HTML);

  if (!shellAsset) {
    // Missing shell asset → 500 (configuration error)
    return new Response("Internal Server Error: UI shell not found", {
      status: 500,
    });
  }

  const content = Buffer.from(shellAsset.content, "base64");

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
