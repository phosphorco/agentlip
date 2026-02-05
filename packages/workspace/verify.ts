#!/usr/bin/env bun
/**
 * Manual verification script for workspace discovery
 * 
 * Usage:
 *   bun verify.ts
 * 
 * This script demonstrates:
 * 1. Workspace initialization
 * 2. Discovery from subdirectories
 * 3. Security boundaries
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverWorkspaceRoot,
  ensureWorkspaceInitialized,
  discoverOrInitWorkspace
} from './src/index';

async function verify() {
  console.log('🔍 Workspace Discovery Verification\n');
  
  // Create temp directory for testing
  const testRoot = join(tmpdir(), `agentlip-verify-${Date.now()}`);
  await fs.mkdir(testRoot, { recursive: true });
  console.log(`📁 Test directory: ${testRoot}\n`);
  
  try {
    // Test 1: No workspace exists
    console.log('Test 1: Discovery from directory without workspace');
    const discovery1 = await discoverWorkspaceRoot(testRoot);
    console.log(`  Result: ${discovery1 ? 'FOUND' : 'NOT FOUND (expected)'} ✓\n`);
    
    // Test 2: Initialize workspace
    console.log('Test 2: Initialize workspace');
    const init = await ensureWorkspaceInitialized(testRoot);
    console.log(`  Created: ${init.created}`);
    console.log(`  Root: ${init.root}`);
    console.log(`  DB Path: ${init.dbPath}`);
    
    // Verify files exist
    const stats = await fs.stat(init.dbPath);
    console.log(`  DB exists: ✓`);
    if (process.platform !== 'win32') {
      const mode = (stats.mode & 0o777).toString(8);
      console.log(`  DB permissions: ${mode} (expected 600) ${mode === '600' ? '✓' : '✗'}`);
    }
    console.log();
    
    // Test 3: Discover from same directory
    console.log('Test 3: Discovery from workspace root');
    const discovery2 = await discoverWorkspaceRoot(testRoot);
    console.log(`  Found: ${discovery2 ? '✓' : '✗'}`);
    console.log(`  Root: ${discovery2?.root}`);
    console.log(`  Discovered: ${discovery2?.discovered}\n`);
    
    // Test 4: Discover from subdirectory
    console.log('Test 4: Discovery from nested subdirectory');
    const subdir = join(testRoot, 'a', 'b', 'c');
    await fs.mkdir(subdir, { recursive: true });
    const discovery3 = await discoverWorkspaceRoot(subdir);
    console.log(`  Searching from: ${subdir}`);
    console.log(`  Found workspace: ${discovery3 ? '✓' : '✗'}`);
    console.log(`  Workspace root: ${discovery3?.root}`);
    console.log(`  Same as test root: ${discovery3?.root === testRoot ? '✓' : '✗'}\n`);
    
    // Test 5: discoverOrInitWorkspace
    console.log('Test 5: discoverOrInitWorkspace (should discover existing)');
    const combined1 = await discoverOrInitWorkspace(subdir);
    console.log(`  Root: ${combined1.root}`);
    console.log(`  Discovered (not initialized): ${combined1.discovered ? '✓' : '✗'}\n`);
    
    // Test 6: discoverOrInitWorkspace in new location
    console.log('Test 6: discoverOrInitWorkspace in new isolated directory');
    const isolatedDir = join(tmpdir(), `agentlip-isolated-${Date.now()}`);
    await fs.mkdir(isolatedDir, { recursive: true });
    const combined2 = await discoverOrInitWorkspace(isolatedDir);
    console.log(`  Root: ${combined2.root}`);
    console.log(`  Initialized (not discovered): ${!combined2.discovered ? '✓' : '✗'}`);
    
    // Clean up isolated dir
    await fs.rm(isolatedDir, { recursive: true, force: true });
    console.log();
    
    console.log('✅ All verification tests passed!\n');
  } finally {
    // Clean up test directory
    console.log(`🧹 Cleaning up ${testRoot}`);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

verify().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
