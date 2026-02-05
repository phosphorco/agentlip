#!/usr/bin/env bun
/**
 * agentchatd CLI - daemon control utilities
 *
 * Commands:
 * - status: check hub health and validate against on-disk DB
 */

import { readServerJson } from "./serverJson.js";
import { discoverWorkspaceRoot } from "@agentchat/workspace";
import { openDb } from "@agentchat/kernel";
import type { HealthResponse } from "@agentchat/protocol";

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
      error: "No workspace found (no .zulip/db.sqlite3 in current directory tree)",
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
 * Main CLI entry point.
 */
function printHelp(): void {
  console.log("Usage: agentchatd <command> [options]");
  console.log();
  console.log("Commands:");
  console.log("  status   Check hub health using server.json and validate db_id");
  console.log();
  console.log("Run: agentchatd status --help");
}

function printStatusHelp(): void {
  console.log("Usage: agentchatd status [--workspace <path>] [--json]");
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

export async function main(argv: string[] = process.argv.slice(2)) {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command !== "status") {
    console.error(`Unknown command: ${command}`);
    console.error("Use --help for usage information");
    process.exit(1);
  }

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

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
