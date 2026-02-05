-- Migration: 0001_schema_v1.sql
-- Initial schema for AgentChat Local Hub v1
-- From schema version: 0 (none)
-- To schema version: 1

BEGIN TRANSACTION;

-- Meta table: system metadata and versioning
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

-- Required meta keys
-- - db_id: stable workspace identifier (UUIDv4-ish), generated once at init
-- - schema_version: current schema version
-- - created_at: workspace creation timestamp (ISO8601 UTC)
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO meta (key, value)
  VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO meta (key, value) VALUES (
  'db_id',
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  '4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
);

-- Channels: top-level conversation containers
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(name) > 0 AND length(name) <= 100)
) STRICT;

-- Topics: first-class thread entities within channels
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  UNIQUE(channel_id, title),
  CHECK (length(title) > 0 AND length(title) <= 200)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_topics_channel ON topics(channel_id, updated_at DESC);

-- Messages: content with stable identity, edit/delete via events
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  content_raw TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
  CHECK (length(sender) > 0),
  CHECK (length(content_raw) <= 65536),
  CHECK (version >= 1)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- Trigger: prevent hard deletes on messages (tombstone only)
CREATE TRIGGER IF NOT EXISTS prevent_message_delete
BEFORE DELETE ON messages
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Hard deletes forbidden on messages; use tombstone');
END;

-- Events: immutable append-only event log (integration surface)
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  name TEXT NOT NULL,
  scope_channel_id TEXT,
  scope_topic_id TEXT,
  scope_topic_id2 TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  CHECK (length(name) > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_replay ON events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_scope_channel ON events(scope_channel_id, event_id);
CREATE INDEX IF NOT EXISTS idx_events_scope_topic ON events(scope_topic_id, event_id);
CREATE INDEX IF NOT EXISTS idx_events_scope_topic2 ON events(scope_topic_id2, event_id);

-- Trigger: prevent updates on events (immutable)
CREATE TRIGGER IF NOT EXISTS prevent_event_mutation
BEFORE UPDATE ON events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Events are immutable');
END;

-- Trigger: prevent deletes on events (append-only)
CREATE TRIGGER IF NOT EXISTS prevent_event_delete
BEFORE DELETE ON events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Events are append-only');
END;

-- Topic attachments: structured grounding metadata with idempotency
CREATE TABLE IF NOT EXISTS topic_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT,
  value_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  CHECK (length(kind) > 0),
  CHECK (length(dedupe_key) > 0),
  CHECK (length(value_json) <= 16384)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_attachments_topic ON topic_attachments(topic_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_attachments_dedupe
  ON topic_attachments(topic_id, kind, COALESCE(key, ''), dedupe_key);

-- Enrichments: derived data (recomputable)
CREATE TABLE IF NOT EXISTS enrichments (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  CHECK (span_start >= 0),
  CHECK (span_end > span_start),
  CHECK (length(kind) > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_enrichments_message ON enrichments(message_id, created_at DESC);

COMMIT;
