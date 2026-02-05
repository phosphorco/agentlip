/**
 * Plugin Worker script - executes plugin code in isolated Worker context.
 * 
 * Receives RPC requests via postMessage:
 * - { modulePath, request: { type, input } }
 * 
 * Responds with:
 * - { ok: true, data: Enrichment[] | Attachment[] }
 * - { ok: false, error: string }
 * 
 * This script runs in a Bun Worker thread (isolated from hub process).
 * 
 * ISOLATION GUARANTEES (bd-16d.4.4):
 * - Filesystem guards block writes to .zulip/ directory (practical isolation)
 * - Plugins receive no workspace path context (path-blind execution)
 * 
 * LIMITATIONS (v1):
 * - Not cryptographic sandboxing (Bun Workers share process memory)
 * - Plugins can access network and non-.zulip filesystem
 * - Guards are best-effort (sophisticated plugins might bypass)
 * - Future: consider true sandboxing (subprocess, Deno, wasm)
 */

import { promises as fs } from "node:fs";
import { resolve, normalize, sep } from "node:path";

interface WorkerRequest {
  type: "extractor" | "linkifier";
  input: {
    message: {
      id: string;
      content_raw: string;
      sender: string;
      topic_id: string;
      channel_id: string;
      created_at: string;
    };
    config: Record<string, unknown>;
  };
}

interface LinkifierPlugin {
  name: string;
  version: string;
  enrich(input: any): Promise<any[]>;
}

interface ExtractorPlugin {
  name: string;
  version: string;
  extract(input: any): Promise<any[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem Isolation Guards (bd-16d.4.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a path targets .zulip/ directory (or any .zulip ancestor).
 * Returns true if path should be blocked.
 */
function isZulipPath(targetPath: string): boolean {
  try {
    const normalized = normalize(resolve(targetPath));
    const parts = normalized.split(sep);
    
    // Check if any path component is exactly '.zulip'
    return parts.includes(".zulip");
  } catch {
    // If path resolution fails, be conservative and block
    return true;
  }
}

/**
 * Wrap filesystem write operations to block .zulip/ access.
 * This is practical isolation, not cryptographic sandboxing.
 */
function installFilesystemGuards(): void {
  // Promises API (async)
  const originalWriteFile = fs.writeFile;
  const originalAppendFile = fs.appendFile;
  const originalMkdir = fs.mkdir;
  const originalRm = fs.rm;
  const originalRmdir = fs.rmdir;
  const originalUnlink = fs.unlink;
  const originalOpen = fs.open;

  // Sync API
  const fsSync = require("node:fs");
  const originalWriteFileSync = fsSync.writeFileSync;
  const originalAppendFileSync = fsSync.appendFileSync;
  const originalMkdirSync = fsSync.mkdirSync;
  const originalRmSync = fsSync.rmSync;
  const originalRmdirSync = fsSync.rmdirSync;
  const originalUnlinkSync = fsSync.unlinkSync;
  const originalOpenSync = fsSync.openSync;

  const blockMessage = "Plugin isolation violation: write access to .zulip/ directory is forbidden";

  // @ts-ignore - intentionally overriding
  fs.writeFile = async function (path: any, data: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalWriteFile.call(this, path, data, options);
  };

  // @ts-ignore
  fs.appendFile = async function (path: any, data: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalAppendFile.call(this, path, data, options);
  };

  // @ts-ignore
  fs.mkdir = async function (path: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalMkdir.call(this, path, options);
  };

  // @ts-ignore
  fs.rm = async function (path: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalRm.call(this, path, options);
  };

  // @ts-ignore - runtime filesystem guard
  fs.rmdir = async function (path: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    // @ts-ignore - dynamic override
    return originalRmdir.call(this, path, options);
  };

  // @ts-ignore
  fs.unlink = async function (path: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalUnlink.call(this, path);
  };

  // @ts-ignore
  fs.open = async function (path: any, flags: any, ...args: any[]) {
    // Block write/append modes
    const flagsStr = String(flags || "r");
    const isWrite = /[wa+]/.test(flagsStr) || flags === 1 || flags === 2 || flags === 3;
    
    if (isWrite && isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalOpen.call(this, path, flags, ...args);
  };

  // Sync API guards
  fsSync.writeFileSync = function (path: any, data: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalWriteFileSync.call(this, path, data, options);
  };

  fsSync.appendFileSync = function (path: any, data: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalAppendFileSync.call(this, path, data, options);
  };

  fsSync.mkdirSync = function (path: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalMkdirSync.call(this, path, options);
  };

  fsSync.rmSync = function (path: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalRmSync.call(this, path, options);
  };

  fsSync.rmdirSync = function (path: any, options?: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalRmdirSync.call(this, path, options);
  };

  fsSync.unlinkSync = function (path: any) {
    if (isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalUnlinkSync.call(this, path);
  };

  fsSync.openSync = function (path: any, flags: any, ...args: any[]) {
    const flagsStr = String(flags || "r");
    const isWrite = /[wa+]/.test(flagsStr) || flags === 1 || flags === 2 || flags === 3;
    
    if (isWrite && isZulipPath(String(path))) {
      throw new Error(blockMessage);
    }
    return originalOpenSync.call(this, path, flags, ...args);
  };
}

// Install guards before plugin code runs
installFilesystemGuards();

// Type assertion for Worker context
const workerSelf = self as unknown as Worker;

workerSelf.onmessage = async (event: MessageEvent) => {
  try {
    const { modulePath, request } = event.data as {
      modulePath: string;
      request: WorkerRequest;
    };

    // Dynamically import plugin module
    let plugin: LinkifierPlugin | ExtractorPlugin;
    
    try {
      const module = await import(modulePath);
      plugin = module.default ?? module;
    } catch (importError: any) {
      workerSelf.postMessage({
        ok: false,
        error: `Failed to load plugin: ${importError.message}`,
      });
      return;
    }

    // Validate plugin interface
    if (!plugin || typeof plugin !== "object") {
      workerSelf.postMessage({
        ok: false,
        error: "Plugin module must export a default object",
      });
      return;
    }

    // Call appropriate plugin method
    let result: any[];
    
    try {
      if (request.type === "linkifier") {
        const linkifier = plugin as LinkifierPlugin;
        if (typeof linkifier.enrich !== "function") {
          workerSelf.postMessage({
            ok: false,
            error: "Linkifier plugin must implement enrich() method",
          });
          return;
        }
        result = await linkifier.enrich(request.input);
      } else {
        const extractor = plugin as ExtractorPlugin;
        if (typeof extractor.extract !== "function") {
          workerSelf.postMessage({
            ok: false,
            error: "Extractor plugin must implement extract() method",
          });
          return;
        }
        result = await extractor.extract(request.input);
      }
    } catch (execError: any) {
      workerSelf.postMessage({
        ok: false,
        error: `Plugin execution failed: ${execError.message}`,
      });
      return;
    }

    // Send success response (validation happens in main thread)
    workerSelf.postMessage({
      ok: true,
      data: result,
    });
  } catch (error: any) {
    workerSelf.postMessage({
      ok: false,
      error: `Worker error: ${error.message}`,
    });
  }
};
