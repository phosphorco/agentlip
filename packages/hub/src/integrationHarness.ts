/**
 * Integration test harness utilities for @agentchat/hub
 * 
 * Provides reusable helpers for integration tests:
 * - createTempWorkspace: temp directory + DB + migrations
 * - startTestHub: hub server with random port + cleanup
 * - wsConnect: WebSocket client wrapper (when WS support lands)
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { openDb, runMigrations } from "@agentchat/kernel";
import { ensureWorkspaceInitialized } from "@agentchat/workspace";
import { startHub, type HubServer } from "./index";

const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

/**
 * Temporary workspace for testing
 */
export interface TempWorkspace {
  /** Absolute path to workspace root */
  root: string;
  /** Absolute path to db.sqlite3 */
  dbPath: string;
  /** Cleanup function - removes workspace directory */
  cleanup: () => Promise<void>;
}

/**
 * Test hub instance with cleanup
 */
export interface TestHub {
  /** Hub server instance */
  server: HubServer;
  /** Base URL for HTTP requests (http://host:port) */
  url: string;
  /** Stop server and cleanup */
  stop: () => Promise<void>;
}

/**
 * WebSocket client wrapper for testing
 */
export interface WsTestClient {
  /** WebSocket instance */
  ws: WebSocket;
  /** Wait for next message (with timeout) */
  waitForMessage: (timeoutMs?: number) => Promise<MessageEvent>;
  /** Send JSON message */
  sendJson: (data: unknown) => void;
  /** Close connection */
  close: () => void;
}

/**
 * Create temporary workspace with initialized DB and migrations.
 * 
 * Creates:
 * - Temp directory in OS tmpdir
 * - .zulip/db.sqlite3 file
 * - Runs kernel migrations (schema v1, optionally FTS)
 * 
 * @param options - Configuration options
 * @returns TempWorkspace with cleanup function
 */
export async function createTempWorkspace(options?: {
  /** Enable FTS (opportunistic, non-fatal) */
  enableFts?: boolean;
}): Promise<TempWorkspace> {
  const { enableFts = false } = options ?? {};

  // Create unique temp directory
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2);
  const root = join(tmpdir(), `agentchat-test-${timestamp}-${random}`);

  await fs.mkdir(root, { recursive: true });

  // Initialize workspace (.zulip/db.sqlite3)
  const { dbPath } = await ensureWorkspaceInitialized(root);

  // Run migrations
  const db = openDb({ dbPath });
  try {
    runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts });
  } finally {
    db.close();
  }

  return {
    root,
    dbPath,
    async cleanup() {
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Start test hub server with random port.
 * 
 * Features:
 * - Binds to 127.0.0.1 with random available port
 * - Optional auth token
 * - Optional rate limiting disable
 * - Returns TestHub with stop() cleanup
 * 
 * @param options - Hub configuration
 * @returns TestHub instance
 */
export async function startTestHub(options?: {
  /** Workspace root directory (defaults to in-memory DB) */
  workspaceRoot?: string;
  /** Auth token for mutation endpoints + WS */
  authToken?: string;
  /** Disable rate limiting (useful for stress tests) */
  rateLimitDisabled?: boolean;
}): Promise<TestHub> {
  const { workspaceRoot, authToken, rateLimitDisabled = false } = options ?? {};

  const server = await startHub({
    host: "127.0.0.1",
    port: 0, // Random available port
    authToken,
    disableRateLimiting: rateLimitDisabled,
    dbPath: workspaceRoot ? join(workspaceRoot, ".zulip", "db.sqlite3") : undefined,
  });

  const url = `http://${server.host}:${server.port}`;

  return {
    server,
    url,
    async stop() {
      await server.stop();
    },
  };
}

/**
 * Connect WebSocket client for testing.
 * 
 * Note: WebSocket support not yet implemented in hub (bd-16d.2.17).
 * This helper is prepared for when WS endpoints land.
 * 
 * @param options - Connection options
 * @returns WsTestClient wrapper
 */
export async function wsConnect(options: {
  /** WebSocket URL (ws://host:port/path) */
  url: string;
  /** Auth token (appended as ?token=) */
  token?: string;
}): Promise<WsTestClient> {
  const { url, token } = options;

  // Build URL with token query param if provided
  const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages: MessageEvent[] = [];
    let messageResolve: ((msg: MessageEvent) => void) | null = null;

    let opened = false;
    let settled = false;

    const openTimeoutMs = 5000;
    const openTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`WebSocket open timeout after ${openTimeoutMs}ms`));
    }, openTimeoutMs);

    const makeClient = (): WsTestClient => ({
      ws,

      waitForMessage(timeoutMs = 5000): Promise<MessageEvent> {
        // Check if we already have buffered messages
        if (messages.length > 0) {
          return Promise.resolve(messages.shift()!);
        }

        // Wait for next message
        return new Promise((res, rej) => {
          messageResolve = res;

          const timeout = setTimeout(() => {
            messageResolve = null;
            rej(new Error(`WebSocket message timeout after ${timeoutMs}ms`));
          }, timeoutMs);

          // Clear timeout if we resolve
          const originalResolve = messageResolve;
          messageResolve = (msg) => {
            clearTimeout(timeout);
            originalResolve(msg);
          };
        });
      },

      sendJson(data: unknown): void {
        ws.send(JSON.stringify(data));
      },

      close(): void {
        ws.close();
      },
    });

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimeout);
      resolve(makeClient());
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimeout);
      reject(err);
    };

    ws.onopen = () => {
      opened = true;
      finishResolve();
    };

    ws.onerror = (err) => {
      finishReject(new Error(`WebSocket connection failed: ${String(err)}`));
    };

    ws.onclose = (ev) => {
      if (!opened) {
        finishReject(
          new Error(
            `WebSocket closed before open (code=${(ev as any).code}, reason=${(ev as any).reason})`
          )
        );
      }
    };

    ws.onmessage = (event) => {
      if (messageResolve) {
        messageResolve(event);
        messageResolve = null;
      } else {
        // Buffer message for later retrieval
        messages.push(event);
      }
    };

    // Some runtimes can open synchronously (or fire the open event before handlers
    // are attached). Handle that by checking readyState after wiring handlers.
    if (ws.readyState === WebSocket.OPEN) {
      opened = true;
      finishResolve();
    }
  });
}
