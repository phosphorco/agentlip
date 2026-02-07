# Agentlip Protocol Documentation

## Overview

Agentlip uses a hybrid HTTP REST + WebSocket protocol for real-time communication.

- **Protocol Version**: `v1` (declared in `packages/protocol/src/index.ts`)
- **Transport**: HTTP for mutations and queries, WebSocket for live event streaming
- **Authentication**: Bearer token for all authenticated endpoints
- **Data Format**: JSON for all payloads

## HTTP API Reference

All endpoints are under `/api/v1/`. Implementation: `packages/hub/src/apiV1.ts`.

### Health Check

**GET /health**

No authentication required.

**Response** (200):
```json
{
  "status": "ok",
  "instance_id": "abc123...",
  "db_id": "def456...",
  "schema_version": 1,
  "protocol_version": "v1",
  "pid": 12345,
  "uptime_seconds": 3600
}
```

### Channels

#### List Channels

**GET /api/v1/channels**

No authentication required.

**Response** (200):
```json
{
  "channels": [
    {
      "id": "ch_...",
      "name": "general",
      "description": "General discussion",
      "created_at": "2025-02-05T21:40:00.000Z"
    }
  ]
}
```

#### Create Channel

**POST /api/v1/channels**

Requires authentication (Bearer token).

**Request Body**:
```json
{
  "name": "general",
  "description": "General discussion"  // optional
}
```

**Response** (201):
```json
{
  "channel": {
    "id": "ch_...",
    "name": "general",
    "description": "General discussion",
    "created_at": "2025-02-05T21:40:00.000Z"
  },
  "event_id": 1
}
```

**Validation**:
- `name` required, 1-100 characters
- `description` optional
- Unique name constraint (returns 400 on duplicate)

### Topics

#### List Topics in Channel

**GET /api/v1/channels/:channel_id/topics**

No authentication required.

**Query Parameters**:
- `limit` (optional, default 50): max results to return
- `offset` (optional, default 0): pagination offset

**Response** (200):
```json
{
  "topics": [
    {
      "id": "topic_...",
      "channel_id": "ch_...",
      "title": "Feature Discussion",
      "created_at": "2025-02-05T21:40:00.000Z",
      "updated_at": "2025-02-05T21:45:00.000Z"
    }
  ],
  "has_more": false
}
```

#### Create Topic

**POST /api/v1/topics**

Requires authentication (Bearer token).

**Request Body**:
```json
{
  "channel_id": "ch_...",
  "title": "Feature Discussion"
}
```

**Response** (201):
```json
{
  "topic": {
    "id": "topic_...",
    "channel_id": "ch_...",
    "title": "Feature Discussion",
    "created_at": "2025-02-05T21:40:00.000Z",
    "updated_at": "2025-02-05T21:40:00.000Z"
  },
  "event_id": 2
}
```

**Validation**:
- `channel_id` required, must exist
- `title` required, 1-200 characters
- Unique title per channel (returns 400 on duplicate)

#### Update Topic

**PATCH /api/v1/topics/:topic_id**

Requires authentication (Bearer token).

**Request Body**:
```json
{
  "title": "New Title"
}
```

**Response** (200):
```json
{
  "topic": {
    "id": "topic_...",
    "channel_id": "ch_...",
    "title": "New Title",
    "created_at": "2025-02-05T21:40:00.000Z",
    "updated_at": "2025-02-05T21:50:00.000Z"
  },
  "event_id": 3
}
```

### Messages

#### List Messages

**GET /api/v1/messages**

No authentication required.

**Query Parameters**:
- `channel_id` (optional): filter by channel
- `topic_id` (optional): filter by topic
- `limit` (optional, default 50): max results
- `before_id` (optional): messages before this ID (pagination)
- `after_id` (optional): messages after this ID (pagination)

At least one of `channel_id` or `topic_id` is required.

**Response** (200):
```json
{
  "messages": [
    {
      "id": "msg_...",
      "topic_id": "topic_...",
      "channel_id": "ch_...",
      "sender": "user@example.com",
      "content_raw": "Hello world",
      "version": 1,
      "created_at": "2025-02-05T21:40:00.000Z",
      "edited_at": null,
      "deleted_at": null,
      "deleted_by": null
    }
  ],
  "has_more": false
}
```

#### Create Message

**POST /api/v1/messages**

Requires authentication (Bearer token).

**Request Body**:
```json
{
  "topic_id": "topic_...",
  "sender": "user@example.com",
  "content_raw": "Hello world"
}
```

**Response** (201):
```json
{
  "message": {
    "id": "msg_...",
    "topic_id": "topic_...",
    "channel_id": "ch_...",
    "sender": "user@example.com",
    "content_raw": "Hello world",
    "version": 1,
    "created_at": "2025-02-05T21:40:00.000Z",
    "edited_at": null,
    "deleted_at": null,
    "deleted_by": null
  },
  "event_id": 4
}
```

**Validation**:
- `topic_id` required, must exist
- `sender` required, non-empty
- `content_raw` required, max 64KB

**URL Extraction**: If URL extraction is enabled, HTTP(S) URLs in `content_raw` are automatically extracted and added as topic attachments (deduplicated by URL).

#### Update Message

**PATCH /api/v1/messages/:message_id**

Requires authentication (Bearer token).

Supports three operations: `edit`, `delete`, `move_topic`.

##### Edit Operation

**Request Body**:
```json
{
  "op": "edit",
  "content_raw": "Updated content",
  "expected_version": 1  // optional, for optimistic locking
}
```

**Response** (200):
```json
{
  "message": {
    "id": "msg_...",
    "topic_id": "topic_...",
    "channel_id": "ch_...",
    "sender": "user@example.com",
    "content_raw": "Updated content",
    "version": 2,
    "created_at": "2025-02-05T21:40:00.000Z",
    "edited_at": "2025-02-05T21:50:00.000Z",
    "deleted_at": null,
    "deleted_by": null
  },
  "event_id": 5
}
```

##### Delete Operation

**Request Body**:
```json
{
  "op": "delete",
  "actor": "user@example.com",
  "expected_version": 2  // optional
}
```

**Response** (200):
```json
{
  "message": {
    "id": "msg_...",
    "topic_id": "topic_...",
    "channel_id": "ch_...",
    "sender": "user@example.com",
    "content_raw": "[deleted]",
    "version": 3,
    "created_at": "2025-02-05T21:40:00.000Z",
    "edited_at": "2025-02-05T21:55:00.000Z",
    "deleted_at": "2025-02-05T21:55:00.000Z",
    "deleted_by": "user@example.com"
  },
  "event_id": 6
}
```

Delete is idempotent: if already deleted, returns success with `event_id: null`.

##### Move Topic Operation

**Request Body**:
```json
{
  "op": "move_topic",
  "to_topic_id": "topic_...",
  "mode": "one",  // "one", "later", or "all"
  "expected_version": 3  // optional (only checked for anchor message)
}
```

**Modes**:
- `one`: Move only this message
- `later`: Move this message and all subsequent messages (by ID order)
- `all`: Move all messages in the topic

**Response** (200):
```json
{
  "affected_count": 1,
  "event_ids": [7]
}
```

**Validation**:
- Target topic must be in same channel (returns 400 `CROSS_CHANNEL_MOVE` error on violation)
- Idempotent: if message(s) already in target topic, returns success with `affected_count: 0`

### Attachments

#### List Topic Attachments

**GET /api/v1/topics/:topic_id/attachments**

No authentication required.

**Query Parameters**:
- `kind` (optional): filter by attachment kind

**Response** (200):
```json
{
  "attachments": [
    {
      "id": "att_...",
      "topic_id": "topic_...",
      "kind": "url",
      "key": null,
      "value_json": {
        "url": "https://example.com",
        "title": "Example",
        "description": "An example link"
      },
      "dedupe_key": "https://example.com",
      "source_message_id": "msg_...",
      "created_at": "2025-02-05T21:40:00.000Z"
    }
  ]
}
```

#### Create Attachment

**POST /api/v1/topics/:topic_id/attachments**

Requires authentication (Bearer token).

**Request Body**:
```json
{
  "kind": "url",
  "key": null,  // optional
  "value_json": {
    "url": "https://example.com",
    "title": "Example",
    "description": "An example link"
  },
  "dedupe_key": "https://example.com",  // optional, defaults to JSON.stringify(value_json)
  "source_message_id": "msg_..."  // optional
}
```

**Response** (201):
```json
{
  "attachment": {
    "id": "att_...",
    "topic_id": "topic_...",
    "kind": "url",
    "key": null,
    "value_json": {
      "url": "https://example.com",
      "title": "Example",
      "description": "An example link"
    },
    "dedupe_key": "https://example.com",
    "source_message_id": "msg_...",
    "created_at": "2025-02-05T21:40:00.000Z"
  },
  "event_id": 8
}
```

**Validation**:
- `kind` required, non-empty
- `value_json` required, max 16KB
- For `kind: "url"` or `kind: "link"`:
  - `value_json.url` required, max 2048 chars, must be valid HTTP(S) URL
  - `value_json.title` optional, max 500 chars
  - `value_json.description` optional, max 500 chars
  - XSS protection: rejects HTML tags, javascript: protocol, control characters

**Deduplication**: If attachment with same `(topic_id, kind, key, dedupe_key)` exists, returns existing attachment with `event_id: null` (idempotent).

### Events

#### List Events

**GET /api/v1/events**

No authentication required.

**Query Parameters**:
- `after` (optional, default 0): return events with `event_id > after`
- `tail` (optional): return the most recent N events (mutually exclusive with `after`)
  - Server clamps `tail` to 1..1000
  - Returns events in ascending `event_id` order (oldest to newest of the tail)
- `limit` (optional, default 100, max 1000): max results (only applies when using `after`)
- `channel_id` (optional, repeatable): filter by channel scope (OR semantics)
  - IDs must match `/^[a-zA-Z0-9_-]+$/`
  - Malformed IDs return 400 `INVALID_INPUT`
  - Non-existent IDs return empty results (200)
- `topic_id` (optional, repeatable): filter by topic scope (OR semantics)
  - Checks both `scope.topic_id` and `scope.topic_id2`
  - IDs must match `/^[a-zA-Z0-9_-]+$/`
  - Malformed IDs return 400 `INVALID_INPUT`
  - Non-existent IDs return empty results (200)

**Response** (200):
```json
{
  "replay_until": 5,
  "events": [
    {
      "event_id": 1,
      "ts": "2025-02-05T21:40:00.000Z",
      "name": "channel.created",
      "data_json": {
        "channel": {
          "id": "ch_...",
          "name": "general",
          "description": "General discussion",
          "created_at": "2025-02-05T21:40:00.000Z"
        }
      },
      "scope": {
        "channel_id": "ch_...",
        "topic_id": null,
        "topic_id2": null
      },
      "entity": {
        "type": "channel",
        "id": "ch_..."
      }
    }
  ]
}
```

**Additive Fields (Gate A)**:
- `replay_until`: Current maximum `event_id` (use for WS handshake)
- `scope`: Event scope routing metadata
  - `channel_id`: Channel scope (nullable)
  - `topic_id`: Primary topic scope (nullable)
  - `topic_id2`: Secondary topic scope (nullable, used for `message.moved_topic`)
- `entity`: Event entity reference
  - `type`: Entity type (e.g., `"channel"`, `"topic"`, `"message"`, `"attachment"`)
  - `id`: Entity ID

**Error Codes**:
- `400 INVALID_INPUT`: `after` and `tail` both provided, or malformed ID parameters

## WebSocket Protocol

Implementation: `packages/hub/src/wsEndpoint.ts`, `packages/client/src/types.ts`.

### Connection URL

```
ws://localhost:3000/ws?token=<auth_token>
```

Token authentication via query parameter (validated during upgrade).

### Handshake Flow

1. **Client sends `hello` message**:

```json
{
  "type": "hello",
  "after_event_id": 0,
  "subscriptions": {
    "channels": ["ch_..."],
    "topics": ["topic_..."]
  }
}
```

**Fields**:
- `after_event_id` (required, number ≥ 0): last event ID client has seen
- `subscriptions` (optional, object):
  - `channels` (optional, string[]): channel IDs to subscribe to
  - `topics` (optional, string[]): topic IDs to subscribe to

**Subscription Semantics**:
- **Omitted `subscriptions`**: wildcard mode, subscribe to ALL events (channels=null, topics=null in implementation)
- **Provided but empty arrays**: subscribe to NONE (e.g., `{"channels": [], "topics": []}`)
- **Non-empty arrays**: filter to specified IDs (events match if `scope.channel_id` in channels OR `scope.topic_id`/`scope.topic_id2` in topics)

2. **Server responds with `hello_ok`**:

```json
{
  "type": "hello_ok",
  "replay_until": 42,
  "instance_id": "abc123..."
}
```

**Fields**:
- `replay_until` (number): snapshot of latest event ID at handshake time
- `instance_id` (string): server instance identifier

3. **Server replays events**: Events in range `(after_event_id, replay_until]` matching subscriptions are sent immediately as `event` envelopes.

4. **Live event streaming**: Events with `event_id > replay_until` are sent as they occur.

### Replay Boundary Semantics

The `replay_until` value establishes a clear boundary:

- **Replay events**: `event_id` in `(after_event_id, replay_until]` — replayed immediately after handshake (up to 1000 events, filtered by subscriptions)
- **Live events**: `event_id > replay_until` — streamed as they occur

This ensures:
- No duplicate events (replay and live are disjoint ranges)
- No missing events (boundary is atomic snapshot)
- Client can resume from any point using last seen `event_id`

### Event Envelope Format

All events sent to clients use this envelope:

```json
{
  "type": "event",
  "event_id": 1,
  "ts": "2025-02-05T21:40:00.000Z",
  "name": "channel.created",
  "scope": {
    "channel_id": "ch_...",
    "topic_id": null,
    "topic_id2": null
  },
  "data": {
    "channel": {
      "id": "ch_...",
      "name": "general",
      "description": "General discussion",
      "created_at": "2025-02-05T21:40:00.000Z"
    }
  }
}
```

### Subscription Filtering

Events are filtered based on `scope` fields:

- **Channel filter**: event matches if `scope.channel_id` in subscribed channels
- **Topic filter**: event matches if `scope.topic_id` OR `scope.topic_id2` in subscribed topics
- **Combined**: event matches if it passes channel filter OR topic filter

For `message.moved_topic` events: `scope.topic_id` = old topic, `scope.topic_id2` = new topic (both are checked against topic subscriptions).

### Backpressure Handling

Server monitors backpressure on each send:

- If `ws.send()` returns `-1` or `0`: client buffer full (≥16 messages pending in Bun implementation)
- Server immediately closes connection with code `1008` (policy violation) and reason `"backpressure"`
- Client should reconnect with last seen `event_id` to resume

### Close Codes

- **1000** (normal closure): clean disconnect
- **1001** (going away): server shutting down
- **1003** (unsupported data): invalid JSON or protocol error
- **1008** (policy violation): backpressure threshold exceeded
- **1011** (internal error): unexpected server error
- **4401** (custom): authentication failed (returned during upgrade, before WS handshake completes)

### Size Limits

- **WS message size**: 256KB max per message (`SIZE_LIMITS.WS_MESSAGE` in `packages/hub/src/bodyParser.ts:17`)
- Messages exceeding limit are rejected with close code `1009`

## Event Types

Implementation: `packages/kernel/src/events.ts`, `packages/client/src/events.ts`, `packages/kernel/src/messageMutations.ts`.

All events follow this structure:
- `event_id`: monotonically increasing integer (primary key)
- `ts`: ISO 8601 timestamp
- `name`: event type string
- `scope`: routing metadata (channel_id, topic_id, topic_id2)
- `data`: event-specific payload

### channel.created

**Emitted when**: New channel is created (apiV1.ts:236-247)

**Scope**:
- `channel_id`: created channel ID
- `topic_id`: null
- `topic_id2`: null

**Data Shape**:
```json
{
  "channel": {
    "id": "ch_...",
    "name": "general",
    "description": "General discussion",
    "created_at": "2025-02-05T21:40:00.000Z"
  }
}
```

### topic.created

**Emitted when**: New topic is created (apiV1.ts:338-349)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: created topic ID
- `topic_id2`: null

**Data Shape**:
```json
{
  "topic": {
    "id": "topic_...",
    "channel_id": "ch_...",
    "title": "Feature Discussion",
    "created_at": "2025-02-05T21:40:00.000Z",
    "updated_at": "2025-02-05T21:40:00.000Z"
  }
}
```

### topic.renamed

**Emitted when**: Topic title is updated (apiV1.ts:427-435)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: renamed topic ID
- `topic_id2`: null

**Data Shape**:
```json
{
  "topic_id": "topic_...",
  "old_title": "Old Title",
  "new_title": "New Title"
}
```

### topic.attachment_added

**Emitted when**: Attachment added to topic (apiV1.ts:530-542, apiV1.ts:1070-1082)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: topic ID
- `topic_id2`: null

**Data Shape**:
```json
{
  "attachment": {
    "id": "att_...",
    "topic_id": "topic_...",
    "kind": "url",
    "key": null,
    "value_json": {
      "url": "https://example.com",
      "title": "Example",
      "description": "An example link"
    },
    "dedupe_key": "https://example.com",
    "source_message_id": "msg_...",
    "created_at": "2025-02-05T21:40:00.000Z"
  }
}
```

### message.created

**Emitted when**: New message is posted (apiV1.ts:512-524)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: topic ID
- `topic_id2`: null

**Data Shape**:
```json
{
  "message": {
    "id": "msg_...",
    "topic_id": "topic_...",
    "channel_id": "ch_...",
    "sender": "user@example.com",
    "content_raw": "Hello world",
    "version": 1,
    "created_at": "2025-02-05T21:40:00.000Z",
    "edited_at": null,
    "deleted_at": null,
    "deleted_by": null
  }
}
```

### message.edited

**Emitted when**: Message content is edited (messageMutations.ts:174-185)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: topic ID
- `topic_id2`: null

**Data Shape**:
```json
{
  "message_id": "msg_...",
  "old_content": "Hello world",
  "new_content": "Hello universe",
  "version": 2
}
```

### message.deleted

**Emitted when**: Message is tombstone deleted (messageMutations.ts:247-256)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: topic ID
- `topic_id2`: null

**Data Shape**:
```json
{
  "message_id": "msg_...",
  "deleted_by": "user@example.com",
  "version": 3
}
```

### message.moved_topic

**Emitted when**: Message(s) moved to different topic (messageMutations.ts:405-418)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: old topic ID
- `topic_id2`: new topic ID

**Data Shape**:
```json
{
  "message_id": "msg_...",
  "old_topic_id": "topic_...",
  "new_topic_id": "topic_...",
  "channel_id": "ch_...",
  "mode": "one",
  "version": 4
}
```

**Note**: `mode` indicates scope of operation (`"one"`, `"later"`, or `"all"`). One event emitted per affected message.

### message.enriched

**Emitted when**: Message is enriched with metadata (e.g., link preview, entity extraction)

**Scope**:
- `channel_id`: parent channel ID
- `topic_id`: topic ID
- `topic_id2`: null

**Data Shape**:
```json
{
  "message_id": "msg_...",
  "plugin_name": "linkifier",
  "enrichments": [
    {
      "id": 1,
      "message_id": "msg_...",
      "plugin_name": "linkifier",
      "kind": "url",
      "span_start": 0,
      "span_end": 23,
      "label": "example.com",
      "url": "https://example.com",
      "metadata_json": null,
      "created_at": "2025-02-05T21:40:00.000Z"
    }
  ],
  "enrichment_ids": [1]
}
```

## Conflict Handling

### Optimistic Locking

Message mutations (edit, delete, move_topic) support optimistic locking via `expected_version`:

```json
{
  "op": "edit",
  "content_raw": "New content",
  "expected_version": 2
}
```

If current `message.version` doesn't match `expected_version`:

**Response** (409):
```json
{
  "error": "Version conflict for message msg_...: expected 2, current 3",
  "code": "VERSION_CONFLICT",
  "details": {
    "current": 3
  }
}
```

Client should:
1. Fetch latest message state
2. Resolve conflict (merge or overwrite)
3. Retry with updated `expected_version`

### Tombstone Deletes

Deletes are tombstone (soft delete):
- `deleted_at` timestamp set
- `deleted_by` actor recorded
- `content_raw` replaced with `"[deleted]"`
- `version` incremented
- Row remains in database

Idempotent: deleting an already-deleted message returns success without new event.

### Retopic Modes

`move_topic` operation supports three modes:

- **`one`**: Move only the specified message
- **`later`**: Move specified message + all subsequent messages (by ID order) in same topic
- **`all`**: Move all messages in the topic

Cross-channel moves are forbidden (returns 400 `CROSS_CHANNEL_MOVE` error).

## Error Codes

Defined in `packages/protocol/src/index.ts:12-28`.

All errors return this shape:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "details": {
    "key": "value"
  }
}
```

### Error Code Catalog

| Code | HTTP Status | Description | Details Fields |
|------|-------------|-------------|----------------|
| `INVALID_INPUT` | 400 | Request validation failed | - |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds size limit | `max_bytes` |
| `NOT_FOUND` | 404 | Resource not found | - |
| `VERSION_CONFLICT` | 409 | Optimistic lock failure | `current`, `expected` |
| `CROSS_CHANNEL_MOVE` | 400 | Attempted cross-channel retopic | - |
| `UNAUTHORIZED` | 401 | Missing or invalid auth token | - |
| `INVALID_AUTH` | 401 | Authentication failed | - |
| `RATE_LIMITED` | 429 | Rate limit exceeded | `limit`, `window`, `retry_after` |
| `SERVICE_UNAVAILABLE` | 503 | Temporary failure (DB locked, disk full) | `reason` |
| `INTERNAL_ERROR` | 500 | Unexpected server error | - |
| `HUB_NOT_RUNNING` | - | CLI error: hub not running | - |
| `CONNECTION_FAILED` | - | CLI error: connection failed | - |

### Rate Limiting

When rate limited:

**Response** (429):
```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMITED",
  "details": {
    "limit": 100,
    "window": "1s",
    "retry_after": 1
  }
}
```

**Headers**:
- `X-RateLimit-Limit`: requests allowed per window
- `X-RateLimit-Remaining`: requests remaining in current window
- `X-RateLimit-Reset`: Unix timestamp when window resets
- `Retry-After`: seconds until rate limit resets

## Schema Evolution Rules

Protocol follows **additive-only evolution** (declared in `packages/client/src/events.ts:3-8`):

### Allowed Changes

✅ Add new event types (unknown event names pass through as generic EventEnvelope)  
✅ Add new fields to existing event data shapes  
✅ Add new HTTP endpoints  
✅ Add new query parameters (with sensible defaults)  
✅ Add new optional request body fields  

### Forbidden Changes

❌ Remove or rename event types  
❌ Remove or rename fields in event data  
❌ Change field types in event data  
❌ Remove HTTP endpoints  
❌ Remove query parameters  
❌ Make optional fields required  

### Client Compatibility Contract

Clients MUST:
- Gracefully handle unknown event types (ignore or log, don't crash)
- Ignore unknown fields in event data
- Use type guards for known event types (see `packages/client/src/events.ts:122-175`)

Example:
```typescript
for await (const envelope of wsConnection.events()) {
  if (isMessageCreated(envelope)) {
    // TypeScript narrowing: envelope.data.message is typed
    console.log(envelope.data.message.content_raw);
  } else if (isKnownEvent(envelope)) {
    // Handle other known events
  } else {
    // Unknown event type (future version) - don't crash
    console.log("Unknown event:", envelope.name);
  }
}
```

### Version Header

All responses include:
```
X-Protocol-Version: v1
```

Future breaking changes will increment major version (v2, v3, etc.) and require new URL path prefix (`/api/v2/*`).
