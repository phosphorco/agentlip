/**
 * Workspace config loader and schema validation
 * 
 * Security requirements:
 * - Only load agentlip.config.ts from workspace root (never traverse upward)
 * - Validate plugin module paths to prevent path traversal
 * - Return null for missing config (optional file)
 */

import { join, resolve, relative, normalize } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Plugin configuration
 */
export interface PluginConfig {
  name: string;
  type: "linkifier" | "extractor";
  enabled: boolean;
  /** Path to custom plugin module (relative to workspace root or absolute). Default: built-in */
  module?: string;
  /** Plugin-specific configuration */
  config?: Record<string, unknown>;
}

/**
 * Workspace configuration schema
 */
export interface WorkspaceConfig {
  plugins?: PluginConfig[];
  rateLimits?: {
    perConnection?: number;
    global?: number;
  };
  limits?: {
    maxMessageSize?: number;
    maxAttachmentSize?: number;
    maxWsMessageSize?: number;
    maxWsConnections?: number;
    maxWsQueueSize?: number;
    maxEventReplayBatch?: number;
  };
  pluginDefaults?: {
    timeout?: number;
    memoryLimit?: number;
  };
}

/**
 * Result of config loading
 */
export interface LoadConfigResult {
  config: WorkspaceConfig;
  /** Absolute path to config file (if loaded) */
  configPath?: string;
}

/**
 * Validate that a plugin module path does not escape workspace root.
 * 
 * Security: prevents path traversal attacks via plugin.module field.
 * 
 * @param modulePath - Plugin module path (relative or absolute)
 * @param workspaceRoot - Workspace root directory (absolute)
 * @returns Absolute path to module if valid
 * @throws Error if path escapes workspace root
 */
export function validatePluginModulePath(
  modulePath: string,
  workspaceRoot: string
): string {
  const absWorkspaceRoot = resolve(workspaceRoot);
  
  // Resolve module path relative to workspace root (if relative)
  const absModulePath = resolve(absWorkspaceRoot, modulePath);
  
  // Normalize paths to handle '..' and '.' components
  const normalizedWorkspaceRoot = normalize(absWorkspaceRoot);
  const normalizedModulePath = normalize(absModulePath);
  
  // Check that resolved path is within workspace root
  const rel = relative(normalizedWorkspaceRoot, normalizedModulePath);
  
  // relative() returns a path that:
  // - starts with '..' if target is outside source
  // - is empty string if paths are identical
  // - is a relative path within if target is inside source
  
  if (rel.startsWith("..") || resolve(normalizedWorkspaceRoot, rel) !== normalizedModulePath) {
    throw new Error(
      `Plugin module path escapes workspace root: ${modulePath} ` +
      `(resolves to ${normalizedModulePath}, workspace: ${normalizedWorkspaceRoot})`
    );
  }
  
  return normalizedModulePath;
}

/**
 * Validate workspace config schema.
 * 
 * Performs basic structural validation and security checks.
 * 
 * @param config - Config object to validate
 * @param workspaceRoot - Workspace root for plugin path validation
 * @throws Error if validation fails
 */
export function validateWorkspaceConfig(
  config: unknown,
  workspaceRoot: string
): asserts config is WorkspaceConfig {
  if (config === null || typeof config !== "object") {
    throw new Error("Config must be an object");
  }
  
  const cfg = config as Record<string, unknown>;
  
  // Validate plugins array (if present)
  if (cfg.plugins !== undefined) {
    if (!Array.isArray(cfg.plugins)) {
      throw new Error("plugins must be an array");
    }
    
    for (const [idx, plugin] of cfg.plugins.entries()) {
      if (plugin === null || typeof plugin !== "object") {
        throw new Error(`plugins[${idx}] must be an object`);
      }
      
      const p = plugin as Record<string, unknown>;
      
      // Required fields
      if (typeof p.name !== "string" || p.name.length === 0) {
        throw new Error(`plugins[${idx}].name must be a non-empty string`);
      }
      
      if (p.type !== "linkifier" && p.type !== "extractor") {
        throw new Error(`plugins[${idx}].type must be "linkifier" or "extractor"`);
      }
      
      if (typeof p.enabled !== "boolean") {
        throw new Error(`plugins[${idx}].enabled must be a boolean`);
      }
      
      // Validate module path (if provided)
      if (p.module !== undefined) {
        if (typeof p.module !== "string") {
          throw new Error(`plugins[${idx}].module must be a string`);
        }
        
        // Security: validate path does not escape workspace
        try {
          validatePluginModulePath(p.module, workspaceRoot);
        } catch (err: any) {
          throw new Error(`plugins[${idx}].module: ${err.message}`);
        }
      }
      
      // Validate config (if provided)
      if (p.config !== undefined) {
        if (p.config === null || typeof p.config !== "object" || Array.isArray(p.config)) {
          throw new Error(`plugins[${idx}].config must be an object`);
        }
      }
    }
  }
  
  // Validate rateLimits (if present)
  if (cfg.rateLimits !== undefined) {
    if (cfg.rateLimits === null || typeof cfg.rateLimits !== "object") {
      throw new Error("rateLimits must be an object");
    }
    
    const rl = cfg.rateLimits as Record<string, unknown>;
    
    if (rl.perConnection !== undefined && typeof rl.perConnection !== "number") {
      throw new Error("rateLimits.perConnection must be a number");
    }
    
    if (rl.global !== undefined && typeof rl.global !== "number") {
      throw new Error("rateLimits.global must be a number");
    }
  }
  
  // Validate limits (if present)
  if (cfg.limits !== undefined) {
    if (cfg.limits === null || typeof cfg.limits !== "object") {
      throw new Error("limits must be an object");
    }
    
    const lim = cfg.limits as Record<string, unknown>;
    const limitFields = [
      "maxMessageSize",
      "maxAttachmentSize",
      "maxWsMessageSize",
      "maxWsConnections",
      "maxWsQueueSize",
      "maxEventReplayBatch",
    ];
    
    for (const field of limitFields) {
      if (lim[field] !== undefined && typeof lim[field] !== "number") {
        throw new Error(`limits.${field} must be a number`);
      }
    }
  }
  
  // Validate pluginDefaults (if present)
  if (cfg.pluginDefaults !== undefined) {
    if (cfg.pluginDefaults === null || typeof cfg.pluginDefaults !== "object") {
      throw new Error("pluginDefaults must be an object");
    }
    
    const pd = cfg.pluginDefaults as Record<string, unknown>;
    
    if (pd.timeout !== undefined && typeof pd.timeout !== "number") {
      throw new Error("pluginDefaults.timeout must be a number");
    }
    
    if (pd.memoryLimit !== undefined && typeof pd.memoryLimit !== "number") {
      throw new Error("pluginDefaults.memoryLimit must be a number");
    }
  }
}

/**
 * Load and validate workspace config from agentlip.config.ts.
 * 
 * Security guarantees:
 * - Only loads from workspace root (never traverses upward)
 * - Validates plugin module paths to prevent path traversal
 * - Returns null if config file doesn't exist (optional file)
 * 
 * @param workspaceRoot - Absolute path to workspace root directory
 * @returns Config object or null if file doesn't exist
 * @throws Error if config exists but is invalid
 */
export async function loadWorkspaceConfig(
  workspaceRoot: string
): Promise<LoadConfigResult | null> {
  const absWorkspaceRoot = resolve(workspaceRoot);
  const configPath = join(absWorkspaceRoot, "agentlip.config.ts");
  
  // Convert to file:// URL for dynamic import
  const configUrl = pathToFileURL(configPath).href;
  
  let configModule: unknown;
  try {
    configModule = await import(configUrl);
  } catch (err: any) {
    // File doesn't exist or has syntax errors
    if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ENOENT") {
      return null;
    }
    
    // Config exists but has errors - propagate
    throw new Error(`Failed to load agentlip.config.ts: ${err.message}`);
  }
  
  // Extract default export
  const config = (configModule as any)?.default;
  
  if (config === undefined) {
    throw new Error("agentlip.config.ts must have a default export");
  }
  
  // Validate config schema
  validateWorkspaceConfig(config, absWorkspaceRoot);
  
  return {
    config,
    configPath,
  };
}
