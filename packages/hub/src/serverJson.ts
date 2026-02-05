import {
  mkdir,
  writeFile,
  readFile,
  unlink,
  chmod,
  stat,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface ServerJsonData {
  instance_id: string;
  db_id: string;
  port: number;
  host: string;
  auth_token: string;
  pid: number;
  started_at: string;
  protocol_version: string;
  schema_version?: number;
}

function agentlipDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".agentlip");
}

function serverJsonPath(workspaceRoot: string): string {
  return join(agentlipDir(workspaceRoot), "server.json");
}

async function ensureMode0600(filePath: string): Promise<void> {
  const mode = (await stat(filePath)).mode & 0o777;
  if (mode === 0o600) return;

  await chmod(filePath, 0o600);
  const mode2 = (await stat(filePath)).mode & 0o777;
  if (mode2 !== 0o600) {
    throw new Error(
      `Failed to set mode 0600 on ${filePath} (got ${mode2.toString(8)})`
    );
  }
}

/**
 * Write `.agentlip/server.json` atomically.
 *
 * Requirements (AGENTLIP_PLAN.md §4.2 / Gate J):
 * - atomic write (temp file in same dir + rename)
 * - mode 0600 (owner read/write only)
 * - never log auth_token
 */
export async function writeServerJson({
  workspaceRoot,
  data,
}: {
  workspaceRoot: string;
  data: ServerJsonData;
}): Promise<void> {
  const dir = agentlipDir(workspaceRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const finalPath = serverJsonPath(workspaceRoot);
  const tmpPath = join(
    dir,
    `.server.json.tmp.${randomBytes(8).toString("hex")}`
  );

  const content = JSON.stringify(data, null, 2);

  try {
    // Write temp file first (same filesystem), then rename over final.
    await writeFile(tmpPath, content, { mode: 0o600, flag: "wx" });
    await ensureMode0600(tmpPath);

    try {
      await rename(tmpPath, finalPath);
    } catch (err: any) {
      // Windows can fail to overwrite existing target; best-effort fallback.
      if (err?.code === "EEXIST" || err?.code === "EPERM") {
        try {
          await unlink(finalPath);
        } catch (unlinkErr: any) {
          if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
        }
        await rename(tmpPath, finalPath);
      } else {
        throw err;
      }
    }

    // Belt-and-suspenders: verify perms on final file.
    await ensureMode0600(finalPath);
  } finally {
    // If rename failed mid-way, temp file may still exist.
    try {
      await unlink(tmpPath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
}

/**
 * Read and parse `.agentlip/server.json`.
 * Returns null if missing.
 */
export async function readServerJson({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): Promise<ServerJsonData | null> {
  try {
    const content = await readFile(serverJsonPath(workspaceRoot), "utf-8");
    return JSON.parse(content) as ServerJsonData;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Remove `.agentlip/server.json`.
 * No-op if missing.
 */
export async function removeServerJson({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): Promise<void> {
  try {
    await unlink(serverJsonPath(workspaceRoot));
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
}
