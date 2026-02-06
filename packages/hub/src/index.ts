// Bun hub daemon (HTTP + WS)
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Server } from "bun";
import type { HealthResponse } from "@agentlip/protocol";
import { PROTOCOL_VERSION } from "@agentlip/protocol";
import { openDb, runMigrations, MIGRATIONS_DIR as KERNEL_MIGRATIONS_DIR } from "@agentlip/kernel";
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
import { acquireWriterLock, releaseWriterLock } from "./lock";
import {
  writeServerJson,
  readServerJson,
  removeServerJson,
  type ServerJsonData,
} from "./serverJson";
import { generateAuthToken } from "./authToken";
import { loadWorkspaceConfig, type WorkspaceConfig } from "./config";
import { runLinkifierPluginsForMessage } from "./linkifierDerived";
import { runExtractorPluginsForMessage } from "./extractorDerived";
import { handleUiRequest } from "./ui";

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
    process.env.CI === "true" && process.env.AGENTLIP_LOG_LEVEL === undefined;
  
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

/** Security headers applied to all responses */
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
} as const;

/** Add security headers to response */
function withSecurityHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
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
export { handleApiV1, type ApiV1Context, type UrlExtractionConfig } from "./apiV1";

// Re-export WS endpoint utilities
export {
  createWsHub,
  createWsHandlers,
  type WsHub,
  type WsHandlers,
} from "./wsEndpoint";

// Re-export config utilities
export {
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  validatePluginModulePath,
  type WorkspaceConfig,
  type PluginConfig,
  type LoadConfigResult,
} from "./config";

export interface StartHubOptions {
  host?: string;
  port?: number;
  instanceId?: string;
  dbId?: string;
  schemaVersion?: number;
  /** SQLite db file path. Defaults to in-memory (":memory:") for tests. */
  dbPath?: string;
  /** 
   * Workspace root directory (enables daemon mode).
   * When provided, hub will:
   * - Acquire writer lock (.agentlip/locks/writer.lock)
   * - Write server.json (.agentlip/server.json with mode 0600)
   * - Clean up on shutdown (remove lock + server.json)
   */
  workspaceRoot?: string;
  /** Directory containing SQL migrations (defaults to repo migrations/). */
  migrationsDir?: string;
  /** Enable optional FTS5 migration (opportunistic, non-fatal). If undefined, uses AGENTLIP_ENABLE_FTS env var (1=enabled, 0=disabled). Default: false. */
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
  /** URL extraction configuration for auto-creating attachments from message content. */
  urlExtraction?: {
    allowlist?: RegExp[];
    blocklist?: RegExp[];
  };
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
 * Resolve FTS enablement from options or environment variable.
 * 
 * Precedence:
 * 1. Explicit enableFts parameter (if provided)
 * 2. AGENTLIP_ENABLE_FTS env var (1=enabled, 0=disabled)
 * 3. Default: false
 */
function resolveFtsEnabled(enableFts?: boolean): boolean {
  if (enableFts !== undefined) {
    return enableFts;
  }
  
  const envValue = process.env.AGENTLIP_ENABLE_FTS;
  if (envValue === "1") return true;
  if (envValue === "0") return false;
  
  return false;
}

/**
 * Start the Agentlip hub HTTP server.
 * 
 * Implements:
 * - GET /health endpoint (unauthenticated, always returns 200 when responsive)
 * - Localhost-only bind validation by default
 * - FTS configuration via options or AGENTLIP_ENABLE_FTS env var
 * - Workspace-aware daemon mode (when workspaceRoot provided):
 *   - Acquires writer lock (.agentlip/locks/writer.lock)
 *   - Writes server.json (.agentlip/server.json with mode 0600)
 *   - Graceful shutdown removes lock + server.json
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
    workspaceRoot,
    migrationsDir,
    enableFts,
    allowUnsafeNetwork = false,
    authToken: providedAuthToken,
    rateLimitPerClient,
    rateLimitGlobal,
    disableRateLimiting = false,
  } = options;
  
  const effectiveEnableFts = resolveFtsEnabled(enableFts);
  
  // Validate localhost-only bind
  assertLocalhostBind(host, { allowUnsafeNetwork });

  // Daemon mode: acquire writer lock before starting server
  const daemonMode = !!workspaceRoot;
  if (daemonMode && workspaceRoot) {
    // Health check function for lock acquisition
    const healthCheck = async (serverJson: ServerJsonData): Promise<boolean> => {
      try {
        const healthUrl = `http://${serverJson.host}:${serverJson.port}/health`;
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(2000), // 2s timeout
        });
        if (!res.ok) return false;
        
        const health = await res.json();
        // Verify instance_id matches (same hub instance)
        return health.instance_id === serverJson.instance_id;
      } catch {
        return false; // Any error = stale
      }
    };

    // Acquire writer lock (throws if live hub exists)
    await acquireWriterLock({ workspaceRoot, healthCheck });
  }

  // Determine auth token (daemon mode: load from server.json or generate new)
  let authToken = providedAuthToken;
  if (daemonMode && workspaceRoot && !authToken) {
    // Try to load existing token from server.json (if present and valid)
    const existingServerJson = await readServerJson({ workspaceRoot });
    if (existingServerJson?.auth_token) {
      authToken = existingServerJson.auth_token;
    } else {
      // Generate new token for this instance
      authToken = generateAuthToken();
    }
  }

  // Load workspace config (agentlip.config.ts) in daemon mode (optional file)
  let workspaceConfig: WorkspaceConfig | null = null;
  if (daemonMode && workspaceRoot) {
    try {
      const loaded = await loadWorkspaceConfig(workspaceRoot);
      workspaceConfig = loaded?.config ?? null;
    } catch (err) {
      // Config load failed - release lock and abort startup
      await releaseWriterLock({ workspaceRoot });
      throw err;
    }
  }

  // Open database (default: in-memory for tests) and apply migrations
  const effectiveMigrationsDir =
    migrationsDir ?? KERNEL_MIGRATIONS_DIR;
  const db = openDb({ dbPath });
  try {
    runMigrations({ db, migrationsDir: effectiveMigrationsDir, enableFts: effectiveEnableFts });
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Plugin derived pipelines (linkifiers/extractors)
  // ─────────────────────────────────────────────────────────────────────────────

  const hasEnabledLinkifiers =
    workspaceRoot != null &&
    workspaceConfig?.plugins?.some(
      (p) => p.enabled && p.type === "linkifier" && typeof p.module === "string"
    ) === true;

  const hasEnabledExtractors =
    workspaceRoot != null &&
    workspaceConfig?.plugins?.some(
      (p) => p.enabled && p.type === "extractor" && typeof p.module === "string"
    ) === true;

  const getEventInfoStmt = db.query<
    { name: string; entity_id: string },
    [number]
  >(
    "SELECT name, entity_id FROM events WHERE event_id = ?"
  );

  function scheduleDerivedPluginsForMessage(messageId: string): void {
    if (!workspaceRoot || !workspaceConfig) return;
    if (!hasEnabledLinkifiers && !hasEnabledExtractors) return;

    // Defer to avoid blocking the request that triggered the mutation.
    setTimeout(() => {
      if (hasEnabledLinkifiers) {
        void runLinkifierPluginsForMessage({
          db,
          workspaceRoot,
          workspaceConfig,
          messageId,
          onEventIds: (ids) => wsHub.publishEventIds(ids),
        }).catch((err) => {
          if (!isTestEnvironment()) {
            console.warn(
              `[plugins] linkifier pipeline failed for message ${messageId}: ${err?.message ?? String(err)}`
            );
          }
        });
      }

      if (hasEnabledExtractors) {
        void runExtractorPluginsForMessage({
          db,
          workspaceRoot,
          workspaceConfig,
          messageId,
          onEventIds: (ids) => wsHub.publishEventIds(ids),
        }).catch((err) => {
          if (!isTestEnvironment()) {
            console.warn(
              `[plugins] extractor pipeline failed for message ${messageId}: ${err?.message ?? String(err)}`
            );
          }
        });
      }
    }, 0);
  }

  function maybeSchedulePluginsForEventIds(eventIds: number[]): void {
    if (!workspaceRoot || !workspaceConfig) return;
    if (!hasEnabledLinkifiers && !hasEnabledExtractors) return;

    for (const eventId of eventIds) {
      const row = getEventInfoStmt.get(eventId);
      if (!row) continue;

      if (row.name === "message.created" || row.name === "message.edited") {
        scheduleDerivedPluginsForMessage(row.entity_id);
      }
    }
  }

  // Track process start time for uptime calculation
  const startTimeMs = Date.now();

  // Initialize rate limiter (unless disabled)
  const rateLimiter = disableRateLimiting
    ? null
    : new HubRateLimiter(rateLimitGlobal, rateLimitPerClient);
  rateLimiter?.startCleanup();

  // Graceful shutdown flag (when set, reject new non-health requests)
  let shuttingDown = false;

  // Track in-flight requests for graceful drain
  let inflightCount = 0;
  const inflightPromises = new Set<Promise<void>>();
  
  const server = Bun.serve({
    hostname: host,
    port,

    fetch(req: Request, bunServer: any) {
      const url = new URL(req.url);
      const requestId = getRequestId(req);
      const startMs = Date.now();

      // GET /health - unauthenticated health check (no rate limiting, no logging)
      // Always respond to health checks, even during shutdown
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
        return withSecurityHeaders(withRequestIdHeader(Response.json(healthResponse), requestId));
      }

      // Graceful shutdown: reject new non-health requests with 503
      if (shuttingDown) {
        const response = new Response(
          JSON.stringify({
            error: "Service unavailable",
            code: "SHUTTING_DOWN",
            message: "Hub is shutting down gracefully",
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "10", // Suggest client retry in 10s
            },
          }
        );
        emitLog({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "request_rejected_shutdown",
          method: req.method,
          path: url.pathname,
          status: 503,
          duration_ms: Date.now() - startMs,
          instance_id: instanceId,
          request_id: requestId,
        });
        return withSecurityHeaders(withRequestIdHeader(response, requestId));
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
          return withSecurityHeaders(withRequestIdHeader(response, requestId));
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
        const finalResponse = withSecurityHeaders(withRequestIdHeader(withRateLimitHeaders(response), requestId));
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

      // /ui/* - HTML UI endpoints (no auth required for GET, token embedded in page)
      if (url.pathname.startsWith("/ui")) {
        // UI is only available if authToken is configured
        if (!authToken) {
          return finalizeResponse(
            new Response("UI unavailable: no auth token configured", { status: 503 })
          );
        }

        // Determine base URL for API calls
        const baseUrl = `http://${boundHost}:${boundPort}`;
        
        const uiResponse = handleUiRequest(req, {
          baseUrl,
          authToken,
        });

        if (uiResponse) {
          return finalizeResponse(uiResponse);
        }

        // UI route not found - fall through to 404
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
          urlExtraction: options.urlExtraction,
          onEventIds(eventIds) {
            capturedEventIds = eventIds;
            wsHub.publishEventIds(eventIds);
            maybeSchedulePluginsForEventIds(eventIds);
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
    if (daemonMode && workspaceRoot) {
      await releaseWriterLock({ workspaceRoot });
    }
    throw new Error(
      "Hub server must bind to hostname+port (unix sockets not supported)"
    );
  }

  // Daemon mode: write server.json after successful server start
  if (daemonMode && workspaceRoot && authToken) {
    try {
      const serverJsonData: ServerJsonData = {
        instance_id: instanceId,
        db_id: effectiveDbId,
        port: boundPort,
        host: boundHost,
        auth_token: authToken,
        pid: process.pid,
        started_at: new Date(startTimeMs).toISOString(),
        protocol_version: PROTOCOL_VERSION,
        schema_version: effectiveSchemaVersion,
      };

      await writeServerJson({ workspaceRoot, data: serverJsonData });
    } catch (err) {
      // Failed to write server.json - clean up and fail
      await server.stop(true);
      db.close();
      await releaseWriterLock({ workspaceRoot });
      throw err;
    }
  }

  return {
    server,
    instanceId,
    port: boundPort,
    host: boundHost,

    async stop() {
      // Set shutdown flag to reject new work
      shuttingDown = true;

      try {
        // Wait for in-flight requests to complete (with timeout)
        const drainTimeout = 10000; // 10s per plan spec
        if (inflightPromises.size > 0) {
          const drainPromise = Promise.all(Array.from(inflightPromises));
          await Promise.race([drainPromise, Bun.sleep(drainTimeout)]);
        }

        // Close all WebSocket connections (code 1001 = going away)
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

        // WAL checkpoint (best-effort, TRUNCATE mode to reclaim space)
        // Do this BEFORE closing the database
        try {
          db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (err) {
          // Best-effort; log and continue (only if not test env)
          if (!isTestEnvironment()) {
            console.warn("WAL checkpoint failed during shutdown:", err);
          }
        }

        // Close database
        db.close();

        // Daemon mode cleanup: remove lock + server.json
        if (daemonMode && workspaceRoot) {
          try {
            await removeServerJson({ workspaceRoot });
          } catch (err) {
            console.warn("Failed to remove server.json during shutdown:", err);
          }

          try {
            await releaseWriterLock({ workspaceRoot });
          } catch (err) {
            console.warn("Failed to release writer lock during shutdown:", err);
          }
        }
      }
    },
  };
}
