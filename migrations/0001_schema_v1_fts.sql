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

-- Trigger: sync FTS on insert
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, content_raw) VALUES (new.rowid, new.content_raw);
END;

-- Trigger: sync FTS on update
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
BEGIN
  UPDATE messages_fts SET content_raw = new.content_raw WHERE rowid = old.rowid;
END;

-- Trigger: sync FTS on delete
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

COMMIT;
