/**
 * Server discovery and health validation for Agentlip SDK
 * 
 * Reads .agentlip/server.json and validates hub connectivity via /health endpoint.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { discoverWorkspaceRoot } from "@agentlip/workspace";
import { PROTOCOL_VERSION, type HealthResponse } from "@agentlip/protocol";
import type { ServerJsonData } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthValidationResult {
  valid: boolean;
  health?: HealthResponse;
  reason?: string;
}

export interface HubConnectionInfo {
  serverJson: ServerJsonData;
  health: HealthResponse;
  workspaceRoot: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server.json Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read server.json from workspace .agentlip directory.
 * 
 * @param workspaceRoot - Absolute path to workspace root
 * @returns ServerJsonData or null if file doesn't exist
 * @throws Error if file exists but is invalid JSON
 */
export async function readServerJson(
  workspaceRoot: string
): Promise<ServerJsonData | null> {
  const serverJsonPath = join(workspaceRoot, ".agentlip", "server.json");

  try {
    const content = await fs.readFile(serverJsonPath, "utf-8");
    const data = JSON.parse(content);

    // Basic validation
    if (!data.instance_id || !data.db_id || !data.port || !data.auth_token) {
      throw new Error("Invalid server.json: missing required fields");
    }

    return data as ServerJsonData;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return null; // File doesn't exist
    }
    throw err; // Re-throw parse errors or other issues
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate hub health by calling GET /health endpoint.
 * 
 * Checks:
 * - Protocol version matches PROTOCOL_VERSION
 * - Schema version >= 1
 * - HTTP 200 status
 * 
 * @param serverJson - Server configuration from server.json
 * @returns Validation result with health response or error reason
 */
export async function validateHub(
  serverJson: ServerJsonData
): Promise<HealthValidationResult> {
  const url = `http://${serverJson.host}:${serverJson.port}/health`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${serverJson.auth_token}`,
      },
    });

    if (!response.ok) {
      return {
        valid: false,
        reason: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const health = (await response.json()) as HealthResponse;

    // Validate protocol version
    if (health.protocol_version !== PROTOCOL_VERSION) {
      return {
        valid: false,
        reason: `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${health.protocol_version}`,
      };
    }

    // Validate schema version
    if (health.schema_version < 1) {
      return {
        valid: false,
        reason: `Invalid schema version: ${health.schema_version} (expected >= 1)`,
      };
    }

    return {
      valid: true,
      health,
    };
  } catch (err: any) {
    return {
      valid: false,
      reason: `Connection failed: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: Discovery + Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover workspace, read server.json, and validate hub health.
 * 
 * Convenience method combining:
 * 1. Workspace discovery (walking upward from startPath)
 * 2. Reading server.json
 * 3. Validating hub via /health
 * 
 * @param startPath - Directory to start workspace search (defaults to cwd)
 * @returns Hub connection info or null if workspace not found, server.json missing, or validation failed
 */
export async function discoverAndValidateHub(
  startPath?: string
): Promise<HubConnectionInfo | null> {
  // 1. Discover workspace
  const workspace = await discoverWorkspaceRoot(startPath);
  if (!workspace) {
    return null;
  }

  // 2. Read server.json
  const serverJson = await readServerJson(workspace.root);
  if (!serverJson) {
    return null;
  }

  // 3. Validate hub
  const validation = await validateHub(serverJson);
  if (!validation.valid || !validation.health) {
    return null;
  }

  return {
    serverJson,
    health: validation.health,
    workspaceRoot: workspace.root,
  };
}
