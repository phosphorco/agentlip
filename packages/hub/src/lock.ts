import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ServerJsonData } from "./serverJson.js";
import { readServerJson } from "./serverJson.js";

export interface HealthCheckFn {
  (serverJson: ServerJsonData): Promise<boolean>;
}

/**
 * Acquire writer lock for the workspace.
 * 
 * Lock path: .zulip/locks/writer.lock
 * 
 * If lock exists:
 * - Reads server.json to get port/instance info
 * - Calls healthCheck(serverJson) to verify hub is alive
 * - If alive: throws error (lock held by live hub)
 * - If stale: removes lock and retries
 * 
 * @param healthCheck - Async function that validates hub liveness via /health
 */
export async function acquireWriterLock({
  workspaceRoot,
  healthCheck,
}: {
  workspaceRoot: string;
  healthCheck: HealthCheckFn;
}): Promise<void> {
  const locksDir = join(workspaceRoot, ".zulip", "locks");
  const lockPath = join(locksDir, "writer.lock");

  // Ensure locks directory exists
  await mkdir(locksDir, { recursive: true });

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;

    try {
      // Try to create lock file exclusively
      await writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}`, {
        flag: "wx", // exclusive create; fails if exists
      });

      // Success!
      return;
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        // Unexpected error
        throw error;
      }

      // Lock exists; check if stale
      const isStale = await isLockStale({ workspaceRoot, healthCheck });

      if (!isStale) {
        throw new Error(
          "Writer lock already held by live hub. Cannot start another hub instance."
        );
      }

      // Lock is stale; remove it and retry
      console.warn(`Removing stale lock at ${lockPath}`);
      try {
        await unlink(lockPath);
      } catch (unlinkError: any) {
        if (unlinkError.code !== "ENOENT") {
          throw unlinkError;
        }
        // Already removed (race); retry
      }

      // Retry acquisition
      if (attempt < maxRetries) {
        // Brief delay to avoid tight loop in case of races
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  throw new Error(
    `Failed to acquire writer lock after ${maxRetries} attempts. ` +
    `Lock may be held by another process or filesystem issues.`
  );
}

/**
 * Check if existing lock is stale.
 * 
 * Strategy:
 * 1. Read server.json to get hub instance info (port, pid, instance_id)
 * 2. Call healthCheck(serverJson) to validate via /health endpoint
 * 3. If healthCheck returns true: lock is live (not stale)
 * 4. If healthCheck returns false or throws: lock is stale
 * 
 * Additional heuristics (future):
 * - Check if PID from server.json is still running (platform-specific)
 * - Check lock file age (stale if >1 hour?)
 */
async function isLockStale({
  workspaceRoot,
  healthCheck,
}: {
  workspaceRoot: string;
  healthCheck: HealthCheckFn;
}): Promise<boolean> {
  try {
    // Try to read server.json
    const serverJson = await readServerJson({ workspaceRoot });

    if (!serverJson) {
      // No server.json; lock is definitely stale
      return true;
    }

    // Check if hub is responsive via health check
    const isAlive = await healthCheck(serverJson);

    // If alive, lock is not stale
    return !isAlive;
  } catch (error) {
    // Any error reading server.json or health check means stale
    console.warn(`Lock staleness check error: ${error}`);
    return true;
  }
}

/**
 * Release writer lock.
 * No-op if lock doesn't exist.
 */
export async function releaseWriterLock({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): Promise<void> {
  const lockPath = join(workspaceRoot, ".zulip", "locks", "writer.lock");

  try {
    await unlink(lockPath);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      // Already gone
      return;
    }
    throw error;
  }
}

/**
 * Read the current writer lock file content (for debugging).
 * Returns null if lock doesn't exist.
 */
export async function readLockInfo({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): Promise<string | null> {
  const lockPath = join(workspaceRoot, ".zulip", "locks", "writer.lock");

  try {
    return await readFile(lockPath, "utf-8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
