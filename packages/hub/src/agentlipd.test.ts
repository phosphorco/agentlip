/**
 * Tests for agentlipd CLI (daemon control utilities)
 * 
 * Verifies:
 * - `agentlipd up` creates server.json and holds writer lock
 * - Second `agentlipd up` exits with code 10 (lock conflict)
 * - SIGINT triggers graceful shutdown cleanup
 * - Token secrecy: auth_token never leaks to stdout/stderr
 */

import { describe, it, expect, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { createTempWorkspace } from "./integrationHarness";
import { readServerJson } from "./serverJson";

const AGENTLIPD_PATH = join(import.meta.dir, "agentlipd.ts");

interface SpawnedProcess {
  child: ReturnType<typeof spawn>;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  waitForExit: () => Promise<number>;
}

/**
 * Spawn agentlipd subprocess and capture output.
 */
function spawnAgentlipd(args: string[], cwd: string): SpawnedProcess {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  let exitResolve: ((code: number) => void) | null = null;

  const child = spawn("bun", [AGENTLIPD_PATH, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    stdout.push(chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString());
  });

  child.on("exit", (code) => {
    exitCode = code ?? 1;
    if (exitResolve) {
      exitResolve(exitCode);
    }
  });

  const waitForExit = (): Promise<number> => {
    if (exitCode !== null) {
      return Promise.resolve(exitCode);
    }
    return new Promise((resolve) => {
      exitResolve = resolve;
    });
  };

  return {
    child,
    stdout,
    stderr,
    exitCode,
    waitForExit,
  };
}

/**
 * Wait for server.json to exist and be readable.
 */
async function waitForServerJson(
  workspaceRoot: string,
  timeoutMs: number = 5000
): Promise<void> {
  const serverJsonPath = join(workspaceRoot, ".agentlip", "server.json");
  const startMs = Date.now();

  while (Date.now() - startMs < timeoutMs) {
    try {
      await fs.access(serverJsonPath);
      // Also verify it's readable JSON
      await readServerJson({ workspaceRoot });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(
    `server.json did not appear within ${timeoutMs}ms at ${serverJsonPath}`
  );
}

/**
 * Wait for /health endpoint to respond successfully.
 */
async function waitForHealth(
  host: string,
  port: number,
  timeoutMs: number = 5000
): Promise<void> {
  const startMs = Date.now();

  while (Date.now() - startMs < timeoutMs) {
    try {
      const res = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        return;
      }
    } catch {
      // Ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `/health endpoint did not respond within ${timeoutMs}ms at ${host}:${port}`
  );
}

describe("agentlipd up", () => {
  const workspaces: Array<{ cleanup: () => Promise<void> }> = [];
  const processes: SpawnedProcess[] = [];

  afterEach(async () => {
    // Kill all spawned processes
    for (const proc of processes) {
      if (!proc.child.killed) {
        proc.child.kill("SIGKILL");
      }
    }
    processes.length = 0;

    // Clean up workspaces
    for (const ws of workspaces) {
      await ws.cleanup();
    }
    workspaces.length = 0;
  });

  it("creates server.json and holds writer lock", async () => {
    const workspace = await createTempWorkspace();
    workspaces.push(workspace);

    // Start agentlipd up
    const proc = spawnAgentlipd(["up", "--port", "0"], workspace.root);
    processes.push(proc);

    // Wait for server.json to appear
    await waitForServerJson(workspace.root);

    // Verify server.json exists and has expected fields
    const serverJson = await readServerJson({ workspaceRoot: workspace.root });
    expect(serverJson).not.toBeNull();
    expect(serverJson!.instance_id).toBeDefined();
    expect(serverJson!.port).toBeGreaterThan(0);
    expect(serverJson!.host).toBe("127.0.0.1");
    expect(serverJson!.auth_token).toBeDefined();

    // Verify hub is responsive
    await waitForHealth(serverJson!.host, serverJson!.port);

    // Verify writer lock exists
    const lockPath = join(workspace.root, ".agentlip", "locks", "writer.lock");
    await fs.access(lockPath); // Should not throw

    // Kill process
    proc.child.kill("SIGINT");
    const exitCode = await proc.waitForExit();
    expect(exitCode).toBe(0);
  }, 10000);

  it("second `agentlipd up` exits with code 10 quickly", async () => {
    const workspace = await createTempWorkspace();
    workspaces.push(workspace);

    // Start first hub
    const proc1 = spawnAgentlipd(["up", "--port", "0"], workspace.root);
    processes.push(proc1);

    // Wait for server.json
    await waitForServerJson(workspace.root);

    const serverJson = await readServerJson({ workspaceRoot: workspace.root });
    expect(serverJson).not.toBeNull();

    // Wait for hub to be responsive
    await waitForHealth(serverJson!.host, serverJson!.port);

    // Try to start second hub (should fail with exit code 10)
    const proc2 = spawnAgentlipd(["up", "--port", "0"], workspace.root);
    processes.push(proc2);

    const exitCode = await proc2.waitForExit();
    expect(exitCode).toBe(10);

    // Verify error message mentions lock conflict
    const stderrText = proc2.stderr.join("");
    expect(stderrText).toContain("already running");

    // First hub should still be running
    const healthRes = await fetch(`http://${serverJson!.host}:${serverJson!.port}/health`);
    expect(healthRes.ok).toBe(true);

    // Clean up first hub
    proc1.child.kill("SIGINT");
    await proc1.waitForExit();
  }, 10000);

  it("SIGINT triggers graceful shutdown cleanup", async () => {
    const workspace = await createTempWorkspace();
    workspaces.push(workspace);

    // Start hub
    const proc = spawnAgentlipd(["up", "--port", "0"], workspace.root);
    processes.push(proc);

    // Wait for server.json
    await waitForServerJson(workspace.root);

    const serverJson = await readServerJson({ workspaceRoot: workspace.root });
    expect(serverJson).not.toBeNull();

    // Wait for hub to be responsive
    await waitForHealth(serverJson!.host, serverJson!.port);

    // Send SIGINT
    proc.child.kill("SIGINT");
    const exitCode = await proc.waitForExit();
    expect(exitCode).toBe(0);

    // Verify server.json is removed
    await new Promise((resolve) => setTimeout(resolve, 500)); // Allow cleanup time
    const serverJsonAfter = await readServerJson({ workspaceRoot: workspace.root });
    expect(serverJsonAfter).toBeNull();

    // Verify writer lock is removed
    const lockPath = join(workspace.root, ".agentlip", "locks", "writer.lock");
    await expect(fs.access(lockPath)).rejects.toThrow();
  }, 10000);

  it("token secrecy: auth_token never appears in stdout/stderr", async () => {
    const workspace = await createTempWorkspace();
    workspaces.push(workspace);

    // Start hub with --json output
    const proc = spawnAgentlipd(["up", "--port", "0", "--json"], workspace.root);
    processes.push(proc);

    // Wait for server.json
    await waitForServerJson(workspace.root);

    const serverJson = await readServerJson({ workspaceRoot: workspace.root });
    expect(serverJson).not.toBeNull();
    const authToken = serverJson!.auth_token;
    expect(authToken).toBeDefined();
    expect(authToken.length).toBeGreaterThan(20);

    // Kill process
    proc.child.kill("SIGINT");
    await proc.waitForExit();

    // Check stdout and stderr do NOT contain auth token
    const stdoutText = proc.stdout.join("");
    const stderrText = proc.stderr.join("");
    const combinedOutput = stdoutText + stderrText;

    expect(combinedOutput).not.toContain(authToken);

    // Verify JSON output does NOT include auth_token field
    if (stdoutText.includes("{")) {
      const jsonMatch = stdoutText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        expect(parsed.auth_token).toBeUndefined();
      }
    }
  }, 10000);

  it("--idle-shutdown-ms flag is accepted and passed to startHub", async () => {
    const workspace = await createTempWorkspace();
    workspaces.push(workspace);

    // Start hub with idle shutdown (set to very high value so it doesn't trigger)
    const proc = spawnAgentlipd(
      ["up", "--port", "0", "--idle-shutdown-ms", "999999"],
      workspace.root
    );
    processes.push(proc);

    // Wait for server.json
    await waitForServerJson(workspace.root);

    const serverJson = await readServerJson({ workspaceRoot: workspace.root });
    expect(serverJson).not.toBeNull();

    // Verify hub is responsive
    await waitForHealth(serverJson!.host, serverJson!.port);

    // Clean up
    proc.child.kill("SIGINT");
    const exitCode = await proc.waitForExit();
    expect(exitCode).toBe(0);
  }, 10000);
});
