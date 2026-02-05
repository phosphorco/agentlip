/**
 * Extractor plugin derived pipeline for @agentlip/hub
 * 
 * Implements bd-16d.4.6: execute extractor plugins on new messages,
 * insert topic_attachments with idempotency, emit topic.attachment_added events.
 * 
 * Flow:
 * 1. Read message and capture snapshot (for staleness guard)
 * 2. Run each enabled extractor plugin via runPlugin<Attachment[]>
 * 3. For each attachment:
 *    - Validate shape (kind non-empty string, value_json is object)
 *    - Enforce 16KB size limit on serialized value_json
 *    - Compute dedupe_key (attachment.dedupe_key ?? JSON.stringify(value_json))
 *    - Insert with idempotency (dedupe by topic_id, kind, key, dedupe_key)
 *    - Emit topic.attachment_added only on new inserts (not on dedupe)
 * 4. Wrap in staleness-guarded transaction (discard if message changed/deleted)
 * 
 * Security:
 * - Runs plugins in isolated Workers with timeout (via runPlugin)
 * - Enforces attachment size limits (16KB per attachment metadata)
 * - Validates attachment structure before insertion
 * - Staleness guard prevents committing results from stale content
 */

import type { Database } from "bun:sqlite";
import { validatePluginModulePath, type WorkspaceConfig } from "./config";
import {
  runPlugin,
  type Attachment,
  type ExtractInput,
  type PluginResult,
} from "./pluginRuntime";
import { withMessageStalenessGuard, captureSnapshot } from "./derivedStaleness";
import { getMessageById, findAttachmentByDedupeKey, insertEvent } from "@agentlip/kernel";
import { SIZE_LIMITS } from "./bodyParser";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RunExtractorPluginsForMessageOptions {
  db: Database;
  workspaceRoot: string;
  workspaceConfig: WorkspaceConfig;
  messageId: string;
  /** Optional hook to publish newly-created event IDs (for WS fanout) */
  onEventIds?: (eventIds: number[]) => void;
}

export interface ExtractorRunResult {
  /** Total number of plugins executed */
  pluginsExecuted: number;
  /** Number of attachments inserted (excluding duplicates) */
  attachmentsInserted: number;
  /** Number of attachments skipped (duplicate dedupe_key) */
  attachmentsDeduplicated: number;
  /** Number of plugins that failed */
  pluginsFailed: number;
  /** Event IDs emitted (topic.attachment_added) */
  eventIds: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run extractor plugins for a message and insert attachments with idempotency.
 * 
 * Steps:
 * 1. Read message and capture snapshot
 * 2. Run each enabled extractor plugin
 * 3. Validate and insert attachments with dedupe protection
 * 4. Emit topic.attachment_added events only for new attachments
 * 5. Wrap in staleness-guarded transaction
 * 
 * @param options - Extractor run options
 * @returns Result with stats and event IDs, or null if message is stale/missing
 */
export async function runExtractorPluginsForMessage(
  options: RunExtractorPluginsForMessageOptions
): Promise<ExtractorRunResult | null> {
  const { db, workspaceRoot, workspaceConfig, messageId, onEventIds } = options;

  // Step 1: Read message and capture snapshot
  const message = getMessageById(db, messageId);
  if (!message) {
    return null; // Message doesn't exist
  }

  if (message.deleted_at) {
    return null; // Message is tombstoned, skip processing
  }

  const snapshot = captureSnapshot(message);

  // Step 2: Find enabled extractor plugins
  const extractorPlugins =
    workspaceConfig.plugins?.filter(
      (p) => p.type === "extractor" && p.enabled
    ) ?? [];

  if (extractorPlugins.length === 0) {
    return {
      pluginsExecuted: 0,
      attachmentsInserted: 0,
      attachmentsDeduplicated: 0,
      pluginsFailed: 0,
      eventIds: [],
    };
  }

  // Step 3: Run each extractor plugin
  const allAttachments: Array<{
    attachment: Attachment;
    pluginName: string;
  }> = [];
  let pluginsExecuted = 0;
  let pluginsFailed = 0;

  for (const plugin of extractorPlugins) {
    pluginsExecuted++;

    const input: ExtractInput = {
      message: {
        id: message.id,
        content_raw: message.content_raw,
        sender: message.sender,
        topic_id: message.topic_id,
        channel_id: message.channel_id,
        created_at: message.created_at,
      },
      config: plugin.config ?? {},
    };

    // Resolve plugin module path
    let modulePath: string;
    try {
      if (plugin.module) {
        modulePath = validatePluginModulePath(plugin.module, workspaceRoot);
      } else {
        // Built-in plugins are not implemented in v1 (require explicit module)
        pluginsFailed++;
        console.warn(
          `[extractorDerived] Plugin '${plugin.name}' has no module path, skipping`
        );
        continue;
      }
    } catch (err: any) {
      pluginsFailed++;
      console.warn(
        `[extractorDerived] Plugin '${plugin.name}' module path validation failed: ${err.message}`
      );
      continue;
    }

    // Get timeout from pluginDefaults
    const timeoutMs = workspaceConfig.pluginDefaults?.timeout;

    const result: PluginResult<Attachment[]> = await runPlugin<Attachment[]>({
      type: "extractor",
      modulePath,
      input,
      timeoutMs,
      pluginName: plugin.name,
    });

    if (!result.ok) {
      pluginsFailed++;
      console.warn(
        `[extractorDerived] Plugin ${plugin.name} failed: ${result.error} (code: ${result.code})`
      );
      continue;
    }

    // Collect attachments
    for (const attachment of result.data) {
      allAttachments.push({ attachment, pluginName: plugin.name });
    }
  }

  // Step 4: Insert attachments with staleness guard
  let guardResult: any;
  try {
    guardResult = withMessageStalenessGuard(db, snapshot, (currentMessage) => {
      let attachmentsInserted = 0;
      let attachmentsDeduplicated = 0;
      const eventIds: number[] = [];

      for (const { attachment, pluginName } of allAttachments) {
        // Validate attachment shape
        const validationError = validateAttachment(attachment);
        if (validationError) {
          console.warn(
            `[extractorDerived] Invalid attachment from ${pluginName}: ${validationError}`
          );
          continue;
        }

        // Enforce 16KB size limit
        const serializedValue = JSON.stringify(attachment.value_json);
        if (serializedValue.length > SIZE_LIMITS.ATTACHMENT) {
          console.warn(
            `[extractorDerived] Attachment from ${pluginName} exceeds size limit: ${serializedValue.length} bytes (max ${SIZE_LIMITS.ATTACHMENT})`
          );
          continue;
        }

        // Compute dedupe_key (empty strings are invalid per schema)
        const dedupeKey =
          attachment.dedupe_key && attachment.dedupe_key.trim().length > 0
            ? attachment.dedupe_key
            : serializedValue;

        // Check for existing attachment (idempotency)
        const existing = findAttachmentByDedupeKey(
          db,
          currentMessage.topic_id,
          attachment.kind,
          attachment.key ?? null,
          dedupeKey
        );

        if (existing) {
          attachmentsDeduplicated++;
          continue; // Skip duplicate, no event emitted
        }

        // Insert new attachment
        const attachmentId = generateId("att");
        const now = new Date().toISOString();

        db.run(
          `
          INSERT INTO topic_attachments (
            id, topic_id, kind, key, value_json, dedupe_key, source_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            attachmentId,
            currentMessage.topic_id,
            attachment.kind,
            attachment.key ?? null,
            serializedValue,
            dedupeKey,
            currentMessage.id,
            now,
          ]
        );

        attachmentsInserted++;

        // Emit topic.attachment_added event
        const eventId = insertEvent({
          db,
          name: "topic.attachment_added",
          scopes: {
            channel_id: currentMessage.channel_id,
            topic_id: currentMessage.topic_id,
          },
          entity: {
            type: "attachment",
            id: attachmentId,
          },
          data: {
            attachment: {
              id: attachmentId,
              topic_id: currentMessage.topic_id,
              kind: attachment.kind,
              key: attachment.key ?? null,
              value_json: attachment.value_json,
              dedupe_key: dedupeKey,
              source_message_id: currentMessage.id,
              created_at: now,
            },
          },
        });

        eventIds.push(eventId);
      }

      return {
        pluginsExecuted,
        attachmentsInserted,
        attachmentsDeduplicated,
        pluginsFailed,
        eventIds,
      };
    });
  } catch (err: any) {
    console.warn(
      `[extractorDerived] Failed to commit derived attachments: ${err?.message ?? String(err)}`
    );
    return null;
  }

  // Handle staleness
  if (!guardResult.ok) {
    console.warn(
      `[extractorDerived] Message ${messageId} is stale: ${guardResult.reason} - ${guardResult.detail}`
    );
    return null;
  }

  // Publish event IDs for WS fanout
  if (onEventIds && guardResult.value.eventIds.length > 0) {
    onEventIds(guardResult.value.eventIds);
  }

  return guardResult.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate attachment structure.
 * 
 * Requirements:
 * - kind is non-empty string
 * - value_json is plain object (not array, not null)
 * - key is optional string
 * - dedupe_key is optional string
 * 
 * @param attachment - Attachment to validate
 * @returns Error message if invalid, null if valid
 */
function validateAttachment(attachment: Attachment): string | null {
  if (typeof attachment.kind !== "string" || attachment.kind.trim().length === 0) {
    return "attachment.kind must be a non-empty string";
  }

  if (
    attachment.value_json === null ||
    attachment.value_json === undefined ||
    typeof attachment.value_json !== "object" ||
    Array.isArray(attachment.value_json)
  ) {
    return "attachment.value_json must be a plain object";
  }

  if (
    attachment.key !== undefined &&
    typeof attachment.key !== "string"
  ) {
    return "attachment.key must be a string or undefined";
  }

  if (attachment.dedupe_key !== undefined) {
    if (typeof attachment.dedupe_key !== "string") {
      return "attachment.dedupe_key must be a string or undefined";
    }
    if (attachment.dedupe_key.trim().length === 0) {
      return "attachment.dedupe_key must be a non-empty string if provided";
    }
  }

  return null;
}

/**
 * Generate unique ID with prefix.
 * 
 * Format: {prefix}_{timestamp36}{random8}
 * 
 * @param prefix - ID prefix (e.g. "attach", "enrich")
 * @returns Generated ID
 */
function generateId(prefix: string): string {
  const randomPart = Math.random().toString(36).substring(2, 10);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${randomPart}`;
}
