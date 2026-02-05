# Kernel Unit Tests - Verification Report

## Test Suite: `packages/kernel/src/schema.test.ts`

### Coverage Summary

Comprehensive unit tests have been added for @agentlip/kernel schema and query contracts, meeting all Gate A requirements for bead bd-16d.6.1.

### Test Categories

#### 1. Schema Initialization (3 tests)
- ✅ Fresh DB with `runMigrations(enableFts: false)` creates all required tables
- ✅ Meta table initialized with `db_id`, `schema_version=1`, and `created_at`
- ✅ All required indexes are created

#### 2. PRAGMA Configuration (3 tests)
- ✅ `openDb()` sets `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`
- ✅ `openDb()` sets `journal_mode=WAL` when not readonly
- ✅ `openDb(readonly: true)` sets `query_only=ON` and skips WAL

#### 3. Trigger Enforcement (3 tests)
- ✅ Trigger prevents DELETE on messages table (tombstone-only)
- ✅ Trigger prevents UPDATE on events table (immutable)
- ✅ Trigger prevents DELETE on events table (append-only)

#### 4. Optional FTS (3 tests)
- ✅ `runMigrations(enableFts: true)` creates `messages_fts` OR returns `ftsError` gracefully
- ✅ `isFtsAvailable()` returns false when FTS not enabled
- ✅ `isFtsAvailable()` detects existing FTS table correctly

#### 5. Query Contract Smoke Tests (4 tests)
- ✅ Create channel/topic/message and perform basic SELECT
- ✅ `topic_attachments` unique index enforces dedupe by `(topic_id, kind, key, dedupe_key)`
- ✅ Foreign key constraints enforce referential integrity
- ✅ CASCADE DELETE removes dependent records

#### 6. Migration Idempotency (1 test)
- ✅ Re-running migrations does not re-apply already applied migrations

### Test Execution Results

```bash
$ cd packages/kernel && bun test

bun test v1.3.8 (b64edcb4)

src/schema.test.ts:
 17 pass
 0 fail
 59 expect() calls
Ran 17 tests across 1 file. [72.00ms]
```

### TypeScript Type Checking

```bash
$ bun run typecheck 2>&1 | grep "packages/kernel"
# (no output - no type errors in kernel package)
```

### Backward Compatibility

Existing verification script continues to pass:

```bash
$ bun verify-kernel.ts
✅ All verifications passed!
```

## Implementation Details

### Test File Location
- `packages/kernel/src/schema.test.ts` (17,803 bytes, 540 lines)

### Key Testing Patterns

1. **Isolated Test Environments**: Each test uses a unique temporary database in `.test-tmp/`
2. **Cleanup Hooks**: `beforeEach`/`afterEach` ensure no test pollution
3. **Graceful FTS Handling**: Tests accept either FTS success or graceful failure with error message
4. **Type Safety**: Properly typed query parameters and return types throughout
5. **Contract Validation**: Tests verify both positive and negative cases (e.g., constraints that should fail)

### Files Modified

- ✅ Created: `packages/kernel/src/schema.test.ts`
- ✅ No changes to implementation code (implementation already correct)
- ✅ No changes to existing verification script

## Verification Commands

To verify the complete test suite:

```bash
# Run unit tests
cd packages/kernel && bun test

# Run type checking (kernel package only)
bun run typecheck 2>&1 | grep "packages/kernel"

# Run existing verification script (backward compatibility)
bun verify-kernel.ts
```

## Coverage Analysis

All bd-16d.6.1 requirements satisfied:

| Requirement | Status | Test(s) |
|------------|--------|---------|
| Fresh DB + runMigrations creates tables | ✅ | Schema Initialization > Fresh DB with runMigrations... |
| Meta keys (db_id, schema_version, created_at) | ✅ | Schema Initialization > Meta table initialized... |
| PRAGMAs (foreign_keys, busy_timeout, synchronous, journal_mode) | ✅ | PRAGMA Configuration (all 3 tests) |
| Triggers enforce message delete abort | ✅ | Trigger Enforcement > Trigger prevents DELETE on messages |
| Triggers enforce events update/delete abort | ✅ | Trigger Enforcement > Trigger prevents UPDATE/DELETE on events |
| Optional FTS (creates OR graceful fallback) | ✅ | Optional FTS (all 3 tests) |
| Query contract smoke (channel/topic/message) | ✅ | Query Contract Smoke Tests > Create channel/topic/message... |
| topic_attachments dedupe index | ✅ | Query Contract Smoke Tests > topic_attachments unique index... |

## Notes

- Tests avoid flaky behavior (no backup -wal file selection issues)
- Tests use proper bun:test framework with describe/test/expect
- All tests complete in < 100ms total
- Zero type errors in kernel package
- 100% compatibility with existing verification infrastructure
