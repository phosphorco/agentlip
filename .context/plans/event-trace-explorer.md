# Plan: Event Trace Explorer (Hub UI)

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal and Motivation

Agentlip already has an append-only event log (HTTP replay + WS live stream), but humans currently can’t *see* it without digging into DB queries or logs.

The **Event Trace Explorer** makes the event stream first-class in the Hub UI so reviewers/operators can:
- answer “what happened, when, and why?” (audit/debug)
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
  - “tail” mode (keeps appending live events; pause/resume)
  - navigation entry: `/ui/events` is reachable from the existing UI pages

- **HTTP API:** extend `GET /api/v1/events` to support Event Trace Explorer efficiently:
  - include `scope` and `entity` fields for each event (**additive**)
  - include `replay_until` in response (**additive**)
  - add `tail=<n>` query param to fetch the most recent N events
  - add optional scope filters (e.g. `channel_id`, `topic_id`) (**additive**)

- **WS payload (optional but recommended):** include `entity` in WS `EventEnvelope` (**additive**)

- **Docs + tests:** update protocol docs for the extended events response; add hub tests covering `/ui/events` and new `/api/v1/events` behavior.

### Explicitly Excludes (Non-goals)

- **Auth model changes** (no login/session cookies; no read-only tokens). If UI is hosted beyond trusted networks, handle via a separate plan.
- Full-text search / FTS UI.
- Large-topic virtualization/infinite scroll (messages UI). This plan focuses on the events view.
- Export/snapshot tooling.
- Multi-instance browser and ops dashboard.
- “Modern UI packaging” migration to a separate frontend build.
- Server-side “event name contains …” query (MVP uses client-side substring filter only).

## Product Shape (MVP)

- Default view: **last 200 events** (via `tail=200`), then live-tail via WS.
- Timeline rows show: `event_id`, timestamp, `name`, `scope`, `entity`.
- Clicking an event reveals full JSON details.
- Empty state: fresh hub shows “No events yet”.
- Bounded timeline: show “Showing last N events” when older items are evicted.
- “Jump to entity” links:
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
| Client WS types | `packages/client/src/types.ts` | `EventEnvelope` type (additive extension ok) |
| Protocol docs | `docs/protocol.md` | update `/api/v1/events` section |

---

## Gate A — Extend `GET /api/v1/events` for explorer use

### Deliverables

1. Response event objects become **strictly additive**:
   - keep existing fields (including `data_json`)
   - add:
     - `scope: { channel_id, topic_id, topic_id2 }`
     - `entity: { type, id }`
2. Response includes `replay_until: number` (current max event_id).
3. Add query params:
   - `tail=<n>`: return the most recent N events
     - server clamps `n` to `1..1000`
     - **mutually exclusive** with `after` (if both provided → 400 `INVALID_INPUT`)
   - `channel_id=<id>` (repeatable; OR semantics) and `topic_id=<id>` (repeatable; OR semantics)
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

---

## Gate B — Add `/ui/events` page (timeline + details + live tail)

### Deliverables

1. `/ui/events` route added to `handleUiRequest()`.
2. Navigation:
   - `/ui/events` page includes a simple header nav (back to Channels)
   - existing UI pages expose a link to `/ui/events` (global nav entry)
3. UI load behavior:
   - initial load: `GET /api/v1/events?tail=200` → render
   - empty state: render “No events yet” when list is empty
   - error state: render a visible error block (same pattern as existing pages)
4. Live tail:
   - connect WS with `after_event_id = highest_loaded_event_id`
   - keep a bounded in-memory list (e.g. max 2000). When exceeding cap, evict oldest and show “Showing last 2000 events”.
   - pause/resume tailing:
     - while paused: keep WS connected and buffer up to 500 events
     - on resume: flush buffered events and render a small “N events received while paused” separator
5. Filtering (MVP):
   - client-side substring filter for `event.name`
   - client-side filter by `scope.channel_id` / `scope.topic_id`
   - (optional) when a scope filter is set, re-fetch via scoped HTTP params and reconnect WS with matching subscriptions

### Acceptance

- Human can open `/ui/events` and immediately see recent events.
- New events appear live while tailing is enabled.
- Pausing does not lose events (within buffer bound) and resuming is visually obvious.
- Clicking an event reveals its JSON details without page reload.

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

## Gate C — Navigation + deep links from events to entities

### Deliverables

- For events with `scope.topic_id`, link to `/ui/topics/:topic_id`.
- For message-scoped events, link to `/ui/topics/:topic_id#msg_<message_id>`.
- Topic messages page: add minimal hash handling to:
  - scroll-to + highlight the message if present in the DOM
  - otherwise show a clear “Message not currently loaded” hint (MVP is last-50 only)

### Acceptance

- Clicking “view topic” from an event lands in the correct topic.
- Clicking “view message” either scrolls+highlights or clearly indicates it’s not in the current view.

### Verification

- UI test asserts message hash appears in generated links.
- Manual: click an old message event (not in last 50) → hint is shown.

---

## Gate D — WS envelope (optional) + type/docs alignment

### Deliverables

- Add `entity: { type, id }` to WS event envelopes (**additive**).
- Update `packages/client/src/types.ts` `EventEnvelope` to include optional `entity?: { type: string; id: string }`.
- Update `docs/protocol.md` WS event envelope description.

### Acceptance

- Existing WS clients continue to function (extra fields tolerated).
- Explorer can link reliably using `event.entity` without parsing `data`.

### Verification

- `bun run typecheck`
- `bun test`

---

## Security Assumptions (must be true for safe deployment)

1. Hub binds to localhost only by default; never enable unsafe networking without an authenticating reverse proxy.
2. Anyone who can access `/ui/*` is trusted equivalent to the bearer-token holder (token is present in page source today).
3. Event data contains full message content; treat it as sensitive (PII-equivalent).
4. Browser environment is trusted (extensions/devtools can extract embedded token).

## Risks / Notes

- Wildcard live-tail can be noisy; follow-up can use WS subscriptions when filters are applied.
- `tail=<n>` makes bulk extraction easier; clamp server-side and keep changes additive.
- CSP currently allows `'unsafe-inline'` for UI scripts; hardening is a separate effort.
