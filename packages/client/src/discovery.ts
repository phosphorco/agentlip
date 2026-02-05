/**
 * Workspace discovery helpers - re-exported from @agentchat/workspace
 * 
 * Provides workspace root discovery and initialization for AgentChat clients.
 */

export {
  discoverWorkspaceRoot,
  ensureWorkspaceInitialized,
  discoverOrInitWorkspace,
} from "@agentchat/workspace";

export type {
  WorkspaceDiscoveryResult,
  WorkspaceInitResult,
} from "@agentchat/workspace";
