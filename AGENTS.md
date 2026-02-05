# Agent Instructions for AgentChat

## Orientation (read this first)

This is a **Bun + TypeScript monorepo** with 6 workspace packages under `packages/`. No build step — TypeScript is executed directly by Bun. All SQL uses prepared statements. All tests use `bun:test`.

```
packages/
  protocol/    # Shared types (error codes, health response)
  kernel/      # SQLite schema, migrations, events, queries, mutations
  workspace/   # Workspace discovery (.zulip/ upward walk)
  hub/         # Bun HTTP+WS server, plugin runtime, UI
  cli/         # Stateless CLI (agentchat)
  client/      # TypeScript SDK (discovery, WS, typed events, mutations)
```

**Dependency rule:** `client` → `protocol` + `workspace`. `hub` → `protocol` + `kernel`. `cli` → `kernel` + `workspace`. Nothing depends on `hub` at compile time (test files may import its harness).

## Dev Commands

```bash
bun test              # Full suite (725 tests, ~24s)
bun test packages/hub # Test one package
bun run typecheck     # tsc --noEmit (zero errors required)
```

Always run both before committing.

## Testing Patterns

**Unit tests** (kernel, protocol): import functions directly, use temp SQLite DBs.

**Integration tests** (hub, client): use the shared harness:
```typescript
import { createTempWorkspace, startTestHub } from "../../hub/src/integrationHarness";

const workspace = await createTempWorkspace();
const hub = await startTestHub({ workspaceRoot: workspace.root, authToken: "test-token" });
// ... test against hub.url ...
await hub.stop();
await workspace.cleanup();
```

**To create events in tests**, use the real API chain — never invent endpoints:
```typescript
import { createChannel, createTopic, sendMessage } from "@agentchat/client";
const client = { baseUrl: hub.url, authToken: "test-token" };
const ch = await createChannel(client, { name: "test-ch" });
const tp = await createTopic(client, { channelId: ch.channel.id, title: "test-tp" });
const msg = await sendMessage(client, { topicId: tp.topic.id, sender: "agent", contentRaw: "hello" });
```

## Key Design Decisions

- **No hard deletes.** Messages are tombstoned (`deleted_at` set, content replaced). Events are immutable.
- **Optimistic locking.** Edits accept `expected_version`; mismatch returns `VERSION_CONFLICT`.
- **Plugin isolation.** Plugins run in Worker threads with timeouts + circuit breaker. No direct DB access. See `docs/adr/ADR-0005-plugin-isolation.md`.
- **Staleness guard.** Derived data (enrichments, attachments from plugins) is checked for staleness before commit — version + deleted_at verified in same transaction.
- **Additive-only schema.** New event types and fields must not break existing consumers.

## Reference Docs

- [docs/protocol.md](docs/protocol.md) — HTTP API endpoints, WS handshake, event types, error codes
- [docs/ops.md](docs/ops.md) — Hub startup sequence, recovery, migrations
- [docs/security.md](docs/security.md) — Threat model, auth, safe defaults
- [AGENTLIP_PLAN.md](AGENTLIP_PLAN.md) — Full design plan (3400 lines, all decisions locked)

---

<!-- br-agent-instructions-v1 -->

## Issue Tracking (beads)

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue tracking. Issues are stored in `.beads/` and tracked in git.

### Quick Reference

```bash
br ready                  # Unblocked work (prefer this over br list)
br show <id>              # Full details + dependencies
br update <id> --status=in_progress
br close <id> --reason="..."
br sync --flush-only      # Export to JSONL before committing
```

### Workflow

1. `br ready` → pick a task
2. `br update <id> --status=in_progress`
3. Implement + test + typecheck
4. `br close <id> --reason="<what was done + verification>"` 
5. `br sync --flush-only && git add .beads/ && git commit`

### Robot Views (for PM agents coordinating parallel work)

```bash
bv --robot-plan --format json     # Dependency-respecting execution tracks
bv --robot-triage --format json   # Scored picks + unblockers
br ready                          # Simple unblocked list (most useful)
```

**Tip:** `br ready` is more useful than `bv --robot-next` (which tends to pick top-level epics over actionable leaf tasks). Use `br show <id>` to inspect dependencies before claiming.

<!-- end-br-agent-instructions -->

---

## Lessons for PM Agents Using Background Tasks

If you're orchestrating parallel background tasks (via `start_tasks`), these patterns were learned from building this project:

### Task prompt quality determines success rate

**56% of tasks delivered clean, shippable code.** The rest needed fixes. The difference was how much concrete context the prompt contained.

**Do:**
- Include exact type signatures the task should produce or consume
- Specify which existing functions to use for test setup (e.g., "use `createChannel` + `createTopic` + `sendMessage` to generate events")
- Include the file paths AND the key facts extracted from those files

**Don't:**
- List 12+ file paths and expect the task to read and synthesize them all (it may timeout)
- Let parallel tasks independently discover shared interfaces (they'll hallucinate)
- Combine two unrelated deliverables in one task (the second one may not get written)

### Sequencing rules

- Tasks that define types/interfaces → run first
- Tasks that write tests for another task's code → sequence after it
- Docs tasks → pre-digest the facts in the prompt instead of giving raw file paths
- Anything on the critical path → one focused deliverable per task

### Always verify after integration

After all tasks in a wave complete:
```bash
bun run typecheck              # Type errors from mismatched interfaces
bun test packages/<modified>   # Catch broken tests before full suite
bun test                       # Full suite
```

Check barrel exports (`index.ts`) — tasks frequently forget to add their module to the re-export list.
