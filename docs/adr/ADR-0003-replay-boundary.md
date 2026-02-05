# ADR-0003: Replay Boundary Semantics

**Status:** Accepted  
**Date:** 2026-02-05  
**Context:** bd-16d.2.1 (WebSocket replay boundary specification)

## Context

AgentChat provides real-time event streaming via WebSocket connections. When clients disconnect and reconnect, they need to resume from their last processed event without missing or duplicating events. This requires a well-defined **replay boundary** that separates historical events (replay) from live events (streaming).

Without a clear boundary, race conditions can occur:
- Events inserted during replay might be included in replay AND live stream (duplicates)
- Events might be excluded from both (gaps)
- The set of replayed events might be non-deterministic

## Decision

### The Replay Boundary Contract

1. **At handshake**, the server captures `replay_until = MAX(event_id)` from the database
2. **Server returns** `hello_ok` containing `replay_until` to the client
3. **Replay phase** sends events matching: `WHERE event_id > after_event_id AND event_id <= replay_until`
4. **Live phase** sends events matching: `WHERE event_id > replay_until`
5. **Boundary is immutable** for the duration of the connection (no re-snapshotting)

### Key Invariants

**Invariant 1: Non-overlapping partitions**
```
Replay events: { e | after_event_id < e.event_id ≤ replay_until }
Live events:   { e | e.event_id > replay_until }
```

These sets are disjoint. No event can appear in both.

**Invariant 2: Complete coverage**
```
All events > after_event_id = Replay ∪ Live
```

No events are missed (assuming client dedupes on event_id for at-least-once delivery).

**Invariant 3: Deterministic replay**

Given the same `(after_event_id, replay_until, subscription_filters)`, the replay query returns identical results. The boundary is captured once and not affected by concurrent insertions.

**Invariant 4: Resumable replay**

Client can disconnect mid-replay, reconnect with updated `after_event_id = last_processed`, and resume without re-receiving already-processed events.

## Timeline Examples

### Example 1: Basic reconnection

```
Time    Action                              DB state        Client state
────────────────────────────────────────────────────────────────────────
T0      Events 1-100 exist                  max_id=100      last_seen=100
T1      Client disconnects                  -               last_seen=100
T2      Events 101-150 inserted             max_id=150      (offline)
T3      Client reconnects, sends after=100  -               -
T4      Server: replay_until=150            -               -
T5      Server replays 101-150              -               processing
T6      Event 151 inserted                  max_id=151      -
T7      Event 152 inserted                  max_id=152      -
T8      Replay completes                    -               last_seen=150
T9      Server streams 151, 152 (live)      -               last_seen=152
```

Replay boundary (150) ensures events 151-152 are NOT in replay.

### Example 2: Concurrent insertions during replay

```
Time    Action                              Replay query    Live stream
────────────────────────────────────────────────────────────────────────
T0      replay_until=100 captured           -               -
T1      Replay query executes (1-100)       events 1-100    -
T2      Event 101 inserted (mid-replay!)    -               -
T3      Event 102 inserted                  -               -
T4      Replay sends events 1-100           -               -
T5      Replay completes                    -               -
T6      Live stream starts (>100)           -               101, 102
```

**Critical**: Events 101-102 inserted during replay are NOT included in replay because `replay_until=100`. They appear in live stream only.

### Example 3: Resume from mid-replay

```
Time    Action                              Result
────────────────────────────────────────────────────────────────────────
T0      Connect: after=0, replay_until=100  -
T1      Receive events 1-50                 last_seen=50
T2      Network drops (disconnected)        -
T3      Reconnect: after=50, replay_until=100  -
T4      Receive events 51-100               last_seen=100
T5      Live stream starts (>100)           -
```

Client correctly resumes from event 50 without re-receiving 1-50.

### Example 4: Empty replay (client up-to-date)

```
Time    Action                              Result
────────────────────────────────────────────────────────────────────────
T0      Events 1-100 exist                  max_id=100
T1      Connect: after=100                  -
T2      replay_until=100                    -
T3      Replay query: >100 AND <=100        0 events (empty set)
T4      Live stream starts immediately      waiting for >100
```

No replay needed when `after_event_id == replay_until`.

## SQL Implementation

### Replay Query (canonical)

```sql
SELECT event_id, ts, name, scope_channel_id, scope_topic_id, scope_topic_id2,
       entity_type, entity_id, data_json
FROM events
WHERE event_id > :after_event_id 
  AND event_id <= :replay_until
  AND (/* subscription scope filters */)
ORDER BY event_id ASC
LIMIT :batch_size
```

Uses `idx_events_replay (event_id)` index for efficient range scan.

### Capture replay_until (at handshake)

```sql
SELECT MAX(event_id) as replay_until FROM events
```

Executed **once** at connection handshake. Result cached for connection lifetime.

## Test Cases

The following test cases verify replay boundary correctness (implemented in `packages/kernel/src/replay-boundary.test.ts`):

### Boundary correctness tests

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | Replay with replay_until excludes later events | Events > replay_until not returned |
| 2 | Concurrent insert during "replay" doesn't affect boundary | Boundary remains as captured |
| 3 | Resume from mid-replay point | Only events > after_event_id returned |
| 4 | Empty replay (after_event_id == replay_until) | Zero events returned |
| 5 | replay_until=0 (fresh client, no events) | Zero events returned |

### Determinism tests

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 6 | Same parameters yield identical results | Byte-for-byte identical |
| 7 | Replay is idempotent (can re-run safely) | Same results every time |

### Edge case tests

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 8 | Large batch with limit | Correct pagination |
| 9 | Filtered replay respects boundary | Filters AND boundary both honored |
| 10 | Events at exactly replay_until | Included in replay |
| 11 | Events at exactly after_event_id | Excluded from replay |

## Consequences

### Positive

- **Predictable replay**: Clients always know exactly which events are replay vs. live
- **No duplicates**: Clear partition means no double-delivery (assuming client dedupes on event_id)
- **Resumable**: Clients can resume mid-replay without special server coordination
- **Simple implementation**: Single snapshot value, immutable for connection lifetime

### Negative

- **Potential lag in live stream**: If replay takes time, live events queue up
- **Memory pressure**: Server may buffer live events while replay completes
- **Stale boundary if client slow**: Very slow clients might have large live backlog

### Mitigations

- Backpressure: disconnect slow clients, let them reconnect and re-snapshot
- Batch limits: paginate replay with `LIMIT` to prevent memory exhaustion
- Timeout: maximum replay duration before forcing live mode

## References

- AGENTLIP_PLAN.md §0.9 (WebSocket protocol)
- `packages/kernel/src/events.ts` - replayEvents() implementation
- `packages/kernel/src/replay-boundary.test.ts` - boundary tests
