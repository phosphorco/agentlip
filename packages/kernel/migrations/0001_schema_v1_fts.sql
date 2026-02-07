-- Migration: 0001_schema_v1_fts.sql
-- Optional FTS5 virtual table for full-text search on message content
-- Applied opportunistically after schema_v1; non-fatal failure

BEGIN TRANSACTION;

-- FTS5 virtual table for message content search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content_raw,
  content=messages,
  content_rowid=rowid
);

-- Triggers: sync FTS with content table
-- Note: for external content FTS5 tables, updates/deletes must be performed via
-- special "delete" commands rather than UPDATE/DELETE statements.

DROP TRIGGER IF EXISTS messages_fts_insert;
DROP TRIGGER IF EXISTS messages_fts_update;
DROP TRIGGER IF EXISTS messages_fts_delete;

-- Trigger: sync FTS on insert
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, content_raw) VALUES (new.rowid, new.content_raw);
END;

-- Trigger: sync FTS on update
CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_raw) VALUES ('delete', old.rowid, old.content_raw);
  INSERT INTO messages_fts(rowid, content_raw) VALUES (new.rowid, new.content_raw);
END;

-- Trigger: sync FTS on delete
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_raw) VALUES ('delete', old.rowid, old.content_raw);
END;

COMMIT;
