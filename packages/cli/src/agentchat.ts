#!/usr/bin/env bun
/**
 * agentchat CLI - stateless read-only queries and hub mutations
 * 
 * Commands:
 * - doctor: run diagnostics (DB integrity, schema version, etc.)
 * - (more to come: channel list, topic list, msg tail, etc.)
 */

import { openWorkspaceDbReadonly, isQueryOnly, WorkspaceNotFoundError, DatabaseNotFoundError } from "./index.js";

interface DoctorOptions {
  workspace?: string;
  json?: boolean;
}

interface DoctorResult {
  status: "ok" | "error";
  workspace_root?: string;
  db_path?: string;
  db_id?: string;
  schema_version?: number;
  query_only?: boolean;
  error?: string;
}

/**
 * Run basic diagnostics on the workspace.
 */
async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  try {
    const { db, workspaceRoot, dbPath } = await openWorkspaceDbReadonly({
      workspace: options.workspace,
    });

    try {
      // Verify query_only is enabled
      const queryOnly = isQueryOnly(db);

      // Read db_id and schema_version from meta table
      let dbId: string | undefined;
      let schemaVersion: number | undefined;

      try {
        const metaRow = db
          .query<{ key: string; value: string }, []>("SELECT key, value FROM meta WHERE key IN ('db_id', 'schema_version')")
          .all();

        for (const row of metaRow) {
          if (row.key === "db_id") dbId = row.value;
          if (row.key === "schema_version") schemaVersion = parseInt(row.value, 10);
        }
      } catch {
        // meta table may not exist yet (uninitialized DB)
      }

      return {
        status: "ok",
        workspace_root: workspaceRoot,
        db_path: dbPath,
        db_id: dbId,
        schema_version: schemaVersion,
        query_only: queryOnly,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      return {
        status: "error",
        error: err.message,
      };
    }
    if (err instanceof DatabaseNotFoundError) {
      return {
        status: "error",
        error: err.message,
      };
    }
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Print doctor result in human-readable format.
 */
function printHumanDoctor(result: DoctorResult): void {
  if (result.status === "ok") {
    console.log("✓ Workspace found");
    console.log(`  Workspace Root:  ${result.workspace_root}`);
    console.log(`  Database Path:   ${result.db_path}`);
    console.log(`  Database ID:     ${result.db_id ?? "(not initialized)"}`);
    console.log(`  Schema Version:  ${result.schema_version ?? "(not initialized)"}`);
    console.log(`  Query Only:      ${result.query_only ? "yes" : "no"}`);
  } else {
    console.log("✗ Workspace check failed");
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  }
}

/**
 * Print help message.
 */
function printHelp(): void {
  console.log("Usage: agentchat <command> [options]");
  console.log();
  console.log("Commands:");
  console.log("  doctor    Run diagnostics on workspace DB");
  console.log("  init      Initialize workspace (not yet implemented)");
  console.log("  channel   Channel operations (not yet implemented)");
  console.log("  topic     Topic operations (not yet implemented)");
  console.log("  msg       Message operations (not yet implemented)");
  console.log("  listen    Stream events (not yet implemented)");
  console.log();
  console.log("Global options:");
  console.log("  --workspace <path>  Explicit workspace root (default: auto-discover)");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
}

function printDoctorHelp(): void {
  console.log("Usage: agentchat doctor [--workspace <path>] [--json]");
  console.log();
  console.log("Run diagnostics on workspace database.");
  console.log();
  console.log("Options:");
  console.log("  --workspace <path>  Explicit workspace root (default: auto-discover)");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
  console.log();
  console.log("Exit codes:");
  console.log("  0  OK");
  console.log("  1  Error (workspace not found, DB issues, etc.)");
}

/**
 * Main CLI entry point.
 */
export async function main(argv: string[] = process.argv.slice(2)) {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command !== "doctor") {
    console.error(`Unknown or not yet implemented command: ${command}`);
    console.error("Use --help for usage information");
    process.exit(1);
  }

  // Parse doctor args
  const options: DoctorOptions = {};

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
      printDoctorHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Use --help for usage information");
      process.exit(1);
    }
  }

  const result = await runDoctor(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanDoctor(result);
  }

  process.exit(result.status === "ok" ? 0 : 1);
}

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
