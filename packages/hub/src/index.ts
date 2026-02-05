// Bun hub daemon (HTTP + WS)
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Server } from "bun";
import type { HealthResponse } from "@agentchat/protocol";
import { PROTOCOL_VERSION } from "@agentchat/protocol";
import { openDb, runMigrations } from "@agentchat/kernel";
import { requireAuth, requireWsToken } from "./authMiddleware";
import { handleApiV1, type ApiV1Context } from "./apiV1";
import { createWsHub, createWsHandlers } from "./wsEndpoint";
import {
  HubRateLimiter,
  rateLimitedResponse,
  addRateLimitHeaders,
  type RateLimiterConfig,
} from "./rateLimiter";
import { readJsonBody, SIZE_LIMITS } from "./bodyParser";

// ─────────────────────────────────────────────────────────────────────────────
// Structured JSON logger
// ─────────────────────────────────────────────────────────────────────────────

/** Cached test environment detection result */
let _isTestEnvCached: boolean | null = null;

/** Detect if running under test environment to suppress log noise */
function isTestEnvironment(): boolean {
  if (_isTestEnvCached !== null) return _isTestEnvCached;
  
  _isTestEnvCached =
    // Explicit environment variables (conventional)
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined ||
    process.env.JEST_WORKER_ID !== undefined ||
    // Bun test: entry point is a .test. or _test. file
    (process.argv[1]?.match(/[._]test\.[jt]sx?$/) !== null) ||
    // CI test runners often set this
    process.env.CI === "true" && process.env.AGENTCHAT_LOG_LEVEL === undefined;
  
  return _isTestEnvCached;
}

/** Structured log entry for HTTP requests */
export interface HttpLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  msg: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  instance_id: string;
  request_id: string;
  event_ids?: number[];
  content_length?: number;
}

/** Emit a structured JSON log line (no-op in test environment) */
function emitLog(entry: HttpLogEntry): void {
  if (isTestEnvironment()) return;
  // Write to stdout as single JSON line
  console.log(JSON.stringify(entry));
}

/** Get or generate request ID from X-Request-ID header */
function getRequestId(req: Request): string {
  return req.headers.get("X-Request-ID") ?? randomUUID();
}

/** Add X-Request-ID header to response */
function withRequestIdHeader(response: Response, requestId: string): Response {
  // Clone response to add header (Response headers may be immutable)
  const newHeaders = new Headers(response.headers);
  newHeaders.set("X-Request-ID", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// Re-export auth middleware utilities
export {
  parseBearerToken,
  requireAuth,
  requireWsToken,
  type AuthResult,
  type AuthOk,
  type AuthFailure,
  type WsAuthResult,
  type WsAuthOk,
  type WsAuthFailure,
} from "./authMiddleware";

// Re-export rate limiter utilities
export {
  RateLimiter,
  HubRateLimiter,
  rateLimitedResponse,
  addRateLimitHeaders,
  DEFAULT_RATE_LIMITS,
  type RateLimiterConfig,
  type RateLimitResult,
} from "./rateLimiter";

// Re-export body parser utilities
export {
  readJsonBody,
  parseWsMessage,
  validateWsMessageSize,
  validateJsonSize,
  payloadTooLargeResponse,
  invalidJsonResponse,
  invalidContentTypeResponse,
  validationErrorResponse,
  SIZE_LIMITS,
  type ReadJsonBodyOptions,
  type JsonBodyResult,
} from "./bodyParser";

// Re-export HTTP API handler utilities
export { handleApiV1, type ApiV1Context } from "./apiV1";

// Re-export WS endpoint utilities
export {
  createWsHub,
  createWsHandlers,
  type WsHub,
  type WsHandlers,
} from "./wsEndpoint";

export interface StartHubOptions {
  host?: string;
  port?: number;
  instanceId?: string;
  dbId?: string;
  schemaVersion?: number;
  /** SQLite db file path. Defaults to in-memory (":memory:") for tests. */
  dbPath?: string;
  /** Directory containing SQL migrations (defaults to repo migrations/). */
  migrationsDir?: string;
  /** Enable optional FTS5 migration (opportunistic, non-fatal). */
  enableFts?: boolean;
  allowUnsafeNetwork?: boolean;
  /** Auth token for mutation endpoints + WS. If not provided, mutations are rejected. */
  authToken?: string;
  /** Rate limit config for per-client limiting */
  rateLimitPerClient?: RateLimiterConfig;
  /** Rate limit config for global limiting */
  rateLimitGlobal?: RateLimiterConfig;
  /** Disable rate limiting (for testing) */
  disableRateLimiting?: boolean;
}

export interface HubServer {
  server: Server<unknown>;
  instanceId: string;
  port: number;
  host: string;
  stop(): Promise<void>;
}

/**
 * Validates that the bind host is localhost-only (127.0.0.1 or ::1).
 * Rejects 0.0.0.0 unless allowUnsafeNetwork flag is explicitly set.
 * 
 * @throws Error if host is not localhost and allowUnsafeNetwork is false
 */
export function assertLocalhostBind(
  host: string,
  options?: { allowUnsafeNetwork?: boolean }
): void {
  const normalized = host.trim().toLowerCase();
  
  // Allow localhost variants
  const localhostVariants = [
    "127.0.0.1",
    "localhost",
    "::1",
    "[::1]",
  ];
  
  if (localhostVariants.includes(normalized)) {
    return;
  }
  
  // Reject 0.0.0.0 and :: unless explicitly allowed
  const unsafeHosts = ["0.0.0.0", "::", "[::]"];
  if (unsafeHosts.includes(normalized)) {
    if (options?.allowUnsafeNetwork === true) {
      return;
    }
    throw new Error(
      `Refusing to bind to ${host}: network-exposed binding is unsafe. ` +
      `Use 127.0.0.1 or ::1 for localhost, or pass allowUnsafeNetwork: true to override.`
    );
  }
  
  // Reject any other non-localhost address
  throw new Error(
    `Invalid bind host: ${host}. Must be localhost (127.0.0.1 or ::1). ` +
    `Use allowUnsafeNetwork: true to bind to network interfaces.`
  );
}

/**
 * Start the AgentChat hub HTTP server.
 * 
 * Implements:
 * - GET /health endpoint (unauthenticated, always returns 200 when responsive)
 * - Localhost-only bind validation by default
 * 
 * @param options Configuration options
 * @returns HubServer instance with stop() method
 */
export async function startHub(options: StartHubOptions = {}): Promise<HubServer> {
  const {
    host = "127.0.0.1",
    port = 0, // 0 = random available port
    instanceId = randomUUID(),
    dbId,
    schemaVersion,
    dbPath = ":memory:",
    migrationsDir,
    enableFts = false,
    allowUnsafeNetwork = false,
    authToken,
    rateLimitPerClient,
    rateLimitGlobal,
    disableRateLimiting = false,
  } = options;
  
  // Validate localhost-only bind
  assertLocalhostBind(host, { allowUnsafeNetwork });

  // Open database (default: in-memory for tests) and apply migrations
  const effectiveMigrationsDir =
    migrationsDir ?? join(import.meta.dir, "../../../migrations");
  const db = openDb({ dbPath });
  try {
    runMigrations({ db, migrationsDir: effectiveMigrationsDir, enableFts });
  } catch (err) {
    db.close();
    throw err;
  }

  // Read meta values (used as defaults for /health if not explicitly provided)
  const readMetaValue = (key: string): string | null => {
    try {
      const row = db
        .query<{ value: string }, [string]>(
          "SELECT value FROM meta WHERE key = ?"
        )
        .get(key);
      return row?.value ?? null;
    } catch {
      return null;
    }
  };

  const metaDbId = readMetaValue("db_id");
  const metaSchemaVersion = (() => {
    const raw = readMetaValue("schema_version");
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  })();

  const effectiveDbId = dbId ?? metaDbId ?? "unknown";
  const effectiveSchemaVersion = schemaVersion ?? metaSchemaVersion ?? 0;

  // Initialize WS hub (used when /ws is upgraded)
  const wsHub = createWsHub({ db, instanceId }) as any;
  const wsHandlers = createWsHandlers({
    db,
    authToken: authToken ?? "",
    hub: wsHub,
  });

  // Track process start time for uptime calculation
  const startTimeMs = Date.now();

  // Initialize rate limiter (unless disabled)
  const rateLimiter = disableRateLimiting
    ? null
    : new HubRateLimiter(rateLimitGlobal, rateLimitPerClient);
  rateLimiter?.startCleanup();
  
  const server = Bun.serve({
    hostname: host,
    port,

    fetch(req: Request, bunServer: any) {
      const url = new URL(req.url);
      const requestId = getRequestId(req);
      const startMs = Date.now();

      // GET /health - unauthenticated health check (no rate limiting, no logging)
      if (url.pathname === "/health" && req.method === "GET") {
        const uptimeSeconds = Math.floor((Date.now() - startTimeMs) / 1000);

        const healthResponse: HealthResponse = {
          status: "ok",
          instance_id: instanceId,
          db_id: effectiveDbId,
          schema_version: effectiveSchemaVersion,
          protocol_version: PROTOCOL_VERSION,
          pid: process.pid,
          uptime_seconds: uptimeSeconds,
        };

        // Health endpoint: no logging to avoid noise
        return withRequestIdHeader(Response.json(healthResponse), requestId);
      }

      // GET /ws - WebSocket upgrade endpoint
      if (url.pathname === "/ws") {
        if (!authToken) {
          const response = new Response(
            JSON.stringify({
              error: "Service unavailable",
              code: "NO_AUTH_CONFIGURED",
            }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            }
          );
          emitLog({
            ts: new Date().toISOString(),
            level: "warn",
            msg: "request",
            method: req.method,
            path: url.pathname,
            status: 503,
            duration_ms: Date.now() - startMs,
            instance_id: instanceId,
            request_id: requestId,
          });
          return withRequestIdHeader(response, requestId);
        }

        // WS upgrade: log the upgrade attempt
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          msg: "ws_upgrade",
          method: req.method,
          path: url.pathname,
          status: 101,
          duration_ms: Date.now() - startMs,
          instance_id: instanceId,
          request_id: requestId,
        });
        return wsHandlers.upgrade(req, bunServer);
      }

      return (async () => {
      // Track event IDs produced by mutations
      let capturedEventIds: number[] | undefined;

      // Apply rate limiting to all non-health endpoints
      let rateLimitResult: { allowed: boolean; limit: number; remaining: number; resetAt: number } | null = null;
      if (rateLimiter) {
        rateLimitResult = rateLimiter.check(req);
        if (!rateLimitResult.allowed) {
          const response = rateLimitedResponse(rateLimitResult);
          emitLog({
            ts: new Date().toISOString(),
            level: "warn",
            msg: "request",
            method: req.method,
            path: url.pathname,
            status: response.status,
            duration_ms: Date.now() - startMs,
            instance_id: instanceId,
            request_id: requestId,
          });
          return withRequestIdHeader(response, requestId);
        }
      }

      // Helper to add rate limit headers to response
      const withRateLimitHeaders = (response: Response): Response => {
        if (rateLimitResult) {
          return addRateLimitHeaders(response, rateLimitResult);
        }
        return response;
      };

      // Helper to finalize response with logging and headers
      const finalizeResponse = (response: Response): Response => {
        const finalResponse = withRequestIdHeader(withRateLimitHeaders(response), requestId);
        emitLog({
          ts: new Date().toISOString(),
          level: response.status >= 400 ? (response.status >= 500 ? "error" : "warn") : "info",
          msg: "request",
          method: req.method,
          path: url.pathname,
          status: response.status,
          duration_ms: Date.now() - startMs,
          instance_id: instanceId,
          request_id: requestId,
          ...(capturedEventIds && capturedEventIds.length > 0 ? { event_ids: capturedEventIds } : {}),
        });
        return finalResponse;
      };

      // POST /api/v1/_ping - authenticated ping (sample mutation endpoint)
      // Demonstrates auth + rate limiting + body parsing middleware usage
      if (url.pathname === "/api/v1/_ping" && req.method === "POST") {
        if (!authToken) {
          // Hub started without auth token - reject all mutations
          return finalizeResponse(
            new Response(
              JSON.stringify({ error: "Service unavailable", code: "NO_AUTH_CONFIGURED" }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        const authResult = requireAuth(req, authToken);
        if (authResult.ok === false) {
          return finalizeResponse(authResult.response);
        }

        // Parse JSON body with size limit (optional body for _ping)
        const bodyResult = await readJsonBody<{ echo?: string }>(req, {
          maxBytes: SIZE_LIMITS.MESSAGE_BODY,
        });

        // If body provided but invalid, return error
        if (bodyResult.ok === false) {
          // Check if it's a content-type issue (no body is ok for ping)
          const contentType = req.headers.get("Content-Type");
          if (contentType && contentType.includes("application/json")) {
            return finalizeResponse(bodyResult.response);
          }
        }

        // Authenticated - return pong (with optional echo)
        const responseBody: { pong: boolean; instance_id: string; echo?: string } = {
          pong: true,
          instance_id: instanceId,
        };

        if (bodyResult.ok && bodyResult.data?.echo) {
          responseBody.echo = bodyResult.data.echo;
        }

        return finalizeResponse(Response.json(responseBody));
      }

      // /api/v1/* - HTTP API endpoints (channels/topics/messages/attachments/events)
      if (url.pathname.startsWith("/api/v1/") && url.pathname !== "/api/v1/_ping") {
        const method = req.method.toUpperCase();
        const isMutation = method !== "GET" && method !== "HEAD";

        // Hub started without auth token - reject all mutations
        if (isMutation && !authToken) {
          return finalizeResponse(
            new Response(
              JSON.stringify({
                error: "Service unavailable",
                code: "NO_AUTH_CONFIGURED",
              }),
              { status: 503, headers: { "Content-Type": "application/json" } }
            )
          );
        }

        const apiCtx: ApiV1Context = {
          db,
          authToken: authToken ?? "",
          instanceId,
          onEventIds(eventIds) {
            capturedEventIds = eventIds;
            wsHub.publishEventIds(eventIds);
          },
        };

        const apiResponse = await handleApiV1(req, apiCtx);
        return finalizeResponse(apiResponse);
      }

      // 404 for all other routes
      return finalizeResponse(new Response("Not Found", { status: 404 }));
      })();
    },

    websocket: {
      open: wsHandlers.open,
      message: wsHandlers.message,
      close: wsHandlers.close,
    },
  });

  // Bun's types allow unix sockets (port/hostname undefined). We don't support that in v1.
  const boundPort = server.port;
  const boundHost = server.hostname;
  if (boundPort == null || boundHost == null) {
    await server.stop(true);
    db.close();
    throw new Error(
      "Hub server must bind to hostname+port (unix sockets not supported)"
    );
  }

  return {
    server,
    instanceId,
    port: boundPort,
    host: boundHost,

    async stop() {
      try {
        wsHub.closeAll?.();
      } finally {
        rateLimiter?.stopCleanup();

        // Bun 1.3.x: Server.stop(true) can hang indefinitely after a WebSocket
        // connection has been accepted (even if it was later closed). We still
        // want to initiate shutdown, but we must not await forever.
        const stopPromise = server.stop(true).catch(() => {
          // Ignore stop errors during shutdown
        });

        // Wait a short, bounded amount of time for the server to stop.
        // If it doesn't resolve, we proceed with cleanup anyway.
        await Promise.race([stopPromise, Bun.sleep(250)]);

        db.close();
      }
    },
  };
}
