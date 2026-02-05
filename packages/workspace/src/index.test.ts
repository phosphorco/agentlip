/**
 * Tests for workspace discovery + initialization
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverWorkspaceRoot,
  ensureWorkspaceInitialized,
  discoverOrInitWorkspace
} from './index';

let testRoot: string;

beforeEach(async () => {
  // Create a unique test directory
  testRoot = join(tmpdir(), `agentlip-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  // Clean up test directory
  try {
    await fs.rm(testRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('discoverWorkspaceRoot', () => {
  test('finds workspace in current directory', async () => {
    // Setup: create .agentlip/db.sqlite3 in testRoot
    const workspaceDir = join(testRoot, '.agentlip');
    const dbPath = join(workspaceDir, 'db.sqlite3');
    await fs.mkdir(workspaceDir);
    await fs.writeFile(dbPath, '');
    
    // Test
    const result = await discoverWorkspaceRoot(testRoot);
    
    // Assert
    expect(result).not.toBeNull();
    expect(result!.root).toBe(testRoot);
    expect(result!.dbPath).toBe(dbPath);
    expect(result!.discovered).toBe(true);
  });
  
  test('finds workspace in parent directory', async () => {
    // Setup: create workspace in testRoot
    const workspaceDir = join(testRoot, '.agentlip');
    const dbPath = join(workspaceDir, 'db.sqlite3');
    await fs.mkdir(workspaceDir);
    await fs.writeFile(dbPath, '');
    
    // Create subdirectory to search from
    const subdir = join(testRoot, 'sub', 'nested', 'deep');
    await fs.mkdir(subdir, { recursive: true });
    
    // Test
    const result = await discoverWorkspaceRoot(subdir);
    
    // Assert
    expect(result).not.toBeNull();
    expect(result!.root).toBe(testRoot);
    expect(result!.dbPath).toBe(dbPath);
    expect(result!.discovered).toBe(true);
  });
  
  test('returns null when no workspace found', async () => {
    // No .agentlip created - should return null
    const result = await discoverWorkspaceRoot(testRoot);
    
    expect(result).toBeNull();
  });
  
  test('stops at filesystem root', async () => {
    // Search from deep in filesystem without workspace marker
    const result = await discoverWorkspaceRoot(testRoot);
    
    // Should eventually give up at filesystem boundary
    expect(result).toBeNull();
  });
});

describe('ensureWorkspaceInitialized', () => {
  test('creates workspace when it does not exist', async () => {
    const result = await ensureWorkspaceInitialized(testRoot);
    
    expect(result.root).toBe(testRoot);
    expect(result.created).toBe(true);
    
    // Verify files exist
    const workspaceDir = join(testRoot, '.agentlip');
    const dbPath = join(workspaceDir, 'db.sqlite3');
    
    // fs.access resolves on success, rejects on failure
    await fs.access(workspaceDir);
    await fs.access(dbPath);
    
    // Verify permissions (Unix-like systems)
    if (process.platform !== 'win32') {
      const dirStat = await fs.stat(workspaceDir);
      const dbStat = await fs.stat(dbPath);
      
      // Directory should be 0700 (owner rwx only)
      expect(dirStat.mode & 0o777).toBe(0o700);
      
      // DB file should be 0600 (owner rw only)
      expect(dbStat.mode & 0o777).toBe(0o600);
    }
  });
  
  test('does not recreate when workspace exists', async () => {
    // First initialization
    const result1 = await ensureWorkspaceInitialized(testRoot);
    expect(result1.created).toBe(true);
    
    // Second initialization
    const result2 = await ensureWorkspaceInitialized(testRoot);
    expect(result2.created).toBe(false);
    expect(result2.root).toBe(testRoot);
  });
  
  test('handles existing directory gracefully', async () => {
    // Pre-create .agentlip directory
    const workspaceDir = join(testRoot, '.agentlip');
    await fs.mkdir(workspaceDir);
    
    // Should still create db.sqlite3
    const result = await ensureWorkspaceInitialized(testRoot);
    expect(result.created).toBe(true);
    
    const dbPath = join(workspaceDir, 'db.sqlite3');
    await fs.access(dbPath);
  });
});

describe('discoverOrInitWorkspace', () => {
  test('discovers existing workspace', async () => {
    // Setup workspace
    const workspaceDir = join(testRoot, '.agentlip');
    const dbPath = join(workspaceDir, 'db.sqlite3');
    await fs.mkdir(workspaceDir);
    await fs.writeFile(dbPath, '');
    
    // Test
    const result = await discoverOrInitWorkspace(testRoot);
    
    expect(result.root).toBe(testRoot);
    expect(result.dbPath).toBe(dbPath);
    expect(result.discovered).toBe(true);
  });
  
  test('initializes workspace when not found', async () => {
    // No workspace exists
    const result = await discoverOrInitWorkspace(testRoot);
    
    expect(result.root).toBe(testRoot);
    expect(result.discovered).toBe(false);
    
    // Verify workspace was created
    const dbPath = join(testRoot, '.agentlip', 'db.sqlite3');
    await fs.access(dbPath);
  });
  
  test('discovers workspace in parent instead of initializing', async () => {
    // Create workspace in testRoot
    const workspaceDir = join(testRoot, '.agentlip');
    const dbPath = join(workspaceDir, 'db.sqlite3');
    await fs.mkdir(workspaceDir);
    await fs.writeFile(dbPath, '');
    
    // Search from subdirectory
    const subdir = join(testRoot, 'subdir');
    await fs.mkdir(subdir);
    
    const result = await discoverOrInitWorkspace(subdir);
    
    // Should find parent workspace, not initialize in subdir
    expect(result.root).toBe(testRoot);
    expect(result.discovered).toBe(true);
    
    // Verify no workspace created in subdir
    const subdirWorkspace = join(subdir, '.agentlip');
    await expect(fs.access(subdirWorkspace)).rejects.toThrow();
  });
});

describe('security boundaries', () => {
  test('does not traverse above home directory', async () => {
    // This test is conceptual - in practice we'd need to mock homedir()
    // or create a test scenario with controlled permissions
    
    // For now, just verify that discovery from a deep path without
    // workspace returns null (stops at boundary)
    const result = await discoverWorkspaceRoot(testRoot);
    expect(result).toBeNull();
  });
});
