/**
 * Event insertion and replay utilities for @agentchat/kernel
 * 
 * Implements bd-16d.2.3 (canonical read queries for events) and bd-16d.2.9 (insertEvent helper)
 */

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EventScopes {
  channel_id?: string | null;
  topic_id?: string | null;
  topic_id2?: string | null;
}

export interface EventEntity {
  type: string;
  id: string;
}

export interface InsertEventOptions {
  db: Database;
  name: string;
  scopes: EventScopes;
  entity: EventEntity;
  data: Record<string, unknown>;
}

export interface EventRow {
  event_id: number;
  ts: string;
  name: string;
  scope_channel_id: string | null;
  scope_topic_id: string | null;
  scope_topic_id2: string | null;
  entity_type: string;
  entity_id: string;
  data_json: string;
}

export interface ParsedEvent {
  event_id: number;
  ts: string;
  name: string;
  scope: EventScopes;
  entity: EventEntity;
  data: Record<string, unknown>;
}

export interface ReplayEventsOptions {
  db: Database;
  afterEventId: number;
  replayUntil: number;
  channelIds?: string[];
  topicIds?: string[];
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Scope Catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scope requirements for known v1 events.
 * Unknown event names are allowed (for extensibility) and skip scope validation.
 * 
 * Implements bd-16d.2.10 (scope correctness) and bd-16d.2.11 (dev assertions).
 */
interface ScopeRequirements {
  channel_id: boolean;  // true if channel_id is required
  topic_id: boolean;    // true if topic_id is required
  topic_id2: boolean;   // true if topic_id2 is required
}

const EVENT_SCOPE_CATALOG: Record<string, ScopeRequirements> = {
  // Channel events: require channel_id only
  "channel.created": { channel_id: true, topic_id: false, topic_id2: false },

  // Topic events: require channel_id + topic_id
  "topic.created": { channel_id: true, topic_id: true, topic_id2: false },
  "topic.renamed": { channel_id: true, topic_id: true, topic_id2: false },
  "topic.attachment_added": { channel_id: true, topic_id: true, topic_id2: false },

  // Message events: require channel_id + topic_id (except moved_topic)
  "message.created": { channel_id: true, topic_id: true, topic_id2: false },
  "message.edited": { channel_id: true, topic_id: true, topic_id2: false },
  "message.deleted": { channel_id: true, topic_id: true, topic_id2: false },
  "message.enriched": { channel_id: true, topic_id: true, topic_id2: false },

  // Message move: requires channel_id + topic_id (old) + topic_id2 (new)
  "message.moved_topic": { channel_id: true, topic_id: true, topic_id2: true },
};

/**
 * Validate event scopes against catalog requirements.
 * 
 * @param name - Event name
 * @param scopes - Event scopes to validate
 * @throws Error if required scopes are missing or invalid for known event types
 */
function validateEventScopes(name: string, scopes: EventScopes): void {
  const requirements = EVENT_SCOPE_CATALOG[name];
  
  // Unknown event types are allowed (skip validation)
  if (!requirements) {
    return;
  }

  // Helper to check if a scope value is valid (present and non-empty)
  const isValidScope = (value: string | null | undefined): value is string => {
    return typeof value === "string" && value.trim().length > 0;
  };

  // Check each required scope
  if (requirements.channel_id && !isValidScope(scopes.channel_id)) {
    throw new Error(
      `Event '${name}' requires scope.channel_id but it is missing or empty`
    );
  }

  if (requirements.topic_id && !isValidScope(scopes.topic_id)) {
    throw new Error(
      `Event '${name}' requires scope.topic_id but it is missing or empty`
    );
  }

  if (requirements.topic_id2 && !isValidScope(scopes.topic_id2)) {
    throw new Error(
      `Event '${name}' requires scope.topic_id2 but it is missing or empty`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// insertEvent Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert a new event into the events table.
 * 
 * Single entry point for all event insertions. Validates inputs and serializes
 * data deterministically. Never mutates existing events (schema triggers prevent).
 * 
 * Enforces scope correctness per EVENT_SCOPE_CATALOG (bd-16d.2.10 + bd-16d.2.11).
 * Unknown event names are allowed and skip scope validation.
 * 
 * @param options - Event insertion options
 * @returns The inserted event_id (monotonically increasing)
 * @throws Error if name is empty, entity fields empty, data is not a plain object, or scopes are invalid
 */
export function insertEvent(options: InsertEventOptions): number {
  const { db, name, scopes, entity, data } = options;
  
  // Validate name
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Event name must be a non-empty string");
  }
  
  // Validate scopes (bd-16d.2.10 + bd-16d.2.11)
  validateEventScopes(name, scopes);
  
  // Validate entity
  if (!entity.type || typeof entity.type !== "string" || entity.type.trim().length === 0) {
    throw new Error("Entity type must be a non-empty string");
  }
  if (!entity.id || typeof entity.id !== "string" || entity.id.trim().length === 0) {
    throw new Error("Entity id must be a non-empty string");
  }
  
  // Validate data is a plain object (not null, array, or primitive)
  if (data === null || data === undefined) {
    throw new Error("Event data must be an object, got null/undefined");
  }
  if (Array.isArray(data)) {
    throw new Error("Event data must be an object, not an array");
  }
  if (typeof data !== "object") {
    throw new Error(`Event data must be an object, got ${typeof data}`);
  }
  
  // Serialize data deterministically (JSON.stringify is deterministic for same input structure)
  const dataJson = JSON.stringify(data);
  
  // Generate timestamp
  const ts = new Date().toISOString();
  
  // Insert event
  const stmt = db.prepare<
    { event_id: number },
    [string, string, string | null, string | null, string | null, string, string, string]
  >(`
    INSERT INTO events (ts, name, scope_channel_id, scope_topic_id, scope_topic_id2, entity_type, entity_id, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING event_id
  `);
  
  const result = stmt.get(
    ts,
    name,
    scopes.channel_id ?? null,
    scopes.topic_id ?? null,
    scopes.topic_id2 ?? null,
    entity.type,
    entity.id,
    dataJson
  );
  
  if (!result) {
    throw new Error("Failed to insert event: no event_id returned");
  }
  
  return result.event_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Replay Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the latest event_id from the events table.
 * 
 * Used for WS handshake to establish replay_until boundary.
 * 
 * @param db - Database instance
 * @returns The maximum event_id, or 0 if no events exist
 */
export function getLatestEventId(db: Database): number {
  const row = db
    .query<{ max_id: number | null }, []>("SELECT MAX(event_id) as max_id FROM events")
    .get();
  
  return row?.max_id ?? 0;
}

/**
 * Parse a raw EventRow into a ParsedEvent with structured scope/entity/data.
 */
function parseEventRow(row: EventRow): ParsedEvent {
  return {
    event_id: row.event_id,
    ts: row.ts,
    name: row.name,
    scope: {
      channel_id: row.scope_channel_id,
      topic_id: row.scope_topic_id,
      topic_id2: row.scope_topic_id2,
    },
    entity: {
      type: row.entity_type,
      id: row.entity_id,
    },
    data: JSON.parse(row.data_json),
  };
}

/**
 * Replay events matching the specified criteria.
 * 
 * Implements the plan's replay query:
 * WHERE event_id > after AND event_id <= replay_until 
 * AND (scopes match) ORDER BY event_id ASC LIMIT ...
 * 
 * Scope matching logic:
 * - If channelIds provided: events where scope_channel_id IN channelIds
 * - If topicIds provided: events where scope_topic_id IN topicIds OR scope_topic_id2 IN topicIds
 * - Both can be combined (OR: matches channel OR topic)
 * - If neither provided: returns all events in range
 * 
 * @param options - Replay options
 * @returns Array of parsed events in ascending event_id order
 */
export function replayEvents(options: ReplayEventsOptions): ParsedEvent[] {
  const { db, afterEventId, replayUntil, channelIds, topicIds, limit = 1000 } = options;
  
  // Validate boundaries
  if (afterEventId < 0) {
    throw new Error("afterEventId must be >= 0");
  }
  if (replayUntil < afterEventId) {
    throw new Error("replayUntil must be >= afterEventId");
  }
  if (limit <= 0) {
    throw new Error("limit must be > 0");
  }
  
  // Build query based on scope filters
  const hasChannelFilter = channelIds && channelIds.length > 0;
  const hasTopicFilter = topicIds && topicIds.length > 0;
  
  let sql = `
    SELECT event_id, ts, name, scope_channel_id, scope_topic_id, scope_topic_id2, 
           entity_type, entity_id, data_json
    FROM events
    WHERE event_id > ? AND event_id <= ?
  `;
  
  const params: (number | string)[] = [afterEventId, replayUntil];
  
  if (hasChannelFilter || hasTopicFilter) {
    const scopeConditions: string[] = [];
    
    if (hasChannelFilter) {
      const placeholders = channelIds.map(() => "?").join(", ");
      scopeConditions.push(`scope_channel_id IN (${placeholders})`);
      params.push(...channelIds);
    }
    
    if (hasTopicFilter) {
      const placeholders = topicIds.map(() => "?").join(", ");
      scopeConditions.push(`(scope_topic_id IN (${placeholders}) OR scope_topic_id2 IN (${placeholders}))`);
      params.push(...topicIds, ...topicIds);
    }
    
    sql += ` AND (${scopeConditions.join(" OR ")})`;
  }
  
  sql += ` ORDER BY event_id ASC LIMIT ?`;
  params.push(limit);
  
  const rows = db.query<EventRow, (number | string)[]>(sql).all(...params);
  
  return rows.map(parseEventRow);
}

/**
 * Get a single event by its ID.
 * 
 * @param db - Database instance
 * @param eventId - Event ID to retrieve
 * @returns Parsed event or null if not found
 */
export function getEventById(db: Database, eventId: number): ParsedEvent | null {
  const row = db
    .query<EventRow, [number]>(`
      SELECT event_id, ts, name, scope_channel_id, scope_topic_id, scope_topic_id2,
             entity_type, entity_id, data_json
      FROM events
      WHERE event_id = ?
    `)
    .get(eventId);
  
  return row ? parseEventRow(row) : null;
}

/**
 * Count events in a range (useful for pagination info).
 * 
 * @param db - Database instance
 * @param afterEventId - Start boundary (exclusive)
 * @param replayUntil - End boundary (inclusive)
 * @returns Number of events in range
 */
export function countEventsInRange(db: Database, afterEventId: number, replayUntil: number): number {
  const row = db
    .query<{ count: number }, [number, number]>(`
      SELECT COUNT(*) as count FROM events
      WHERE event_id > ? AND event_id <= ?
    `)
    .get(afterEventId, replayUntil);
  
  return row?.count ?? 0;
}
