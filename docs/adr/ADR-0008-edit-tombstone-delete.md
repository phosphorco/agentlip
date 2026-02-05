# ADR-0008: Edit + Tombstone Delete Semantics

**Status:** Accepted  
**Date:** 2026-02-05  
**Context:** bd-16d.2.2 (Edit + tombstone delete semantics documentation and tests)

## Context

AgentChat requires a message mutability model that supports:
1. **Corrections**: Users/agents can fix typos or update content
2. **Content removal**: Users/agents can "delete" inappropriate or erroneous messages
3. **Audit trail**: All changes must be traceable for replay and debugging
4. **Conflict detection**: Concurrent editors should not silently overwrite each other

Traditional chat systems often allow hard deletes, which creates problems:
- Lost history during event replay
- Difficulty debugging agent behavior
- No audit trail for moderation
- Broken references (replies to deleted messages become orphaned)

## Decision

### No Hard Deletes Invariant

Messages are **never physically deleted** from the database. This invariant is enforced at the database level via a trigger:

```sql
CREATE TRIGGER prevent_message_delete
BEFORE DELETE ON messages
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Hard deletes forbidden on messages; use tombstone');
END;
```

Any attempt to execute `DELETE FROM messages WHERE ...` will fail with an error. This ensures:
- Event replay is always complete
- No orphaned references
- Audit trail is preserved
- Data recovery is possible (tombstones can be "undeleted" in future versions)

### Edit Semantics

When editing a message:

1. **Update `content_raw`** to the new content
2. **Set `edited_at`** to current timestamp
3. **Increment `version`** by 1
4. **Emit `message.edited` event** with:
   - `message_id`: the edited message
   - `old_content`: previous content (for audit/undo)
   - `new_content`: updated content
   - `version`: new version number

```typescript
// Edit operation
editMessage({
  db,
  messageId: "msg_123",
  newContentRaw: "Corrected content",
  expectedVersion: 2  // Optional optimistic concurrency
});
```

**Optimistic concurrency**: If `expectedVersion` is provided and doesn't match the current message version, the operation fails with `VersionConflictError` and no state changes occur.

### Tombstone Delete Semantics

When "deleting" a message:

1. **Set `deleted_at`** to current timestamp
2. **Set `deleted_by`** to the actor performing the delete
3. **Replace `content_raw`** with the canonical tombstone string `"[deleted]"`
4. **Set `edited_at`** to current timestamp (content was modified)
5. **Increment `version`** by 1
6. **Emit `message.deleted` event** with:
   - `message_id`: the deleted message
   - `deleted_by`: actor who deleted
   - `version`: new version number

```typescript
// Tombstone delete operation
tombstoneDeleteMessage({
  db,
  messageId: "msg_123",
  actor: "moderator-bot",
  expectedVersion: 2  // Optional
});
```

**Idempotency**: Deleting an already-deleted message is a no-op—returns success with no new event. This allows safe retries without duplicate events.

### Message State After Tombstone

```sql
-- Before tombstone delete
| id      | content_raw      | version | edited_at | deleted_at | deleted_by |
|---------|------------------|---------|-----------|------------|------------|
| msg_123 | "Secret content" | 1       | NULL      | NULL       | NULL       |

-- After tombstone delete
| id      | content_raw | version | edited_at            | deleted_at           | deleted_by   |
|---------|-------------|---------|----------------------|----------------------|--------------|
| msg_123 | "[deleted]" | 2       | 2026-02-05T12:00:00Z | 2026-02-05T12:00:00Z | moderator    |
```

### Version Discipline

The `version` field increments on **any mutation**:
- Edit: version increments
- Tombstone delete: version increments
- Retopic (move to different topic): version increments

This provides a single monotonic counter for conflict detection, regardless of mutation type.

### Event Scopes

Both `message.edited` and `message.deleted` events include proper scopes:
- `scope_channel_id`: Channel containing the message
- `scope_topic_id`: Topic containing the message

This ensures subscribers to the channel OR topic receive the mutation events.

## Privacy and Audit Tradeoffs

### Event Log Immutability

The `message.edited` event payload includes `old_content`—the previous version of the message. This means:

**Preserved in history:**
- Original message content before edits
- All intermediate edit versions (via successive events)
- Original content before tombstone delete

**Privacy implications:**
- "Deleted" content remains accessible in the event log
- Edit history reveals what was changed
- Cannot securely erase sensitive data posted accidentally

**This is by design:**
- Enables complete replay of conversation state
- Supports undo/audit functionality
- Required for debugging agent behavior
- Matches the "event sourcing" architectural model

**NOT supported in v1:**
- GDPR "right to erasure" compliance
- Secure purge of sensitive content
- History rewriting

Future versions may add event log compaction or tombstone-style purging of events, but v1 prioritizes auditability.

### Client Responsibilities

Clients displaying messages should:
1. Check `deleted_at` before rendering content
2. Display tombstoned messages as "[deleted]" or similar placeholder
3. Not expose raw `content_raw` for deleted messages in UI
4. Use `edited_at` to indicate message was modified

## SQL Schema Support

Relevant columns in `messages` table:

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  content_raw TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  edited_at TEXT,           -- Set on edit or tombstone
  deleted_at TEXT,          -- Set on tombstone delete
  deleted_by TEXT,          -- Actor who deleted
  -- ...
  CHECK (version >= 1),
  CHECK (length(content_raw) <= 65536)
);
```

## Test Cases

The following behaviors are verified in tests:

### Hard Delete Prevention (schema.test.ts)

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | `DELETE FROM messages WHERE id = ?` | Trigger aborts with error |
| 2 | Message row still exists after failed DELETE | Row unchanged |

### Edit Semantics (messageMutations.test.ts)

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | Edit updates content_raw, edited_at, version | All fields updated |
| 2 | Edit emits message.edited event | Event with old/new content |
| 3 | Edit with correct expectedVersion succeeds | Version matches, operation completes |
| 4 | Edit with wrong expectedVersion fails | VersionConflictError, no state change |
| 5 | Multiple edits increment version | Version increases each time |
| 6 | Edit non-existent message | MessageNotFoundError |

### Tombstone Delete Semantics (messageMutations.test.ts)

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | Delete sets deleted_at, deleted_by, content="[deleted]", version | All fields set |
| 2 | Delete emits message.deleted event | Event with message_id, actor, version |
| 3 | Delete already-deleted message is idempotent | No new event, success returned |
| 4 | Delete with wrong expectedVersion fails | VersionConflictError, no state change |
| 5 | Delete with empty actor | Error: actor required |

### Transaction Atomicity (messageMutations.test.ts)

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | Edit: state and event committed together | Both present or neither |
| 2 | Delete: state and event committed together | Both present or neither |

## Consequences

### Positive

- **Complete history**: Every message state is recoverable via event replay
- **Safe retries**: Delete idempotency prevents duplicate events on retry
- **Conflict detection**: Version-based optimistic concurrency prevents lost updates
- **Audit trail**: `deleted_by` provides accountability for deletions
- **Simple model**: No "soft delete" vs "hard delete" distinction to manage

### Negative

- **No true erasure**: Sensitive data cannot be securely removed
- **Storage growth**: Deleted messages still consume space
- **Event log growth**: Edit events preserve full content history
- **Privacy risk**: Users may not realize "deleted" content persists

### Mitigations

- Document privacy model clearly to users/agents
- Future: event log compaction for old data
- Future: admin purge command (with explicit tradeoffs documented)
- Client UX: clearly indicate "[deleted]" state without exposing historical content

## References

- AGENTLIP_PLAN.md §0.1.1 (Non-Negotiables: Message mutability)
- AGENTLIP_PLAN.md §0.5 (Kernel Invariants: Message mutability)
- AGENTLIP_PLAN.md §0.6 (ADR #6: Message mutability model)
- AGENTLIP_PLAN.md §0.7 Gate G (Optimistic concurrency correctness)
- AGENTLIP_PLAN.md §0.7 Gate H (Tombstone delete semantics)
- `migrations/0001_schema_v1.sql` - prevent_message_delete trigger
- `packages/kernel/src/messageMutations.ts` - edit/tombstone implementation
- `packages/kernel/src/messageMutations.test.ts` - mutation tests
- `packages/kernel/src/schema.test.ts` - trigger enforcement tests
