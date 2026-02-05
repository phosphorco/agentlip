/**
 * @agentchat/workspace - Workspace discovery + initialization
 * 
 * Provides upward workspace discovery with security boundaries:
 * - Starts at cwd (or provided path)
 * - Walks upward until .zulip/db.sqlite3 exists
 * - Stops at filesystem boundary OR user home directory
 * - Initializes workspace at starting directory if not found
 */

import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const WORKSPACE_MARKER = '.zulip';
const DB_FILENAME = 'db.sqlite3';

/**
 * Result of workspace discovery
 */
export interface WorkspaceDiscoveryResult {
  /** Absolute path to workspace root directory */
  root: string;
  /** Absolute path to db.sqlite3 file */
  dbPath: string;
  /** Whether workspace was discovered (true) or needs initialization (false) */
  discovered: boolean;
}

/**
 * Result of workspace initialization
 */
export interface WorkspaceInitResult {
  /** Absolute path to workspace root directory */
  root: string;
  /** Absolute path to db.sqlite3 file */
  dbPath: string;
  /** Whether workspace was newly created (true) or already existed (false) */
  created: boolean;
}

/**
 * Discover workspace root by walking upward from startPath.
 * 
 * Stops at:
 * - Filesystem boundary (device ID change)
 * - User home directory (never traverse above home)
 * 
 * @param startPath - Directory to start search from (defaults to cwd)
 * @returns Discovery result or null if no workspace found within boundary
 */
export async function discoverWorkspaceRoot(
  startPath?: string
): Promise<WorkspaceDiscoveryResult | null> {
  const start = resolve(startPath ?? process.cwd());
  const home = resolve(homedir());

  // Get initial filesystem device ID
  const startStat = await fs.lstat(start);
  const startDevice = startStat.dev;
  
  let current = start;
  
  while (true) {
    // Check if .zulip/db.sqlite3 exists at current level
    const workspaceDir = join(current, WORKSPACE_MARKER);
    const dbPath = join(workspaceDir, DB_FILENAME);
    
    try {
      await fs.access(dbPath);
      // Found it!
      return {
        root: current,
        dbPath,
        discovered: true
      };
    } catch {
      // Not found, continue upward
    }
    
    // Check boundary conditions before going up
    const parent = dirname(current);
    
    // Reached filesystem root (parent === current)
    if (parent === current) {
      return null;
    }
    
    // Stop traversal at user home directory (security boundary)
    if (current === home) {
      return null;
    }
    
    // Check filesystem boundary (device ID change)
    try {
      const parentStat = await fs.lstat(parent);
      if (parentStat.dev !== startDevice) {
        // Crossed filesystem boundary
        return null;
      }
    } catch {
      // Can't stat parent - stop here
      return null;
    }
    
    current = parent;
  }
}

/**
 * Ensure workspace is initialized at workspaceRoot.
 * Creates .zulip/ directory and empty db.sqlite3 file if they don't exist.
 * 
 * @param workspaceRoot - Directory to initialize workspace in
 * @returns Init result indicating whether workspace was newly created
 */
export async function ensureWorkspaceInitialized(
  workspaceRoot: string
): Promise<WorkspaceInitResult> {
  const root = resolve(workspaceRoot);
  const workspaceDir = join(root, WORKSPACE_MARKER);
  const dbPath = join(workspaceDir, DB_FILENAME);
  
  let created = false;
  
  // Check if db already exists
  try {
    await fs.access(dbPath);
    // Already initialized
    return { root, dbPath, created: false };
  } catch {
    // Need to initialize
  }
  
  // Create .zulip directory with mode 0700 (owner rwx only)
  try {
    await fs.mkdir(workspaceDir, { mode: 0o700, recursive: true });
  } catch (err: any) {
    // If directory already exists, that's fine
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
  
  // Create empty db.sqlite3 with mode 0600 (owner rw only)
  try {
    const handle = await fs.open(dbPath, 'wx', 0o600); // x = fail if exists
    await handle.close();
    created = true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // File was created between our check and now - that's fine
      created = false;
    } else {
      throw err;
    }
  }
  
  return { root, dbPath, created };
}

/**
 * Discover workspace or initialize if not found.
 * 
 * Combines discovery + initialization:
 * - First tries to discover workspace by walking upward
 * - If not found, initializes workspace at startPath
 * 
 * @param startPath - Directory to start search from (defaults to cwd)
 * @returns Discovery result (never null)
 */
export async function discoverOrInitWorkspace(
  startPath?: string
): Promise<WorkspaceDiscoveryResult> {
  const start = resolve(startPath ?? process.cwd());
  
  // Try discovery first
  const discovered = await discoverWorkspaceRoot(start);
  if (discovered) {
    return discovered;
  }
  
  // No workspace found - initialize at start path
  const initialized = await ensureWorkspaceInitialized(start);
  
  return {
    root: initialized.root,
    dbPath: initialized.dbPath,
    discovered: false
  };
}
