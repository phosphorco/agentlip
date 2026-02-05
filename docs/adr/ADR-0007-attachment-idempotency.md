# ADR-0007: Attachment Idempotency (dedupe_key)

**Status:** Accepted  
**Date:** 2026-02-05  
**Context:** bd-16d.3.1 (Attachment idempotency implementation)

## Context

Topic attachments provide structured, referenceable metadata that plugins and agents attach to conversations (citations, code references, extracted entities, etc.). A key operational challenge is **retry safety**:

- Network failures during attachment insertion require retries
- Plugin execution may be re-run due to crashes or re-enrichment
- Multiple agents might independently extract the same structured data
- Without deduplication, retries create duplicate attachments and redundant events

Traditional approaches (client-side request IDs, separate lookup-before-insert) introduce race conditions and require additional API round-trips. We need **server-side idempotency** at the attachment level.

## Decision

### Mandatory dedupe_key Field

Every attachment requires a `dedupe_key` field that uniquely identifies the semantic content of the attachment within its `(topic_id, kind, key)` scope:

```sql
CREATE TABLE topic_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT,
  value_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,  -- REQUIRED: idempotency token
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  -- ...
  CHECK (length(dedupe_key) > 0)
);
```

### Unique Index Enforcement

Duplicate attachments are prevented via a unique index on the natural key:

```sql
CREATE UNIQUE INDEX idx_topic_attachments_dedupe
  ON topic_attachments(topic_id, kind, COALESCE(key, ''), dedupe_key);
```

**Key design decisions:**
- `COALESCE(key, '')` ensures `NULL` keys are treated consistently (required for unique index)
- Index spans `(topic_id, kind, key, dedupe_key)` — the complete semantic identity
- Constraint violations are handled at application level (not exposed as SQLite errors)

### Insert Semantics: Idempotent Upsert

When inserting an attachment via `POST /api/v1/topics/:topic_id/attachments`:

1. **Dedupe check**: Query for existing attachment matching `(topic_id, kind, key, dedupe_key)`
2. **If exists**: Return existing attachment with `event_id: null` (200 OK, no state change)
3. **If new**: Insert attachment + emit `topic.attachment_added` event (201 Created)

Both operations are wrapped in a single transaction for atomicity.

**Implementation** (from `packages/hub/src/apiV1.ts`, lines ~830-870):

```typescript
const result = ctx.db.transaction(() => {
  // Check if attachment already exists (dedupe)
  const existing = ctx.db
    .query<{ id: string }, [string, string, string, string]>(
      `SELECT id FROM topic_attachments
       WHERE topic_id = ? AND kind = ? AND COALESCE(key, '') = ? AND dedupe_key = ?`
    )
    .get(topicId, kind, key ?? "", finalDedupeKey);

  if (existing) {
    // Return existing attachment, no event
    return { attachmentId: existing.id, eventId: null, deduplicated: true };
  }

  // Insert new attachment
  ctx.db.run(
    `INSERT INTO topic_attachments (id, topic_id, kind, key, value_json, dedupe_key, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [attachmentId, topicId, kind, key ?? null, valueJsonStr, finalDedupeKey, source_message_id ?? null, now]
  );

  // Emit event
  const eventId = insertEvent({
    db: ctx.db,
    name: "topic.attachment_added",
    // ...
  });

  return { attachmentId, eventId, deduplicated: false };
})();
```

### Computed dedupe_key (Fallback Strategy)

If the client **does not provide** `dedupe_key`, the hub computes it as:

```typescript
const finalDedupeKey = dedupe_key ?? JSON.stringify(value_json);
```

**Implications:**
- Convenient for simple cases where `value_json` fully defines uniqueness
- **Fragile** for complex cases: key ordering, floating-point precision, nested structures
- Clients performing retries SHOULD explicitly compute and provide `dedupe_key` for stable behavior
- Future enhancement: support stable hashing (e.g., canonical JSON)

**Best practice:** Clients should compute `dedupe_key` explicitly using domain-specific logic:

```typescript
// Example: URL citation
{
  kind: "citation",
  key: "url",
  value_json: { url: "https://example.com", title: "Example" },
  dedupe_key: "url:https://example.com"  // Domain key, ignores title changes
}

// Example: Code reference
{
  kind: "code_ref",
  key: null,
  value_json: { file: "src/main.ts", line: 42 },
  dedupe_key: `file:src/main.ts:42`
}
```

## Event Emission Semantics

### New Attachment (201 Created)

```json
{
  "attachment": { "id": "att_xyz", "topic_id": "...", "kind": "...", "dedupe_key": "..." },
  "event_id": 123
}
```

- `topic.attachment_added` event emitted
- WebSocket subscribers receive the event
- Event log contains full attachment payload

### Deduplicated Attachment (200 OK)

```json
{
  "attachment": { "id": "att_abc", "topic_id": "...", "kind": "...", "dedupe_key": "..." },
  "event_id": null
}
```

- **No event emitted** (state unchanged)
- Existing attachment returned
- Safe to retry infinitely

**Rationale:** Events represent state mutations. Duplicate attachment insertion causes no state change, so no event is warranted. This prevents event log pollution from retries.

## Test Coverage

### Schema Constraint Tests (`packages/kernel/src/schema.test.ts`, lines ~402-452)

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | Insert with same `(topic_id, kind, key, dedupe_key)` | UNIQUE constraint violation |
| 2 | Insert with different `dedupe_key` | Success (distinct attachment) |
| 3 | Insert with `NULL` key vs. empty string | Treated as distinct (via `COALESCE`) |

### API Idempotency Tests (`packages/hub/src/apiV1.test.ts`, lines ~734-760)

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | Create attachment with explicit `dedupe_key` | 201 Created, event emitted |
| 2 | Retry same attachment (same `dedupe_key`) | 200 OK, `event_id: null`, existing attachment returned |
| 3 | Create attachment without `dedupe_key` | Computed from `JSON.stringify(value_json)` |

### Query Tests (`packages/kernel/src/queries.test.ts`)

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | `findAttachmentByDedupeKey()` returns existing | Correct attachment matched |
| 2 | List attachments after dedupe | Only unique attachments visible |

## Consequences

### Positive

- **Retry safety**: Clients can safely retry attachment insertion on network failures
- **Plugin idempotency**: Plugins can re-run extraction without creating duplicates
- **Event log hygiene**: No duplicate `topic.attachment_added` events from retries
- **Race-free**: Unique index handles concurrent duplicate insertions atomically

### Negative

- **Client complexity**: Optimal use requires clients to compute stable `dedupe_key` values
- **JSON.stringify brittleness**: Default fallback sensitive to key ordering, precision, etc.
- **No "update" semantics**: Dedupe returns existing; cannot update attachment via retry
- **Schema coupling**: `dedupe_key` is required (cannot be omitted)

### Mitigations

- Document best practices for computing domain-specific `dedupe_key` values
- Future: canonical JSON serialization for stable fallback computation
- Future: explicit "update if exists" API (separate from idempotent insert)

### Alternative Designs Considered

**1. Client-provided request IDs (like message creation):**
- Requires separate deduplication table or column
- More flexible but adds complexity
- Chosen for v1 simplicity: `dedupe_key` is semantic

**2. No deduplication:**
- Simple but unsafe for retries
- Event log pollution
- Rejected: idempotency is critical for plugin reliability

**3. Unique constraint without `key` in index:**
- Simpler index but loses `key`-scoped deduplication
- Example: different `key` values with same `dedupe_key` would conflict
- Rejected: too restrictive

## References

- AGENTLIP_PLAN.md §0.1.1 (Non-Negotiables: Idempotency guarantees A)
- AGENTLIP_PLAN.md §0.14 (ADR-0007: Topic attachment idempotency)
- `migrations/0001_schema_v1.sql` - `topic_attachments` table + unique index
- `packages/hub/src/apiV1.ts` - `handleCreateAttachment()` implementation (lines ~772-910)
- `packages/kernel/src/queries.ts` - `findAttachmentByDedupeKey()` helper
- `packages/hub/src/apiV1.test.ts` - attachment idempotency tests (lines ~734-760)
- `packages/kernel/src/schema.test.ts` - unique constraint validation (lines ~402-452)
