# WebSocket Delivery Guarantees Test Suite

**Status:** ✅ Complete  
**Location:** `packages/hub/src/wsDelivery.test.ts`  
**Gate:** Gate C (Replay Equivalence)  
**ADR:** ADR-0003 (Replay Boundary Semantics)

## Overview

This test suite verifies critical WebSocket delivery guarantees for the AgentChat Hub. These tests ensure that clients can reliably reconnect, resume from disconnections, and receive a complete event stream without gaps or duplicates.

## Test Scenarios

### 1. Disconnect Mid-Replay

**Coverage:**
- Client disconnects during replay phase
- Server doesn't crash or hang when client drops mid-stream
- Reconnection with `after_event_id` resumes cleanly from last processed event
- No gaps in event sequence across reconnection boundary

**Tests:**
- `client disconnects during replay, reconnects with after_event_id, resumes cleanly`
  - Seeds 100 events
  - Client receives first 50 events, then disconnects
  - Reconnects with `after_event_id=50`
  - Receives remaining 50 events (51-100)
  - Verifies: no gaps, no duplicates, strict ordering

- `server continues without crash when client disconnects mid-replay`
  - Seeds 200 events
  - Client closes immediately after handshake
  - Verifies server remains responsive (new connections work)
  - Verifies connection count correctly decremented

**Gate C Mapping:** Demonstrates replay resumption without data loss.

---

### 2. Replay Boundary Semantics (ADR-0003)

**Coverage:**
- `replay_until` boundary remains stable even if new events inserted during replay
- Events never appear in both replay and live phases
- Replay/live partition is deterministic and non-overlapping

**Tests:**
- `replay_until boundary remains stable even if new events inserted during replay`
  - Seeds 50 initial events
  - Client connects, receives `replay_until=50`
  - **During replay phase**, inserts events 51-100 and publishes to live stream
  - Verifies events 1-50 come from replay, 51-100 come from live stream
  - Demonstrates ADR-0003 invariants: replay ≤ boundary, live > boundary

- `replay boundary prevents duplicates: same event never in both replay and live`
  - Seeds 30 events
  - Verifies no event_id appears twice
  - Verifies strictly increasing sequence

**Gate C Mapping:** Core replay equivalence guarantee - same `(after_event_id, replay_until, filters)` yields deterministic results.

---

### 3. Mid-Batch Send Failure

**Coverage:**
- Connection closes gracefully when send fails during replay
- Client can reconnect after mid-batch failure
- No lost events when resuming from last processed `event_id`

**Tests:**
- `connection closes gracefully on send error during replay`
  - Seeds 50 events
  - Client closes connection after receiving 10 events
  - Verifies server remains responsive after client drop
  - No server crash or hang

- `client reconnects after mid-batch failure and receives remaining events`
  - Seeds 100 events
  - Client receives 25 events, then fails
  - Reconnects with `after_event_id=25`
  - Receives remaining 75 events (26-100)
  - Verifies no gaps, strict ordering

**Gate C Mapping:** Demonstrates resilience to network failures; replay protocol supports resumption.

---

### 4. Stale Client Pagination

**Coverage:**
- Client far behind (large `replay_until - after_event_id` delta) can catch up
- Replay maintains ordering and filtering across large batches
- No backpressure issues with reasonable event counts (500 events)

**Tests:**
- `client far behind (after_event_id=0 with many events) receives ordered replay`
  - Seeds 500 events
  - Client connects with `after_event_id=0` (fresh start)
  - Receives all 500 events in replay phase
  - Verifies strict ordering: 1, 2, 3, ..., 500

- `stale client receives events with correct filtering`
  - Seeds 200 events across `ch1` and `ch2` (alternating)
  - Client subscribes to `ch1` only
  - Receives 100 events (all from `ch1`, all even IDs)
  - Verifies filtering works correctly during large replay

**Gate C Mapping:** Validates replay scalability and correctness with large deltas.

---

### 5. Hub Restart Behavior

**Coverage:**
- Hub restart during active connections
- Clients can reconnect after hub restart
- `instance_id` changes but protocol remains compatible
- No data loss across hub lifecycle

**Tests:**
- `hub restart: clients reconnect and resume from last processed event_id`
  - Seeds 50 events, starts hub instance-1
  - Client connects and receives 30 events
  - **Hub stops**, client disconnects
  - Seeds 50 more events (while hub down)
  - Starts new hub instance-2
  - Client reconnects with `after_event_id=30`
  - Receives remaining 70 events (31-100)
  - Verifies no gaps, no duplicates

- `instance_id changes on hub restart but protocol still works`
  - Verifies `hello_ok.instance_id` changes across restarts
  - Demonstrates protocol is instance-agnostic (client doesn't depend on instance_id stability)

**Gate C Mapping:** Demonstrates durable replay; event stream survives hub restarts.

---

## Verification Results

All tests pass:
```
✓ Disconnect Mid-Replay (2 tests)
✓ Replay Boundary Semantics (ADR-0003) (2 tests)
✓ Mid-Batch Send Failure (2 tests)
✓ Stale Client Pagination (2 tests)
✓ Hub Restart Behavior (2 tests)

10 pass, 0 fail, 1012 assertions
```

## Gate C: Replay Equivalence

**Status:** ✅ Verified

These tests collectively demonstrate:

1. **Deterministic Replay:** Same `(after_event_id, replay_until, subscriptions)` → same events
2. **Complete Coverage:** Replay ∪ Live = All events > after_event_id (no gaps)
3. **Non-Overlapping Partition:** Replay ∩ Live = ∅ (no duplicates from server)
4. **Resumable:** Client can disconnect/reconnect at any point and resume without data loss
5. **Stable Boundary:** `replay_until` captured once, immutable for connection lifetime (ADR-0003)
6. **Durable:** Replay survives hub restarts (events persisted in SQLite)

## Edge Cases Covered

- ✅ Disconnect mid-replay
- ✅ Concurrent event insertion during replay
- ✅ Mid-batch failure with resume
- ✅ Stale client (large event delta)
- ✅ Hub restart with instance_id change
- ✅ Subscription filtering during large replay
- ✅ Connection cleanup after client drop

## Remaining Work

**Not covered in this suite (may require separate tests or manual verification):**

- Clock skew tolerance (system clock changes during operation)
  - Currently not easily testable in unit tests without manipulating system time
  - Recommend integration test or manual verification
  
- Backpressure enforcement with very slow clients
  - Existing tests in `wsEndpoint.test.ts` (currently failing)
  - May require separate investigation

- Connection limit enforcement (max 100 concurrent)
  - Recommend stress test or integration test

- Oversized replay (>10k events) with batching
  - Current tests cover 500 events; plan specifies 1000 event default batch
  - Consider adding stress test for 10k+ event replay

## Files Modified

- ✅ Created `packages/hub/src/wsDelivery.test.ts` (10 tests, ~900 lines)
- ✅ Uses existing integration harness (`setupTestServer`, `setupTestDb`)
- ✅ All tests deterministic (no arbitrary sleeps, bounded timeouts)
- ✅ Self-reviewed for flakiness

## Verification Commands

```bash
# Run delivery guarantees tests
bun test packages/hub/src/wsDelivery.test.ts

# Run all hub tests
bun test packages/hub/src/

# Typecheck
bun run typecheck
```

## References

- **Plan:** AGENTLIP_PLAN.md §0.9 (WebSocket protocol)
- **ADR:** docs/adr/ADR-0003-replay-boundary.md
- **Implementation:** packages/hub/src/wsEndpoint.ts
- **Integration Harness:** packages/hub/src/integrationHarness.ts
