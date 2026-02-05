// Bun hub daemon (HTTP + WS)
import { randomUUID } from "node:crypto";
import type { Server } from "bun";
import type { HealthResponse } from "@agentchat/protocol";
import { PROTOCOL_VERSION } from "@agentchat/protocol";
import { requireAuth, requireWsToken } from "./authMiddleware";

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

export interface StartHubOptions {
  host?: string;
  port?: number;
  instanceId?: string;
  dbId?: string;
  schemaVersion?: number;
  allowUnsafeNetwork?: boolean;
  /** Auth token for mutation endpoints + WS. If not provided, mutations are rejected. */
  authToken?: string;
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
    dbId = "unknown", // Will be replaced with actual db_id from meta table in future tasks
    schemaVersion = 0, // Will be replaced with actual schema version in future tasks
    allowUnsafeNetwork = false,
    authToken,
  } = options;
  
  // Validate localhost-only bind
  assertLocalhostBind(host, { allowUnsafeNetwork });
  
  // Track process start time for uptime calculation
  const startTimeMs = Date.now();
  
  const server = Bun.serve({
    hostname: host,
    port,

    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      // GET /health - unauthenticated health check
      if (url.pathname === "/health" && req.method === "GET") {
        const uptimeSeconds = Math.floor((Date.now() - startTimeMs) / 1000);

        const healthResponse: HealthResponse = {
          status: "ok",
          instance_id: instanceId,
          db_id: dbId,
          schema_version: schemaVersion,
          protocol_version: PROTOCOL_VERSION,
          pid: process.pid,
          uptime_seconds: uptimeSeconds,
        };

        return Response.json(healthResponse);
      }

      // POST /api/v1/_ping - authenticated ping (sample mutation endpoint)
      // Demonstrates auth middleware usage pattern for future mutations
      if (url.pathname === "/api/v1/_ping" && req.method === "POST") {
        if (!authToken) {
          // Hub started without auth token - reject all mutations
          return new Response(
            JSON.stringify({ error: "Service unavailable", code: "NO_AUTH_CONFIGURED" }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }

        const authResult = requireAuth(req, authToken);
        if (authResult.ok === false) {
          return authResult.response;
        }

        // Authenticated - return pong
        return Response.json({ pong: true, instance_id: instanceId });
      }

      // 404 for all other routes
      return new Response("Not Found", { status: 404 });
    },
  });

  // Bun's types allow unix sockets (port/hostname undefined). We don't support that in v1.
  const boundPort = server.port;
  const boundHost = server.hostname;
  if (boundPort == null || boundHost == null) {
    await server.stop(true);
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
      await server.stop(true);
    },
  };
}
