/**
 * Replay Boundary Tests (ADR-0003)
 * 
 * These tests verify the replay boundary semantics documented in
 * docs/adr/ADR-0003-replay-boundary.md
 * 
 * Implements bd-16d.2.1: Tests asserting replay boundary behavior at DB query layer
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, runMigrations } from "./index";
import {
  insertEvent,
  getLatestEventId,
  replayEvents,
} from "./events";
import type { Database } from "bun:sqlite";

const TEST_DIR = join(import.meta.dir, ".test-tmp-replay-boundary");
const MIGRATIONS_DIR = join(import.meta.dir, "../../../migrations");

function setupTestDb(): { db: Database; dbPath: string } {
  const dbPath = join(TEST_DIR, `replay-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb({ dbPath });
  runMigrations({ db, migrationsDir: MIGRATIONS_DIR, enableFts: false });
  return { db, dbPath };
}

function insertTestEvents(db: Database, count: number, channelId = "ch_test"): number[] {
  const eventIds: number[] = [];
  for (let i = 1; i <= count; i++) {
    const eventId = insertEvent({
      db,
      name: `message.created`,
      scopes: { channel_id: channelId, topic_id: `topic_${i}` },
      entity: { type: "message", id: `msg_${i}` },
      data: { content: `Message ${i}`, seq: i },
    });
    eventIds.push(eventId);
  }
  return eventIds;
}

beforeEach(() => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    for (const file of readdirSync(TEST_DIR)) {
      const filePath = join(TEST_DIR, file);
      try {
        unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

describe("ADR-0003: Replay Boundary Semantics", () => {
  describe("Boundary correctness", () => {
    test("1. Replay with replay_until excludes later events", () => {
      // ADR Example 1: Basic reconnection scenario
      const { db } = setupTestDb();

      // Insert events 1-100
      insertTestEvents(db, 100);
      expect(getLatestEventId(db)).toBe(100);

      // Client disconnects at event 50, later reconnects
      const afterEventId = 50;

      // Capture replay_until at "handshake" time
      const replayUntil = getLatestEventId(db); // 100

      // Simulate concurrent insertions AFTER handshake
      insertTestEvents(db, 50, "ch_new"); // Events 101-150

      // Verify DB has more events now
      expect(getLatestEventId(db)).toBe(150);

      // Replay query with original replay_until should ONLY return events 51-100
      const events = replayEvents({
        db,
        afterEventId,
        replayUntil,
      });

      expect(events.length).toBe(50); // 51-100
      expect(events[0].event_id).toBe(51);
      expect(events[49].event_id).toBe(100);
      
      // Verify NO events > replay_until
      expect(events.every(e => e.event_id <= replayUntil)).toBe(true);
      expect(events.every(e => e.event_id > afterEventId)).toBe(true);

      db.close();
    });

    test("2. Concurrent insert during 'replay' doesn't affect boundary", () => {
      // ADR Example 2: Events inserted during replay execution
      const { db } = setupTestDb();

      // Setup: events 1-10
      insertTestEvents(db, 10);
      const replayUntil = getLatestEventId(db); // 10

      // First replay call
      const firstReplay = replayEvents({
        db,
        afterEventId: 0,
        replayUntil,
      });
      expect(firstReplay.length).toBe(10);

      // "During replay" - insert more events
      insertTestEvents(db, 5, "ch_concurrent"); // Events 11-15
      expect(getLatestEventId(db)).toBe(15);

      // Second replay call with SAME boundary
      const secondReplay = replayEvents({
        db,
        afterEventId: 0,
        replayUntil, // Still 10!
      });

      // Should return identical results despite new events existing
      expect(secondReplay.length).toBe(10);
      expect(secondReplay.map(e => e.event_id)).toEqual(firstReplay.map(e => e.event_id));

      db.close();
    });

    test("3. Resume from mid-replay point", () => {
      // ADR Example 3: Resume from mid-replay
      const { db } = setupTestDb();

      insertTestEvents(db, 100);
      const replayUntil = getLatestEventId(db); // 100

      // First batch: events 1-50
      const batch1 = replayEvents({
        db,
        afterEventId: 0,
        replayUntil,
        limit: 50,
      });
      expect(batch1.length).toBe(50);
      expect(batch1[49].event_id).toBe(50);

      // Client "disconnects" after processing batch1
      const lastProcessed = batch1[49].event_id; // 50

      // Client reconnects and resumes from last processed
      const batch2 = replayEvents({
        db,
        afterEventId: lastProcessed, // Resume from 50
        replayUntil,
      });

      // Should get events 51-100 (not re-receive 1-50)
      expect(batch2.length).toBe(50);
      expect(batch2[0].event_id).toBe(51);
      expect(batch2[49].event_id).toBe(100);

      // No overlap between batches
      const batch1Ids = new Set(batch1.map(e => e.event_id));
      const batch2Ids = batch2.map(e => e.event_id);
      expect(batch2Ids.some(id => batch1Ids.has(id))).toBe(false);

      db.close();
    });

    test("4. Empty replay (after_event_id == replay_until)", () => {
      // ADR Example 4: Client up-to-date
      const { db } = setupTestDb();

      insertTestEvents(db, 100);
      const replayUntil = getLatestEventId(db); // 100

      // Client already at replay_until
      const events = replayEvents({
        db,
        afterEventId: 100, // Same as replay_until
        replayUntil: 100,
      });

      expect(events.length).toBe(0);

      db.close();
    });

    test("5. replay_until=0 (fresh client, no events)", () => {
      const { db } = setupTestDb();

      // No events inserted
      const replayUntil = getLatestEventId(db); // 0
      expect(replayUntil).toBe(0);

      const events = replayEvents({
        db,
        afterEventId: 0,
        replayUntil: 0,
      });

      expect(events.length).toBe(0);

      db.close();
    });
  });

  describe("Determinism", () => {
    test("6. Same parameters yield identical results", () => {
      const { db } = setupTestDb();

      insertTestEvents(db, 50);
      const replayUntil = getLatestEventId(db);

      // Run replay multiple times with same parameters
      const results: string[] = [];
      for (let i = 0; i < 5; i++) {
        const events = replayEvents({
          db,
          afterEventId: 10,
          replayUntil,
          channelIds: ["ch_test"],
        });
        // Serialize for comparison
        results.push(JSON.stringify(events.map(e => ({
          event_id: e.event_id,
          name: e.name,
          entity: e.entity,
        }))));
      }

      // All results should be identical
      expect(new Set(results).size).toBe(1);

      db.close();
    });

    test("7. Replay is idempotent (can re-run safely)", () => {
      const { db } = setupTestDb();

      insertTestEvents(db, 20);
      const replayUntil = getLatestEventId(db);

      const firstRun = replayEvents({
        db,
        afterEventId: 5,
        replayUntil,
      });

      // Insert more events
      insertTestEvents(db, 10, "ch_extra");

      // Re-run with same boundary
      const secondRun = replayEvents({
        db,
        afterEventId: 5,
        replayUntil, // Same boundary as before
      });

      // Results should be identical (new events don't affect old boundary)
      expect(secondRun.length).toBe(firstRun.length);
      expect(secondRun.map(e => e.event_id)).toEqual(firstRun.map(e => e.event_id));

      db.close();
    });
  });

  describe("Edge cases", () => {
    test("8. Large batch with limit (pagination)", () => {
      const { db } = setupTestDb();

      insertTestEvents(db, 1000);
      const replayUntil = getLatestEventId(db);

      // Paginate through all events
      let afterEventId = 0;
      let totalEvents = 0;
      const allEventIds: number[] = [];

      while (true) {
        const batch = replayEvents({
          db,
          afterEventId,
          replayUntil,
          limit: 100,
        });

        if (batch.length === 0) break;

        totalEvents += batch.length;
        allEventIds.push(...batch.map(e => e.event_id));
        afterEventId = batch[batch.length - 1].event_id;
      }

      expect(totalEvents).toBe(1000);
      
      // Verify no duplicates
      expect(new Set(allEventIds).size).toBe(1000);
      
      // Verify order
      for (let i = 1; i < allEventIds.length; i++) {
        expect(allEventIds[i]).toBeGreaterThan(allEventIds[i - 1]);
      }

      db.close();
    });

    test("9. Filtered replay respects boundary", () => {
      const { db } = setupTestDb();

      // Insert events in two channels
      insertTestEvents(db, 50, "ch_a"); // Events 1-50
      insertTestEvents(db, 50, "ch_b"); // Events 51-100

      const replayUntil = getLatestEventId(db); // 100

      // Insert more in ch_a (events 101-125)
      insertTestEvents(db, 25, "ch_a");

      // Filtered replay for ch_a with old boundary
      const events = replayEvents({
        db,
        afterEventId: 0,
        replayUntil, // 100, not 125
        channelIds: ["ch_a"],
      });

      // Should only get ch_a events up to boundary (1-50)
      expect(events.length).toBe(50);
      expect(events.every(e => e.event_id <= 100)).toBe(true);
      expect(events.every(e => e.scope.channel_id === "ch_a")).toBe(true);

      db.close();
    });

    test("10. Events at exactly replay_until are included", () => {
      const { db } = setupTestDb();

      insertTestEvents(db, 10);
      const replayUntil = getLatestEventId(db); // 10

      const events = replayEvents({
        db,
        afterEventId: 0,
        replayUntil,
      });

      // Event 10 should be included (boundary is inclusive)
      expect(events.length).toBe(10);
      expect(events.some(e => e.event_id === replayUntil)).toBe(true);

      db.close();
    });

    test("11. Events at exactly after_event_id are excluded", () => {
      const { db } = setupTestDb();

      insertTestEvents(db, 10);
      const replayUntil = getLatestEventId(db);

      const events = replayEvents({
        db,
        afterEventId: 5, // Exclusive
        replayUntil,
      });

      // Event 5 should NOT be included (afterEventId is exclusive)
      expect(events.length).toBe(5); // Events 6-10
      expect(events.some(e => e.event_id === 5)).toBe(false);
      expect(events[0].event_id).toBe(6);

      db.close();
    });
  });

  describe("WS handshake simulation (integration)", () => {
    test("Full WS connection lifecycle with replay boundary", () => {
      const { db } = setupTestDb();

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 1: Initial connection and state
      // ═══════════════════════════════════════════════════════════════════════
      
      // Server has events 1-100
      insertTestEvents(db, 100);

      // Client connects fresh (after_event_id=0)
      const client1AfterEventId = 0;
      const client1ReplayUntil = getLatestEventId(db); // 100

      // Simulate hello_ok response
      const helloOk = {
        type: "hello_ok",
        replay_until: client1ReplayUntil,
        instance_id: "test-instance",
      };
      expect(helloOk.replay_until).toBe(100);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 2: Replay phase
      // ═══════════════════════════════════════════════════════════════════════

      // Server processes replay in batches
      const replayBatch1 = replayEvents({
        db,
        afterEventId: client1AfterEventId,
        replayUntil: client1ReplayUntil,
        limit: 50,
      });
      expect(replayBatch1.length).toBe(50);
      expect(replayBatch1[0].event_id).toBe(1);

      // CONCURRENT: New events arrive during replay
      insertTestEvents(db, 10, "ch_concurrent"); // Events 101-110

      // Continue replay (batch 2)
      const replayBatch2 = replayEvents({
        db,
        afterEventId: replayBatch1[49].event_id, // 50
        replayUntil: client1ReplayUntil, // Still 100!
        limit: 50,
      });
      expect(replayBatch2.length).toBe(50);
      expect(replayBatch2[0].event_id).toBe(51);
      expect(replayBatch2[49].event_id).toBe(100);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 3: Transition to live
      // ═══════════════════════════════════════════════════════════════════════

      // Replay complete. Now stream live events (> replay_until)
      const liveEvents = replayEvents({
        db,
        afterEventId: client1ReplayUntil, // 100
        replayUntil: getLatestEventId(db), // 110
      });
      expect(liveEvents.length).toBe(10);
      expect(liveEvents[0].event_id).toBe(101);

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 4: Client reconnection
      // ═══════════════════════════════════════════════════════════════════════

      // Client disconnects at event 105, then reconnects
      const client2AfterEventId = 105;
      const client2ReplayUntil = getLatestEventId(db); // 110

      // More events while client offline
      insertTestEvents(db, 20, "ch_offline"); // Events 111-130

      // Client reconnects
      const reconnectReplay = replayEvents({
        db,
        afterEventId: client2AfterEventId,
        replayUntil: client2ReplayUntil, // Captured at handshake (110)
      });

      // Should only get events 106-110 (not 111-130)
      expect(reconnectReplay.length).toBe(5);
      expect(reconnectReplay[0].event_id).toBe(106);
      expect(reconnectReplay[4].event_id).toBe(110);

      // Live stream would then send 111-130
      const reconnectLive = replayEvents({
        db,
        afterEventId: client2ReplayUntil, // 110
        replayUntil: getLatestEventId(db), // 130
      });
      expect(reconnectLive.length).toBe(20);

      db.close();
    });

    test("Multiple concurrent clients with different boundaries", () => {
      const { db } = setupTestDb();

      // Initial events 1-50
      insertTestEvents(db, 50);

      // Client A connects (replay_until=50)
      const clientAReplayUntil = getLatestEventId(db); // 50

      // Events 51-60 arrive
      insertTestEvents(db, 10, "ch_between");

      // Client B connects (replay_until=60)
      const clientBReplayUntil = getLatestEventId(db); // 60

      // Events 61-70 arrive
      insertTestEvents(db, 10, "ch_later");

      // Client A replays with its boundary
      const clientAReplay = replayEvents({
        db,
        afterEventId: 0,
        replayUntil: clientAReplayUntil,
      });
      expect(clientAReplay.length).toBe(50);

      // Client B replays with its boundary
      const clientBReplay = replayEvents({
        db,
        afterEventId: 0,
        replayUntil: clientBReplayUntil,
      });
      expect(clientBReplay.length).toBe(60);

      // Client A would then get live events 51-70
      const clientALive = replayEvents({
        db,
        afterEventId: clientAReplayUntil,
        replayUntil: getLatestEventId(db),
      });
      expect(clientALive.length).toBe(20);

      // Client B would then get live events 61-70
      const clientBLive = replayEvents({
        db,
        afterEventId: clientBReplayUntil,
        replayUntil: getLatestEventId(db),
      });
      expect(clientBLive.length).toBe(10);

      db.close();
    });
  });
});
