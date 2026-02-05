# Agentlip Local Hub v1 Plan (Consolidated)
**Version:** v0.2 (plan checkpoint; incorporates locked decisions from discussion)
**Scope:** local-only, workspace-scoped coordination substrate for AI coding agents
**Primary deliverables:** SQLite schema + event log, Bun hub daemon (HTTP+WS), stateless CLI, TypeScript SDK, plugin isolation, minimal UI
**Out of scope (v1):** multi-machine sync, accounts/permissions, Zulip-style unread/reactions/emoji, rich renderer, internet-facing service

## How to use this plan
1. Read **Part 0: Executive Blueprint** end-to-end—that's the contract
2. Treat **Section 0.14: ADR Expansions** as locked unless explicitly revised
3. Implement **Phases 0 → 4** in order; use **Quality Gates** as PR merge requirements
4. Track work via **Part X: Master TODO Inventory**—the execution board

> **Document note:** code and SQL are "shape-accurate" specs, not copy/paste final implementations. Where it matters, query semantics and invariants are exact.

---

# PART 0: Executive Blueprint

## 0.1 Executive Summary
You're building a **local-first, durable coordination hub** for AI agents inside a workspace. The core promise is a shared local truth that is:

- **Durable:** state survives crashes/restarts (SQLite WAL)
- **Observable:** monotonic event stream with replay (`event_id`)
- **Addressable:** `channel_id / topic_id / message_id`
- **Extensible:** isolated TypeScript plugins for enrichment + extraction
- **Offline/private:** localhost-bound, no internet dependency

The "Zulip-inspired" piece is the **channel/topic mental model**, with one decisive structural commitment:

> **Topics are first-class entities with stable IDs. Messages reference `topic_id`.**

Additionally (locked from day 1):
- Messages support **edits** (explicit events with optimistic concurrency)
- "Delete" is a **tombstone mutation** (rows are never removed)
- **No hard deletes ever** for `messages` (events are immutable/append-only)

**Success looks like:**
Multiple agents and a human can tail a topic, post, retopic (same-channel only), edit, tombstone-delete, and rely on replay after disconnects—without data loss or divergence.

---

## 0.1.1 Non-Negotiables (Engineering Contract)
Stop-ship invariants. If any is violated, the system is untrusted.

### Idempotency guarantees (system-wide)

The system provides idempotency at multiple layers:

**A. Attachment insertion (strong idempotency):**
- Same `(topic_id, kind, key, dedupe_key)` inserted twice → second insert returns existing attachment, no new event
- Guaranteed by unique index; safe to retry

**B. Message deletion (tombstone; idempotent on retry):**
- Delete already-deleted message → 200 OK, no state change, no new event
- Safe to retry; outcome stable

**C. Retopic to current topic (idempotent success):**
- Retopic message to its current topic → 200 OK, no state change, no new events
- Safe to retry; outcome stable

**D. Message creation (NOT idempotent):**
- Same content sent twice → two distinct messages created
- v1: no deduplication; client must track sent message IDs to avoid duplicates
- Future: support `client_request_id` for server-side deduplication

**E. Message edit (NOT idempotent):**
- Edit to same content → still creates new event and increments version
- Rationale: edit is a user action; event log preserves action history regardless of content change
- Client should avoid retrying edits unnecessarily

**F. WS event delivery (at-least-once):**
- Same event may be delivered multiple times (reconnect, replay)
- Client deduplicates by `event_id` (effectively idempotent)

**G. Plugin execution (conditional idempotency):**
- Enrichments: no built-in deduplication (rely on staleness guard)
- Attachments: `dedupe_key` ensures idempotency
- Multiple runs on same message may produce duplicate enrichments; future re-enrichment must handle this

**H. Schema migration (forward-only):**
- Re-running same migration may fail or succeed depending on DDL (use `IF NOT EXISTS` for idempotency)
- Rollback requires restore from backup



### Data + correctness
1. **Single-writer:** only the hub writes to `.agentlip/db.sqlite3`.
2. **Atomic mutation + event:** every mutation commits its state change and corresponding `events` row(s) **in the same SQLite transaction**.
3. **Monotonic event stream:** `events.event_id` is strictly increasing and defines total order of mutations and derived outputs.
4. **At-least-once delivery** over WS; **clients dedupe by `event_id`**.
5. **Ordering:** for any `message_id`, `message.created` commits before any derived events sourced from that message.
6. **Stateless reads:** CLI can query `.agentlip/db.sqlite3` read-only without hub participation.

### Message mutability
7. **No hard deletes:** `messages` rows are never deleted. "Delete" is a **tombstone mutation**.
8. **Explicit edit/delete events:** edits and tombstone deletes emit durable events (`message.edited`, `message.deleted`).
9. **Optimistic concurrency for content mutations:** edit and delete support `expected_version`; mismatch ⇒ conflict response, **no state change, no events**.
10. **Message version discipline:** any successful mutation (edit, delete, retopic) increments `messages.version` by 1. Rationale: version tracks mutation history for conflict detection, even for non-content changes like retopic.
11. **Derived staleness protection:** derived jobs must not publish results derived from stale content. When persisting outputs, verify the message's **current `content_raw` still matches** what was processed (don't gate on `version`, since `move_topic` also bumps it).
12. **Privacy implication:** immutable event log means old message content (before edits) may persist in `message.edited` event payloads. Tombstone deletes do not erase; "deleted" content remains in DB and historical events. **This is by design for audit/replay but precludes secure erasure.**

### Local security + isolation
13. **Local-only bind:** hub binds to `127.0.0.1` (and optionally `::1`), never `0.0.0.0`.
14. **Auth token required** for mutations and WS connections (cryptographically random token ≥128-bit stored in `server.json` with mode 0600).
15. **Plugins are isolated** (Worker or subprocess). They cannot block ingestion; failures are contained. Plugins must not have write access to `.agentlip/db.sqlite3` or `server.json`.
16. **Input validation:** all endpoints validate and sanitize inputs; reject oversized payloads (message content, attachment metadata, etc.).
17. **Rate limiting:** per-connection and global rate limits prevent DoS (configurable, sensible defaults).
18. **No secrets in logs:** structured logs never include auth tokens, full message content, or other sensitive data.

### Operational reliability
19. **Stale server discovery is safe:** `server.json` is advisory; `/health` validation is authoritative.
20. **Backpressure enforced:** slow WS clients are disconnected; reconnection + replay is the recovery path.
21. **Connection limits:** max concurrent WS connections enforced to prevent resource exhaustion.
22. **Migrations are forward-only** and must include a rollback story (backup/snapshot + recompute derived tables).

---

## 0.1.2 Threat Model & Trust Boundaries

### Threat Model
**In scope (v1):**
- Malicious or buggy plugins (sandboxing, timeouts, resource limits)
- Accidental exposure of auth token (file permissions, log redaction)
- Local DoS via API abuse (rate limits, size limits, connection limits)
- Path traversal during workspace discovery
- SQL injection via user inputs
- Sensitive data leakage in logs or error messages
- Untrusted workspace config (`agentlip.config.ts` executes code)

**Out of scope (v1 assumes localhost is trusted):**
- Network-level attacks (no TLS; localhost-only)
- Multi-user/multi-tenant isolation (single workspace owner)
- Secure deletion/erasure of message history (tombstones do not erase; events are immutable)
- Supply-chain attacks on npm dependencies (assumed trusted; **mitigation: use lockfiles, periodic `npm audit`, consider SRI for plugins in future**)

### Trust Boundaries
1. **Workspace config boundary:** `agentlip.config.ts` is code execution; only load from trusted workspace root (never traverse upward through untrusted directories).
2. **Plugin boundary:** 
   - Plugins run isolated (Worker/subprocess) with no write access to `.agentlip/` directory
   - v1: plugins CAN access network and filesystem (Worker limitations); document this risk
   - v2+: explicit capability grants (network/filesystem/environment)
   - Plugins receive read-only message data; cannot directly mutate DB
   - Plugin outputs (enrichments/attachments) validated before insertion
3. **Client boundary:** CLI/SDK/UI are trusted (same user); auth token in `server.json` is shared secret.
4. **Data boundary:** event log is durable and immutable; "deleted" messages remain in history (tombstoned); UI/clients must respect tombstone semantics.

### Safe Defaults
- Hub binds `127.0.0.1` only (not `0.0.0.0`)
- `server.json` mode 0600
- Rate limits: 100 req/s per connection, 1000 req/s global (configurable)
- Max WS connections: 100 (configurable)
- Max message size: 64KB
- Max attachment metadata: 16KB
- Max WS message: 256KB
- Max event replay batch: 1000 events
- Plugin timeout: 5s (default)
- Plugin memory limit: 128MB (if enforceable)
- Prepared statements for all SQL queries
- Error responses: generic messages (detailed errors in server logs only)

---

## 0.2 Mission and Non-Goals

### Mission (v1)
Build a **minimal, stable kernel** that:
- persists canonical conversation state (channels/topics/messages)
- persists structured grounding (topic attachments)
- exposes a replayable change feed (events)
- is ergonomic for agents (CLI JSONL + SDK async iterator)
- supports deterministic server-side enrichment via isolated plugins
- supports **message edit + tombstone delete** from day 1 with explicit events and optimistic concurrency

### Non-goals (v1)
- Multi-machine sync or LAN collaboration
- Users/accounts/permissions
- Agentlip "unread" model, typing indicators, reactions
- Complex search language (support basic filtering + optional FTS5)
- Full markdown/HTML rendering engine
- Secure erasure / "history wipe" semantics (tombstones do not remove past events)

---

## 0.3 Layered Architecture (three-ring)
Strict dependency direction; keep the core small.

### Ring 1: Kernel (small + stable)
- SQLite schema (`schema_v1.sql` + optional `schema_v1_fts.sql`)
- DB invariants + indexes for tail/pagination + event replay
- Versioning fields (`meta`, schema_version, db_id)

### Ring 2: Hub (single writer + event publisher)
- Bun daemon
- HTTP API (`/api/v1/...`)
- WebSocket feed (`/ws`) with replay
- Derived pipelines (enrichment + attachment extraction) **async**
- Lock + lifecycle (`server.json`, writer.lock)

### Ring 3: Clients + Extensions
- Stateless CLI:
  - reads DB directly (queries)
  - writes via hub (mutations)
  - listens via WS (JSONL)
- TypeScript SDK (`@agentlip/client`)
- Minimal UI consuming same APIs
- Plugin system (isolated runtime)

**Dependency rule:** clients/plugins depend on protocol types; hub depends on protocol + kernel schema; kernel depends on nothing.

---

## 0.4 Workspace / Module Layout

### On-disk workspace layout (authoritative)
```
.agentlip/
  db.sqlite3
  server.json
  config.json              # optional generated snapshot
  logs/
  locks/
    writer.lock
agentlip.config.ts            # workspace config (plugins, limits)
```

### Repo layout (recommended)
```
packages/
  protocol/                # protocol_v1.ts (single source of truth)
  client/                  # @agentlip/client
  cli/                     # agentlip
  hub/                     # agentlipd (Bun server)
  ui/                      # minimal UI assets
  plugins/                 # built-in plugins (url extractor, etc.)
migrations/
  0001_schema_v1.sql
  0001_schema_v1_fts.sql
docs/
  plan.md
  protocol.md
  ops.md
```

---

## 0.5 Kernel Invariants (Testable)

### Identity + addressing
- `channels.id`, `topics.id`, `messages.id` are stable identifiers.
- `topics` are unique by `(channel_id, title)` (human-addressability).
- Messages reference `topic_id`. Topics are first-class.

### Message mutability
- `messages` rows are never deleted (tombstone-only).
- `messages.version` starts at 1 and increments on **edit/delete/move_topic**.
- Tombstone delete sets `deleted_at`, `deleted_by`, and replaces `content_raw` with a canonical tombstone string (e.g. `"[deleted]"`).

### Event log
- Every mutation inserts exactly one "primary" event row (plus optional derived events).
- `event_id` strictly increases; replay is by `event_id`.
- `events` rows are immutable and append-only (no update/delete).
- `events.scope_*` columns are populated so replay queries are index-backed and correct.

### Retopic semantics (locked: same-channel only)
- Retopic updates `messages.topic_id` (not `messages.channel_id`) and emits `message.moved_topic`.
- Fanout correctness:
  - deliver to **old topic** subscribers
  - deliver to **new topic** subscribers
  - deliver to **channel** subscribers

### Derived pipeline
- Derived data (enrichments, auto attachments) is **recomputable** and must not be required for correctness of ingestion.
- Derived jobs must not publish stale outputs if message content changed mid-flight.

---

## 0.6 Decisions to Lock Early (ADRs)
Churn magnets-lock early.

1. **Topics are entities with stable IDs** (locked).
2. **Events are the integration surface** (WS + replay; additive evolution) (locked).
3. **Single-writer hub + stateless readers** (locked).
4. **Replay boundary contract**: `replay_until` handshake semantics (locked).
5. **Cross-channel retopic:** **forbidden in v1** (locked).
6. **Message mutability model:** edits are explicit events with optimistic concurrency; deletes are tombstones; **no hard deletes ever** (locked).
7. **Version semantics:** `messages.version` increments on edit/delete/move_topic; conflicts enforced when `expected_version` provided (locked).
8. **Attachment idempotency:** `topic_attachments.dedupe_key` + unique index; hub computes if absent; emit event only on new insert (locked).
9. **Plugin isolation mechanism:** Bun Worker by default; subprocess reserved for later (locked).
10. **FTS optionality:** separate schema applied opportunistically; fallback behavior explicit (locked).

Expanded in **Section 0.14: ADR Expansions**.

---

## 0.7 Quality Gates (Stop-Ship)

### Gate A: DB + schema correctness
- Schema initializes cleanly in empty workspace
- Optional FTS schema applies if supported; failure non-fatal and detectable

### Gate B: Mutation atomicity
- Every mutation endpoint commits state + event in same SQLite transaction
- Verify with failure injection: no state change without corresponding event row(s)

### Gate C: Replay equivalence
Given subscription set `S` and last processed `event_id = k`:
- Replay query returns exactly events matching `S` with `event_id > k` (ascending order)
- Streaming thereafter produces no gaps (duplicates allowed; client dedupes)

### Gate D: Retopic fanout correctness
When moving message from topic A → B:
- Subscribers to topic A, topic B, and parent channel all receive event
- Event includes old/new topic IDs and mode
- Cross-channel moves rejected (no events, DB unchanged)

### Gate E: Plugin safety
- Plugin hangs bounded by timeout; hub continues ingesting messages
- Plugin failures logged; may emit internal error events; do not crash hub

### Gate F: CLI + SDK stability (machine interface)
- CLI `--json/--jsonl` output is versioned and additive-only
- SDK reconnects indefinitely, making forward progress using stored `event_id`

### Gate G: Optimistic concurrency correctness
If `expected_version` provided and mismatched:
- Return conflict response
- No DB change
- No new events

### Gate H: Tombstone delete semantics
After successful delete:
- Message row still exists
- `deleted_at != NULL`, `deleted_by` non-empty
- `content_raw` is tombstoned
- `message.deleted` emitted exactly once

### Gate I: Derived job staleness protection
If message edited or deleted while enrichment/extraction job running:
- Job must not commit stale derived rows
- Job must not emit derived events for old content

### Gate J: Security baseline
- Auth token ≥128-bit cryptographically random, stored with mode 0600
- Hub binds localhost only (rejects `0.0.0.0` by default)
- All SQL uses prepared statements
- Rate limits enforced (per-connection and global)
- Input size limits enforced (message ≤64KB, attachment ≤16KB, WS ≤256KB)
- Logs never contain auth tokens or full message content
- Plugin isolation: no write access to `.agentlip/` directory
- Workspace config loaded only from discovered workspace root

---

## 0.8 Error Code Catalog

All API errors return a consistent shape:
```json
{
  "error": "human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "details": {}  // optional context
}
```

**Standard error codes:**

| Code | HTTP | Meaning | Example |
|------|------|---------|---------|
| `INVALID_INPUT` | 400 | Validation failed | Missing required field, invalid format |
| `PAYLOAD_TOO_LARGE` | 400 | Size limit exceeded | Message >64KB |
| `NOT_FOUND` | 404 | Entity doesn't exist | Topic/message/channel not found |
| `VERSION_CONFLICT` | 409 | Optimistic lock failed | `expected_version` mismatch; includes `current_version` |
| `CROSS_CHANNEL_MOVE` | 400 | Invalid retopic | Target topic in different channel |
| `UNAUTHORIZED` | 401 | Auth failed | Missing/invalid token |
| `RATE_LIMITED` | 429 | Too many requests | Exceeded per-connection or global limit |
| `SERVICE_UNAVAILABLE` | 503 | Temporary failure | DB lock contention, shutdown in progress |
| `INTERNAL_ERROR` | 500 | Unexpected server error | Log correlation ID for debugging |

**Conflict response example (version mismatch):**
```json
{
  "error": "version conflict",
  "code": "VERSION_CONFLICT",
  "details": {
    "expected": 2,
    "current": 4,
    "message_id": "msg_456"
  }
}
```

**Rate limit response example:**
```json
{
  "error": "rate limit exceeded",
  "code": "RATE_LIMITED",
  "details": {
    "limit": 100,
    "window": "1s",
    "retry_after": 0.5
  }
}
```

## 0.9 Public API Surface (Target)

### CLI (canonical workflows)

**Global flags:**
- `--workspace <path>` - explicit workspace (otherwise auto-discover from cwd)
- `--json` - machine-readable JSON output
- `--jsonl` - newline-delimited JSON (for streaming)

**Read-only queries (direct DB access, no hub required):**

`agentlip channel list [--json]`
- Output: table or JSON array of channels
- Example JSON: `[{"id": "ch_123", "name": "general", "description": null, "created_at": "2026-02-04T20:00:00Z"}]`

`agentlip topic list --channel <name|id> [--json]`
- Output: topics in channel, sorted by updated_at DESC
- Example: `agentlip topic list --channel general --json`

`agentlip msg tail --topic-id <id> [--limit 50] [--json]`
- Output: latest N messages in topic (newest first)
- Example JSON: `[{"id": "msg_456", "sender": "agent-1", "content_raw": "Hello", "version": 1, "created_at": "...", "edited_at": null, "deleted_at": null}]`

`agentlip msg page --topic-id <id> [--before-id <id>] [--after-id <id>] [--limit 50] [--json]`
- Bidirectional pagination
- Example: `agentlip msg page --topic-id topic_xyz --before-id msg_100 --limit 20`

`agentlip search <query> [--channel <name>] [--topic-id <id>] [--limit 100] [--json]`
- Basic search (LIKE-based); uses FTS5 if available (faster, better ranking)
- Query syntax:
  - FTS available: `"exact phrase"`, `word1 word2` (AND), `word1 OR word2`
  - FTS unavailable: simple substring match (`WHERE content_raw LIKE '%query%'`)
- Example: `agentlip search "error message" --channel general --limit 10`
- Example phrase: `agentlip search '"connection refused"' --json`
- Response includes `fts_used: boolean` field indicating search method used

`agentlip attachment list --topic-id <id> [--kind <kind>] [--json]`
- List attachments for a topic
- Example: `agentlip attachment list --topic-id topic_xyz --kind url --json`

**Mutations (require running hub):**

`agentlip msg send --topic-id <id> --sender <name> [--content <text>] [--stdin]`
- Send message (content from arg or stdin)
- Example: `echo "Hello world" | agentlip msg send --topic-id topic_xyz --sender agent-1 --stdin`
- Response: `{"message_id": "msg_789", "event_id": 42}`

`agentlip msg edit <message_id> --content <text> [--expected-version <n>]`
- Edit message content with optional optimistic lock
- Example: `agentlip msg edit msg_456 --content "Updated text" --expected-version 2`
- On conflict: exit code 2, stderr: `Error: version conflict (current: 4)`

`agentlip msg delete <message_id> --actor <name> [--expected-version <n>]`
- Tombstone delete
- Example: `agentlip msg delete msg_456 --actor agent-1`
- Response: `{"deleted": true, "event_id": 43}`

`agentlip msg retopic <message_id> --to-topic-id <id> --mode <one|later|all> [--force]`
- Move message(s) to different topic (same channel only)
- `--force` required for mode=all (safety guardrail)
- Example: `agentlip msg retopic msg_100 --to-topic-id topic_new --mode later`
- Example all: `agentlip msg retopic msg_50 --to-topic-id topic_archive --mode all --force`
- Error on cross-channel: exit code 1, stderr: `Error: cross-channel move forbidden`

`agentlip topic rename <topic_id> --title <new_title>`
- Rename topic
- Example: `agentlip topic rename topic_xyz --title "New Title"`

`agentlip attachment add --topic-id <id> --kind <kind> --value-json <json> [--key <key>] [--source-message-id <id>] [--dedupe-key <key>]`
- Add attachment (manual or scripted)
- Example: `agentlip attachment add --topic-id topic_xyz --kind url --value-json '{"url":"https://example.com","title":"Example"}' --source-message-id msg_123`
- Response on new: `{"attachment_id": "att_999", "event_id": 44}`
- Response on dedupe: `{"attachment_id": "att_888", "event_id": null, "deduplicated": true}`

**Listening (WebSocket stream):**

`agentlip listen [--since <event_id>] [--channel <name|id>...] [--topic-id <id>...] [--format jsonl]`
- Stream events to stdout
- Defaults: since=0 (all history), no filters (all events), format=jsonl
- Example: `agentlip listen --since 42 --channel general --format jsonl`
- Output: one JSON envelope per line
- Reconnects automatically on disconnect; resumes from last seen event_id
- Exit: Ctrl+C or SIGTERM

**Daemon control:**

`agentlipd up [--port <port>] [--host 127.0.0.1] [--config <path>]`
- Start hub daemon
- Defaults: port from `server.json` or random, host=127.0.0.1
- Writes `server.json` with token + instance_id
- Example: `agentlipd up --port 8080`

`agentlipd down`
- Graceful shutdown (finds hub via server.json, sends SIGTERM)

`agentlipd status`
- Check hub health and print info
- Output: `{"status": "running", "instance_id": "...", "db_id": "...", "schema_version": 1, "port": 8080}`

`agentlip init [--workspace <path>]`
- Initialize workspace (create `.agentlip/` and schema)
- Example: `agentlip init` (in repo root)

`agentlip doctor`
- Run diagnostics (DB integrity, schema version, server health, etc.)

**Exit codes:**
- `0` - success
- `1` - general error (invalid input, not found, etc.)
- `2` - conflict (version mismatch)
- `3` - hub not running / connection failed
- `4` - authentication failed

### HTTP API (v1)

**Authentication:** All mutation endpoints and WS require `Authorization: Bearer <token>` header. Token from `server.json`.

**Common request headers:**
- `Authorization: Bearer <token>` - required for mutations and WS
- `Content-Type: application/json` - for POST/PATCH with body
- `X-Request-ID: <uuid>` - optional; echoed in response for correlation

**Common response headers:**
- `X-Request-ID: <uuid>` - echoed from request, or server-generated
- `X-RateLimit-Limit: <n>` - requests allowed per window
- `X-RateLimit-Remaining: <n>` - requests remaining in current window
- `X-RateLimit-Reset: <timestamp>` - ISO8601 when limit resets
- `X-Instance-ID: <id>` - hub instance ID (for debugging multi-hub issues)

**Common response codes:**
- `200 OK` - success
- `400 Bad Request` - invalid input (body includes `{error: string, code: string}`)
- `401 Unauthorized` - missing/invalid auth token
- `404 Not Found` - entity not found
- `409 Conflict` - optimistic concurrency failure (includes `current_version`)
- `429 Too Many Requests` - rate limit exceeded
- `503 Service Unavailable` - DB lock contention or temporary failure

**Endpoints:**

`GET /health`
- No auth required
- Response: `{instance_id: string, db_id: string, schema_version: number, protocol_version: string}`
- Example: `{"instance_id": "abc123", "db_id": "def456", "schema_version": 1, "protocol_version": "v1"}`

`GET /api/v1/channels`
- Response: `{channels: [{id: string, name: string, description: string|null, created_at: string}]}`

`POST /api/v1/channels`
- Request: `{name: string, description?: string}`
- Response: `{channel: {id: string, name: string, ...}, event_id: number}`

`GET /api/v1/channels/:channel_id/topics`
- Query params: `?limit=50&before_id=...` (pagination)
- Response: `{topics: [{id: string, channel_id: string, title: string, created_at: string, updated_at: string}]}`

`POST /api/v1/topics`
- Request: `{channel_id: string, title: string}`
- Response: `{topic: {id: string, ...}, event_id: number}`

`PATCH /api/v1/topics/:topic_id`
- Request: `{title: string}`
- Response: `{topic: {id: string, title: string, ...}, event_id: number}`

`GET /api/v1/messages`
- Query params: `?channel_id=...&topic_id=...&limit=50&before_id=...&after_id=...`
- At least one of `channel_id` or `topic_id` required
- Pagination: use `before_id` (older messages) or `after_id` (newer messages)
- Response: `{messages: [{id: string, topic_id: string, channel_id: string, sender: string, content_raw: string, version: number, created_at: string, edited_at: string|null, deleted_at: string|null, deleted_by: string|null}], has_more: boolean, cursor?: string}`
- Example: `GET /api/v1/messages?topic_id=topic_xyz&limit=20&before_id=msg_500`
- Returns up to 20 messages older than msg_500, newest first
- `has_more: true` if more messages available in requested direction

`POST /api/v1/messages`
- Request: `{topic_id: string, sender: string, content_raw: string}`
- Response: `{message: {id: string, version: 1, ...}, event_id: number}`
- Example request: `{"topic_id": "topic_abc", "sender": "agent-1", "content_raw": "Hello world"}`
- Validation: `content_raw` max 64KB; `sender` required non-empty string

`PATCH /api/v1/messages/:message_id`
- Operations via `op` field:

**Edit operation:**
```json
{
  "op": "edit",
  "content_raw": "Updated content",
  "expected_version": 2
}
```
Response on success: `{message: {..., version: 3, edited_at: "..."}, event_id: number}`
Response on conflict: `409 {"error": "version conflict", "code": "VERSION_CONFLICT", "current_version": 4}`

**Delete operation (tombstone):**
```json
{
  "op": "delete",
  "actor": "agent-1",
  "expected_version": 2
}
```
Response: `{message: {..., deleted_at: "...", deleted_by: "agent-1", version: 3}, event_id: number}`

**Move topic operation:**
```json
{
  "op": "move_topic",
  "to_topic_id": "new_topic_xyz",
  "mode": "one"|"later"|"all",
  "expected_version": 2
}
```
Response: `{affected_count: number, event_ids: number[]}`
Error if cross-channel: `400 {"error": "cross-channel move forbidden", "code": "CROSS_CHANNEL_MOVE"}`

`GET /api/v1/topics/:topic_id/attachments`
- Response: `{attachments: [{id: string, topic_id: string, kind: string, key: string|null, value_json: object, dedupe_key: string, source_message_id: string|null, created_at: string}]}`

`POST /api/v1/topics/:topic_id/attachments`
- Request: `{kind: string, key?: string, value_json: object, dedupe_key?: string, source_message_id?: string}`
- Response on new insert: `{attachment: {...}, event_id: number}`
- Response on dedupe: `{attachment: {...}, event_id: null}` (no new event)
- Example: `{"kind": "url", "value_json": {"url": "https://example.com", "title": "Example"}, "source_message_id": "msg_123"}`
- Validation: `value_json` max 16KB serialized

`GET /api/v1/events?after=&limit=` (optional fallback for non-WS clients)
- Query params: `after` (event_id), `limit` (default 100, max 1000)
- Response: `{events: [{event_id: number, ts: string, name: string, data_json: object}]}`

### WebSocket protocol (v1)

**Connection:** `ws://localhost:<port>/ws?token=<auth_token>`

**Message format:** All messages are JSON objects with a `type` field.

**Handshake sequence:**

1. Client connects and sends `hello`:
```json
{
  "type": "hello",
  "after_event_id": 42,
  "subscriptions": {
    "channels": ["channel_abc"],
    "topics": ["topic_xyz", "topic_123"]
  }
}
```
- `after_event_id`: last event processed by client (0 for fresh start)
- `subscriptions`: channels and/or topics to follow (omit field or pass empty array for none)

2. Server responds with `hello_ok`:
```json
{
  "type": "hello_ok",
  "replay_until": 100,
  "instance_id": "abc123"
}
```
- `replay_until`: server's `latest_event_id` at handshake time; defines replay boundary

3. Server sends replay events (if any):
```json
{
  "type": "event",
  "event_id": 43,
  "ts": "2026-02-04T23:30:00.000Z",
  "name": "message.created",
  "scope": {
    "channel_id": "channel_abc",
    "topic_id": "topic_xyz"
  },
  "data": {
    "message": {
      "id": "msg_456",
      "topic_id": "topic_xyz",
      "channel_id": "channel_abc",
      "sender": "agent-2",
      "content_raw": "Hello",
      "version": 1,
      "created_at": "2026-02-04T23:30:00.000Z"
    }
  }
}
```

4. After replay completes (all events `<= replay_until` sent), server streams live events (`> replay_until`)

**Event envelope structure:**
```typescript
{
  type: "event",
  event_id: number,        // strictly increasing, unique
  ts: string,              // ISO8601 timestamp
  name: string,            // event type (see event catalog below)
  scope: {                 // routing metadata
    channel_id?: string,
    topic_id?: string,     // primary topic
    topic_id2?: string     // secondary topic (for moves)
  },
  data: object             // event-specific payload
}
```

**Event catalog (v1):**

- `channel.created` - data: `{channel: {...}}`
- `topic.created` - data: `{topic: {...}}`
- `topic.renamed` - data: `{topic_id: string, old_title: string, new_title: string}`
- `message.created` - data: `{message: {...}}`
- `message.edited` - data: `{message_id: string, old_content: string, new_content: string, version: number}`
- `message.deleted` - data: `{message_id: string, deleted_by: string, version: number}`
- `message.moved_topic` - data: `{message_id: string, old_topic_id: string, new_topic_id: string, channel_id: string, mode: string, version: number}`
- `message.enriched` - data: `{message_id: string, enrichments: [{kind: string, span: {start: number, end: number}, data: object}]}`
- `topic.attachment_added` - data: `{attachment: {...}}`

**Client responsibilities:**
- Deduplicate events by `event_id` (server guarantees at-least-once delivery)
- Store `latest_processed_event_id` durably for reconnection
- Handle backpressure disconnect gracefully (reconnect with last processed id)

**Server backpressure policy:**
- Each connection has bounded outbound queue (default: 1000 events)
- If queue fills, disconnect with close code 1008 (policy violation)
- Client should reconnect with `after_event_id`

**Connection limits:**
- Max concurrent connections: 100 (configurable)
- Connection refused with HTTP 503 if limit reached

**WebSocket close codes:**
- `1000` (Normal Closure): graceful shutdown, client should not auto-reconnect
- `1001` (Going Away): server shutdown in progress, client should reconnect after delay
- `1008` (Policy Violation): backpressure limit exceeded, client should reconnect with last processed event_id
- `1011` (Internal Error): unexpected server error, client should reconnect with exponential backoff
- `4401` (Unauthorized): invalid auth token, client should not reconnect without re-authentication

**Connection lifecycle example:**

1. Client connects: `ws://localhost:8080/ws?token=abc123...`
2. Client sends `hello`:
```json
{"type": "hello", "after_event_id": 42, "subscriptions": {"channels": ["general"]}}
```
3. Server validates token and subscriptions
4. Server responds `hello_ok`:
```json
{"type": "hello_ok", "replay_until": 100, "instance_id": "xyz789"}
```
5. Server sends replay events (43..100)
6. Server sends live events (>100) as they occur
7. If backpressure: server closes with 1008, client reconnects from last processed event_id
8. On shutdown: server sends close 1001, client waits 5s and reconnects
9. On auth failure: server sends close 4401, client exits (requires manual intervention)

**Client reconnection strategy (recommended):**
```typescript
let reconnectDelay = 1000; // start at 1s
const maxDelay = 30000;    // cap at 30s

async function connect() {
  try {
    const ws = await connectWebSocket();
    reconnectDelay = 1000; // reset on success
    // ... handle messages
  } catch (err) {
    if (err.code === 4401) {
      console.error('Auth failed, cannot reconnect');
      process.exit(1);
    }
    
    // Exponential backoff
    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    connect(); // retry
  }
}
```

**Client reconnection edge cases:**

1. **Reconnect loop during hub shutdown:**
   - Hub sends close 1001 (Going Away) for graceful shutdown
   - Client should wait longer (e.g., 5-10s) before reconnecting (not immediate)
   - If hub doesn't come back after max retries (e.g., 5 attempts): exit or alert user

2. **Reconnect with stale after_event_id:**
   - Client last processed event_id 100, but hub restarted with new DB (events start from 1)
   - Replay query returns no events (none match subscription + `event_id > 100`)
   - Client receives replay_until=50 (current max), waits indefinitely for events >100
   - Mitigation: if `replay_until < after_event_id`: client should reset to `after=0` or `after=replay_until` (fresh start)

3. **Reconnect during hub migration:**
   - Hub offline for 5 minutes during schema migration
   - Client reconnects repeatedly, fails (connection refused)
   - After migration completes: client reconnects, new `instance_id`, resumes from last processed event_id
   - No special handling needed (transparent to client)

4. **Reconnect with invalid subscription (topic deleted):**
   - Client subscribed to topic A, hub restarts, topic A deleted during downtime
   - Client reconnects with subscription to topic A (now invalid/non-existent)
   - Hub accepts subscription (no validation; topic may exist in future)
   - Replay returns no events for topic A (no matching scope_topic_id)
   - Client receives no errors; just no events for deleted topic

5. **Hub instance_id changed mid-connection (impossible but paranoid check):**
   - Client connects, receives `instance_id=abc`
   - Hub restarts mid-connection (connection dropped, but hypothetically...)
   - In practice: connection drops, client reconnects, gets new instance_id
   - No special handling needed (connection drop forces reconnect)

6. **Multiple clients with same after_event_id:**
   - Two clients both last processed event_id 100
   - Both reconnect simultaneously
   - Both receive replay 101-200 (current events)
   - No conflict; replay is idempotent, read-only
   - Hub may serve both from cache (if implemented)

7. **Client storage corruption (loses after_event_id):**
   - Client loses durable state, doesn't know last processed event_id
   - Options:
     a. Reconnect with `after=0` (full replay from beginning)
     b. Reconnect with `after=current_time` (skip history, only new events)
   - v1: client decides policy (no hub-side guidance)
   - Future: hub could suggest "reasonable" replay window (e.g., last 1000 events)

### Configuration file schemas

**`server.json` (generated by hub, mode 0600):**
```json
{
  "instance_id": "abc123-def456",
  "db_id": "workspace-unique-uuid",
  "port": 8080,
  "host": "127.0.0.1",
  "auth_token": "64-char-hex-string",
  "pid": 12345,
  "started_at": "2026-02-04T20:00:00.000Z",
  "protocol_version": "v1"
}
```
- Written on hub startup
- `auth_token`: cryptographically random ≥128-bit (e.g., `crypto.randomBytes(32).toString('hex')`)
- `db_id`: must match `meta.db_id` from database
- Clients read this to discover port and token
- Advisory only; `/health` validation is authoritative

**`agentlip.config.ts` (workspace config, optional):**
```typescript
import type { WorkspaceConfig } from '@agentlip/hub';

const config: WorkspaceConfig = {
  // Plugin configuration
  plugins: [
    {
      name: 'url-extractor',
      type: 'extractor',
      enabled: true,
      config: {
        allowedDomains: ['example.com', 'github.com'],  // optional allowlist
        timeout: 5000  // ms
      }
    },
    {
      name: 'code-linkifier',
      type: 'linkifier',
      enabled: true,
      module: './custom-plugins/code-links.ts',
      config: {
        repoRoot: process.env.REPO_ROOT
      }
    }
  ],

  // Rate limiting
  rateLimits: {
    perConnection: 100,  // requests per second
    global: 1000
  },

  // Resource limits
  limits: {
    maxMessageSize: 65536,        // 64KB
    maxAttachmentSize: 16384,     // 16KB
    maxWsMessageSize: 262144,     // 256KB
    maxWsConnections: 100,
    maxWsQueueSize: 1000,
    maxEventReplayBatch: 1000
  },

  // Plugin execution
  pluginDefaults: {
    timeout: 5000,       // ms
    memoryLimit: 134217728  // 128MB (if enforceable)
  }
};

export default config;
```

**WorkspaceConfig TypeScript interface:**
```typescript
interface WorkspaceConfig {
  plugins?: PluginConfig[];
  rateLimits?: {
    perConnection?: number;
    global?: number;
  };
  limits?: {
    maxMessageSize?: number;
    maxAttachmentSize?: number;
    maxWsMessageSize?: number;
    maxWsConnections?: number;
    maxWsQueueSize?: number;
    maxEventReplayBatch?: number;
  };
  pluginDefaults?: {
    timeout?: number;
    memoryLimit?: number;
  };
}

interface PluginConfig {
  name: string;
  type: 'linkifier' | 'extractor';
  enabled: boolean;
  module?: string;  // path to custom plugin (default: built-in)
  config?: Record<string, unknown>;  // plugin-specific config
}
```

### Plugin contract (v1)

**Plugin types:**
1. **Linkifier** (enrichment): analyzes message content, returns structured enrichments
2. **Extractor** (attachment): analyzes message content, returns topic attachments

**Plugin interface (Worker-based):**

```typescript
// Plugin implementation (user-provided or built-in)
export interface LinkifierPlugin {
  name: string;
  version: string;

  // Called for each new/edited message
  enrich(input: EnrichInput): Promise<Enrichment[]>;
}

export interface ExtractorPlugin {
  name: string;
  version: string;

  // Called for each new/edited message
  extract(input: ExtractInput): Promise<Attachment[]>;
}

// Input types
interface EnrichInput {
  message: {
    id: string;
    content_raw: string;
    sender: string;
    topic_id: string;
    channel_id: string;
    created_at: string;
  };
  config: Record<string, unknown>;  // from agentlip.config.ts
}

interface ExtractInput {
  message: {
    id: string;
    content_raw: string;
    sender: string;
    topic_id: string;
    channel_id: string;
    created_at: string;
  };
  config: Record<string, unknown>;
}

// Output types
interface Enrichment {
  kind: string;           // e.g., 'url', 'code_ref', 'file_path'
  span: {
    start: number;        // character offset
    end: number;
  };
  data: Record<string, unknown>;  // enrichment-specific structured data
}

interface Attachment {
  kind: string;           // e.g., 'url', 'file', 'image'
  key?: string;           // optional namespace
  value_json: Record<string, unknown>;
  dedupe_key?: string;    // optional (hub will compute if absent)
}

// Example enrichment output
const exampleEnrichment: Enrichment = {
  kind: 'url',
  span: { start: 10, end: 30 },
  data: {
    url: 'https://example.com',
    title: 'Example Domain',
    resolved: true
  }
};

// Example attachment output
const exampleAttachment: Attachment = {
  kind: 'url',
  value_json: {
    url: 'https://github.com/owner/repo/issues/42',
    title: 'Issue #42',
    issue_number: 42,
    repo: 'owner/repo'
  },
  dedupe_key: 'url:https://github.com/owner/repo/issues/42'
};
```

**Plugin isolation contract:**
- Plugins run in Bun Worker (separate thread, no shared memory)
- Timeout enforced (default 5s, configurable per plugin)
- If plugin throws or times out: log error, may emit internal error event, do not crash hub
- No write access to `.agentlip/` directory (read-only DB access via RPC if needed in future)
- v1 limitation: plugins CAN access network and filesystem (Worker limitations); documented risk
- Future: explicit capability grants

**Plugin lifecycle:**
1. Hub loads plugins from `agentlip.config.ts` on startup
2. For each new/edited message:
   - Hub spawns Worker with plugin code
   - Passes message + config via RPC
   - Waits for result (with timeout)
   - Validates output (size, schema)
   - Staleness guard: verify message content unchanged before persisting
   - Insert enrichments/attachments + emit events
   - Close Worker

**Staleness guard (critical for correctness):**
Before committing plugin outputs, hub must:
```typescript
// Re-read current message state
const current = await db.get(
  'SELECT content_raw, deleted_at FROM messages WHERE id = ?',
  [messageId]
);

// Verify content unchanged and not deleted
if (current.content_raw !== originalContent || current.deleted_at !== null) {
  // Discard plugin outputs; do not commit or emit events
  return;
}

// Safe to commit
await db.run('INSERT INTO enrichments ...');
await db.run('INSERT INTO events ...');
```

### Protocol types
`packages/protocol/protocol_v1.ts` is the source of truth for:
- WS messages
- event envelope + payload types
- HTTP request/response shapes
- plugin interfaces

**Protocol versioning and compatibility:**

v1 protocol principles:
- **Additive evolution only:** new optional fields, new event types, new endpoints OK
- **Breaking changes forbidden:** removing fields, renaming fields, changing types, changing semantics require v2
- **Client resilience:** clients must ignore unknown event types and unknown fields (forward compatibility)
- **Graceful degradation:** older clients connecting to newer hub should continue working (within v1 protocol version)

**Backward-compatible changes (safe within v1):**
- Adding optional fields (HTTP request/response, WS message)
- Adding new event types (old clients ignore)
- Adding new endpoints (old clients unaffected)
- Adding new CLI commands (old scripts unaffected)

**Breaking changes (require v2):**
- Removing required fields
- Renaming fields
- Changing field types incompatibly (e.g., string→number)
- Changing event payload structure in non-additive way
- Removing endpoints
- Changing WS handshake protocol
- Changing authentication mechanism

**Protocol negotiation:**
- `GET /health` returns `protocol_version: "v1"`
- Clients check this before connecting
- Future: clients could request specific protocol version via header/query param

**Deprecation process (v1 → v2 transition):**
1. Announce deprecation in v1 release (docs, logs)
2. Add v2 endpoints alongside v1
3. Mark v1 endpoints deprecated (header: `X-Deprecated: true`)
4. Run both protocols in parallel during transition period
5. Remove v1 in major version bump (provide migration guide)

**Event catalog evolution:**
- New event types can be added anytime within v1
- Event type names immutable once published
- Event payload fields additive-only within v1
- Events never deleted from catalog (deprecated events remain documented)

### Event log integrity and edge cases

**Event ID gap scenarios:**
1. **Transaction rollback within same session:**
   - Transaction inserts event with ID 100
   - Transaction rolls back (constraint violation, conflict, etc.)
   - Next successful transaction gets ID 101 (gap at 100)
   - SQLite reuses rolled-back IDs in same connection/session
   - Result: no gap if same connection; possible gap if connection closed/reopened

2. **Hub crash mid-transaction:**
   - Transaction inserts event with ID 100, crashes before commit
   - Transaction fully rolled back (WAL recovery)
   - Next hub start: next event gets ID 101 (gap at 100, or ID reused)
   - SQLite behavior: autoincrement IDs may or may not be reused after crash (depends on internal state)
   - Consequence: event_id gaps possible but rare

3. **Intentional gaps (future: event log compaction):**
   - v1: no compaction; events never deleted
   - Future: if events deleted (admin purge old events): gaps intentional
   - Client replay: if gap detected (e.g., request >100, receive 150), no events in range 101-149

**Gap detection and handling:**
- `agentlip doctor` should scan event log for gaps:
  ```sql
  -- Find gaps in event_id sequence
  WITH RECURSIVE cnt(id) AS (
    SELECT MIN(event_id) FROM events
    UNION ALL
    SELECT id+1 FROM cnt WHERE id < (SELECT MAX(event_id) FROM events)
  )
  SELECT id FROM cnt WHERE id NOT IN (SELECT event_id FROM events);
  ```
- If gaps found: log warning; gaps are safe but indicate rollbacks or crashes
- Clients: if replaying and see gap (e.g., last event 100, next event 150), no action needed; simply means events 101-149 don't exist

**Event immutability edge cases:**
1. **Attempt to UPDATE event row:**
   - Trigger `prevent_event_mutation` fires, aborts transaction
   - Returns error; no state change
   - Hub code should never attempt UPDATE; guard rails in DB layer

2. **Attempt to DELETE event row:**
   - Trigger `prevent_event_delete` fires, aborts transaction
   - Returns error; no state change
   - Only way to remove events: delete DB file (catastrophic; not supported)

3. **Event payload size unbounded:**
   - `data_json` is TEXT (unlimited in SQLite)
   - Risk: single event with 10MB payload (e.g., message.edited with huge content)
   - Mitigation: enforce max event payload size (e.g., 1MB); reject mutations that would generate oversized events
   - v1: rely on message content size limit (64KB); event payload will be <100KB typically

4. **Event timestamp in past (clock skew):**
   - Hub generates `ts = new Date().toISOString()`
   - If system clock set backward: new events have earlier `ts` than old events
   - Consequence: `ts` ordering violated, but `event_id` ordering preserved
   - Clients should sort by `event_id`, treat `ts` as advisory

5. **Event timestamp far future (clock skew):**
   - System clock set forward (e.g., +1 year)
   - Events have future `ts`
   - Hub later corrected (clock set back to now)
   - New events have earlier `ts` than recent events
   - Consequence: same as above; `event_id` authoritative

6. **Event scope columns NULL (invalid event):**
   - Some events may not have channel/topic scope (e.g., system-level events)
   - v1: all events MUST have at least one scope (channel or topic)
   - Validation: before inserting event, ensure `scope_channel_id` OR `scope_topic_id` is non-NULL
   - Invalid events won't match any subscription; effectively invisible to clients

7. **Concurrent event inserts (impossible with single writer):**
   - Single-writer guarantee prevents concurrent inserts
   - All inserts serialized by SQLite
   - Event IDs strictly increasing (no race)

**Event replay correctness (detailed):**
- Client sends `after_event_id = 100`
- Hub computes `replay_until = MAX(event_id)` at handshake time (e.g., 200)
- Hub queries: `WHERE event_id > 100 AND event_id <= 200 ORDER BY event_id ASC`
- Events 101-200 replayed
- During replay (takes 1s), new events 201-205 committed
- After replay completes, hub starts live stream: `WHERE event_id > 200`
- Live stream sends 201-205 (and any newer)
- Client dedupes by event_id; sees each event exactly once

**Replay boundary race (pathological case):**
- Client sends `after=100`
- Hub computes `replay_until=200` (snapshot)
- Before replay query executes, events 201-210 committed
- Replay query executes: returns 101-200
- Live stream starts: sends >200 (i.e., 201-210)
- Result: correct; no gap (client sees 101-200, then 201-210)

**Replay timeout (very stale client):**
- Client requests replay from `after=0` (all history)
- Event log has 1M events
- Replay query: paginate by `maxEventReplayBatch` (1000)
- Hub sends 1k events, waits for client to ack (or next batch request)
- If client slow: hub enforces WS backpressure (disconnect after queue full)
- Client reconnects with last processed event_id, resumes
- Total replay time: 1M / 1000 batches * ~1s per batch = ~15 minutes (if no backpressure)
- Mitigation: consider rejecting replays older than TTL (e.g., 7 days worth of events)

**Example additive event evolution:**

v1.0 `message.created`:
```json
{
  "message": {
    "id": "msg_123",
    "content_raw": "Hello"
  }
}
```

v1.5 (added optional field):
```json
{
  "message": {
    "id": "msg_123",
    "content_raw": "Hello",
    "word_count": 1  // new optional field
  }
}
```

Old clients ignore `word_count`; new clients can use it. Both work.

---

## 0.10 Output + Concurrency Architecture

### Single-writer implementation
- `.agentlip/locks/writer.lock` acquired via exclusive create.
- Hub verifies staleness by `/health` (and PID liveness if available).
- DB uses WAL + configured busy timeout.

### Transaction boundaries (load-bearing)
**Mutation transaction must include**
1. state change
2. insert corresponding event row(s) with correct scopes + payload(s)
3. commit

**Crash safety:** if hub crashes between steps 1 and 2 (or before commit), the entire transaction rolls back automatically (SQLite WAL guarantees). No partial state is possible.

**Edge cases and mitigations:**
- **Disk full during transaction:** SQLite returns `SQLITE_FULL`; transaction auto-rolls back; return 503 to client; log disk space exhaustion; consider WAL checkpoint to reclaim space
- **Lock contention timeout:** if `busy_timeout` expires, return 503 with `Retry-After` header; client should implement exponential backoff
- **WAL checkpoint failure (disk full, I/O error):** checkpoint is best-effort; WAL can grow; monitor WAL size; if WAL exceeds threshold (e.g., 100MB), reject new writes with 503 until checkpoint succeeds or admin intervenes
- **Power loss mid-transaction:** WAL recovery on restart; transaction either fully committed or fully rolled back (atomicity guarantee)
- **Corruption detection:** on any `SQLITE_CORRUPT` error, immediately stop serving, mark DB as suspect, require `agentlip doctor --repair` before restart

**Derived pipelines** run in separate transactions after commit. If hub crashes during derived processing, derived data may be incomplete but canonical state (messages/events) is intact and replayable.

**Derived pipeline crash recovery:**
- On hub restart: scan for messages with no enrichments/attachments but should have them (heuristic: recent messages, or messages modified after last enrichment timestamp)
- Option 1: background re-enrichment job
- Option 2: lazy re-enrichment on read (if enrichments missing, queue job)
- v1: **no automatic recovery**; manual `agentlip re-enrich --since <event_id>` command for admin

### Optimistic concurrency
For edit/delete/move_topic:
- If `expected_version` is provided, validate `messages.version == expected_version` inside the transaction.
- On mismatch: rollback and return `conflict`.

**Concurrent mutation edge cases:**

1. **Two edits racing (no expected_version):**
   - Transaction serialization ensures one commits first (increments version to 2)
   - Second commits after (increments version to 3)
   - Both succeed; both emit events; event_id determines order
   - Last writer wins for content; full edit history in event log

2. **Two edits racing (both with expected_version=1):**
   - First edit commits (version 1→2), emits event
   - Second edit's txn sees version=2, conflicts, rolls back, returns 409
   - Client receives conflict response with `current_version: 2`
   - Client must decide: retry with version 2 (re-read current content, recompute edit), or abort

3. **Edit vs. delete race:**
   - If delete commits first: sets `deleted_at`, tombstones content, version 1→2
   - Subsequent edit sees `deleted_at != NULL`; decision: **allow edit of tombstoned message** (set `deleted_at=NULL`, restore content, increment version) OR **reject edit of deleted message**
   - v1 decision: **reject edits of tombstoned messages** (check `deleted_at IS NULL` before edit; return 400 "cannot edit deleted message")

4. **Edit vs. retopic race:**
   - Retopic increments version (v1→v2), changes topic_id
   - Concurrent edit with expected_version=1 will conflict (version now 2)
   - This is correct behavior: retopic is a mutation; version tracking prevents lost updates

5. **Delete vs. delete race:**
   - First delete commits (sets `deleted_at`, version 1→2)
   - Second delete sees version=2 (if expected_version=1 provided): conflicts
   - If no expected_version: second delete sees `deleted_at != NULL`; decision: **idempotent success** (return 200, no state change, no new event) OR **error**
   - v1 decision: **idempotent success** (deleting already-deleted message is no-op; return success with existing state)

6. **Rapid successive edits by same client:**
   - Each edit commits sequentially (v1→v2→v3...)
   - Each emits `message.edited` event
   - Event log preserves full history
   - UI may coalesce edit events for display (e.g., show "edited 3 times" instead of 3 separate events)
   - No special handling needed; version monotonically increases

7. **Retopic "all" mode concurrent with new message insert in source topic:**
   - Retopic transaction selects all messages in topic A at transaction start
   - New message inserts into topic A after retopic starts but before retopic commits
   - Two outcomes:
     a. New message commits first: retopic includes it (correct)
     b. Retopic commits first: new message remains in topic A (correct; message arrived after retopic started)
   - Both outcomes are correct; no lost messages; serialization guarantees consistency

8. **Version overflow (2^31-1 edits):**
   - SQLite INTEGER is 64-bit signed; practical limit is 2^63-1
   - If version overflows: wrap to negative (unlikely in practice)
   - v1: no overflow handling; document that >2B edits per message is unsupported
   - Future: detect approaching overflow, prevent further edits, require manual intervention

### WS fanout
- Maintain per-connection subscriptions (channel/topic)
- On new committed event:
  - match by scopes (`scope_channel_id`, `scope_topic_id`, `scope_topic_id2`)
  - send envelope
- Backpressure:
  - bounded outbound queue per socket
  - disconnect when threshold exceeded
  - client reconnects using last processed `event_id`

**WS delivery edge cases:**

1. **Events committed during replay period:**
   - Scenario: client requests replay from `after=100`, hub sets `replay_until=200`, but events 201-205 commit before replay finishes
   - Solution: replay sends `<= replay_until` (100-200), then live stream sends `> replay_until` (201+); no gap; client may receive duplicates at boundary (200/201); client dedupes by `event_id`

2. **Client disconnect mid-replay:**
   - Replay is best-effort; on disconnect, abandon replay
   - Client reconnects with same `after_event_id` (last processed, not last received)
   - New replay boundary computed; may re-send events (client dedupes)

3. **Send failure mid-batch:**
   - If WS send fails partway through sending multiple events: close connection immediately
   - Do NOT attempt partial retry; client reconnects with last *processed* (ack'd) event_id
   - Server does not track which events were received; relies on client to report `after_event_id` on reconnect

4. **Replay query returns huge result set:**
   - Enforce `maxEventReplayBatch` (default 1000) per query
   - If more events match, send in multiple batches (pagination)
   - After each batch, check if connection still healthy; abort if client disconnected
   - Risk: very stale clients (e.g., `after=0` with 1M events) may take long time and resource; consider rejecting replays older than threshold (e.g., 7 days) with "too stale, reinitialize" error

5. **Concurrent event emission during fanout:**
   - Events may commit while fanout loop is iterating connections
   - Solution: fanout reads event once, iterates connections, sends same envelope to each
   - New events (committed after fanout started) will be picked up by next fanout cycle
   - No event is dropped; at-most-once per cycle, at-least-once over time

6. **Clock skew / timestamp ordering:**
   - `event_id` is authoritative order, not `ts`
   - If system clock jumps backward, `ts` may be out of order but `event_id` monotonicity is preserved
   - Clients should sort/order by `event_id`, use `ts` for display only

7. **Hub restart during active WS connections:**
   - On graceful shutdown: close all WS with code 1001 (Going Away)
   - Clients reconnect with last processed `event_id`
   - New hub instance has new `instance_id`; clients detect and proceed (no special handling needed)
   - On crash/kill: connections drop; clients detect disconnect, reconnect with backoff

---

## 0.11 Open Questions (Resolved for v1)
Major "churn magnet" decisions now locked:

1. **`move_topic` and `edited_at`:** Retopic does not set `edited_at` (it's routing metadata, not content change). Event timestamp is authoritative.
2. **Attachment behavior on retopic:** No automatic attachment migration; attachments stay with topic they were inserted into.
3. **Plugin environment:** Worker-only in v1; subprocess reserved for v2 (simpler isolation).
4. **FTS fallback semantics:** Basic LIKE-based filtering on message content when FTS5 unavailable; document limitations.

---

## 0.12 Definition of Done (v1)
Ship when all true:

- ✅ Workspace init creates `.agentlip/` and schema v1
- ✅ Hub starts, acquires write lock, writes `server.json`, serves `/health`
- ✅ Channels/topics/messages CRUD (as specified)
- ✅ Message edit with optimistic concurrency (emits `message.edited`)
- ✅ Message tombstone delete (emits `message.deleted`; no hard deletes possible)
- ✅ Retopic modes `one|later|all` with CLI guardrails (same-channel only)
- ✅ WS replay + live stream with `after_event_id` correctness (Gates B/C)
- ✅ Topic attachments API + CLI + auto URL extraction with `dedupe_key`
- ✅ Plugin system v1: isolation, timeouts, `message.enriched` events
- ✅ SDK: connect/replay/reconnect; async iterator yields typed envelopes
- ✅ Minimal UI: browse channels/topics/messages/attachments with live updates
- ✅ Test suite covers Gates A-J; CI runs deterministically

---

## 0.13 Performance Budgets + Measurement Harness
Conservative budgets on a typical dev laptop.

### Baseline budgets
- **Message insert** (excluding enrichment): p50 < 10ms, p99 < 50ms
- **Message edit/delete/retopic** (excluding derived): p50 < 15ms, p99 < 75ms
- **Event fanout** (single client): < 5ms overhead per event
- **WS replay**: 10k events in < 1s (localhost)
- **Tail query**: latest 50 messages by (channel, topic) in < 20ms @ 100k messages
- **Retopic "later"**: 1k messages in < 200ms (single transaction; index-dependent)

### Measurement plan
Add a `bench` command (or integration test mode) that:
- populates N messages/topics
- measures key queries and endpoints
- exercises WS replay
- records metrics to JSON for regression tracking (relaxed CI thresholds)

---

## 0.14 ADR Expansions (Options → Decision → Consequences → Tests)

### ADR-0001: Topics as first-class entities
**Decision:** topics are entities with stable IDs; messages reference `topic_id`.

**Tests:** rename topic doesn't rewrite messages; retopic updates `messages.topic_id` and emits events.

---

### ADR-0002: Durable event log is the integration surface
**Decision:** durable events with WS + replay by `event_id`.

**Tests:** replay equivalence; crash atomicity.

---

### ADR-0003: Replay query contract (exact semantics)
**Decision (contract)**
- On WS `hello`, server computes snapshot boundary `replay_until = latest_event_id_at_handshake`.
- Server replies `hello_ok.latest_event_id = replay_until`.
- Server replays events matching subscriptions where:
  - `after_event_id < event_id <= replay_until`
- After replay completes, server streams new matching events with `event_id > replay_until`.

**Reference SQL (shape)**
```sql
SELECT event_id, ts, name, data_json
FROM events
WHERE event_id > :after
  AND event_id <= :until
  AND (
    scope_channel_id IN (/* channelSubs */)
    OR scope_topic_id IN (/* topicSubs */)
    OR scope_topic_id2 IN (/* topicSubs */)
  )
ORDER BY event_id ASC
LIMIT :limit;
```

**Tests:** deterministic replay set/order; boundary test for events inserted during replay.

---

### ADR-0004: Retopic modes, selection, and channel constraint
**Decision**
- Implement `one|later|all` selection exactly.
- **Cross-channel moves are forbidden in v1.** `to_topic_id` must belong to the message's channel.
- Retopic increments `messages.version` and emits per-message `message.moved_topic` (plus scopes).

**Selection SQL (shape)**
- one:
```sql
SELECT id FROM messages WHERE id = :msg_id AND topic_id = :old_topic_id;
```
- later:
```sql
SELECT id FROM messages
WHERE topic_id = :old_topic_id AND id >= :msg_id
ORDER BY id ASC;
```
- all:
```sql
SELECT id FROM messages
WHERE topic_id = :old_topic_id
ORDER BY id ASC;
```

**Write pattern**
- In one transaction:
  - validate channel constraint
  - read affected IDs
  - update `topic_id`, bump `version`
  - insert `message.moved_topic` event per message with:
    - `scope_channel_id = channel_id`
    - `scope_topic_id = old_topic_id`
    - `scope_topic_id2 = new_topic_id`
  - commit

**Tests:** fanout correctness; cross-channel negative test; version bump.

**Detailed retopic example:**

Given:
- Channel `general` with topics `bugs` and `archive`
- Messages in `bugs`: msg_1, msg_2, msg_3, msg_4, msg_5

Scenario: `agentlip msg retopic msg_3 --to-topic-id archive --mode later`

Expected behavior:
1. Select messages: msg_3, msg_4, msg_5 (all with `id >= msg_3` in topic `bugs`)
2. Update each: `topic_id = 'archive'`, `version += 1`
3. Emit 3 events (one per message moved):
```json
{
  "event_id": 101,
  "name": "message.moved_topic",
  "scope": {
    "channel_id": "general",
    "topic_id": "bugs",      // old topic
    "topic_id2": "archive"   // new topic
  },
  "data": {
    "message_id": "msg_3",
    "old_topic_id": "bugs",
    "new_topic_id": "archive",
    "channel_id": "general",
    "mode": "later",
    "version": 2  // incremented
  }
}
// ... events 102, 103 for msg_4, msg_5
```

Subscribers affected:
- Subscribed to channel `general`: receive all 3 events (via `scope.channel_id`)
- Subscribed to topic `bugs`: receive all 3 events (via `scope.topic_id`)
- Subscribed to topic `archive`: receive all 3 events (via `scope.topic_id2`)

Cross-channel rejection example:
```bash
$ agentlip msg retopic msg_3 --to-topic-id other_channel_topic --mode one
Error: cross-channel move forbidden
Exit code: 1
```

**Retopic edge cases:**

1. **Retopic to same topic (no-op):**
   - Message already in target topic
   - Decision: **idempotent success** (no state change, no events, return 200)
   - Rationale: client intent achieved (message is in target topic)

2. **Retopic of tombstoned message:**
   - Message has `deleted_at != NULL`
   - Decision: **allow retopic of deleted messages** (tombstone is content state, not routing state)
   - Retopic updates `topic_id`, increments `version`, emits event
   - Deleted message is now in new topic (still deleted)
   - UI should still render as deleted in new location

3. **Retopic with expected_version on already-moved message:**
   - Message was retopiced (v1→v2), now in topic B
   - Client retries retopic with `expected_version=1` (stale)
   - Result: conflict (current version is 2)
   - Client must re-read current state, decide if retopic still needed

4. **Source topic deleted during retopic "all":**
   - Retopic transaction starts, selects all messages in topic A
   - Topic A deleted (CASCADE deletes all messages) before retopic commits
   - Foreign key constraint: messages referencing topic A are deleted
   - Retopic update finds zero rows (messages gone)
   - Decision: **return 200 with `affected_count: 0`** (no error; topic was deleted)
   - Alternative: topic deletion blocks until retopic completes (lock contention)
   - v1: **allow concurrent topic deletion**; retopic may affect 0 messages if topic deleted

5. **Target topic deleted during retopic:**
   - Retopic transaction starts, validates target topic exists
   - Target topic deleted before retopic update commits
   - Retopic update sets `topic_id` to deleted topic
   - Foreign key constraint: **fails** (target topic_id does not exist)
   - SQLite returns constraint violation; transaction rolls back
   - Return 400 "target topic not found"

6. **Retopic "all" mode selects 10k messages:**
   - Single transaction updates 10k rows + inserts 10k event rows
   - Risk: long transaction, lock contention, WAL growth
   - Mitigation: enforce `max_retopic_batch` (e.g., 1000 messages)
   - If selection exceeds limit: return 400 "too many messages; use mode=later with smaller anchor, or delete old messages first"
   - v1: **no batch limit**; document that "all" mode on large topics may be slow
   - Future: chunked retopic (internal pagination, multiple txns)

7. **Retopic "later" mode anchor message already at end:**
   - Anchor message is last (or only) message in topic
   - Selection: only anchor message (nothing "later")
   - Outcome: move only anchor message (correct; mode=later includes anchor)

8. **Retopic "later" mode with gaps in message IDs:**
   - Topic has messages: msg_1, msg_5, msg_10 (IDs are sparse)
   - Retopic anchor: msg_5, mode=later
   - Selection: `WHERE topic_id=X AND id >= 'msg_5'` → msg_5, msg_10
   - Outcome: msg_1 stays, msg_5 and msg_10 move (correct)

9. **Concurrent retopics on same topic:**
   - Two retopic "all" operations on topic A, different targets (B and C)
   - Both start, both select all messages in topic A
   - First commits: all messages now in topic B, event_id 100-110
   - Second commits: updates `topic_id` from B to C (since messages are now in B, not A; selection was snapshot)
   - Outcome: all messages end up in topic C (last writer wins)
   - Problem: first retopic's events show A→B, but final state is C; confusing
   - Mitigation: **retopic selection should re-check topic_id inside transaction** before update:
     ```sql
     UPDATE messages
     SET topic_id = :new_topic, version = version + 1
     WHERE id IN (:selected_ids) AND topic_id = :expected_old_topic
     ```
   - If topic_id changed, update affects 0 rows; return 409 "messages moved by concurrent retopic"

10. **Retopic + edit race on version:**
    - Already covered in concurrent mutations; version mismatch causes conflict
    - Retopic increments version; concurrent edit with expected_version will fail

---

### ADR-0005: Plugin isolation and timeouts
**Decision:** Bun Worker isolation by default; `--unsafe-inproc-plugins` for dev; subprocess reserved for future.

**Tests:** hang timeout; crash containment.

---

### ADR-0006: Optional FTS5
**Decision:** separate `schema_v1_fts.sql` applied opportunistically; failure is non-fatal.

**Tests:** suite runs with FTS on/off.

---

### ADR-0007: Topic attachment idempotency (dedupe_key)
**Decision**
- Add **required** `dedupe_key` to `topic_attachments`.
- Enforce uniqueness with:
  - `UNIQUE(topic_id, kind, COALESCE(key,''), dedupe_key)`
- Hub computes a `dedupe_key` if caller doesn't provide one.
- Emit `topic.attachment_added` **only if** a new row was created.

**DDL delta (shape)**
```sql
dedupe_key TEXT NOT NULL,
CHECK (length(dedupe_key) > 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_attachments_dedupe
  ON topic_attachments(topic_id, kind, COALESCE(key, ''), dedupe_key);
```

**Insert semantics**
- Attempt insert
- On unique conflict: fetch existing row and return it
- No event on deduped insert

**Tests:** retry insert does not duplicate; no phantom events.

---

### ADR-0008: Message mutability model (edit + tombstone delete)
**Decision**
- Edits are explicit events with optimistic concurrency.
- Deletes are tombstones; **hard deletes are forbidden**.

**Consequences**
- Stable message identity forever
- Attachments referencing `source_message_id` remain valid
- "Delete" is not secure erasure; old content may persist in historical events

**Tests**
- Edit success increments version + emits event
- Edit conflict ⇒ no state/events
- Delete tombstones row + emits event
- Derived staleness guard prevents stale enrichment/extraction commits

---

## 0.15 Execution Tracker Pointer
The canonical execution checklist is **Part X: Master TODO Inventory**. Treat it as the execution board.

---

# PART I: Foundations (Derivation + Specs + Design Proofs)

## Chapter 1: First-principles derivation
This is a **workspace-scoped state machine**:
- Canonical state: channels/topics/messages/attachments/(derived enrichments)
- Canonical change log: events (monotonic)
- Derived projections: enrichment + extraction (recomputable)

Key insight:
- Agents need shared local truth with stable addresses + deterministic replay + minimal coordination overhead.

---

## Chapter 2: Formal Specifications ("TLA-lite")

### 2.1 Transitions (mutations)
Each mutation endpoint is a transition `S → S'` with corresponding event `E`.

**Invariant:** mutation commit implies event commit.
If a message edit commits, a `message.edited` event exists in the same transaction with `event_id` reflecting the total order.

**Concurrent mutations:** SQLite serializes transactions; `event_id` (autoincrement) defines total order. If two mutations target the same message concurrently:
- optimistic concurrency (`expected_version`) may cause one to fail with `conflict`
- both cannot succeed with same `version`; one will see incremented version and fail or retry
- event stream reflects whichever transaction committed first

**Rapid successive edits:** if the same message is edited multiple times in quick succession:
- each edit increments `version` and emits a separate `message.edited` event
- all edits are recorded in event log (preserving edit history)
- clients see all edit events in order; UI may choose to coalesce or show history

### 2.2 WS delivery model
- Server emits a total order by `event_id`.
- Clients store `last_processed_event_id` durably and dedupe.

### 2.6 Concurrency invariants (formal guarantees)

**I1: Single-writer serialization**
- Only one hub process writes to DB at a time (enforced by writer.lock)
- All transactions are serialized by SQLite (SERIALIZABLE isolation + WAL)
- Consequence: no lost updates, no write-write conflicts at DB layer

**I2: Event ID monotonicity**
- `event_id` is INTEGER PRIMARY KEY AUTOINCREMENT
- SQLite guarantees monotonic increase within single connection
- Consequence: total order over all events; no gaps (except wraparound at 2^63, impractical)

**I3: Message version monotonicity**
- Each mutation (edit/delete/retopic) that commits increments `messages.version` by exactly 1
- Version starts at 1 (on creation)
- Consequence: version reflects mutation count; version N means N-1 mutations since creation

**I4: Atomic mutation + event**
- State change and event insertion occur in same SQLite transaction
- If crash occurs: both commit or both rollback (atomicity)
- Consequence: event log is complete (no state change without event, no event without state change)

**I5: At-least-once WS delivery**
- Server may send same event multiple times (e.g., reconnect during replay)
- Server never skips an event matching subscription
- Consequence: clients must dedupe by event_id; guaranteed to see all matching events

**I6: Optimistic concurrency correctness**
- If `expected_version` provided: txn verifies `messages.version == expected_version` before mutation
- If mismatch: txn rolls back, no state change, no event emitted
- Consequence: lost update prevention; client can detect concurrent modifications

**I7: Replay boundary consistency**
- Replay sends events `(after_event_id, replay_until]`
- Live stream sends events `(replay_until, ∞)`
- No gaps: events committed during replay are > replay_until, sent by live stream
- Possible duplicates: event at boundary (replay_until or replay_until+1) may appear in both replay and live
- Consequence: client dedupes by event_id; sees all events exactly once (after deduplication)

**I8: Scope-based routing correctness**
- Every event has `scope_channel_id` and/or `scope_topic_id` and/or `scope_topic_id2`
- Replay query matches subscription by scope columns (index-backed)
- Fanout matches subscription by scope columns
- Consequence: clients receive exactly events matching their subscriptions (no false positives/negatives after deduplication)

**I9: Foreign key consistency**
- `messages.topic_id` references `topics.id` (ON DELETE CASCADE)
- `messages.channel_id` matches `topics.channel_id` for referenced topic (app-enforced invariant)
- `topic_attachments.topic_id` references `topics.id` (ON DELETE CASCADE)
- Consequence: referential integrity; orphaned messages/attachments prevented by cascade or null

**I10: Tombstone immutability**
- `messages` rows never deleted (DELETE trigger prevents)
- Tombstone delete sets `deleted_at`, tombstones `content_raw`, increments `version`
- Consequence: message identity stable forever; historical references valid; "deleted" is a state, not an operation

**I11: Derived data staleness protection**
- Plugin reads message at version V, content C
- Before committing derived outputs: re-read message
- If `content_raw != C` OR `version != V` OR `deleted_at IS NOT NULL`: discard outputs
- Consequence: derived data never references stale/deleted content; correctness over availability

**I12: Lock-free reads (WAL mode)**
- SQLite WAL allows concurrent readers with writer
- CLI queries use `PRAGMA query_only = ON` (read-only snapshot)
- Consequence: CLI can query DB without blocking hub writes; snapshot consistency

### 2.3 Subscription matching
`matches(event, subs)` is OR across:
- `scope_channel_id == sub.channel_id`
- `scope_topic_id == sub.topic_id`
- `scope_topic_id2 == sub.topic_id`

### 2.4 Replay boundary
Handshake defines `replay_until`; replay is `(after, replay_until]`; live starts `> replay_until`.

### 2.5 Ordering constraints with edits/deletes
For any message:
- `message.created` precedes any enrichment/attachment event sourced from its content at that time.
- If content changes (edit/delete), derived jobs must not commit outputs computed from older content after the edit/delete commits (staleness guard).

---

## Chapter 3: Data Model & Indexing Proof Notes

### 3.1 Database schema (DDL contract)

**`meta` table:**
```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

-- Required keys:
-- 'db_id': UUIDv4 generated at init, never changes
-- 'schema_version': integer, current version
-- 'created_at': ISO8601 timestamp
```

**`channels` table:**
```sql
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY NOT NULL,  -- UUIDv4 or ULID
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,      -- ISO8601
  CHECK (length(name) > 0 AND length(name) <= 100)
) STRICT;
```

**`topics` table:**
```sql
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
```

**`messages` table:**
```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,      -- denormalized for fast filtering
  sender TEXT NOT NULL,
  content_raw TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
  CHECK (length(sender) > 0),
  CHECK (length(content_raw) <= 65536),  -- 64KB limit
  CHECK (version >= 1)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- Trigger: prevent hard deletes
CREATE TRIGGER IF NOT EXISTS prevent_message_delete
BEFORE DELETE ON messages
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Hard deletes forbidden on messages; use tombstone');
END;
```

**`events` table:**
```sql
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,              -- ISO8601
  name TEXT NOT NULL,            -- event type (e.g., 'message.created')
  scope_channel_id TEXT,         -- for channel-level routing
  scope_topic_id TEXT,           -- primary topic
  scope_topic_id2 TEXT,          -- secondary topic (for retopic)
  entity_type TEXT NOT NULL,     -- 'channel', 'topic', 'message', etc.
  entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL,       -- JSON payload
  CHECK (length(name) > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_replay ON events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_scope_channel ON events(scope_channel_id, event_id);
CREATE INDEX IF NOT EXISTS idx_events_scope_topic ON events(scope_topic_id, event_id);
CREATE INDEX IF NOT EXISTS idx_events_scope_topic2 ON events(scope_topic_id2, event_id);

-- Trigger: prevent updates/deletes
CREATE TRIGGER IF NOT EXISTS prevent_event_mutation
BEFORE UPDATE ON events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_event_delete
BEFORE DELETE ON events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'Events are append-only');
END;
```

**`topic_attachments` table:**
```sql
CREATE TABLE IF NOT EXISTS topic_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT,                      -- optional namespace (e.g., 'url', 'file')
  value_json TEXT NOT NULL,      -- JSON object
  dedupe_key TEXT NOT NULL,      -- idempotency key
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  CHECK (length(kind) > 0),
  CHECK (length(dedupe_key) > 0),
  CHECK (length(value_json) <= 16384)  -- 16KB limit
) STRICT;

CREATE INDEX IF NOT EXISTS idx_attachments_topic ON topic_attachments(topic_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_attachments_dedupe
  ON topic_attachments(topic_id, kind, COALESCE(key, ''), dedupe_key);
```

**`enrichments` table (derived data, recomputable):**
```sql
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
```

**Optional FTS5 schema (`schema_v1_fts.sql`):**
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content_raw,
  content=messages,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, content_raw) VALUES (new.rowid, new.content_raw);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
BEGIN
  UPDATE messages_fts SET content_raw = new.content_raw WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
```

### 3.2 Why store both `channel_id` and `topic_id` on messages
- Denormalizes for fast filtering without joins.
- Enforces same-channel retopic rule cheaply.
- Invariant: `messages.channel_id` matches `topics.channel_id` for its `topic_id` (validated by hub on insert/retopic).

### 3.3 Event scoping columns
The `scope_*` pattern avoids joins during replay and keeps replay index-backed.

Example replay query:
```sql
SELECT event_id, ts, name, data_json
FROM events
WHERE event_id > :after_event_id
  AND event_id <= :replay_until
  AND (
    scope_channel_id IN (/* subscribed channels */)
    OR scope_topic_id IN (/* subscribed topics */)
    OR scope_topic_id2 IN (/* subscribed topics */)
  )
ORDER BY event_id ASC
LIMIT 1000;
```

### 3.4 WAL and small transactions
WAL allows CLI reads while hub writes; small txns reduce lock time and failure blast radius.

**PRAGMAs (set on connection):**
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;  -- balance safety/performance
```

**Lock contention handling:**
- Hub sets `busy_timeout` (e.g., 5000ms) to retry on lock contention
- If transaction fails after retries: return 503 Service Unavailable to client
- CLI reads use `PRAGMA query_only = ON` to avoid write lock conflicts

### 3.5 Data type conventions and formats

**Timestamps:**
- All timestamps stored as TEXT in ISO8601 format with UTC timezone
- Format: `YYYY-MM-DDTHH:MM:SS.sssZ` (e.g., `2026-02-04T23:30:45.123Z`)
- Millisecond precision required
- Always UTC (Z suffix required)
- Generated via `new Date().toISOString()` or equivalent

**IDs:**
- Entity IDs (channels, topics, messages, attachments, enrichments): TEXT
- Recommended: UUIDv4, UUIDv7, or ULID (sortable)
- Format validation: non-empty, max 64 chars, alphanumeric + hyphen/underscore
- Event IDs: INTEGER AUTOINCREMENT (guarantees monotonicity)

**Strings:**
- All text fields UTF-8
- JSON payloads: UTF-8 encoded
- Max lengths enforced at application layer and DB constraints (CHECK)

**JSON payloads:**
- `data_json`, `value_json`: stored as TEXT (serialized JSON)
- Must be valid JSON object (not array or primitive)
- Parsing: strict mode (reject invalid JSON)
- Size limits enforced before insertion

**Boolean semantics:**
- SQLite STRICT mode: use INTEGER (0/1) for booleans
- Protocol/API: use JSON true/false
- NULL vs. false: explicit NULL for optional fields, never implicit false

**Version numbers:**
- `messages.version`: INTEGER starting at 1, increments on mutation
- `schema_version`: INTEGER starting at 1
- `protocol_version`: STRING ("v1", "v2", etc.)

**Null handling:**
- Optional fields: NULL allowed in DB, null in JSON
- Required fields: NOT NULL constraint in DB, field required in JSON
- Empty string vs. NULL: prefer NULL for "absent" (empty string = present but empty)

### 3.6 Schema versioning and migrations

**Schema version tracking:**
- `meta.schema_version` (integer) tracks current schema version
- Hub checks on startup; refuses to run if version mismatch
- Migrations are forward-only (no downgrades)

**Migration process:**
1. Hub checks `meta.schema_version` against expected version
2. If lower: run migrations sequentially (e.g., `0001_schema_v1.sql` → `0002_add_feature.sql`)
3. Before migration: create backup (`db.sqlite3.backup-v1-TIMESTAMP`)
4. Apply migration SQL in transaction
5. Update `meta.schema_version`
6. Log migration event to `events` table (for audit)

**Migration naming convention:**
- `migrations/NNNN_description.sql`
- e.g., `0001_schema_v1.sql`, `0002_add_enrichments_index.sql`

**Migration file structure:**
```sql
-- Migration: 0002_add_enrichments_index.sql
-- From schema version: 1
-- To schema version: 2

BEGIN TRANSACTION;

-- Create new index
CREATE INDEX IF NOT EXISTS idx_enrichments_kind ON enrichments(kind, message_id);

-- Update schema version
UPDATE meta SET value = '2' WHERE key = 'schema_version';

COMMIT;
```

**Rollback strategy:**
- Restore from timestamped backup
- Recompute derived tables (enrichments, attachments can be regenerated from messages)
- Events table is immutable; never modified by migrations (additive only)

**Breaking schema changes (requiring v2):**
- Removing columns
- Renaming columns
- Changing column types incompatibly
- Changing event payload structure in breaking ways

**Additive schema changes (v1.x):**
- Adding nullable columns
- Adding indexes
- Adding new tables (opt-in features)
- Adding optional fields to event payloads (clients ignore unknown fields)

---

## Chapter 4: Implementation Specifications (Hard Contracts)

### 4.1 Workspace discovery (CLI + SDK)
1. Start at `cwd` (or provided path)
2. Walk upward until `.agentlip/db.sqlite3` exists
3. That directory is workspace root
4. **Security:** stop traversal at filesystem boundary or user home directory; never load `agentlip.config.ts` from untrusted parent directories
5. `server.json` is advisory; validate via `/health`

### 4.2 Hub lifecycle and health checks

**`GET /health` endpoint:**
```json
{
  "status": "ok",
  "instance_id": "abc123-def456",
  "db_id": "workspace-db-uuid",
  "schema_version": 1,
  "protocol_version": "v1",
  "uptime_seconds": 3600,
  "pid": 12345
}
```
- No authentication required (public endpoint)
- Always returns 200 if hub is running and responsive
- `instance_id`: unique per hub process (regenerated on restart)
- `db_id`: stable workspace identifier (from `meta` table)
- Used for staleness detection and validation

**Hub startup sequence:**
1. Validate workspace: `.agentlip/db.sqlite3` exists and readable
2. Open DB, set PRAGMAs (WAL, foreign_keys, busy_timeout)
3. Check `meta.schema_version`; run migrations if needed
4. Acquire writer lock (`.agentlip/locks/writer.lock`)
   - If lock exists: validate via `/health` on port from existing `server.json`
   - If stale (no response or PID dead): remove lock
   - If live: fail with error "hub already running"
5. Generate `instance_id` (UUID)
6. Load or generate `auth_token` (crypto random ≥128-bit)
7. Bind HTTP server to localhost:port
8. Write `server.json` (chmod 0600)
9. Load `agentlip.config.ts` (if exists)
10. Initialize plugin workers
11. Log startup event to `events` table
12. Begin serving requests

**Hub shutdown sequence (graceful):**
1. Stop accepting new connections (close listener)
2. Finish in-flight requests (with timeout, e.g., 10s)
3. Close all WebSocket connections (send close frame)
4. Flush WAL checkpoint
5. Close DB connection
6. Remove writer lock
7. Remove `server.json`
8. Exit process

**Startup failure modes:**
- Schema version too new: refuse to start, instruct user to upgrade hub
- Schema version too old: auto-migrate (with backup) or refuse if migration disabled
- DB corrupted: exit with error, recommend `agentlip doctor`
- Lock acquisition failed (live hub): exit with error showing running hub details
- Port bind failed: exit with error (port already in use)

**`agentlipd status` command:**
1. Read `server.json` (if absent: "no hub running")
2. Call `GET /health` on port from server.json
3. Validate:
   - `db_id` matches on-disk DB
   - Response within timeout (5s)
4. Print status:
```
Status: running
Instance ID: abc123-def456
Port: 8080
PID: 12345
Uptime: 1h 23m
Schema version: 1
Protocol version: v1
```

**`agentlipd down` command:**
1. Read `server.json` to find running hub
2. Send SIGTERM to PID (if available)
3. Wait for graceful shutdown (timeout 10s)
4. If timeout: send SIGKILL
5. Verify shutdown via `/health` (expect connection refused)
6. Clean up stale files if needed

### 4.3 Mutation write path template
1. Validate auth token (constant-time comparison)
2. Validate input:
   - size limits (message content ≤64KB, attachment metadata ≤16KB, etc.)
   - schema/type correctness
   - sanitize/escape as needed
3. Begin txn (using prepared statements/parameterized queries only)
4. Apply state change
5. Insert event row(s) with scopes + payload
6. Commit
7. Trigger async derived pipelines
8. Respond `{ok:true}` (on error: generic message, log details server-side without leaking paths/tokens)

### 4.4 Retopic write path
- Validate same-channel constraint
- Optional `expected_version` validation
- Select affected messages by mode
- Update `topic_id`, bump `version`
- Emit `message.moved_topic` events:
  - `scope_channel_id = channel_id`
  - `scope_topic_id = old_topic_id`
  - `scope_topic_id2 = new_topic_id`

### 4.5 Edit + tombstone delete write path
**Edit**
- Validate `expected_version` (if provided)
- Update:
  - `content_raw`
  - `edited_at = now`
  - `version = version + 1`
- Emit `message.edited`

**Delete (tombstone)**
- Validate `expected_version` (if provided)
- Update:
  - `deleted_at = now`, `deleted_by = actor`
  - `content_raw = "[deleted]"`
  - `edited_at = now` (recommended)
  - `version = version + 1`
- Emit `message.deleted`

### 4.6 Derived pipelines (staleness guard)
When a derived job starts, it reads `{message_id, content_raw, deleted_at, version}`.
Before committing derived outputs:
- re-read `messages.content_raw` and `messages.deleted_at`
- if `content_raw` changed OR `deleted_at IS NOT NULL`: discard outputs (do not commit derived rows or events)
- if message was deleted (tombstoned) after job started: discard

**Security note:** do not extract or enrich tombstoned content; check `deleted_at` before processing.

SQL shape (staleness verification):
```sql
SELECT content_raw, deleted_at, version, topic_id, channel_id
FROM messages
WHERE id = :message_id;
```

**Derived pipeline edge cases:**

1. **ABA problem (edit back to original content):**
   - Job starts with content "Hello"
   - Message edited to "Goodbye" (v1→v2)
   - Message edited back to "Hello" (v2→v3)
   - Job finishes, compares content: "Hello" == "Hello" ✓
   - Problem: content matches but version changed; derived output may be stale
   - Solution: **compare both content AND version**; if version changed, discard even if content matches
   - Updated guard: `if content_raw != original_content OR version != original_version OR deleted_at IS NOT NULL: discard`

2. **TOC/TOU race (content changes during verification):**
   - Job finishes, reads message for verification
   - Edit commits after read but before derived insert
   - Mitigation: **perform verification query and derived insert in same transaction**
   - Transaction ensures atomic "check-then-insert"; if message changes mid-transaction, next read will see new version
   - Verification must use same transaction as derived row insert

3. **Multiple plugins processing same message concurrently:**
   - Two plugins (enricher, extractor) both triggered by `message.created`
   - Both read same initial state, both pass staleness guard (if content unchanged)
   - Both insert derived rows and emit events
   - Outcome: both succeed (correct); enrichments and attachments are independent
   - Edge case: if both try to insert same `dedupe_key` attachment: unique constraint; second fails or returns existing; no duplicate events

4. **Plugin output depends on external state (e.g., URL resolves to title):**
   - Message contains URL; extractor fetches URL, gets title "Old Title"
   - URL content changes externally (server updates page title)
   - Re-enrichment fetches URL, gets title "New Title"
   - Outcome: attachment updated? Or duplicate?
   - v1 decision: **attachments are immutable once inserted**; dedupe_key prevents duplicates; external changes not tracked
   - If URL content changes, manual re-extraction required (`agentlip re-extract --message-id <id>` future command)

5. **Message deleted (tombstoned) while plugin running:**
   - Plugin reads content, starts processing
   - Message deleted: `deleted_at` set, `content_raw` changed to "[deleted]"
   - Staleness guard checks: `deleted_at IS NOT NULL` → discard
   - No derived rows or events emitted for tombstoned content
   - Existing enrichments/attachments remain (not deleted); tied to message via foreign key with `ON DELETE CASCADE` (if message row deleted) or `ON DELETE SET NULL` (for source_message_id in attachments)
   - v1: **existing enrichments persist when message tombstoned** (enrichments not auto-deleted)
   - Clients should hide enrichments when rendering tombstoned messages

6. **Plugin timeout vs. staleness:**
   - Plugin times out (e.g., 5s limit)
   - Hub kills plugin, logs error
   - No derived rows inserted; no events emitted
   - Message remains un-enriched
   - Should we retry? v1 decision: **no automatic retry**; log timeout; emit `plugin.timeout` internal event (optional); admin can manually re-enrich

7. **Plugin emits outputs, then message is edited before commit:**
   - Plugin runs on content "Hello", produces enrichments for "Hello"
   - Message edited to "Goodbye" (v1→v2) before plugin commits
   - Staleness guard sees version changed: discard enrichments
   - New `message.edited` event triggers new plugin job for "Goodbye"
   - Outcome: only "Goodbye" enrichments persist (correct)

8. **Retopic during plugin execution:**
   - Plugin starts on message in topic A
   - Message retopiced to topic B (version increments)
   - Staleness guard sees version changed OR topic_id changed (should we check topic_id?)
   - Decision: **version change is sufficient**; retopic bumps version, so guard will discard
   - Derived rows would be inserted into wrong topic if guard didn't catch this
   - For attachments: `topic_id` is denormalized on attachment row; if message moves, attachment `topic_id` should NOT auto-update
   - v1: **attachments stay with topic they were inserted into**; do not auto-migrate on retopic

9. **Hub restart during plugin execution:**
   - Plugins are in-flight (Worker processes)
   - Hub crashes or restarts
   - Workers detect disconnect or timeout, exit
   - On restart: no in-flight plugin state recovered
   - Messages remain un-enriched; no automatic retry
   - v1: **no crash recovery for plugins**; require manual re-enrichment if needed

10. **Concurrent edits triggering multiple plugin jobs:**
    - Message edited rapidly: v1→v2→v3→v4
    - Each edit triggers plugin job
    - Multiple plugin jobs running concurrently on different versions
    - Each job will check against current version at commit time
    - Only the job matching the current version will commit (if content unchanged since job started)
    - Older jobs will see version mismatch, discard
    - Outcome: at most one set of enrichments persists (for latest version)
    - Problem: rapid edits may cause "thundering herd" of plugin jobs
    - Mitigation: **debounce plugin triggers** (e.g., wait 1s after edit before triggering; if another edit arrives, reset timer)
    - v1: **no debouncing**; document that rapid edits may waste plugin cycles

---

## Chapter 5: Testing Strategy (Mapped to Risks)

### 5.1 Unit tests
- Schema init + optional FTS
- Event insertion helper scope correctness
- Retopic selection correctness
- Patch conflict logic (`expected_version`)
- Tombstone constraints and triggers

### 5.2 Integration tests (hub + db + ws)
- Start hub in temp workspace
- WS connect with `after_event_id=0`
- Send message; verify `message.created`
- Edit; verify `message.edited` and conflict behavior
- Delete; verify tombstone state + `message.deleted`
- Retopic; verify fanout to old/new/channel and cross-channel rejection
- Disconnect/reconnect with last id; verify no gaps

### 5.3 Failure injection
- crash during mutation (between state write/event write) cannot produce partial state
- slow WS client triggers backpressure disconnect
- plugin hang timeout doesn't block ingestion
- derived job staleness guard blocks stale commits

### 5.5 Edge case testing methodology

**Approach 1: Fault injection at SQLite layer**
- Mock or wrap SQLite driver to inject failures:
  - `SQLITE_FULL` during transaction commit
  - `SQLITE_BUSY` after N retries
  - `SQLITE_CORRUPT` on integrity check
- Verify hub handles gracefully (503, log error, no crash)

**Approach 2: Time manipulation**
- Mock `Date.now()` or system clock:
  - Jump backward 1 hour (test clock skew)
  - Jump forward 1 year (test far-future timestamps)
  - Freeze time (test timeout enforcement)
- Verify event_id monotonicity preserved, ts may be out of order

**Approach 3: Concurrency stress testing**
- Spawn N clients (e.g., 50) concurrently:
  - All edit same message (rapid fire, no expected_version)
  - All retopic same message to different topics
  - All insert same attachment (dedupe_key)
- Verify eventual consistency: version correct, no lost events, dedupe works

**Approach 4: Network simulation (WS edge cases)**
- Drop WS connection mid-replay (client or server side)
- Simulate slow client (don't read from socket; trigger backpressure)
- Simulate rapid reconnects (connect, disconnect, repeat 100x)
- Verify replay correctness, backpressure disconnect, no hub crash

**Approach 5: Filesystem simulation**
- Fill disk (create large file to consume space)
- Make `.agentlip/` read-only (chmod 555)
- Delete `server.json` while hub running
- Create lock file with wrong PID
- Verify hub detects conditions, logs errors, fails gracefully

**Approach 6: Plugin simulation**
- Plugin that sleeps 10s (test timeout)
- Plugin that throws error
- Plugin that returns huge output (100MB enrichment)
- Plugin that accesses network (fetch https://example.com; test timeout)
- Verify timeout enforced, errors contained, huge outputs rejected

**Approach 7: Race condition testing (deterministic)**
- Use SQLite hooks (e.g., `update_hook`, `commit_hook`) to inject delays:
  - Pause between state write and event write (should be impossible; same txn)
  - Pause between read and write (staleness guard)
- Verify transactions are atomic (no pause observable)

**Approach 8: Chaos testing (randomized)**
- Randomly:
  - Kill hub mid-request (SIGKILL)
  - Disconnect random WS client
  - Inject random SQLite error
  - Change system clock randomly
  - Fill disk to random percentage
- Run for N iterations (e.g., 1000)
- Verify system recovers, no data loss, no corruption

**Example test case (disk full during mutation):**
```typescript
test('disk full during message insert', async () => {
  // Setup: create workspace, start hub
  const hub = await startTestHub();
  
  // Fill disk (mock or real filesystem limit)
  await fillDisk(1024); // leave 1KB free
  
  // Attempt mutation
  const res = await fetch('http://localhost:8080/api/v1/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      topic_id: 'topic_abc',
      sender: 'agent-1',
      content_raw: 'Hello world'
    })
  });
  
  // Verify: 503 response
  expect(res.status).toBe(503);
  
  // Verify: no partial state (no message row, no event row)
  const messages = await db.all('SELECT * FROM messages');
  const events = await db.all('SELECT * FROM events');
  expect(messages).toHaveLength(0);
  expect(events).toHaveLength(0);
  
  // Verify: hub still running (health check)
  const health = await fetch('http://localhost:8080/health');
  expect(health.status).toBe(200);
});
```

**Example test case (concurrent edits with expected_version):**
```typescript
test('concurrent edits with expected_version', async () => {
  // Create message (version 1)
  const { message_id } = await createMessage();
  
  // Two clients edit concurrently (both expect version 1)
  const [res1, res2] = await Promise.all([
    editMessage(message_id, 'Edit A', 1),
    editMessage(message_id, 'Edit B', 1)
  ]);
  
  // One succeeds (200, version 2), one conflicts (409, current_version 2)
  const success = [res1, res2].find(r => r.status === 200);
  const conflict = [res1, res2].find(r => r.status === 409);
  
  expect(success).toBeDefined();
  expect(conflict).toBeDefined();
  expect(conflict.body.code).toBe('VERSION_CONFLICT');
  expect(conflict.body.details.current_version).toBe(2);
  
  // Verify: only one edit persisted
  const msg = await getMessage(message_id);
  expect(msg.version).toBe(2);
  expect([msg.content_raw]).toContain(success.body.message.content_raw);
  
  // Verify: only one message.edited event
  const editEvents = await getEvents('message.edited');
  expect(editEvents).toHaveLength(1);
});
```

### 5.4 CI gates
- Linux/macOS matrix
- FTS enabled/disabled where possible
- protocol compatibility lint (additive changes only in v1)

---

## Chapter 6: Operational Playbook

### 6.1 Startup (`agentlipd up`)
- acquire writer lock
- open DB; set PRAGMAs (WAL, foreign_keys, busy_timeout, etc.)
- apply migrations (backup first)
- generate auth token if missing (cryptographically random ≥128-bit, e.g., `crypto.randomBytes(32).toString('hex')`)
- write `server.json` with token + instance_id (chmod 0600; verify perms)
- validate localhost bind (reject `0.0.0.0` unless `--unsafe-network` flag)
- serve HTTP+WS with rate limiting and input validation
- never log auth token or full message content

### 6.2 Recovery
- restart; writer lock reacquired after staleness check
- event log continues monotonic (DB-managed ids)

### 6.3 Doctor / troubleshooting
`agentlip doctor`:
- SQLite integrity check (`PRAGMA integrity_check`)
- WAL checkpoint status (`PRAGMA wal_checkpoint(PASSIVE)`)
- WAL file size (warn if >100MB; suggest checkpoint or investigate lock holders)
- Disk space check (warn if <1GB free)
- Schema version validation (compare `meta.schema_version` to expected)
- Foreign key constraint check (`PRAGMA foreign_key_check`)
- Event log gaps (verify `event_id` is contiguous; warn on gaps)
- Last event ID and timestamp
- server.json validation:
  - File exists and mode is 0600
  - PID is alive (if available)
  - `db_id` matches database `meta.db_id`
  - `/health` reachable and returns matching `instance_id`
- Orphaned lock files (writer.lock exists but no live hub)
- Plugin configuration validation (agentlip.config.ts syntax, plugin modules exist)
- Rate limit configuration sanity (not zero, not too high)

**Doctor repair mode:**
`agentlip doctor --repair`:
- Fix file permissions (chmod 0600 on server.json)
- Remove stale lock files (after confirming PID dead or /health unreachable)
- Checkpoint WAL
- Vacuum database (reclaim space)
- Reindex (rebuild indexes for performance)
- **Warning:** repair mode should not modify data; only fix metadata/locks/perms

**Doctor output format:**
```
Agentlip Doctor v1.0

Workspace: /Users/cole/project/.agentlip
Database: db_id abc-123-def-456

[✓] Database integrity: OK
[✓] Schema version: 1 (current)
[✓] Foreign keys: OK (0 violations)
[⚠] WAL size: 120 MB (recommend checkpoint)
[✓] Disk space: 45 GB free
[✓] Event log: 15234 events, no gaps
[✓] Server status: running (instance xyz-789, PID 12345)
[✓] server.json: valid, mode 0600

Warnings:
- WAL file is large; run `agentlip doctor --checkpoint` to reclaim space

Summary: 1 warning, 0 errors
```

### 6.4 Backups and migrations
- before migrations: timestamped copy of `db.sqlite3` (and WAL if present)
- derived tables recomputable (enrichments/extracted links)

### 6.5 Operational monitoring and alerting (recommended)

**Key metrics to track:**
- Event emission rate (events/sec)
- WS connection count (current, peak)
- API request rate (per endpoint)
- Database size (main + WAL)
- Disk space (free GB, % used)
- Plugin execution time (p50, p95, p99)
- Plugin timeout count
- Lock contention (503 error count)
- Auth failures (401 error count)
- Rate limit hits (429 error count)
- Hub uptime
- Last checkpoint timestamp

**Alert thresholds (suggested):**
- WAL file >100MB (warn), >500MB (critical)
- Disk space <10% or <1GB (warn), <5% or <500MB (critical)
- 503 error rate >10/min (warn), >50/min (critical; lock contention)
- 429 error rate >100/min (warn; possible DoS)
- Plugin timeout rate >10% (warn; plugin bug or slow external service)
- Event backlog >10k (warn; slow WS clients)
- Hub not responding to /health for 30s (critical)

**Monitoring implementation (v1):**
- Hub emits structured JSON logs with metrics
- External log aggregator (e.g., Loki, CloudWatch) parses and alerts
- `agentlip doctor --monitor` (future): CLI command to dump current metrics

**Example log entry (metrics event):**
```json
{
  "level": "info",
  "ts": "2026-02-04T23:45:00.000Z",
  "msg": "metrics",
  "metrics": {
    "event_rate_1m": 45.2,
    "ws_connections": 12,
    "db_size_mb": 234,
    "wal_size_mb": 15,
    "disk_free_gb": 50,
    "plugin_timeout_count_1h": 3,
    "api_rate_1m": 120,
    "lock_contention_count_1h": 0
  }
}
```

### 6.6 Operational edge cases and mitigations

**Disk space exhaustion:**
- Symptom: `SQLITE_FULL` errors, writes fail
- Detection: monitor disk usage; alert if <10% free or <1GB
- Immediate mitigation:
  - Stop accepting new messages (return 503)
  - Checkpoint WAL to flush committed data to main DB
  - Vacuum database (reclaim deleted space)
  - Rotate/compress logs
- Prevention:
  - WAL auto-checkpoint (default 1000 pages, ~4MB)
  - Log rotation policy (e.g., keep 7 days, compress older)
  - Message retention policy (future: auto-delete old messages in archived topics)

**WAL file growth unbounded:**
- Symptom: .wal file grows to hundreds of MB or GB
- Causes:
  - Long-running read transaction (CLI holding open read snapshot)
  - Checkpoint disabled or failing
  - High write rate with no reader commit points
- Detection: monitor WAL size; alert if >100MB
- Mitigation:
  - Identify long-running readers (`PRAGMA wal_checkpoint(TRUNCATE)` shows busy status)
  - Force checkpoint: `agentlip doctor --checkpoint`
  - If CLI is culprit: close stale connections/queries
  - If hub is culprit: restart hub (flush WAL on shutdown)
- Prevention:
  - CLI queries use `PRAGMA query_only = ON` and close connections promptly
  - Hub periodically checkpoints (e.g., every 10k events or 10 minutes)

**Clock skew / time travel:**
- Symptom: `ts` timestamps out of order, future timestamps, or past timestamps
- Impact: `event_id` remains authoritative (monotonic); `ts` is advisory
- Clients should sort by `event_id`, display `ts` for human reference only
- NTP sync recommended but not required
- If clock jumps backward: new events have earlier `ts` than old events (cosmetic issue only)
- If clock jumps forward: new events have far-future `ts` (cosmetic issue only)
- No correctness impact (event ordering unaffected)

**Permission errors:**
- `.agentlip/` directory not writable: hub cannot create lock, write server.json → exit with error
- `db.sqlite3` read-only: hub cannot acquire write lock → exit with error
- `server.json` wrong permissions (not 0600): security risk; hub should warn or refuse to start
- Plugin module files not readable: plugin load fails; log error; skip plugin (non-fatal)

**File descriptor exhaustion:**
- Symptom: "too many open files" error
- Causes: many WS connections, many plugin Workers, leaked file handles
- Mitigation:
  - Enforce `maxWsConnections` (default 100)
  - Close plugin Workers promptly after job completes
  - Monitor open FDs: `lsof -p <hub_pid> | wc -l`
  - Increase ulimit if needed (OS-level config)

**SQLite busy timeout edge cases:**
- Transaction retries exhaust `busy_timeout` (5s default)
- Returns `SQLITE_BUSY` → hub returns 503
- Client should retry with exponential backoff
- If persistent: indicates lock contention (long-running txn, or concurrent writer)
- Debug: `PRAGMA wal_autocheckpoint` status, identify slow transactions

**Hub port already in use:**
- Scenario: previous hub crashed, OS hasn't released port yet
- Hub startup tries to bind port, fails
- Mitigation:
  - Try binding with `SO_REUSEADDR` (allow quick rebind)
  - If still fails: try next available port (ephemeral), update server.json
  - Or: wait 5s, retry bind (TCP TIME_WAIT delay)
- CLI: if server.json has stale port, validate via `/health` (connection refused → stale)

**Multiple hub instances (lock failure):**
- Scenario: two users/processes try to start hub in same workspace
- First acquires lock, writes server.json
- Second sees lock exists, validates via `/health`
- If first hub healthy: second exits with error "hub already running at port X"
- If first hub stale (crashed): second removes lock, starts fresh
- Race: both check simultaneously, both think stale, both remove lock, both start
  - Mitigation: **atomic lock file creation** (open with O_CREAT | O_EXCL)
  - If create fails: lock exists; validate staleness
  - Prevents race condition

**Auth token rotation:**
- Scenario: admin wants to rotate token (security best practice)
- Challenge: active clients have old token
- Procedure:
  1. Generate new token
  2. Write new token to server.json
  3. Hub serves both old and new tokens for grace period (e.g., 5 min)
  4. After grace period: reject old token
  5. Clients detect 401, re-read server.json, reconnect with new token
- v1: **no token rotation support**; require hub restart for new token
- Future: `/admin/rotate-token` endpoint (requires existing valid token)

**Schema migration failure:**
- Migration SQL has syntax error or constraint violation
- Transaction rolls back automatically
- Hub exits with error "migration failed"
- Admin must fix migration SQL or restore from backup
- Backup taken before migration ensures safe rollback

**Database corruption:**
- Symptom: `SQLITE_CORRUPT` or integrity check fails
- Causes: disk failure, OS crash during write, bug in SQLite (rare)
- Detection: `PRAGMA integrity_check` in doctor command
- Mitigation:
  - Restore from timestamped backup (before last migration)
  - Replay event log (events table is append-only; may survive corruption)
  - Use `.recover` command (SQLite 3.40+) to extract data from corrupt DB
- Prevention:
  - `PRAGMA synchronous = NORMAL` (balance safety/performance)
  - Avoid forceful shutdowns (SIGKILL); use graceful shutdown (SIGTERM)
  - Use journaling filesystem (ext4, APFS) with barriers enabled

**Plugin module not found:**
- `agentlip.config.ts` references `./custom-plugins/foo.ts`, file doesn't exist
- Hub startup: log error, skip plugin, continue (non-fatal)
- Or: fail fast (exit with error) if plugin loading is critical
- v1 decision: **warn and skip missing plugins**; hub starts without them

**Plugin infinite loop / CPU spike:**
- Plugin has bug, uses 100% CPU, doesn't timeout (e.g., busy loop)
- Worker CPU limit: not enforceable in Bun Worker (JS has no preemption)
- Mitigation: **timeout is wall-clock time** (5s default); Worker killed after timeout regardless of CPU usage
- Monitor: hub tracks plugin execution time, logs slow plugins (>1s)

**Plugin memory leak:**
- Plugin allocates large objects, doesn't release
- Worker memory limit: `--max-old-space-size` flag (if Worker supports)
- v1: **no memory limit enforcement**; rely on timeout to kill runaway plugins
- Future: track Worker RSS, kill if exceeds threshold (requires OS-level monitoring)

**Network partition (localhost unreachable):**
- Scenario: firewall blocks 127.0.0.1 (misconfiguration)
- Hub binds successfully but clients cannot connect
- Detection: `curl http://127.0.0.1:<port>/health` from client machine
- If fails: check firewall, loopback interface status
- v1: assume localhost always reachable (no special handling)

---

## Chapter 7: Roadmap with Exit Criteria (Phases)

### Phase 0: Skeleton
**Build**
- workspace discovery + init
- schema apply (core + optional FTS)
- hub `/health`, lock, `server.json`

**Exit**
- Gate A passes
- `agentlipd status` works

### Phase 1: Core messaging + mutability
**Build**
- channel/topic CRUD
- send message
- edit message + tombstone delete + conflict semantics
- events table + WS replay/stream
- CLI: list/tail/page/listen (+ edit/delete)

**Exit**
- Gates B, C, G, H pass for message mutations
- CLI JSONL listen works with reconnect

### Phase 2: Retopic + attachments
**Build**
- retopic modes + fanout correctness (same-channel only)
- attachments API + CLI
- built-in URL extractor to attachments with dedupe_key

**Exit**
- Gate D passes
- attachment idempotency tests pass

### Phase 3: Plugin system v1
**Build**
- `agentlip.config.ts` loading
- Worker isolation + timeouts + circuit breaker
- linkifier → `message.enriched`
- extractor → `topic.attachment_added`

**Exit**
- Gate E passes
- Gate I passes (staleness tests)

### Phase 4: Minimal UI + SDK polish
**Build**
- `/ui` browsing and live updates
- `@agentlip/client` + served bundle if needed
- docs + examples

**Exit**
- Gate F passes
- end-to-end demo script works

---

# PART X: Master TODO Inventory

## ADRs
- [ ] ADR-0003: Replay boundary codified in docs + tests
- [ ] ADR-0005: Plugin isolation finalized (Worker defaults)
- [ ] ADR-0007: Attachment idempotency implemented (`dedupe_key` + unique index)
- [ ] ADR-0008: Edit + tombstone delete implemented (no hard deletes)

## Kernel / SQLite
- [ ] `schema_v1.sql` with `meta` init (`db_id`, `schema_version`, `created_at`)
- [ ] Optional `schema_v1_fts.sql` with graceful fallback
- [ ] Migration scaffolding using `meta.schema_version`
- [ ] DB open helper sets PRAGMAs (`WAL`, `foreign_keys`, `busy_timeout`)
- [ ] Canonical read queries (channels, topics, tail/page, attachments, replay)

## Messages (mutability)
- [ ] Add columns: `edited_at`, `deleted_at`, `deleted_by`, `version`
- [ ] Triggers: forbid hard deletes on `messages`; forbid update/delete on `events`
- [ ] Implement PATCH operations: edit, delete (tombstone), retopic
- [ ] Conflict responses include `current_version`
- [ ] Version increments on edit/delete/retopic

## Hub daemon (Bun)
- [ ] Writer lock acquisition with staleness handling
- [ ] Auth token generation (≥128-bit cryptographically random)
- [ ] `server.json` writing (chmod 0600 verification; never log token)
- [ ] Localhost-only bind validation (reject `0.0.0.0` by default)
- [ ] `/health` endpoint (`instance_id`, `db_id`, `schema_version`, `protocol_version`)
- [ ] Auth middleware for mutations + WS (constant-time token comparison)
- [ ] Rate limiting middleware (per-connection and global)
- [ ] Input validation and size limits (message ≤64KB, attachment ≤16KB, WS ≤256KB)
- [ ] Prepared statements for all SQL queries
- [ ] HTTP API endpoints v1
- [ ] WS endpoint: hello handshake, replay boundary, live fanout, backpressure
- [ ] Structured JSON logging (`request_id`, `event_id`; never tokens or full content)
- [ ] Graceful shutdown

## Events (core)
- [ ] Central helper: `insertEvent(name, scopes, entity, data)`
- [ ] Scope correctness for all event types
- [ ] Dev-mode invariant assertions for scope population

## Retopic
- [ ] Selection queries: one/later/all
- [ ] CLI guardrails (`--mode all` requires `--force`)
- [ ] Emit per-message `message.moved_topic` events
- [ ] Enforce same-channel constraint with negative tests

## Attachments
- [ ] Implement `dedupe_key` with unique index
- [ ] Insert semantics: dedupe returns existing row without new event
- [ ] Validate attachment metadata (URL format, size limits, sanitize XSS payloads)
- [ ] URL extraction built-in plugin (with configurable allowlist/blocklist)

## Plugin system
- [ ] `agentlip.config.ts` loader with config schema (workspace root only; path traversal protection)
- [ ] Worker runtime harness (RPC, timeouts, circuit breaker)
- [ ] Plugin isolation (no write access to `.agentlip/` directory)
- [ ] Linkifiers: write derived rows, emit `message.enriched`
- [ ] Extractors: insert attachments, emit `topic.attachment_added`
- [ ] Staleness guard for derived jobs (verify content + `deleted_at`; discard if tombstoned)

## CLI (`agentlip`)
- [ ] Workspace discovery + DB read-only open
- [ ] Read-only commands (channel/topic/msg/attachments/search)
- [ ] Mutations via HTTP (send/edit/delete/retopic/attach)
- [ ] `listen` via WS outputting JSONL
- [ ] Stable machine-readable error codes and schemas

## SDK (`@agentlip/client`)
- [ ] Workspace discovery helper
- [ ] Read `server.json`, validate via `/health`
- [ ] WS connect with replay and reconnect loop
- [ ] Async iterator yielding typed event envelopes
- [ ] Convenience mutation methods (send/edit/delete/retopic/attach)

### SDK usage examples

**Connect and stream events:**
```typescript
import { AgentlipClient } from '@agentlip/client';

const client = new AgentlipClient({
  workspacePath: process.cwd(),  // auto-discover from here
  afterEventId: 0,  // or load from persistent storage
  subscriptions: {
    channels: ['general'],
    topics: ['topic_xyz']
  }
});

await client.connect();

// Stream events as async iterator
for await (const envelope of client.events()) {
  console.log(envelope.event_id, envelope.name, envelope.data);
  
  // Persist last processed event_id for reconnection
  await saveCheckpoint(envelope.event_id);
  
  // Handle specific event types
  if (envelope.name === 'message.created') {
    const msg = envelope.data.message;
    console.log(`New message from ${msg.sender}: ${msg.content_raw}`);
  }
}
```

**Send message:**
```typescript
const result = await client.sendMessage({
  topicId: 'topic_xyz',
  sender: 'agent-1',
  contentRaw: 'Hello from SDK'
});

console.log(`Sent message ${result.message.id} (event ${result.event_id})`);
```

**Edit message with optimistic locking:**
```typescript
try {
  const result = await client.editMessage({
    messageId: 'msg_456',
    contentRaw: 'Updated content',
    expectedVersion: 2
  });
  console.log(`Edited to version ${result.message.version}`);
} catch (err) {
  if (err.code === 'VERSION_CONFLICT') {
    console.error(`Conflict: current version is ${err.details.current}`);
    // Retry with current version
  }
}
```

**Retopic messages:**
```typescript
const result = await client.retopicMessage({
  messageId: 'msg_100',
  toTopicId: 'topic_archive',
  mode: 'later'  // or 'one', 'all'
});

console.log(`Moved ${result.affected_count} messages`);
```

**Graceful reconnection:**
```typescript
client.on('disconnect', () => {
  console.log('Disconnected, will reconnect...');
});

client.on('reconnect', (afterEventId) => {
  console.log(`Reconnected, replaying from ${afterEventId}`);
});

// Client automatically reconnects and resumes from last processed event_id
```

**SDK interface:**
```typescript
interface AgentlipClient {
  // Connection lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  
  // Event stream
  events(): AsyncIterableIterator<EventEnvelope>;
  
  // Mutations
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
  editMessage(params: EditMessageParams): Promise<EditMessageResult>;
  deleteMessage(params: DeleteMessageParams): Promise<DeleteMessageResult>;
  retopicMessage(params: RetopicMessageParams): Promise<RetopicResult>;
  addAttachment(params: AddAttachmentParams): Promise<AddAttachmentResult>;
  renameTopic(params: RenameTopicParams): Promise<RenameTopicResult>;
  
  // Queries (direct DB read)
  listChannels(): Promise<Channel[]>;
  listTopics(channelId: string): Promise<Topic[]>;
  tailMessages(params: TailMessagesParams): Promise<Message[]>;
  pageMessages(params: PageMessagesParams): Promise<Message[]>;
  listAttachments(topicId: string): Promise<Attachment[]>;
  search(query: string, filters?: SearchFilters): Promise<Message[]>;
  
  // Events
  on(event: 'disconnect', handler: () => void): void;
  on(event: 'reconnect', handler: (afterEventId: number) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

interface EventEnvelope {
  event_id: number;
  ts: string;
  name: string;
  scope: {
    channel_id?: string;
    topic_id?: string;
    topic_id2?: string;
  };
  data: Record<string, unknown>;
}
```

## UI
- [ ] Channels/topics/messages view
- [ ] Tombstone + edit indicators
- [ ] Attachments pane (sanitize URLs; validate before rendering)
- [ ] Live updates via WS
- [ ] Security headers (CSP to prevent XSS; X-Frame-Options; X-Content-Type-Options)
- [ ] Escape all user content (message text, attachment metadata) before rendering

## Testing & CI
- [ ] Unit tests for schema + query contracts
- [ ] Integration harness (temp workspace + hub + ws client)
- [ ] Failure injection tests (plugin hang, WS slow consumer, conflict)
- [ ] Security tests:
  - [ ] Rate limiting (verify 429 responses)
  - [ ] Input size limits (reject oversized payloads)
  - [ ] SQL injection attempts (verify prepared statements)
  - [ ] Auth token leakage (verify not in logs or error responses)
  - [ ] File permissions (verify server.json is 0600)
  - [ ] Localhost bind (verify rejects `0.0.0.0` by default)
  - [ ] Plugin isolation (verify no write access to `.agentlip/`)
  - [ ] Workspace discovery (verify stops at boundary; no untrusted config loading)
- [ ] CI matrix with FTS on/off

### Edge case test suite (comprehensive)

**Transaction and crash safety:**
- [ ] Disk full during message insert: verify 503 returned, no partial state, transaction rolled back
- [ ] Lock contention timeout: verify 503 with Retry-After header
- [ ] WAL checkpoint failure (simulate I/O error): verify hub continues serving, WAL grows, doctor reports issue
- [ ] Power loss simulation (kill -9 during transaction): verify DB recovers cleanly, WAL replays, no corruption
- [ ] Corruption detection: inject corruption (SQLite debug mode), verify hub refuses to start, doctor detects issue

**WebSocket delivery guarantees:**
- [ ] Client disconnect mid-replay: reconnect with same after_event_id, verify replay restarts, no gaps
- [ ] Events committed during replay: verify boundary semantics (replay sends ≤ replay_until, live sends >replay_until), client dedupes
- [ ] Send failure mid-batch: close connection, client reconnects, verify no lost events
- [ ] Stale client (after=0 with 100k events): verify paginated replay, backpressure enforced if needed
- [ ] Clock skew: set system clock backward, emit events, verify event_id monotonic (ts may be out of order)
- [ ] Hub restart during active connections: verify graceful close (1001), clients reconnect with last processed event_id

**Concurrent mutations:**
- [ ] Two edits racing (no expected_version): both succeed, version increments twice, both events emitted
- [ ] Two edits racing (both expected_version=1): first succeeds, second conflicts (409 with current_version)
- [ ] Edit vs. delete race: delete succeeds, subsequent edit rejected (400 "cannot edit deleted message")
- [ ] Edit vs. retopic race: retopic increments version, concurrent edit conflicts
- [ ] Delete vs. delete race: second delete is idempotent (200, no new event)
- [ ] Rapid successive edits (10 edits in 1s): all succeed, version increments to 11, all events emitted
- [ ] Retopic "all" concurrent with new message insert: verify serialization (message either included or not, no partial state)
- [ ] Version overflow (simulate 2^63 edits): verify overflow handling or rejection

**Plugin and derived data:**
- [ ] ABA problem (edit back to original): verify version-based staleness guard discards outputs
- [ ] TOC/TOU race (content changes during verification): verify transactional verification prevents stale commits
- [ ] Multiple plugins concurrently: verify both succeed, dedupe_key prevents duplicate attachments
- [ ] External state change (URL title changes): verify no automatic update, dedupe prevents duplicate
- [ ] Message deleted while plugin running: verify staleness guard checks deleted_at, discards outputs
- [ ] Plugin timeout: verify hub continues serving, no enrichments committed, timeout logged
- [ ] Plugin emits outputs, message edited before commit: verify version guard discards
- [ ] Retopic during plugin execution: verify version guard discards (version changed)
- [ ] Hub restart during plugin execution: verify plugins exit, no auto-retry, messages remain un-enriched
- [ ] Concurrent edits triggering multiple plugins: verify only latest version's enrichments persist

**Retopic edge cases:**
- [ ] Retopic to same topic: verify idempotent success (200, no events)
- [ ] Retopic of tombstoned message: verify allowed, message moves (still deleted)
- [ ] Retopic with stale expected_version: verify conflict (409)
- [ ] Source topic deleted during retopic: verify 0 affected (200) or constraint error
- [ ] Target topic deleted during retopic: verify foreign key constraint error (400)
- [ ] Retopic "all" with 10k messages: verify succeeds (or rejected if batch limit enforced)
- [ ] Retopic "later" anchor at end: verify only anchor moves
- [ ] Retopic with sparse IDs: verify selection uses >= correctly
- [ ] Concurrent retopics on same topic: verify topic_id re-check prevents double-move
- [ ] Cross-channel retopic attempt: verify 400 error, no state change, no events

**Operational edge cases:**
- [ ] Disk space exhaustion: verify writes fail gracefully (503), checkpoint releases space
- [ ] WAL growth to 500MB: verify doctor reports warning, checkpoint truncates
- [ ] Clock skew (set clock +1 hour): verify event_id order preserved, ts jumps forward
- [ ] Permission error (server.json not writable): verify hub exits with clear error
- [ ] File descriptor exhaustion: verify connection limit enforced, new connections rejected (503)
- [ ] SQLite busy timeout: simulate long txn, concurrent write, verify 503 after timeout
- [ ] Hub port already in use: verify SO_REUSEADDR or port increment, server.json updated
- [ ] Multiple hub instances: verify lock file prevents second start (or removes stale lock)
- [ ] Schema migration failure: verify rollback, backup preserved, hub exits with error
- [ ] Database corruption: verify integrity check fails, doctor detects, hub refuses to start
- [ ] Plugin module not found: verify warning logged, hub starts without plugin
- [ ] Plugin infinite loop: verify timeout kills Worker (wall-clock, not CPU-based)
- [ ] Plugin memory leak: verify timeout eventually kills (no memory limit in v1)

**Attachment idempotency:**
- [ ] Insert same attachment twice: verify dedupe (no new event, existing ID returned)
- [ ] Concurrent attachment inserts with same dedupe_key: verify unique constraint, one succeeds
- [ ] Dedupe_key computed by hub (not provided): verify deterministic computation, idempotent

**Event log integrity:**
- [ ] Event IDs strictly increasing: insert 1000 messages concurrently, verify event_id sequence has no gaps
- [ ] Event immutability: attempt UPDATE/DELETE on events table, verify trigger prevents
- [ ] Message hard delete prevention: attempt DELETE on messages table, verify trigger prevents
- [ ] Scope correctness: verify every event has correct scope_channel_id, scope_topic_id, scope_topic_id2 (audit all event types)

**Rate limiting:**
- [ ] Per-connection limit (100 req/s): send 200 requests in 1s, verify 429 after 100
- [ ] Global limit (1000 req/s): 20 clients send 60 req/s each, verify 429 after 1000 total
- [ ] Rate limit reset: wait for window to expire, verify limit resets

**Security boundary tests:**
- [ ] SQL injection in message content: insert `'; DROP TABLE messages; --`, verify no SQL execution
- [ ] SQL injection in channel name: create channel with `'; DROP TABLE channels; --`, verify no SQL execution
- [ ] Oversized message (100KB): verify 400 rejection
- [ ] Oversized attachment (100KB): verify 400 rejection
- [ ] Oversized WS message (1MB): verify connection closed
- [ ] Auth token in logs: send request with token, verify token not in log output (search for token string)
- [ ] Auth token in error response: send invalid request, verify token not echoed in response
- [ ] server.json permissions: create server.json with mode 0644, verify hub fixes or refuses to start
- [ ] Localhost bind check: configure hub with 0.0.0.0, verify rejection (unless --unsafe-network)
- [ ] Plugin write attempt: plugin tries to write to `.agentlip/db.sqlite3`, verify permission denied or isolation prevents
- [ ] Workspace discovery upward traversal: create `.agentlip/` in parent dir, run CLI in child, verify stops at workspace root

**Migration edge cases:**
- [ ] Upgrade 1→2 with data: apply migration, verify schema_version updated, data intact
- [ ] Downgrade attempt (schema_version=2, hub expects 1): verify hub refuses to start
- [ ] Migration with constraint violation: simulate migration that fails, verify rollback, backup preserved
- [ ] Concurrent hub start during migration: verify second hub sees lock, waits or exits

## Docs
- [ ] Protocol doc (handshake, replay, event types, conflicts)
- [ ] Ops doc (startup, recovery, migrations, doctor)
- [ ] Security doc:
  - [ ] Threat model and trust boundaries
  - [ ] Auth token handling and rotation
  - [ ] Plugin security model and risks (v1: network/filesystem access)
  - [ ] Privacy implications (immutable event log; no secure erasure)
  - [ ] Safe defaults and configuration
  - [ ] Rate limits and resource constraints
- [ ] Examples: multi-agent + human demo script

---

# Appendices

## Appendix A: Glossary
- **Workspace:** Repository directory containing `.agentlip/` state
- **Channel:** Long-lived bucket for project/team scope
- **Topic:** Thread entity with stable ID; belongs to a channel
- **Message:** Stable identity; mutable via explicit edit; deletable via tombstone
- **Event:** Durable append-only log entry ordered by `event_id`; the integration surface
- **Enrichment:** Derived structured expansions for tokens in message text
- **Attachment:** Topic-scoped structured grounding metadata
- **Single writer:** Only the hub process writes to SQLite

## Appendix B: Risk Register (with mitigations)

### Operational Risks
1. **Duplicate attachments due to retries**
   - Mitigation: `dedupe_key` + unique index + no-event on dedupe
   - Residual risk: client-computed dedupe_key may have collisions (hash-based); use full URL as dedupe_key for v1

2. **WS clients miss events due to replay/live boundary bug**
   - Mitigation: explicit `replay_until` contract + integration tests
   - Residual risk: events committed exactly at replay_until boundary may cause edge cases; client deduplication handles

3. **Two hub instances (lock file race)**
   - Mitigation: atomic lock file creation (O_CREAT|O_EXCL) + /health validation + fail fast
   - Residual risk: NFS or network filesystem may not guarantee atomicity; detect via instance_id mismatch

4. **Plugin hangs (infinite loop, network timeout)**
   - Mitigation: Worker isolation, wall-clock timeouts (not CPU-based), circuit breaker after N failures
   - Residual risk: Worker CPU spike may degrade hub performance (JS single-threaded); monitor hub CPU

5. **Schema drift breaks stateless CLI**
   - Mitigation: additive evolution + migrations + query contract tests
   - Residual risk: schema_version mismatch between CLI and DB; CLI should check and warn

6. **Edits cause stale derived outputs**
   - Mitigation: version-match + content-match + `deleted_at` staleness guard in same transaction as insert; re-enqueue on edit; Gate I
   - Residual risk: ABA problem if only content compared; version comparison required

7. **WAL file growth unbounded (reader holds snapshot)**
   - Mitigation: monitor WAL size, periodic checkpoint, CLI closes queries promptly
   - Residual risk: long-running CLI query (e.g., FTS search) may prevent checkpoint; timeout CLI queries

8. **Disk space exhaustion (WAL + logs)**
   - Mitigation: monitor disk usage, checkpoint on low space, log rotation, reject writes if <1GB free
   - Residual risk: rapid growth may fill disk before monitoring detects; preemptive limits

9. **Lock contention timeout (busy database)**
   - Mitigation: `busy_timeout` 5s, return 503 with Retry-After, client exponential backoff
   - Residual risk: pathological write pattern (e.g., retopic 100k messages) may block all writes; enforce batch limits

10. **Clock skew (NTP failure, manual time change)**
    - Mitigation: event_id is authoritative order, not `ts`; document client sorting behavior
    - Residual risk: `ts` may be confusing in UI (out of order); display warning if `ts` jumps >1 hour

11. **Migration failure mid-apply (constraint violation)**
    - Mitigation: migrations in transaction, backup before apply, rollback on error, admin manual intervention
    - Residual risk: backup may be stale if writes occurred during migration prep; stop hub before migration

12. **Database corruption (disk failure, OS crash)**
    - Mitigation: `PRAGMA synchronous=NORMAL`, avoid SIGKILL, journaling filesystem, integrity checks in doctor
    - Residual risk: unrecoverable corruption; restore from backup, replay event log (events table append-only)

13. **Plugin module not found or syntax error**
    - Mitigation: warn and skip plugin, hub starts anyway (graceful degradation)
    - Residual risk: missing plugin may be critical; option to fail-fast if `plugin.required = true`

14. **Hub port already in use (previous crash)**
    - Mitigation: SO_REUSEADDR, retry bind, fallback to ephemeral port
    - Residual risk: clients may have stale server.json; validate via /health

15. **File descriptor exhaustion (many WS connections, leaked handles)**
    - Mitigation: enforce maxWsConnections (100), close Workers promptly, monitor open FDs
    - Residual risk: OS-level ulimit may be low; document requirement (e.g., ulimit -n 1024)

### Security Risks
16. **Auth token leakage (logs, error messages, file perms)**
    - Mitigation: chmod 0600 on server.json; never log token; constant-time comparison; no token in error responses
    - Residual risk: token may leak via process args if passed as flag; use file-based token only

17. **SQL injection via user inputs**
    - Mitigation: prepared statements only; no string concatenation in queries; input validation
    - Residual risk: none if policy enforced; audit all queries

18. **DoS via API abuse (large payloads, rapid requests)**
    - Mitigation: rate limits (per-connection + global); size limits on all inputs; backpressure on WS
    - Residual risk: distributed attack (many clients); add IP-based limit (future, requires reverse proxy)

19. **Malicious plugin (filesystem access, network abuse, resource exhaustion)**
    - Mitigation: Worker isolation; timeouts; no write access to `.agentlip/`; future: explicit capability grants
    - Residual risk: v1 plugins CAN access network and filesystem (Worker limitations); document risk

20. **Path traversal during workspace discovery**
    - Mitigation: stop at filesystem boundary; never load `agentlip.config.ts` from untrusted parent dirs
    - Residual risk: symlink attack (`.agentlip` symlinked to attacker-controlled dir); resolve symlinks, validate ownership

21. **Sensitive data in event log (user thinks "deleted" = erased)**
    - Mitigation: document clearly that tombstones do not erase; events are immutable; old content may persist in historical events
    - Residual risk: users expect secure deletion; add "archive-and-purge" workflow (future, requires v2 with event log truncation)

22. **Untrusted workspace config (code execution via `agentlip.config.ts`)**
    - Mitigation: only load from discovered workspace root; document that workspace is trusted; consider signature verification (future)
    - Residual risk: developer clones malicious repo, runs CLI; code executes; warn on untrusted workspace

23. **XSS or injection via attachment URLs in UI**
    - Mitigation: UI must sanitize/escape attachment metadata; CSP headers; URL validation
    - Residual risk: complex URL schemes (javascript:, data:) may bypass filters; whitelist schemes (http, https, file)

24. **Replay timing attack (infer message content from event timing)**
    - Mitigation: v1 none; localhost-only reduces risk
    - Residual risk: malicious local process could observe timing; future: add jitter to event timestamps

25. **Auth token brute force (if short token)**
    - Mitigation: token is ≥128-bit (32 hex chars = 128 bits entropy); constant-time comparison prevents timing attacks
    - Residual risk: none if token generation secure (crypto.randomBytes)

26. **TOCTOU in staleness guard (content changes between read and insert)**
    - Mitigation: perform verification read and derived insert in same transaction
    - Residual risk: none if transaction isolation correct

27. **Retopic fanout missing subscriber (topic_id2 not indexed)**
    - Mitigation: index on scope_topic_id2; verify fanout logic includes topic_id2 matches
    - Residual risk: missing index would cause slow fanout, not incorrect fanout

28. **Event log gaps (event_id skip due to rollback)**
    - Mitigation: SQLite autoincrement reuses rolled-back IDs in same session, but not across restarts; gaps possible after crash
    - Residual risk: clients assume contiguous event_id; doctor should detect gaps and warn

29. **Hub crashes during graceful shutdown (partial cleanup)**
    - Mitigation: critical cleanup (lock removal, server.json deletion) should be idempotent; next start cleans up stale files
    - Residual risk: stale server.json may confuse clients; validate via /health

30. **Client storage corruption (loses last processed event_id, replays millions)**
    - Mitigation: client decides replay policy (full replay or skip history); hub enforces maxEventReplayBatch to paginate
    - Residual risk: full replay of large event log (1M+ events) may take minutes; consider replay TTL (e.g., only replay last 7 days)

## Appendix C: Verification checklist (pre-merge)

### Correctness
- [ ] Mutation path uses one transaction for state+event
- [ ] Event scopes populated correctly
- [ ] Replay query is index-backed (EXPLAIN QUERY PLAN in dev)
- [ ] WS replay/live boundary tests pass
- [ ] Conflict semantics tests pass (expected_version)
- [ ] Tombstone delete leaves row intact + emits event
- [ ] No hard deletes possible (trigger enforced)
- [ ] Plugin timeout tests pass
- [ ] Derived staleness guard tests pass (including tombstone check)

### Edge case correctness (critical paths)
- [ ] Disk full during mutation: verify 503 returned, no partial state
- [ ] Lock timeout during mutation: verify 503 with Retry-After
- [ ] WAL checkpoint failure: verify hub continues serving (degraded mode)
- [ ] Crash during transaction: verify WAL recovery, atomicity preserved
- [ ] Concurrent edits (no expected_version): both succeed, correct version sequence
- [ ] Concurrent edits (with expected_version): second conflicts with current_version
- [ ] Edit of tombstoned message: verify rejection (400)
- [ ] Delete of already-deleted message: verify idempotent success (200)
- [ ] Retopic to same topic: verify idempotent success (200, no events)
- [ ] Retopic with concurrent topic deletion: verify handles gracefully (0 affected or constraint error)
- [ ] Retopic with concurrent retopic: verify topic_id re-check prevents anomalies
- [ ] Plugin staleness (ABA problem): verify version-based guard discards
- [ ] Plugin staleness (TOC/TOU): verify transactional check-then-insert
- [ ] Plugin timeout: verify hub continues, no stale commits
- [ ] Message deleted during plugin run: verify deleted_at guard discards
- [ ] Attachment dedupe: verify unique constraint, no duplicate events
- [ ] WS events during replay: verify boundary semantics, client dedupes
- [ ] WS disconnect mid-replay: verify reconnect resumes correctly
- [ ] Clock skew: verify event_id monotonicity preserved (ts may be out of order)
- [ ] Rapid successive edits: verify all succeed, no lost events, version correct
- [ ] Retopic "all" with 10k messages: verify succeeds or batch limit enforced
- [ ] Multiple hub instances: verify lock prevents concurrent start
- [ ] Schema migration failure: verify rollback, backup preserved
- [ ] Database corruption: verify doctor detects, hub refuses to start

### Security
- [ ] All SQL uses prepared statements (audit for string concatenation)
- [ ] Auth token never appears in logs or error responses
- [ ] `server.json` has mode 0600 (verify programmatically)
- [ ] Hub rejects `0.0.0.0` bind by default
- [ ] Rate limits enforced (test with burst requests)
- [ ] Input size limits enforced (test with oversized payloads)
- [ ] Plugin isolation verified (cannot write to `.agentlip/`)
- [ ] Workspace discovery stops at boundary (test with untrusted parent)
- [ ] Error responses are generic (no path/token leakage)

### Security edge cases
- [ ] SQL injection in all text fields: verify prepared statements prevent
- [ ] Auth token in logs (search for token literal): verify not present
- [ ] Auth token in error response (test invalid request): verify not echoed
- [ ] server.json wrong permissions: verify hub fixes or refuses to start
- [ ] Localhost bind with 0.0.0.0: verify rejection (unless --unsafe-network flag)
- [ ] Plugin filesystem write: verify isolation prevents or permission denied
- [ ] Plugin network abuse: verify timeout limits duration (v1: no network blocking)
- [ ] Rate limit bypass (multiple connections): verify global limit enforced
- [ ] Oversized payload (message, attachment, WS): verify size limits enforced at all layers
- [ ] XSS in attachment URL (UI): verify sanitization before rendering

### Operational robustness
- [ ] Disk space monitoring: verify doctor reports low disk space
- [ ] WAL size monitoring: verify doctor reports large WAL (>100MB)
- [ ] WAL checkpoint: verify `agentlip doctor --checkpoint` succeeds
- [ ] File descriptor limit: verify connection limit prevents exhaustion
- [ ] Hub graceful shutdown: verify closes WS (1001), flushes WAL, removes lock
- [ ] Hub crash cleanup: verify stale lock removed on next start
- [ ] Hub port conflict: verify SO_REUSEADDR or port increment
- [ ] Plugin module missing: verify warning logged, hub starts
- [ ] Plugin infinite loop: verify timeout enforced (wall-clock)
- [ ] Long-running CLI query: verify doesn't block hub writes (WAL)
- [ ] Multiple simultaneous CLI queries: verify all succeed (read concurrency)
