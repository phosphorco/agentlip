# Plan: Event Trace Explorer (Hub UI)

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal and Motivation

Agentlip already has an append-only event log (HTTP replay + WS live stream), but humans currently can't *see* it without digging into DB queries or logs.

The **Event Trace Explorer** makes the event stream first-class in the Hub UI so reviewers/operators can:
- answer "what happened, when, and why?" (audit/debug)
- trace message/topic lifecycle changes (create/edit/delete/move)
- correlate derived behavior (attachments, enrichments) with upstream causes
- browse quickly via filters + a compact timeline

This is intentionally **read-only** and **incremental**: no frontend framework migration required.

## Scope

### Delivers

- **UI:** new `/ui/events` page
  - timeline view (ordered by `event_id`)
  - details view (expand/collapse JSON)
  - basic filtering (by channel/topic + event name substring)
  - "tail" mode (keeps appending live events; pause/resume)
  - navigation entry: `/ui/events` is reachable from the existing UI pages

- **HTTP API:** extend `GET /api/v1/events` to support Event Trace Explorer efficiently:
  - include `scope` and `entity` fields for each event (**additive**)
  - include `replay_until` in response (**additive**)
  - add `tail=<n>` query param to fetch the most recent N events
  - add optional scope filters (e.g. `channel_id`, `topic_id`) (**additive**)

- **WS payload:** include `entity` in WS `EventEnvelope` (**additive**, see Gate D)

- **Docs + tests:** update protocol docs for the extended events response; add hub tests covering `/ui/events` and new `/api/v1/events` behavior.

### Explicitly Excludes (Non-goals)

- **Auth model changes** (no login/session cookies; no read-only tokens). If UI is hosted beyond trusted networks, handle via a separate plan.
- Full-text search / FTS UI.
- Large-topic virtualization/infinite scroll (messages UI). This plan focuses on the events view.
- Export/snapshot tooling.
- Multi-instance browser and ops dashboard.
- "Modern UI packaging" migration to a separate frontend build.
- Server-side "event name contains …" query (MVP uses client-side substring filter only).

## Product Shape (MVP)

- Default view: **last 200 events** (via `tail=200`), then live-tail via WS.
- Timeline rows show: `event_id`, timestamp, `name`, `scope`, `entity`.
- Clicking an event reveals full JSON details.
- Empty state: fresh hub shows "No events yet".
- Bounded timeline: show "Showing last N events" when older items are evicted.
- "Jump to entity" links:
  - topic-scoped events link to `/ui/topics/:topic_id`
  - message-scoped events link to `/ui/topics/:topic_id#msg_<message_id>` (best-effort highlight)

## Codebase Context

| Area | Path | Notes |
|---|---|---|
| Hub UI router | `packages/hub/src/ui.ts` | `handleUiRequest()`, inline HTML/CSS/JS pattern |
| Hub server mounts UI | `packages/hub/src/index.ts` | `/ui/*` handling; baseUrl computation |
| Events HTTP API | `packages/hub/src/apiV1.ts` | `handleListEvents()` currently returns minimal event shape |
| WS implementation | `packages/hub/src/wsEndpoint.ts` | WS `EventEnvelope` and replay/live fanout |
| Kernel event model | `packages/kernel/src/events.ts` | `ParsedEvent` includes `scope` + `entity`; `replayEvents()` supports channelIds/topicIds |
| Protocol package | `packages/protocol/src/index.ts` | Error codes + health response (WS/event envelope types are not centralized here today) |
| Client WS types | `packages/client/src/types.ts` | Client-side WS types (keep additive changes aligned with hub WS implementation) |
| Protocol docs | `docs/protocol.md` | update `/api/v1/events` section |

## Interface Contracts

This plan is additive: the kernel already produces `ParsedEvent` with `scope` + `entity`. The Hub API will expose those fields over HTTP (Gate A) and over WS (Gate D) so the UI can filter/link without parsing `data_json`.

### Event scope / entity (kernel reference)

Kernel types live in `packages/kernel/src/events.ts`:

```ts
type EventScope = {
  channel_id?: string | null
  topic_id?: string | null
  topic_id2?: string | null
}

type EventEntity = {
  type: string
  id: string
}
```

Notes:
- `scope.*` may be `null` (stored columns are nullable); treat missing and null as "absent".
- `entity.type` is not exhaustively enumerated in v1 (plugins/future features may add new types).
- `entity` is required for kernel events (events table columns `entity_type`/`entity_id` are NOT NULL). HTTP `GET /api/v1/events` should always include `entity`. WS `event.entity` is optional until Gate D; UI must tolerate missing `event.entity` on WS envelopes.

### HTTP response shape: `GET /api/v1/events` (after Gate A)

```ts
type ListEventsResponse = {
  replay_until: number
  events: Array<{
    event_id: number
    ts: string // ISO timestamp
    name: string // e.g. "message.created"
    data_json: Record<string, unknown>
    scope: EventScope
    entity: EventEntity
  }>
}
```

### WS envelope (current + additive)

WS event envelopes already include `scope` + `data`. Gate D adds optional `entity?: EventEntity`. Clients must ignore unknown fields.

---

## Gate A - Extend `GET /api/v1/events` for explorer use

### Deliverables

1. Response event objects become **strictly additive**:
   - keep existing fields (including `data_json`)
   - add (using kernel's existing `ParsedEvent` fields, mapped to JSON):
     - `scope: EventScope` (see Interface Contracts above)
     - `entity: EventEntity` (see Interface Contracts above)
   - **Implementation**: `handleListEvents()` in `packages/hub/src/apiV1.ts` maps kernel's `ParsedEvent.scope` and `ParsedEvent.entity` directly to the response JSON.
2. Response includes `replay_until: number` (current max event_id).
3. Add query params:
   - `tail=<n>`: return the most recent N events
     - server clamps `n` to `1..1000`
     - implementation: query by `ORDER BY event_id DESC LIMIT ?` (prefer a kernel helper), then reverse to ascending before returning
     - **mutually exclusive** with `after` (if both provided → 400 `INVALID_INPUT`)
   - `channel_id=<id>` (repeatable; OR semantics) and `topic_id=<id>` (repeatable; OR semantics)
     - IDs must match `/^[a-zA-Z0-9_-]+$/`; malformed IDs → 400 `INVALID_INPUT`
     - non-existent IDs return empty results (not an error)
   - **Index check:** confirm indexes exist on `events(scope_channel_id, event_id)`, `events(scope_topic_id, event_id)`, and `events(scope_topic_id2, event_id)` (see `idx_events_scope_*` in `packages/kernel/migrations/0001_schema_v1.sql`).
4. Update `docs/protocol.md` to document additive fields + query param semantics (including `tail`/`after` interaction).

### Acceptance

- Existing callers (`/api/v1/events?after=...`) still work.
- `tail` mode returns recent events without scanning from event 0.
- Filter params reduce the dataset returned.

### Verification

- Unit tests in `packages/hub/src/apiV1.test.ts`:
  - events include `scope` + `entity`
  - `tail=2` returns 2 events and includes `replay_until`
  - `after` + `tail` together returns 400
  - `channel_id=...` filter returns only events for that channel
  - `channel_id=<malformed>` returns 400

---

## Gate B - Add `/ui/events` page (timeline + details + live tail)

### Deliverables

1. `/ui/events` route added to `handleUiRequest()`.
2. Navigation:
   - `/ui/events` page includes a simple header nav (back to Channels)
   - existing UI pages expose a link to `/ui/events` (global nav entry)
3. UI load behavior:
   - initial load: `GET /api/v1/events?tail=200` → render
   - empty state: render "No events yet" when list is empty
   - error state: render a visible error block (same pattern as existing pages)
   - **Error recovery:**
     - on HTTP 503: show "Hub busy, retrying..." and auto-retry after `Retry-After` header (default 2s), max 3 attempts
     - on HTTP 401/403: show "Authentication failed" with no retry (likely stale token)
     - on network error: show "Network error" with manual "Retry" button
     - on malformed JSON response: show "Invalid response from hub" and log to console for debugging
4. Live tail:
   - connect WS at `/ws` (requires `token=<authToken>` query param per existing auth model)
   - send hello message (per existing WS protocol in `docs/protocol.md`):
     ```json
     {
       "type": "hello",
       "after_event_id": <httpResponse.replay_until>
     }
     ```
     - omit `subscriptions` for wildcard mode (subscribe to all events)
     - when scope filters are set, include `subscriptions: { "channels": [...], "topics": [...] }`
   - the UI receives `EventEnvelope` messages; it uses `event.scope` for filtering and (if present) `event.entity` for deep-link rendering
   - keep a bounded in-memory list (e.g. max 2000). When exceeding cap, evict oldest and show "Showing last 2000 events".
   - pause/resume tailing:
     - while paused: keep WS connected and buffer up to 500 events
     - on resume: flush buffered events and render a small "N events received while paused" separator
   - **WS reconnection handling:**
     - on WS close/error: show a visible "Disconnected" indicator; attempt reconnect with exponential backoff (1s, 2s, 4s, max 30s)
     - on reconnect: send `hello` with `after_event_id` set to the last received event_id; merge incoming events (dedupe by `event_id`)
     - after 3 failed reconnect attempts: stop auto-retry and show "Connection lost. Click to retry."
   - **Ordering guarantee:** initial WS connect should use `after_event_id = <httpResponse.replay_until>` to avoid gaps between HTTP fetch and WS replay. On reconnect, use `after_event_id = <lastReceivedEventId>`.
5. Filtering (MVP):
   - client-side substring filter for `event.name`
   - client-side filter by `scope.channel_id` / `scope.topic_id`
   - (optional) when a scope filter is set, re-fetch via scoped HTTP params and reconnect WS with matching subscriptions
6. **DOM rendering performance:**
   - use a single container and batch DOM insertions via `DocumentFragment` + DOM APIs (`textContent`), avoid `innerHTML` to preserve XSS protections
   - for live tail, append rows individually (keep scroll position stable unless user is at bottom)
   - JSON details panel: render lazily on click (do not pre-render 2000 JSON blobs)
   - if rendering >500 events takes >1s, log a console warning and consider reducing `tail` default
7. **Backpressure for high-volume streams:**
   - if WS delivers >50 events/sec sustained for 5s, show "High volume - some events may be delayed"
   - if paused buffer exceeds 500, drop oldest buffered events and show "Dropped X events while paused"

### Acceptance

- Human can open `/ui/events` and immediately see recent events.
- New events appear live while tailing is enabled.
- Pausing does not lose events (within buffer bound) and resuming is visually obvious.
- Clicking an event reveals its JSON details without page reload.
- Event JSON is rendered via `JSON.stringify()` + textContent (never innerHTML) to prevent XSS from malicious event payloads.

### Verification

Manual:
- Start hub, create channel/topic/message, open `/ui/events`, confirm:
  - event rows appear for channel/topic/message actions
  - live updates arrive without refresh
  - pause/resume shows buffered indicator

Automated:
- Extend `packages/hub/src/ui.test.ts` to assert:
  - `GET /ui/events` returns HTML
  - page contains a recognizable init function (e.g. `loadEvents`) and WS wiring

---

## Gate C - Navigation + deep links from events to entities

### Deliverables

- For events with `scope.topic_id`, link to `/ui/topics/:topic_id`.
- For message-scoped events (where `entity.type === "message"`), link to `/ui/topics/:topic_id#msg_<entity.id>`.
  - **Note**: `scope.topic_id` provides the containing topic; `entity.id` provides the message ID.
- **ID validation:** `topic_id` and `message_id` must match the ID regex from Gate A (`/^[a-zA-Z0-9_-]+$/`) before rendering as links; otherwise render as plain text (defense against crafted payloads).
- Topic messages page: add minimal hash handling to:
  - scroll-to + highlight the message if present in the DOM
  - otherwise show a clear "Message not currently loaded" hint (MVP is last-50 only)

### Acceptance

- Clicking "view topic" from an event lands in the correct topic.
- Clicking "view message" either scrolls+highlights or clearly indicates it's not in the current view.

### Verification

- Automated: extend `packages/hub/src/ui.test.ts` to assert message hash appears in generated links for message-scoped events.
- Manual: click an old message event (not in last 50) → hint is shown.

---

## Gate D - WS envelope `entity` field + type/docs alignment

### Deliverables

1. **Hub WS layer**: Modify `packages/hub/src/wsEndpoint.ts` to populate an optional `entity: { type: string; id: string }` field in outgoing WS event envelopes (using kernel's `ParsedEvent.entity`).
2. **Client types**: Update `packages/client/src/types.ts` `EventEnvelope` to include optional `entity?: { type: string; id: string }` (additive).
3. **Docs**: Update `docs/protocol.md` WS event envelope description to document optional `entity`.
4. **No shared-types refactor in this plan**: keep `@agentlip/protocol` unchanged; treat the WS envelope change as additive alignment between hub + client.

### Acceptance

- Existing WS clients continue to function (extra fields tolerated).
- Explorer can link reliably using `event.entity` without parsing `data`.

### Verification

- `bun run typecheck`
- `bun test`

---

## Operability

1. **Hub-side logging:** Log at INFO level when `/ui/events` is served and when WS connections are established with `after_event_id`. Log at WARN when scope filter queries exceed 500ms.
2. **Browser console logging:** Log WS state transitions (connecting/connected/disconnected/reconnecting) and any errors to console for debugging.
3. **Health signal:** The `/health` endpoint already exists; no changes needed. If the UI can't connect, the problem is likely network/auth (token mismatch).
4. **Graceful degradation:** If initial HTTP fetch fails, show error with retry button. If WS never connects, the timeline still shows the initial snapshot (no live updates). Show "Live updates unavailable" status if WS fails after 3 reconnect attempts.
5. **Debugging stale events:** If events appear stale (timestamps far in past), operator should check hub process time sync. The UI displays raw `ts` from server; no client-side clock adjustment.

## Security Assumptions (must be true for safe deployment)

1. Hub binds to localhost only by default; never enable unsafe networking without an authenticating reverse proxy.
2. Anyone who can access `/ui/*` is trusted equivalent to the bearer-token holder (token is present in page source today).
3. Event data contains full message content; treat it as sensitive (PII-equivalent).
4. Browser environment is trusted (extensions/devtools can extract embedded token).
5. WS connections require the same auth token as HTTP API (passed via `token` query param); no additional WS-specific auth is introduced.

## Risks

- **Bulk extraction via `tail`:** `tail=<n>` makes bulk extraction easier; mitigated by server-side clamp (1..1000) and the localhost-only deployment assumption.
- **Hub restart during live tail:** If hub restarts, WS connections drop. The UI's reconnect logic will re-fetch from `after_event_id`; if that `event_id` no longer exists (e.g., DB was wiped), hub returns events from the beginning. UI should detect a discontinuity (received `event_id` < expected) and warn "Event history may be incomplete".
- **Large `data_json` payloads:** Some events (e.g., enrichments) may have multi-KB `data_json`. The `tail=1000` response could exceed 10MB.

## Future Considerations (out of scope)

- **Noisy wildcard live-tail:** Follow-up can use WS subscriptions when scope filters are applied.
- **CSP hardening:** Currently allows `'unsafe-inline'` for UI scripts; hardening is a separate effort.
- **Compact mode:** Add a `compact=true` flag that omits `data_json` from the list response for bandwidth-sensitive use cases.
