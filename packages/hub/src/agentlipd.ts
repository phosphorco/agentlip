#!/usr/bin/env bun
/**
 * agentlipd CLI - daemon control utilities
 *
 * Commands:
 * - status: check hub health and validate against on-disk DB
 */

// Runtime guard: require Bun
if (typeof Bun === "undefined") {
  console.error("Error: @agentlip/hub requires Bun runtime (https://bun.sh)");
  process.exit(1);
}

import { readServerJson } from "./serverJson.js";
import { discoverWorkspaceRoot, discoverOrInitWorkspace } from "@agentlip/workspace";
import { openDb } from "@agentlip/kernel";
import type { HealthResponse } from "@agentlip/protocol";
import { startHub, type HubServer } from "./index.js";

interface StatusOptions {
  workspace?: string;
  json?: boolean;
}

interface StatusResult {
  status: "running" | "not_running" | "stale" | "unreachable" | "db_mismatch";
  instance_id?: string;
  db_id?: string;
  schema_version?: number;
  protocol_version?: string;
  port?: number;
  pid?: number;
  uptime_seconds?: number;
  error?: string;
}

/**
 * Read db_id from on-disk meta table.
 * Returns null if DB doesn't exist or meta table not initialized.
 */
async function readDbIdFromDisk(dbPath: string): Promise<string | null> {
  try {
    const db = openDb({ dbPath, readonly: true });
    try {
      const row = db
        .query<{ value: string }, []>(
          "SELECT value FROM meta WHERE key = 'db_id'"
        )
        .get();
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Fetch health endpoint with timeout.
 */
async function fetchHealthWithTimeout(
  url: string,
  timeoutMs: number = 5000
): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return (await response.json()) as HealthResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check hub status: read server.json, call /health, validate db_id.
 */
export async function checkStatus(
  options: StatusOptions = {}
): Promise<StatusResult> {
  // Discover workspace root
  const discovered = await discoverWorkspaceRoot(options.workspace);
  if (!discovered) {
    return {
      status: "not_running",
      error: "No workspace found (no .agentlip/db.sqlite3 in current directory tree)",
    };
  }

  const { root: workspaceRoot, dbPath } = discovered;

  // Read server.json
  const serverJson = await readServerJson({ workspaceRoot });
  if (!serverJson) {
    return {
      status: "not_running",
      error: "No hub running (server.json not found)",
    };
  }

  // Read db_id from on-disk DB
  const diskDbId = await readDbIdFromDisk(dbPath);

  // Call /health endpoint
  const healthUrl = `http://${serverJson.host}:${serverJson.port}/health`;
  let health: HealthResponse;

  try {
    health = await fetchHealthWithTimeout(healthUrl, 5000);
  } catch (err: any) {
    // Hub unreachable - server.json is stale
    return {
      status: "unreachable",
      port: serverJson.port,
      pid: serverJson.pid,
      error: `Hub unreachable at ${healthUrl} (server.json may be stale): ${err.message}`,
    };
  }

  // Validate db_id matches
  if (diskDbId && health.db_id !== diskDbId) {
    return {
      status: "db_mismatch",
      instance_id: health.instance_id,
      db_id: health.db_id,
      schema_version: health.schema_version,
      protocol_version: health.protocol_version,
      port: serverJson.port,
      pid: health.pid,
      uptime_seconds: health.uptime_seconds,
      error: `DB ID mismatch: hub reports ${health.db_id}, disk has ${diskDbId}`,
    };
  }

  // All good!
  return {
    status: "running",
    instance_id: health.instance_id,
    db_id: health.db_id,
    schema_version: health.schema_version,
    protocol_version: health.protocol_version,
    port: serverJson.port,
    pid: health.pid,
    uptime_seconds: health.uptime_seconds,
  };
}

/**
 * Print status result in human-readable format.
 */
function printHumanStatus(result: StatusResult): void {
  switch (result.status) {
    case "running":
      console.log("✓ Hub is running");
      console.log(`  Instance ID:      ${result.instance_id}`);
      console.log(`  Database ID:      ${result.db_id}`);
      console.log(`  Schema Version:   ${result.schema_version}`);
      console.log(`  Protocol Version: ${result.protocol_version}`);
      console.log(`  Port:             ${result.port}`);
      console.log(`  PID:              ${result.pid}`);
      console.log(`  Uptime:           ${result.uptime_seconds}s`);
      break;

    case "not_running":
      console.log("✗ Hub is not running");
      if (result.error) {
        console.log(`  ${result.error}`);
      }
      break;

    case "unreachable":
      console.log("✗ Hub is unreachable (stale server.json?)");
      if (result.port) {
        console.log(`  Port:  ${result.port}`);
      }
      if (result.pid) {
        console.log(`  PID:   ${result.pid}`);
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
      break;

    case "stale":
      console.log("✗ Hub server.json is stale");
      if (result.error) {
        console.log(`  ${result.error}`);
      }
      break;

    case "db_mismatch":
      console.log("✗ Database ID mismatch");
      console.log(`  Hub reports:  ${result.db_id}`);
      console.log(`  Instance ID:  ${result.instance_id}`);
      console.log(`  Port:         ${result.port}`);
      console.log(`  PID:          ${result.pid}`);
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
      break;
  }
}

/**
 * Options for the `up` command.
 */
interface UpOptions {
  workspace?: string;
  host?: string;
  port?: number;
  idleShutdownMs?: number;
  json?: boolean;
}

/**
 * Start the hub daemon (daemon mode with writer lock).
 */
export async function upCommand(options: UpOptions): Promise<number> {
  const {
    workspace,
    host = "127.0.0.1",
    port = 0,
    idleShutdownMs,
    json = false,
  } = options;

  try {
    // Discover or initialize workspace
    const discovered = await discoverOrInitWorkspace(workspace);
    const { root: workspaceRoot, dbPath } = discovered;

    // Start hub in daemon mode
    let hub: HubServer;
    try {
      hub = await startHub({
        host,
        port,
        workspaceRoot,
        dbPath,
        idleShutdownMs,
      });
    } catch (err: any) {
      // Check for writer lock conflict
      if (err?.message?.includes("Writer lock already held")) {
        const errorMsg = {
          error: "Hub already running",
          code: "WRITER_LOCK_HELD",
          workspace_root: workspaceRoot,
          reason: err.message,
        };

        if (json) {
          console.error(JSON.stringify(errorMsg, null, 2));
        } else {
          console.error("✗ Hub already running");
          console.error(`  Workspace: ${workspaceRoot}`);
          console.error(`  Reason: ${err.message}`);
        }

        return 10; // Exit code 10 = lock conflict
      }

      // Other startup errors
      const errorMsg = {
        error: "Hub startup failed",
        code: "STARTUP_FAILED",
        workspace_root: workspaceRoot,
        reason: err?.message ?? String(err),
      };

      if (json) {
        console.error(JSON.stringify(errorMsg, null, 2));
      } else {
        console.error("✗ Hub startup failed");
        console.error(`  Workspace: ${workspaceRoot}`);
        console.error(`  Error: ${err?.message ?? String(err)}`);
      }

      return 1;
    }

    // Print connection info (never include auth token)
    const connInfo = {
      status: "running",
      host: hub.host,
      port: hub.port,
      workspace_root: workspaceRoot,
      instance_id: hub.instanceId,
    };

    if (json) {
      console.log(JSON.stringify(connInfo, null, 2));
    } else {
      console.log("✓ Hub started");
      console.log(`  Host:      ${hub.host}`);
      console.log(`  Port:      ${hub.port}`);
      console.log(`  Workspace: ${workspaceRoot}`);
      console.log(`  Instance:  ${hub.instanceId}`);
    }

    // Setup signal handlers for graceful shutdown
    const shutdown = async (signal: string) => {
      if (!json) {
        console.log(`\nReceived ${signal}, shutting down gracefully...`);
      }

      try {
        await hub.stop();
        if (!json) {
          console.log("✓ Hub stopped");
        }
        process.exit(0);
      } catch (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Keep process alive (await never resolves unless signal received)
    await new Promise(() => {});

    return 0;
  } catch (err: any) {
    const errorMsg = {
      error: "Unexpected error",
      code: "UNEXPECTED_ERROR",
      reason: err?.message ?? String(err),
    };

    if (json) {
      console.error(JSON.stringify(errorMsg, null, 2));
    } else {
      console.error("✗ Unexpected error:", err?.message ?? String(err));
    }

    return 1;
  }
}

/**
 * Main CLI entry point.
 */
function printHelp(): void {
  console.log("Usage: agentlipd <command> [options]");
  console.log();
  console.log("Commands:");
  console.log("  status   Check hub health using server.json and validate db_id");
  console.log("  up       Start hub daemon");
  console.log();
  console.log("Run: agentlipd <command> --help");
}

function printStatusHelp(): void {
  console.log("Usage: agentlipd status [--workspace <path>] [--json]");
  console.log();
  console.log("Check hub health and validate against on-disk database.");
  console.log();
  console.log("Options:");
  console.log("  --workspace <path>  Explicit workspace root (default: auto-discover)");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
  console.log();
  console.log("Exit codes:");
  console.log("  0  Running");
  console.log("  3  Not running / unreachable");
  console.log("  1  Other errors (DB mismatch, etc.)");
}

function printUpHelp(): void {
  console.log("Usage: agentlipd up [options]");
  console.log();
  console.log("Start hub daemon in workspace.");
  console.log();
  console.log("Options:");
  console.log("  --workspace <path>       Workspace root (default: auto-discover or init at cwd)");
  console.log("  --host <host>            Bind host (default: 127.0.0.1)");
  console.log("  --port <port>            Bind port (default: 0 = random)");
  console.log("  --idle-shutdown-ms <ms>  Auto-shutdown after idle timeout (optional)");
  console.log("  --json                   Output as JSON");
  console.log("  --help, -h               Show this help");
  console.log();
  console.log("Exit codes:");
  console.log("  0   Clean shutdown");
  console.log("  1   Error");
  console.log("  10  Writer lock conflict (hub already running)");
  console.log();
  console.log("Note: Auth token is automatically generated and stored in server.json.");
  console.log("      Token is never printed to stdout/stderr.");
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "status") {
    const options: StatusOptions = {};

    // Parse status args
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--workspace" || arg === "-w") {
        const value = args[++i];
        if (!value) {
          console.error("--workspace requires a value");
          process.exit(1);
        }
        options.workspace = value;
      } else if (arg === "--json") {
        options.json = true;
      } else if (arg === "--help" || arg === "-h") {
        printStatusHelp();
        process.exit(0);
      } else {
        console.error(`Unknown argument: ${arg}`);
        console.error("Use --help for usage information");
        process.exit(1);
      }
    }

    const result = await checkStatus(options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanStatus(result);
    }

    if (result.status === "running") {
      process.exit(0);
    }

    if (
      result.status === "not_running" ||
      result.status === "unreachable" ||
      result.status === "stale"
    ) {
      process.exit(3);
    }

    process.exit(1);
  }

  if (command === "up") {
    const options: UpOptions = {};

    // Parse up args
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--workspace" || arg === "-w") {
        const value = args[++i];
        if (!value) {
          console.error("--workspace requires a value");
          process.exit(1);
        }
        options.workspace = value;
      } else if (arg === "--host") {
        const value = args[++i];
        if (!value) {
          console.error("--host requires a value");
          process.exit(1);
        }
        options.host = value;
      } else if (arg === "--port") {
        const value = args[++i];
        if (!value) {
          console.error("--port requires a value");
          process.exit(1);
        }
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
          console.error("--port must be a number between 0 and 65535");
          process.exit(1);
        }
        options.port = parsed;
      } else if (arg === "--idle-shutdown-ms") {
        const value = args[++i];
        if (!value) {
          console.error("--idle-shutdown-ms requires a value");
          process.exit(1);
        }
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error("--idle-shutdown-ms must be a positive number");
          process.exit(1);
        }
        options.idleShutdownMs = parsed;
      } else if (arg === "--json") {
        options.json = true;
      } else if (arg === "--help" || arg === "-h") {
        printUpHelp();
        process.exit(0);
      } else {
        console.error(`Unknown argument: ${arg}`);
        console.error("Use --help for usage information");
        process.exit(1);
      }
    }

    const exitCode = await upCommand(options);
    process.exit(exitCode);
  }

  console.error(`Unknown command: ${command}`);
  console.error("Use --help for usage information");
  process.exit(1);
}

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
