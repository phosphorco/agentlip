/**
 * Example workspace configuration for Agentlip
 * 
 * This file demonstrates the full schema for agentlip.config.ts
 * Place this file at your workspace root (same directory as .agentlip/)
 * 
 * Security notes:
 * - Only loaded from workspace root (never traverses upward)
 * - Plugin module paths are validated to prevent path traversal
 * - This file is code execution - only use in trusted workspaces
 */

import type { WorkspaceConfig } from '@agentlip/hub';

const config: WorkspaceConfig = {
  // Plugin configuration
  plugins: [
    {
      name: 'url-extractor',
      type: 'extractor',
      enabled: true,
      // Optional: use custom plugin module instead of built-in
      // module: './custom-plugins/url-extractor.ts',
      config: {
        allowedDomains: ['example.com', 'github.com'],  // optional allowlist
        timeout: 5000  // ms
      }
    },
    {
      name: 'code-linkifier',
      type: 'linkifier',
      enabled: true,
      module: './custom-plugins/code-links.ts',  // relative to workspace root
      config: {
        repoRoot: process.env.REPO_ROOT
      }
    }
  ],

  // Rate limiting
  rateLimits: {
    perConnection: 100,  // requests per second
    global: 1000
  },

  // Resource limits
  limits: {
    maxMessageSize: 65536,        // 64KB
    maxAttachmentSize: 16384,     // 16KB
    maxWsMessageSize: 262144,     // 256KB
    maxWsConnections: 100,
    maxWsQueueSize: 1000,
    maxEventReplayBatch: 1000
  },

  // Plugin execution defaults
  pluginDefaults: {
    timeout: 5000,       // ms
    memoryLimit: 134217728  // 128MB (if enforceable)
  }
};

export default config;
