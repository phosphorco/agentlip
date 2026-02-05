# Rename AgentChat → Agentlip

> Learnings relevant to future gates should be written back to respective gates, so future collaborators can benefit.

## Goal and Motivation

Rename every occurrence of "AgentChat" / "agentchat" / "agent-chat" and the `.zulip/` workspace marker to use the "Agentlip" / "agentlip" / `.agentlip/` names consistently. The project repo is already called `agentlip` — this finishes the job.

## Scope

**Delivers:**
- Mechanical rename of all identifiers, strings, comments, docs, filenames
- `.zulip/` → `.agentlip/` in code (workspace marker constant, path references, tests, docs)
- `@agentchat/*` npm scope → `@agentlip/*`
- CLI binary `agentchat` → `agentlip`, daemon `agentchatd` → `agentlipd`
- Source file renames: `agentchat.ts` → `agentlip.ts`, `agentchatd.ts` → `agentlipd.ts`
- Rename script that performs the work safely (excludes `.git/`, `node_modules/`)

**Excludes:**
- Renaming actual `.zulip/` directories on disk for existing workspaces (no migration tool)
- Any npm publishing steps
- Changes to git remote URLs

## Codebase Context

| Area | Key files |
|---|---|
| Workspace marker | `packages/workspace/src/index.ts` (WORKSPACE_MARKER const), `packages/workspace/src/index.test.ts` |
| npm scope | All 6 `packages/*/package.json` (`@agentchat/protocol`, `kernel`, `workspace`, `cli`, `client`, `hub`) |
| CLI binary | `packages/cli/package.json` (bin field), `packages/cli/src/agentchat.ts`, `packages/cli/src/agentchat.test.ts` |
| Daemon | `packages/hub/src/agentchatd.ts`, `packages/hub/package.json` |
| Cross-package imports | ~20 unique `@agentchat/*` import lines across all packages |
| Docs | `docs/protocol.md`, `docs/ops.md`, `docs/demo.md`, `docs/security.md`, ADRs, READMEs, `AGENTS.md` |
| Plan doc | `AGENTLIP_PLAN.md` (~63 occurrences) |
| Config example | `packages/hub/example.zulip.config.ts` → rename to `example.agentlip.config.ts` |

---

## Gate 1 — Write & run the rename script

Write a TypeScript/shell script (`scripts/rename-to-agentlip.sh`) that:

1. **File content replacements** (in order, to avoid partial matches):
   - `@agentchat/` → `@agentlip/` (npm scope in imports + package.json)
   - `agentchatd` → `agentlipd` (daemon binary/references — before the shorter pattern)
   - `AgentChat` → `Agentlip` (PascalCase in prose, class names, comments)
   - `agentchat` → `agentlip` (camelCase/lowercase — CLI binary, identifiers, prose)
   - `AGENTCHAT` → `AGENTLIP` (env vars like `AGENTCHAT_ENABLE_FTS`)
   - `agent-chat` → `agent-lip` (kebab-case if any)
   - `.zulip` → `.agentlip` (workspace marker directory — as literal string)
   - `zulip` → `agentlip` in specific filenames only (e.g., `example.zulip.config.ts`)

2. **File renames:**
   - `packages/cli/src/agentchat.ts` → `packages/cli/src/agentlip.ts`
   - `packages/cli/src/agentchat.test.ts` → `packages/cli/src/agentlip.test.ts`
   - `packages/hub/src/agentchatd.ts` → `packages/hub/src/agentlipd.ts`
   - `packages/hub/example.zulip.config.ts` → `packages/hub/example.agentlip.config.ts`

3. **Safety:**
   - Operates only on tracked files (`git ls-files`) — automatically excludes `.git/` and `node_modules/`
   - Dry-run mode that prints what would change
   - Processes binary-safe (skip files that aren't text)

**Acceptance:**
- Script runs without errors
- `git diff --stat` shows the expected set of changed files
- No references to `.git/` or `node_modules/` content modified

## Gate 2 — Verify correctness

After the script runs:

1. `bun run typecheck` — zero errors
2. `bun test` — all tests pass
3. Grep audit: no stale `agentchat` / `.zulip` references remain in tracked files (except `AGENTLIP_PLAN.md` if it intentionally references the old name in historical context, and this plan file itself)
4. All `package.json` files have correct `@agentlip/*` names and dependency references
5. `bun install` succeeds (workspace resolution with new names)

**Acceptance:**
- Typecheck: 0 errors
- Tests: all green
- Grep for old names returns zero hits (excluding plan archive / historical docs if any)

## Gate 3 — Update AGENTS.md and commit

1. Update `AGENTS.md` to reflect the new names (`@agentlip/*`, `agentlip` CLI, `.agentlip/` marker)
2. Single atomic commit with a clear message: `rename: AgentChat → Agentlip (scope, CLI, workspace marker)`

**Acceptance:**
- `AGENTS.md` references are consistent
- Clean commit, no uncommitted changes
