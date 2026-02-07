/**
 * Integration tests for @agentlip/client/local
 * 
 * Tests connectToLocalAgentlip with a running daemon-mode hub.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createTempWorkspace,
  startTestHub,
  type TempWorkspace,
  type TestHub,
} from "../../hub/src/integrationHarness";
import { writeFileSync } from "node:fs";
import {
  connectToLocalAgentlip,
  WorkspaceNotFoundError,
  BunNotFoundError,
  ProtocolVersionMismatchError,
  WaitTimeoutError,
  ConnectionClosedError,
  MutationError,
  type LocalAgentlipClient,
} from "./local";
import { readServerJson, validateHub } from "./serverJson";

const execFileAsync = promisify(execFile);

describe("connectToLocalAgentlip - daemon mode", () => {
  let workspace: TempWorkspace;
  let hub: TestHub;

  beforeAll(async () => {
    // Create workspace and start hub in daemon mode (which writes server.json)
    workspace = await createTempWorkspace();
    
    // Start hub in daemon mode with workspaceRoot (writes server.json)
    hub = await startTestHub({
      workspaceRoot: workspace.root,
      authToken: "test-token",
      rateLimitDisabled: true,
    });

    // Wait for server.json to be written (startHub writes it after binding port)
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    await hub.stop();
    await workspace.cleanup();
  });

  test("connects to running hub and validates health", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    expect(client.workspaceRoot).toBe(workspace.root);
    expect(client.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(client.authToken).toBe("test-token");
    expect(client.startedHub).toBe(false);

    client.close();
  });

  test("bound mutations work correctly", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    // Create channel -> topic -> send message chain
    const ch = await client.createChannel({ name: "local-test-ch" });
    expect(ch.channel.id).toMatch(/^ch_/);
    expect(ch.channel.name).toBe("local-test-ch");

    const tp = await client.createTopic({
      channelId: ch.channel.id,
      title: "Local Test Topic",
    });
    expect(tp.topic.id).toMatch(/^topic_/);
    expect(tp.topic.title).toBe("Local Test Topic");

    const msg = await client.sendMessage({
      topicId: tp.topic.id,
      sender: "test-bot",
      contentRaw: "Hello from local client",
    });
    expect(msg.message.id).toMatch(/^msg_/);
    expect(msg.message.sender).toBe("test-bot");
    expect(msg.message.content_raw).toBe("Hello from local client");

    client.close();
  });

  test("events() returns async iterator of events", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    // Create a channel to generate an event
    const ch = await client.createChannel({ name: "events-test-ch" });

    // Find the channel.created event for our channel (filter out old events from other tests)
    let foundEvent = false;
    for await (const event of client.events()) {
      if (event.name === "channel.created" && (event.data as any).channel.id === ch.channel.id) {
        expect(event.name).toBe("channel.created");
        expect((event.data as any).channel.id).toBe(ch.channel.id);
        foundEvent = true;
        break;
      }
    }

    expect(foundEvent).toBe(true);
    client.close();
  });

  test("waitForEvent resolves when predicate matches", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    // Create channel -> topic first (to avoid matching events from setup)
    const ch = await client.createChannel({ name: "wait-test-ch" });
    const tp = await client.createTopic({
      channelId: ch.channel.id,
      title: "Wait Test Topic",
    });

    // Now start waiting for a specific message.created event
    const waitPromise = client.waitForEvent(
      (event) => event.name === "message.created" && (event.data as any).message.sender === "waiter",
      { timeoutMs: 5000 }
    );

    // Send message
    const msg = await client.sendMessage({
      topicId: tp.topic.id,
      sender: "waiter",
      contentRaw: "test message",
    });

    // Wait should resolve with the message.created event
    const event = await waitPromise;
    expect(event.name).toBe("message.created");
    expect((event.data as any).message.id).toBe(msg.message.id);

    client.close();
  });

  test("waitForEvent throws WaitTimeoutError on timeout", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    try {
      await client.waitForEvent(
        (event) => event.name === "nonexistent.event",
        { timeoutMs: 100 }
      );
      throw new Error("Should have thrown WaitTimeoutError");
    } catch (err) {
      expect(err).toBeInstanceOf(WaitTimeoutError);
    }

    client.close();
  });

  test("waitForEvent respects AbortSignal", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    const controller = new AbortController();
    
    const waitPromise = client.waitForEvent(
      (event) => event.name === "never.happens",
      { signal: controller.signal, timeoutMs: 5000 }
    );

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);

    try {
      await waitPromise;
      throw new Error("Should have thrown AbortError");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    }

    client.close();
  });

  test("close() is idempotent", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    // Close twice - should not throw
    client.close();
    client.close();
  });

  test("close() terminates pending waitForEvent with ConnectionClosedError", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    const waitPromise = client.waitForEvent(
      (event) => event.name === "never.happens",
      { timeoutMs: 2000 } // Shorter timeout to avoid test suite timeout
    );

    // Close connection immediately
    client.close();

    try {
      await waitPromise;
      throw new Error("Should have thrown ConnectionClosedError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionClosedError);
    }
  });

  test("multiple events() iterators receive same events (fanout)", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    // Create two iterators
    const iter1 = client.events();
    const iter2 = client.events();

    // Generate an event
    const ch = await client.createChannel({ name: "fanout-test-ch" });

    // Both iterators should receive the event
    const event1Promise = iter1.next();
    const event2Promise = iter2.next();

    const [result1, result2] = await Promise.all([event1Promise, event2Promise]);

    expect(result1.done).toBe(false);
    expect(result2.done).toBe(false);
    expect(result1.value.name).toBe("channel.created");
    expect(result2.value.name).toBe("channel.created");
    expect(result1.value.event_id).toBe(result2.value.event_id);

    client.close();
  });

  test("mutation errors are wrapped in MutationError", async () => {
    const client = await connectToLocalAgentlip({
      cwd: workspace.root,
      startIfMissing: false,
    });

    try {
      await client.sendMessage({
        topicId: "topic_nonexistent",
        sender: "bot",
        contentRaw: "fail",
      });
      throw new Error("Should have thrown MutationError");
    } catch (err) {
      expect(err).toBeInstanceOf(MutationError);
      expect((err as MutationError).message).toContain("NOT_FOUND");
    }

    client.close();
  });
});

describe("connectToLocalAgentlip - spawn-if-missing (bd-27i.5)", () => {
  test("spawns hub when missing (empty workspace)", async () => {
    const workspace = await createTempWorkspace();

    try {
      // Set test override to spawn local agentlipd
      const agentlipdPath = join(import.meta.dir, "../../hub/src/agentlipd.ts");
      process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH = agentlipdPath;

      const client = await connectToLocalAgentlip({
        cwd: workspace.root,
        startIfMissing: true,
        idleShutdownMs: 200,
        startTimeoutMs: 15000, // Give it more time for first spawn
      });

      expect(client.workspaceRoot).toBe(workspace.root);
      expect(client.startedHub).toBe(true);
      expect(client.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // Verify hub is actually running
      const ch = await client.createChannel({ name: "spawn-test-ch" });
      expect(ch.channel.id).toMatch(/^ch_/);

      client.close();

      // Wait for idle shutdown cleanup to avoid leaving a stray daemon.
      for (let i = 0; i < 60; i++) {
        const sj = await readServerJson(workspace.root);
        if (!sj) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await readServerJson(workspace.root)).toBeNull();
    } finally {
      delete process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;
      await workspace.cleanup();
    }
  });

  test("spawned hub process argv does not contain auth token", async () => {
    const workspace = await createTempWorkspace();

    try {
      const agentlipdPath = join(import.meta.dir, "../../hub/src/agentlipd.ts");
      process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH = agentlipdPath;

      const client = await connectToLocalAgentlip({
        cwd: workspace.root,
        startIfMissing: true,
        idleShutdownMs: 200,
        startTimeoutMs: 15000,
      });

      const serverJson = await readServerJson(workspace.root);
      expect(serverJson).not.toBeNull();

      const { stdout } = await execFileAsync(
        "ps",
        ["-o", "args=", "-p", String(serverJson!.pid)],
        { encoding: "utf8" },
      );

      expect(String(stdout)).not.toContain(serverJson!.auth_token);

      client.close();

      // Wait for idle shutdown cleanup
      for (let i = 0; i < 60; i++) {
        const sj = await readServerJson(workspace.root);
        if (!sj) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await readServerJson(workspace.root)).toBeNull();
    } finally {
      delete process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;
      await workspace.cleanup();
    }
  });

  test("connects to existing hub (startedHub=false)", async () => {
    const workspace = await createTempWorkspace();

    try {
      const agentlipdPath = join(import.meta.dir, "../../hub/src/agentlipd.ts");
      process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH = agentlipdPath;

      // First client spawns hub
      const client1 = await connectToLocalAgentlip({
        cwd: workspace.root,
        startIfMissing: true,
        idleShutdownMs: 200,
        startTimeoutMs: 15000,
      });
      expect(client1.startedHub).toBe(true);

      // Second client connects to existing hub
      const client2 = await connectToLocalAgentlip({
        cwd: workspace.root,
        startIfMissing: true,
        startTimeoutMs: 5000,
      });
      expect(client2.startedHub).toBe(false);

      client1.close();
      client2.close();

      // Wait for idle shutdown cleanup
      for (let i = 0; i < 60; i++) {
        const sj = await readServerJson(workspace.root);
        if (!sj) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await readServerJson(workspace.root)).toBeNull();
    } finally {
      delete process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;
      await workspace.cleanup();
    }
  });

  test("concurrent spawns - both connect to same hub", async () => {
    const workspace = await createTempWorkspace();

    try {
      const agentlipdPath = join(import.meta.dir, "../../hub/src/agentlipd.ts");
      process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH = agentlipdPath;

      // Spawn two concurrent connects
      const [client1, client2] = await Promise.all([
        connectToLocalAgentlip({
          cwd: workspace.root,
          startIfMissing: true,
          idleShutdownMs: 200,
          startTimeoutMs: 15000,
        }),
        connectToLocalAgentlip({
          cwd: workspace.root,
          startIfMissing: true,
          idleShutdownMs: 200,
          startTimeoutMs: 15000,
        }),
      ]);

      // Critical invariant: both should be connected to same hub
      expect(client1.baseUrl).toBe(client2.baseUrl);
      expect(client1.workspaceRoot).toBe(client2.workspaceRoot);

      // Exactly one should have startedHub=true (writer lock ensures only one hub process starts)
      const startedCount = [client1.startedHub, client2.startedHub].filter(Boolean).length;
      expect(startedCount).toBe(1);

      // Verify hub is actually working
      const ch = await client1.createChannel({ name: "concurrent-test-ch" });
      expect(ch.channel.id).toMatch(/^ch_/);

      client1.close();
      client2.close();

      // Wait for idle shutdown cleanup
      for (let i = 0; i < 60; i++) {
        const sj = await readServerJson(workspace.root);
        if (!sj) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await readServerJson(workspace.root)).toBeNull();
    } finally {
      delete process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;
      await workspace.cleanup();
    }
  });

  test("abort during startup kills child and rejects with AbortError", async () => {
    const workspace = await createTempWorkspace();

    try {
      const pidFile = join(workspace.root, "spawned-child.pid");
      process.env.AGENTLIP_TEST_PID_FILE = pidFile;

      // Dummy script: write PID then hang forever
      const dummyScriptPath = join(workspace.root, "slow-start.ts");
      await fs.writeFile(
        dummyScriptPath,
        `
        import { writeFileSync } from "node:fs";
        if (process.env.AGENTLIP_TEST_PID_FILE) {
          writeFileSync(process.env.AGENTLIP_TEST_PID_FILE, String(process.pid));
        }
        await new Promise(() => {});
        `,
        "utf-8"
      );

      process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH = dummyScriptPath;

      const controller = new AbortController();

      const connectPromise = connectToLocalAgentlip({
        cwd: workspace.root,
        startIfMissing: true,
        signal: controller.signal,
        startTimeoutMs: 10000,
      });

      // Wait until the child actually started so we can validate cleanup.
      let pidText: string | null = null;
      for (let i = 0; i < 80; i++) {
        try {
          pidText = await fs.readFile(pidFile, "utf-8");
          break;
        } catch {
          // ignore
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(pidText).not.toBeNull();
      const pid = Number(pidText!.trim());
      expect(Number.isFinite(pid)).toBe(true);

      controller.abort();

      try {
        await connectPromise;
        throw new Error("Should have thrown AbortError");
      } catch (err) {
        expect(err).toBeInstanceOf(DOMException);
        expect((err as DOMException).name).toBe("AbortError");
      }

      // Assert child is gone
      let dead = false;
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          dead = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(dead).toBe(true);
    } finally {
      delete process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;
      delete process.env.AGENTLIP_TEST_PID_FILE;
      await workspace.cleanup();
    }
  });

  test("timeout kills child and throws HubStartTimeoutError", async () => {
    const workspace = await createTempWorkspace();

    try {
      const pidFile = join(workspace.root, "timeout-child.pid");
      process.env.AGENTLIP_TEST_PID_FILE = pidFile;

      // Set override to spawn a long-running dummy process (not hub)
      const dummyScriptPath = join(workspace.root, "dummy.ts");
      await fs.writeFile(
        dummyScriptPath,
        `
        import { writeFileSync } from "node:fs";
        if (process.env.AGENTLIP_TEST_PID_FILE) {
          writeFileSync(process.env.AGENTLIP_TEST_PID_FILE, String(process.pid));
        }
        await new Promise(() => {});
        `,
        "utf-8"
      );
      process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH = dummyScriptPath;

      let pid: number | null = null;

      try {
        await connectToLocalAgentlip({
          cwd: workspace.root,
          startIfMissing: true,
          startTimeoutMs: 500, // Very short timeout
        });
        throw new Error("Should have thrown HubStartTimeoutError");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe("HubStartTimeoutError");
        expect((err as Error).message).toContain("failed to start within");

        try {
          const pidText = await fs.readFile(pidFile, "utf-8");
          pid = Number(pidText.trim());
        } catch {
          // ignore
        }
      }

      // Assert child is gone
      if (pid !== null && Number.isFinite(pid)) {
        let dead = false;
        for (let i = 0; i < 40; i++) {
          try {
            process.kill(pid, 0);
          } catch {
            dead = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(dead).toBe(true);
      }
    } finally {
      delete process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;
      delete process.env.AGENTLIP_TEST_PID_FILE;
      await workspace.cleanup();
    }
  });

  test("child crash stderr is surfaced in error", async () => {
    const workspace = await createTempWorkspace();

    try {
      // Set override to spawn a script that fails with stderr
      const crashScriptPath = join(workspace.root, "crash.ts");
      await fs.writeFile(
        crashScriptPath,
        `
        console.error("boom: intentional crash for testing");
        process.exit(2);
        `,
        "utf-8"
      );
      process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH = crashScriptPath;

      try {
        await connectToLocalAgentlip({
          cwd: workspace.root,
          startIfMissing: true,
          startTimeoutMs: 5000,
        });
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("exit code 2");
        expect((err as Error).message).toContain("boom");
      }
    } finally {
      delete process.env.AGENTLIP_LOCAL_CLIENT_TEST_AGENTLIPD_PATH;
      await workspace.cleanup();
    }
  });

  test("throws BunNotFoundError when bunPath is not found", async () => {
    const workspace = await createTempWorkspace();

    try {
      await connectToLocalAgentlip({
        cwd: workspace.root,
        startIfMissing: true,
        bunPath: "definitely-not-a-real-bun-binary",
        startTimeoutMs: 5000,
      });
      throw new Error("Should have thrown BunNotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(BunNotFoundError);
    } finally {
      await workspace.cleanup();
    }
  });

  test("bunPath validation rejects path traversal", async () => {
    const workspace = await createTempWorkspace();

    try {
      await connectToLocalAgentlip({
        cwd: workspace.root,
        bunPath: "/usr/bin/../../../etc/passwd",
        startIfMissing: true,
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("path traversal");
    } finally {
      await workspace.cleanup();
    }
  });

  test("bunPath validation rejects shell metacharacters", async () => {
    const workspace = await createTempWorkspace();

    try {
      await connectToLocalAgentlip({
        cwd: workspace.root,
        bunPath: "bun; rm -rf /",
        startIfMissing: true,
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("shell metacharacters");
    } finally {
      await workspace.cleanup();
    }
  });

  test("bunPath accepts absolute paths", async () => {
    const workspace = await createTempWorkspace();

    try {
      // This should not throw on validation (will fail later when trying to spawn)
      const error = await connectToLocalAgentlip({
        cwd: workspace.root,
        bunPath: "/usr/local/bin/bun",
        startIfMissing: false, // Don't actually spawn
      }).catch((e) => e);

      // Should fail because hub not running, not because of validation
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("not running");
    } finally {
      await workspace.cleanup();
    }
  });

  test("bunPath accepts bare command names", async () => {
    const workspace = await createTempWorkspace();

    try {
      // This should not throw on validation
      const error = await connectToLocalAgentlip({
        cwd: workspace.root,
        bunPath: "bun",
        startIfMissing: false,
      }).catch((e) => e);

      // Should fail because hub not running
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("not running");
    } finally {
      await workspace.cleanup();
    }
  });
});

describe("connectToLocalAgentlip - error cases", () => {

  test("throws when server.json missing", async () => {
    const workspace = await createTempWorkspace();
    
    try {
      await connectToLocalAgentlip({
        cwd: workspace.root,
        startIfMissing: false,
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("server.json not found");
    } finally {
      await workspace.cleanup();
    }
  });

  test("throws ProtocolVersionMismatchError when /health reports mismatched protocol_version", async () => {
    const workspace = await createTempWorkspace();

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({
            status: "ok",
            instance_id: "fake-instance",
            db_id: "fake-db",
            schema_version: 1,
            protocol_version: "v999",
            pid: 12345,
            uptime_seconds: 1,
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const serverJsonPath = join(workspace.root, ".agentlip", "server.json");
      const serverJson = {
        instance_id: "fake-instance",
        db_id: "fake-db",
        port: server.port!,
        host: "127.0.0.1",
        auth_token: "test-token",
        pid: 12345,
        started_at: new Date().toISOString(),
        protocol_version: "v999",
        schema_version: 1,
      };

      writeFileSync(serverJsonPath, JSON.stringify(serverJson), { mode: 0o600 });

      try {
        await connectToLocalAgentlip({
          cwd: workspace.root,
          startIfMissing: false,
        });
        throw new Error("Should have thrown ProtocolVersionMismatchError");
      } catch (err) {
        expect(err).toBeInstanceOf(ProtocolVersionMismatchError);
        expect((err as ProtocolVersionMismatchError).actual).toBe("v999");
      }
    } finally {
      server.stop();
      await workspace.cleanup();
    }
  });
});
