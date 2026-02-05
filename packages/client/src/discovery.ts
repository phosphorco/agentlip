/**
 * Workspace discovery helpers - re-exported from @agentlip/workspace
 * 
 * Provides workspace root discovery and initialization for Agentlip clients.
 */

export {
  discoverWorkspaceRoot,
  ensureWorkspaceInitialized,
  discoverOrInitWorkspace,
} from "@agentlip/workspace";

export type {
  WorkspaceDiscoveryResult,
  WorkspaceInitResult,
} from "@agentlip/workspace";
