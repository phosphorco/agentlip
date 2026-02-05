/**
 * Linkifier plugin derived pipeline for @agentchat/hub
 * 
 * Implements bd-16d.4.5 (linkifier plugins → enrichments + message.enriched).
 * 
 * Core workflow:
 * 1. Read message state and capture snapshot
 * 2. Execute enabled linkifier plugins via runPlugin()
 * 3. Commit results with staleness guard:
 *    - Insert enrichment rows into DB
 *    - Emit message.enriched events
 *    - Guarded by derived staleness helper (bd-16d.4.7)
 * 
 * Safety:
 * - Staleness protection prevents committing results from stale content
 * - Plugins are isolated in Workers with timeout enforcement
 * - Circuit breaker skips repeatedly failing plugins
 * - Plugin failures do not abort pipeline (continue to next plugin)
 * 
 * Usage Example:
 * ```typescript
 * import { runLinkifierPluginsForMessage } from "@agentchat/hub/src/linkifierDerived";
 * 
 * const eventIds = await runLinkifierPluginsForMessage({
 *   db,
 *   workspaceRoot: "/path/to/workspace",
 *   workspaceConfig: config,
 *   messageId: "msg_123",
 * });
 * 
 * console.log(`Emitted ${eventIds.length} message.enriched events`);
 * ```
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { WorkspaceConfig } from "./config";
import { validatePluginModulePath } from "./config";
import { runPlugin } from "./pluginRuntime";
import type { Enrichment, MessageInput } from "./pluginRuntime";
import { withMessageStalenessGuard, captureSnapshot } from "./derivedStaleness";
import type { CurrentMessageState } from "./derivedStaleness";
import { insertEvent } from "@agentchat/kernel";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RunLinkifierPluginsOptions {
  /** Database instance */
  db: Database;
  
  /** Workspace root directory (absolute) */
  workspaceRoot: string;
  
  /** Workspace configuration (plugins, defaults, etc.) */
  workspaceConfig: WorkspaceConfig;
  
  /** Message ID to process */
  messageId: string;
  
  /**
   * Callback to receive event IDs as they are emitted.
   * Useful for WS broadcast or testing.
   */
  onEventIds?: (eventIds: number[]) => void;
}

/**
 * Result of plugin execution for a single plugin
 */
interface PluginExecutionResult {
  /** Plugin name */
  pluginName: string;
  
  /** Success flag */
  ok: boolean;
  
  /** Event IDs emitted (if successful) */
  eventIds?: number[];
  
  /** Error message (if failed) */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute linkifier plugins for a message and commit enrichments with staleness protection.
 * 
 * Algorithm:
 * 1. Read message row from DB
 * 2. Capture message snapshot (id, content_raw, version)
 * 3. For each enabled linkifier plugin:
 *    a. Resolve plugin module path (relative to workspaceRoot)
 *    b. Execute plugin via runPlugin() (Worker-isolated, timeout enforced)
 *    c. If plugin succeeds and returns enrichments:
 *       - Commit in transaction with staleness guard:
 *         - Verify message unchanged (content_raw, version, not deleted)
 *         - Insert enrichment rows
 *         - Emit message.enriched event
 *    d. If plugin fails: log and continue (do not abort pipeline)
 * 4. Return all emitted event IDs
 * 
 * Staleness protection:
 * - If message changed during plugin execution, discard results (no DB commit, no event)
 * - See bd-16d.4.7 (derivedStaleness.ts) for staleness guard implementation
 * 
 * @param options - Pipeline options
 * @returns Array of event IDs emitted across all plugins
 */
export async function runLinkifierPluginsForMessage(
  options: RunLinkifierPluginsOptions
): Promise<number[]> {
  const { db, workspaceRoot, workspaceConfig, messageId, onEventIds } = options;
  
  // 1. Read message and capture snapshot
  const message = getMessageById(db, messageId);
  if (!message) {
    console.warn(`[linkifierDerived] Message ${messageId} not found, skipping`);
    return [];
  }
  
  // Skip deleted messages
  if (message.deleted_at !== null) {
    console.log(`[linkifierDerived] Message ${messageId} is deleted, skipping`);
    return [];
  }
  
  const snapshot = captureSnapshot(message);
  
  // 2. Get enabled linkifier plugins
  const linkifierPlugins = (workspaceConfig.plugins ?? []).filter(
    (p) => p.type === "linkifier" && p.enabled
  );
  
  if (linkifierPlugins.length === 0) {
    console.log(`[linkifierDerived] No enabled linkifier plugins, skipping`);
    return [];
  }
  
  console.log(
    `[linkifierDerived] Processing message ${messageId} with ${linkifierPlugins.length} linkifier plugins`
  );
  
  // 3. Execute plugins and collect results
  const results: PluginExecutionResult[] = [];
  const allEventIds: number[] = [];
  
  for (const plugin of linkifierPlugins) {
    const result = await executePluginForMessage({
      db,
      workspaceRoot,
      workspaceConfig,
      message,
      snapshot,
      plugin,
    });
    
    results.push(result);
    
    if (result.ok && result.eventIds) {
      allEventIds.push(...result.eventIds);
    }
  }
  
  // 4. Notify callback if provided
  if (onEventIds && allEventIds.length > 0) {
    onEventIds(allEventIds);
  }
  
  // Log summary
  const successCount = results.filter((r) => r.ok).length;
  const failureCount = results.filter((r) => !r.ok).length;
  
  console.log(
    `[linkifierDerived] Completed: ${successCount} success, ${failureCount} failed, ${allEventIds.length} events emitted`
  );
  
  return allEventIds;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Execution
// ─────────────────────────────────────────────────────────────────────────────

interface ExecutePluginOptions {
  db: Database;
  workspaceRoot: string;
  workspaceConfig: WorkspaceConfig;
  message: CurrentMessageState;
  snapshot: ReturnType<typeof captureSnapshot>;
  plugin: NonNullable<WorkspaceConfig["plugins"]>[number];
}

/**
 * Execute a single linkifier plugin and commit results with staleness guard.
 */
async function executePluginForMessage(
  options: ExecutePluginOptions
): Promise<PluginExecutionResult> {
  const { db, workspaceRoot, workspaceConfig, message, snapshot, plugin } = options;
  
  // Resolve plugin module path
  let modulePath: string;
  try {
    if (plugin.module) {
      modulePath = validatePluginModulePath(plugin.module, workspaceRoot);
    } else {
      // Built-in plugin - skip for now (v1 requires explicit module path)
      console.warn(
        `[linkifierDerived] Plugin '${plugin.name}' has no module path, skipping`
      );
      return {
        pluginName: plugin.name,
        ok: false,
        error: "No module path specified (built-in plugins not implemented)",
      };
    }
  } catch (err: any) {
    console.error(
      `[linkifierDerived] Plugin '${plugin.name}' module path validation failed: ${err.message}`
    );
    return {
      pluginName: plugin.name,
      ok: false,
      error: `Module path validation failed: ${err.message}`,
    };
  }
  
  // Execute plugin
  const pluginInput: MessageInput = {
    id: message.id,
    content_raw: message.content_raw,
    sender: message.sender,
    topic_id: message.topic_id,
    channel_id: message.channel_id,
    created_at: message.created_at,
  };
  
  const timeoutMs = workspaceConfig.pluginDefaults?.timeout ?? 5000;
  
  console.log(`[linkifierDerived] Executing plugin '${plugin.name}' for message ${message.id}`);
  
  const pluginResult = await runPlugin<Enrichment[]>({
    type: "linkifier",
    modulePath,
    input: {
      message: pluginInput,
      config: plugin.config ?? {},
    },
    timeoutMs,
    pluginName: plugin.name,
  });
  
  // Handle plugin failure
  if (!pluginResult.ok) {
    console.warn(
      `[linkifierDerived] Plugin '${plugin.name}' failed: ${pluginResult.error} (${pluginResult.code})`
    );
    return {
      pluginName: plugin.name,
      ok: false,
      error: `${pluginResult.code}: ${pluginResult.error}`,
    };
  }
  
  // Handle empty output (success, but nothing to commit)
  if (!pluginResult.data || pluginResult.data.length === 0) {
    console.log(`[linkifierDerived] Plugin '${plugin.name}' returned no enrichments`);
    return {
      pluginName: plugin.name,
      ok: true,
      eventIds: [],
    };
  }
  
  console.log(
    `[linkifierDerived] Plugin '${plugin.name}' returned ${pluginResult.data.length} enrichments`
  );
  
  // Commit with staleness guard
  let guardResult: any;
  try {
    guardResult = withMessageStalenessGuard(db, snapshot, (current) => {
      const enrichmentIds: string[] = [];
      const eventIds: number[] = [];

      // Insert enrichment rows
      for (const enrichment of pluginResult.data) {
        const enrichmentId = insertEnrichment(db, {
          messageId: current.id,
          kind: enrichment.kind,
          spanStart: enrichment.span.start,
          spanEnd: enrichment.span.end,
          dataJson: enrichment.data,
        });

        enrichmentIds.push(enrichmentId);
      }

      // Emit single message.enriched event for all enrichments from this plugin
      const eventId = insertEvent({
        db,
        name: "message.enriched",
        scopes: {
          channel_id: current.channel_id,
          topic_id: current.topic_id,
        },
        entity: {
          type: "message",
          id: current.id,
        },
        data: {
          message_id: current.id,
          plugin_name: plugin.name,
          enrichments: pluginResult.data,
          enrichment_ids: enrichmentIds,
        },
      });

      eventIds.push(eventId);

      return { enrichmentIds, eventIds };
    });
  } catch (err: any) {
    console.warn(
      `[linkifierDerived] Failed to commit enrichments from plugin '${plugin.name}': ${err?.message ?? String(err)}`
    );
    return {
      pluginName: plugin.name,
      ok: false,
      error: `COMMIT_FAILED: ${err?.message ?? String(err)}`,
    };
  }
  
  // Handle staleness
  if (!guardResult.ok) {
    console.warn(
      `[linkifierDerived] Discarded stale enrichments from plugin '${plugin.name}': ${guardResult.reason} - ${guardResult.detail}`
    );
    return {
      pluginName: plugin.name,
      ok: false,
      error: `Staleness detected: ${guardResult.reason}`,
    };
  }
  
  console.log(
    `[linkifierDerived] Plugin '${plugin.name}' committed ${guardResult.value.enrichmentIds.length} enrichments, emitted event ${guardResult.value.eventIds[0]}`
  );
  
  return {
    pluginName: plugin.name,
    ok: true,
    eventIds: guardResult.value.eventIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a message by ID, returning all fields needed for plugin input + staleness verification.
 */
function getMessageById(db: Database, messageId: string): CurrentMessageState | null {
  const row = db
    .query<CurrentMessageState, [string]>(`
      SELECT id, topic_id, channel_id, sender, content_raw, version, 
             created_at, edited_at, deleted_at, deleted_by
      FROM messages
      WHERE id = ?
    `)
    .get(messageId);
  
  return row ?? null;
}

/**
 * Insert an enrichment row into the database.
 */
function insertEnrichment(
  db: Database,
  options: {
    messageId: string;
    kind: string;
    spanStart: number;
    spanEnd: number;
    dataJson: Record<string, unknown>;
  }
): string {
  const { messageId, kind, spanStart, spanEnd, dataJson } = options;
  
  const enrichmentId = randomUUID();
  const createdAt = new Date().toISOString();
  const dataJsonStr = JSON.stringify(dataJson);
  
  db.prepare(`
    INSERT INTO enrichments (id, message_id, kind, span_start, span_end, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(enrichmentId, messageId, kind, spanStart, spanEnd, dataJsonStr, createdAt);
  
  return enrichmentId;
}
