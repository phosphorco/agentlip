/**
 * Operational edge-case tests (deterministic, CI-friendly)
 * 
 * Coverage:
 * - Port already in use
 * - server.json permission errors (daemon mode)
 * - Multiple hub instances / lock behavior
 * - Permission errors for directory creation
 */

import { describe, it, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile, chmod, stat } from "node:fs/promises";
import { startHub, type HubServer } from "./index";
import { readServerJson, writeServerJson } from "./serverJson";
import { acquireWriterLock, releaseWriterLock, readLockInfo } from "./lock";

const TEST_TOKEN = "test_edge_auth_token_abc123";

/**
 * Test utilities
 */
async function createTempWorkspace(): Promise<string> {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2);
  const workspace = join(tmpdir(), `agentchat-edge-test-${timestamp}-${random}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function makeDirectoryReadOnly(dirPath: string): Promise<void> {
  await chmod(dirPath, 0o555); // r-xr-xr-x
}

async function makeDirectoryWritable(dirPath: string): Promise<void> {
  await chmod(dirPath, 0o755); // rwxr-xr-x
}

async function makeFileReadOnly(filePath: string): Promise<void> {
  await chmod(filePath, 0o444); // r--r--r--
}

describe("Operational Edge Cases", () => {
  let hubs: HubServer[] = [];
  let tempWorkspaces: string[] = [];

  afterEach(async () => {
    // Stop all hubs
    for (const hub of hubs) {
      try {
        await hub.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
    hubs = [];

    // Clean up temp workspaces (restore perms first)
    for (const workspace of tempWorkspaces) {
      try {
        const zulipDir = join(workspace, ".zulip");
        const locksDir = join(zulipDir, "locks");
        
        // Restore writability to allow cleanup
        try {
          await makeDirectoryWritable(locksDir);
        } catch {
          // May not exist
        }
        
        try {
          await makeDirectoryWritable(zulipDir);
        } catch {
          // May not exist
        }
        
        try {
          await makeDirectoryWritable(workspace);
        } catch {
          // May not exist
        }
        
        await rm(workspace, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    tempWorkspaces = [];
  });

  describe("Port already in use", () => {
    it("fails clearly when attempting to bind to occupied port", async () => {
      // Start first hub on random port
      const hub1 = await startHub({
        host: "127.0.0.1",
        port: 0,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub1);

      const occupiedPort = hub1.port;

      // Attempt to start second hub on same port
      let error: Error | null = null;
      try {
        const hub2 = await startHub({
          host: "127.0.0.1",
          port: occupiedPort,
          authToken: TEST_TOKEN,
        });
        hubs.push(hub2);
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/EADDRINUSE|address already in use|port.*in use|Failed to start server/i);
    });

    it("succeeds when binding to different port", async () => {
      const hub1 = await startHub({
        host: "127.0.0.1",
        port: 0,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub1);

      const hub2 = await startHub({
        host: "127.0.0.1",
        port: 0, // Random port
        authToken: TEST_TOKEN,
      });
      hubs.push(hub2);

      expect(hub1.port).not.toBe(hub2.port);

      // Both should be healthy
      const res1 = await fetch(`http://${hub1.host}:${hub1.port}/health`);
      expect(res1.status).toBe(200);

      const res2 = await fetch(`http://${hub2.host}:${hub2.port}/health`);
      expect(res2.status).toBe(200);
    });
  });

  describe("server.json permission errors (daemon mode)", () => {
    it("fails when .zulip directory is read-only", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      const zulipDir = join(workspace, ".zulip");
      await mkdir(zulipDir, { recursive: true });
      await makeDirectoryReadOnly(zulipDir);

      let error: Error | null = null;
      try {
        const hub = await startHub({
          workspaceRoot: workspace,
          authToken: TEST_TOKEN,
        });
        hubs.push(hub);
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/EACCES|EPERM|permission denied|read-only/i);
    });

    it.skip("fails when server.json exists and is read-only", async () => {
      // SKIPPED: serverJson.ts uses atomic write (temp file + rename),
      // which can overwrite read-only target on many filesystems.
      // This behavior is platform-specific and not reliably testable.
      // The important case (.zulip dir read-only) is tested above.
    });

    it("succeeds when server.json is writable", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      const hub = await startHub({
        workspaceRoot: workspace,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub);

      // Verify server.json was created with mode 0600
      const serverJson = await readServerJson({ workspaceRoot: workspace });
      expect(serverJson).not.toBeNull();
      expect(serverJson?.instance_id).toBe(hub.instanceId);
      expect(serverJson?.auth_token).toBe(TEST_TOKEN);

      const serverJsonPath = join(workspace, ".zulip", "server.json");
      const stats = await stat(serverJsonPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("Multiple hub instances / writer lock behavior", () => {
    it("prevents second hub from starting when first is live", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      // Start first hub
      const hub1 = await startHub({
        workspaceRoot: workspace,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub1);

      // Verify lock exists
      const lockInfo = await readLockInfo({ workspaceRoot: workspace });
      expect(lockInfo).not.toBeNull();
      expect(lockInfo).toContain(String(process.pid));

      // Attempt to start second hub (should fail - lock held)
      let error: Error | null = null;
      try {
        const hub2 = await startHub({
          workspaceRoot: workspace,
          authToken: TEST_TOKEN,
        });
        hubs.push(hub2);
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/Writer lock already held by live hub/i);
    });

    it("removes stale lock and succeeds when health check fails", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      // Manually create stale lock + stale server.json (invalid port)
      const locksDir = join(workspace, ".zulip", "locks");
      await mkdir(locksDir, { recursive: true });

      const lockPath = join(locksDir, "writer.lock");
      await writeFile(lockPath, `99999\n${new Date().toISOString()}`);

      await writeServerJson({
        workspaceRoot: workspace,
        data: {
          instance_id: "stale-instance",
          db_id: "test-db",
          port: 1, // Invalid/unreachable port
          host: "127.0.0.1",
          auth_token: "stale-token",
          pid: 99999,
          started_at: new Date().toISOString(),
          protocol_version: "v1",
          schema_version: 1,
        },
      });

      // Starting hub should detect stale lock, remove it, and succeed
      const hub = await startHub({
        workspaceRoot: workspace,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub);

      // Verify new lock exists with current PID
      const lockInfo = await readLockInfo({ workspaceRoot: workspace });
      expect(lockInfo).not.toBeNull();
      expect(lockInfo).toContain(String(process.pid));
      expect(lockInfo).not.toContain("99999");

      // Verify server.json updated
      const serverJson = await readServerJson({ workspaceRoot: workspace });
      expect(serverJson?.instance_id).toBe(hub.instanceId);
      expect(serverJson?.port).toBe(hub.port);
    });

    it("cleans up lock and server.json on graceful shutdown", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      const hub = await startHub({
        workspaceRoot: workspace,
        authToken: TEST_TOKEN,
      });

      // Verify lock + server.json exist
      expect(await readLockInfo({ workspaceRoot: workspace })).not.toBeNull();
      expect(await readServerJson({ workspaceRoot: workspace })).not.toBeNull();

      // Stop hub
      await hub.stop();

      // Verify cleanup
      expect(await readLockInfo({ workspaceRoot: workspace })).toBeNull();
      expect(await readServerJson({ workspaceRoot: workspace })).toBeNull();
    });
  });

  describe("Permission errors for directory creation", () => {
    it("fails when workspace root is read-only", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      await makeDirectoryReadOnly(workspace);

      let error: Error | null = null;
      try {
        const hub = await startHub({
          workspaceRoot: workspace,
          authToken: TEST_TOKEN,
        });
        hubs.push(hub);
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/EACCES|EPERM|permission denied/i);
    });

    it("fails when .zulip/locks directory cannot be created", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      const zulipDir = join(workspace, ".zulip");
      await mkdir(zulipDir, { recursive: true });
      await makeDirectoryReadOnly(zulipDir);

      let error: Error | null = null;
      try {
        const hub = await startHub({
          workspaceRoot: workspace,
          authToken: TEST_TOKEN,
        });
        hubs.push(hub);
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/EACCES|EPERM|permission denied/i);
    });

    it("succeeds when all directories are writable", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      const hub = await startHub({
        workspaceRoot: workspace,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub);

      // Verify directories created successfully
      const zulipDir = join(workspace, ".zulip");
      const locksDir = join(zulipDir, "locks");

      const zulipStats = await stat(zulipDir);
      expect(zulipStats.isDirectory()).toBe(true);

      const locksStats = await stat(locksDir);
      expect(locksStats.isDirectory()).toBe(true);
    });
  });

  describe("Lock staleness detection", () => {
    it("treats lock as stale when server.json missing", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      // Create lock without server.json
      const locksDir = join(workspace, ".zulip", "locks");
      await mkdir(locksDir, { recursive: true });

      const lockPath = join(locksDir, "writer.lock");
      await writeFile(lockPath, `99999\n${new Date().toISOString()}`);

      // Starting hub should detect stale lock and succeed
      const hub = await startHub({
        workspaceRoot: workspace,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub);

      // Verify new lock with current PID
      const lockInfo = await readLockInfo({ workspaceRoot: workspace });
      expect(lockInfo).toContain(String(process.pid));
    });

    it("treats lock as stale when health check times out", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      // Create lock + server.json with unreachable endpoint
      const locksDir = join(workspace, ".zulip", "locks");
      await mkdir(locksDir, { recursive: true });

      await writeFile(
        join(locksDir, "writer.lock"),
        `99999\n${new Date().toISOString()}`
      );

      // Use a non-routable IP (192.0.2.0/24 is TEST-NET-1, guaranteed to timeout)
      await writeServerJson({
        workspaceRoot: workspace,
        data: {
          instance_id: "timeout-instance",
          db_id: "test-db",
          port: 54321,
          host: "192.0.2.1", // Non-routable test network
          auth_token: "timeout-token",
          pid: 99999,
          started_at: new Date().toISOString(),
          protocol_version: "v1",
          schema_version: 1,
        },
      });

      // Should timeout on health check and treat as stale (may take ~2s)
      const hub = await startHub({
        workspaceRoot: workspace,
        authToken: TEST_TOKEN,
      });
      hubs.push(hub);

      expect(hub.instanceId).not.toBe("timeout-instance");
    });
  });

  describe("Direct lock API tests", () => {
    it("acquireWriterLock succeeds when no lock exists", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      const mockHealthCheck = async () => false;

      await acquireWriterLock({
        workspaceRoot: workspace,
        healthCheck: mockHealthCheck,
      });

      const lockInfo = await readLockInfo({ workspaceRoot: workspace });
      expect(lockInfo).not.toBeNull();
      expect(lockInfo).toContain(String(process.pid));

      // Cleanup
      await releaseWriterLock({ workspaceRoot: workspace });
    });

    it("acquireWriterLock retries and succeeds when lock is stale", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      // Create stale lock
      const locksDir = join(workspace, ".zulip", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(join(locksDir, "writer.lock"), "stale\n");

      const mockHealthCheck = async () => false; // Always stale

      await acquireWriterLock({
        workspaceRoot: workspace,
        healthCheck: mockHealthCheck,
      });

      const lockInfo = await readLockInfo({ workspaceRoot: workspace });
      expect(lockInfo).toContain(String(process.pid));

      // Cleanup
      await releaseWriterLock({ workspaceRoot: workspace });
    });

    it("acquireWriterLock fails when lock is live", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      // Create lock + valid server.json so health check has something to validate
      const locksDir = join(workspace, ".zulip", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(join(locksDir, "writer.lock"), "live\n");

      // Write server.json with valid instance data
      await writeServerJson({
        workspaceRoot: workspace,
        data: {
          instance_id: "live-instance",
          db_id: "test-db",
          port: 54321,
          host: "127.0.0.1",
          auth_token: "live-token",
          pid: process.pid,
          started_at: new Date().toISOString(),
          protocol_version: "v1",
          schema_version: 1,
        },
      });

      const mockHealthCheck = async () => true; // Always live

      let error: Error | null = null;
      try {
        await acquireWriterLock({
          workspaceRoot: workspace,
          healthCheck: mockHealthCheck,
        });
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/Writer lock already held by live hub/i);
    });

    it("releaseWriterLock is no-op when lock doesn't exist", async () => {
      const workspace = await createTempWorkspace();
      tempWorkspaces.push(workspace);

      // Should not throw
      await releaseWriterLock({ workspaceRoot: workspace });

      expect(await readLockInfo({ workspaceRoot: workspace })).toBeNull();
    });
  });
});
