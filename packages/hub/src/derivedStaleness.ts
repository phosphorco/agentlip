/**
 * Derived job staleness guard for @agentchat/hub
 * 
 * Implements bd-16d.4.7 (staleness guard) per AGENTLIP_PLAN.md §4.6.
 * 
 * Core requirement: before committing derived outputs (enrichments/attachments),
 * verify the message hasn't changed. Use same transaction for check+commit.
 * 
 * Staleness detection:
 * - Discard if content_raw changed (message was edited)
 * - Discard if version changed (handles ABA: edit back to original)
 * - Discard if deleted_at IS NOT NULL (message was tombstoned)
 * - Discard if message no longer exists
 * 
 * Pattern: 
 * 1. Job starts, captures MessageSnapshot (id, content_raw, version)
 * 2. Job processes content (enrichment, extraction, etc.)
 * 3. Job commits via withMessageStalenessGuard:
 *    - Re-read message state in SAME transaction
 *    - Verify snapshot still matches
 *    - If stale: discard, return {ok: false, reason: '...'}
 *    - If fresh: call fn(currentMessage) to commit derived rows/events
 * 
 * Usage Example (plugin or derived job):
 * ```typescript
 * import { getMessageById } from "@agentchat/kernel";
 * import { withMessageStalenessGuard, captureSnapshot } from "@agentchat/hub/src/derivedStaleness";
 * 
 * // 1. Read message and capture snapshot
 * const message = getMessageById(db, messageId);
 * if (!message) return;
 * const snapshot = captureSnapshot(message);
 * 
 * // 2. Process content (may take seconds; message could change during this)
 * const enrichments = await analyzeContent(message.content_raw);
 * 
 * // 3. Commit with staleness protection
 * const result = withMessageStalenessGuard(db, snapshot, (current) => {
 *   // Safe: message verified unchanged in this transaction
 *   const enrichmentId = insertEnrichment(db, {
 *     messageId: current.id,
 *     kind: "sentiment",
 *     data: enrichments,
 *   });
 *   
 *   const eventId = insertEvent({
 *     db,
 *     name: "message.enriched",
 *     scopes: { channel_id: current.channel_id, topic_id: current.topic_id },
 *     entity: { type: "enrichment", id: enrichmentId },
 *     data: { enrichment_id: enrichmentId },
 *   });
 *   
 *   return { enrichmentId, eventId };
 * });
 * 
 * if (!result.ok) {
 *   console.warn(`Discarded stale enrichment: ${result.reason} - ${result.detail}`);
 *   return;
 * }
 * 
 * console.log(`Committed enrichment: ${result.value.enrichmentId}`);
 * ```
 */

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Immutable snapshot of message state captured when derived job starts.
 * 
 * Guards against:
 * - Content changes (edits)
 * - Version changes (ABA problem: edit back to original content)
 * - Tombstone deletes
 */
export interface MessageSnapshot {
  /** Message ID */
  messageId: string;
  
  /** Original content_raw when job started */
  contentRaw: string;
  
  /** Original version when job started */
  version: number;
}

/**
 * Current message state read during staleness verification.
 * 
 * Includes channel_id/topic_id so caller can emit events with correct scopes.
 */
export interface CurrentMessageState {
  id: string;
  topic_id: string;
  channel_id: string;
  sender: string;
  content_raw: string;
  version: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

/**
 * Staleness check result: success case
 */
export interface StalenessCheckSuccess<T> {
  ok: true;
  /** Value returned by fn */
  value: T;
}

/**
 * Staleness check result: failure case
 */
export interface StalenessCheckFailure {
  ok: false;
  /** Why the check failed */
  reason: "STALE_CONTENT" | "STALE_VERSION" | "DELETED" | "MISSING";
  /** Human-readable detail */
  detail: string;
}

export type StalenessCheckResult<T> = StalenessCheckSuccess<T> | StalenessCheckFailure;

// ─────────────────────────────────────────────────────────────────────────────
// Staleness Guard Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute derived output commit with staleness protection.
 * 
 * Pattern (per §4.6):
 * 1. Re-read message state in SAME transaction as derived insert
 * 2. Compare with original snapshot:
 *    - content_raw must match exactly
 *    - version must match exactly (prevents ABA)
 *    - deleted_at must be NULL
 * 3. If stale: discard (rollback transaction), return {ok: false, reason}
 * 4. If fresh: call fn(currentMessage) to commit derived rows/events
 * 
 * Usage:
 * ```ts
 * const snapshot = { messageId, contentRaw, version };
 * const result = await withMessageStalenessGuard(db, snapshot, (current) => {
 *   // Safe to commit: message hasn't changed
 *   const enrichmentId = insertEnrichment(db, {...});
 *   const eventId = insertEvent(db, {...});
 *   return { enrichmentId, eventId };
 * });
 * 
 * if (!result.ok) {
 *   console.log(`Discarded stale output: ${result.reason}`);
 *   return;
 * }
 * ```
 * 
 * @param db - Database instance
 * @param snapshot - Immutable snapshot captured when job started
 * @param fn - Callback to commit derived outputs; receives current message state
 * @returns Success with fn's return value, or failure with reason
 */
export function withMessageStalenessGuard<T>(
  db: Database,
  snapshot: MessageSnapshot,
  fn: (current: CurrentMessageState) => T
): StalenessCheckResult<T> {
  // Validate snapshot
  if (!snapshot.messageId || typeof snapshot.messageId !== "string") {
    throw new Error("Invalid snapshot: messageId must be a non-empty string");
  }
  if (typeof snapshot.contentRaw !== "string") {
    throw new Error("Invalid snapshot: contentRaw must be a string");
  }
  if (typeof snapshot.version !== "number" || snapshot.version < 1) {
    throw new Error("Invalid snapshot: version must be a positive number");
  }

  // Use transaction for atomic check+commit
  const result = db.transaction((): StalenessCheckResult<T> => {
    // Re-read message state
    const current = db
      .query<CurrentMessageState, [string]>(
        `SELECT id, topic_id, channel_id, sender, content_raw, version, 
                created_at, edited_at, deleted_at, deleted_by
         FROM messages
         WHERE id = ?`
      )
      .get(snapshot.messageId);

    // Check 1: message still exists
    if (!current) {
      return {
        ok: false,
        reason: "MISSING",
        detail: `Message ${snapshot.messageId} no longer exists`,
      };
    }

    // Check 2: message not tombstoned
    if (current.deleted_at !== null) {
      return {
        ok: false,
        reason: "DELETED",
        detail: `Message ${snapshot.messageId} was deleted at ${current.deleted_at}`,
      };
    }

    // Check 3: version unchanged (prevents ABA)
    if (current.version !== snapshot.version) {
      return {
        ok: false,
        reason: "STALE_VERSION",
        detail: `Message ${snapshot.messageId} version changed: ${snapshot.version} → ${current.version}`,
      };
    }

    // Check 4: content unchanged
    if (current.content_raw !== snapshot.contentRaw) {
      return {
        ok: false,
        reason: "STALE_CONTENT",
        detail: `Message ${snapshot.messageId} content changed`,
      };
    }

    // All checks passed: message is fresh, safe to commit
    const value = fn(current);
    return { ok: true, value };
  })();

  return result;
}

/**
 * Capture a snapshot of a message for later staleness verification.
 * 
 * Helper to extract only the fields needed for staleness guard.
 * Use when a job starts processing a message.
 * 
 * @param message - Full message object from queries
 * @returns Minimal snapshot for staleness verification
 */
export function captureSnapshot(message: CurrentMessageState): MessageSnapshot {
  return {
    messageId: message.id,
    contentRaw: message.content_raw,
    version: message.version,
  };
}
