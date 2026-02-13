---
title: Hub UI SPA Simplification (Svelte 5)
type: epic
status: beaded
epic-id: bd-580
beadified-at: 2026-02-13
---

# Hub UI SPA Simplification (Svelte 5)

> This epic is execution-frozen once beadified. Record learnings/discoveries on beads via `br comments add <bead-id> ...`.

## Bead Mapping

| Gate | Beads |
|---|---|
| Gate: Establish deterministic packaging + scripts | `bd-580.1` |
| Gate: Add bootstrap endpoint and static serving contract | `bd-580.2` |
| Gate: Migrate routes to Svelte SPA with parity | `bd-580.3` |
| Gate: Hardening, cutover, and legacy removal | `bd-580.4` |

## Goal and Motivation

Replace inline HTML/JS UI in `packages/hub/src/ui.ts` with a maintainable SPA while preserving current behavior (channels/topics/messages/events, WS live updates, deep links), keeping a single runtime server (hub), and staying localhost/offline-first.

## Pre-research Summary and Decision

| Option | Pros | Cons | Decision |
|---|---|---|---|
| SvelteKit (Svelte 5) | Full framework + routing conventions | Adds extra server/runtime model (SSR/adapters/load), larger release/test surface | No |
| Plain Svelte 5 + Vite SPA | Component model + routing + minimal runtime complexity | Adds build-time frontend pipeline | **Yes** |
| Lightweight vanilla/mini-framework | Lower dependency count | Hand-rolled state/routing complexity grows quickly | No |

**Decision:** Use **plain Svelte 5 + Vite**. Build UI once, embed generated assets into hub TS sources, serve from hub.

## Scope

### In scope
- Svelte SPA for `/ui/*` with client-side routing.
- Runtime bootstrap endpoint (`/ui/bootstrap`) instead of inline token interpolation.
- Hub-served static UI assets + SPA fallback.
- Migrate parity for:
  - `/ui` channels list
  - `/ui/channels/:channel_id` topics list
  - `/ui/topics/:topic_id` messages/attachments/live updates/hash deep links
  - `/ui/events` timeline/filter/pause-buffer/reconnect/entity deep links
- Keep API/WS contracts additive only.

### Out of scope
- Auth redesign (sessions/cookies/roles).
- API redesign for UI convenience.
- Rich dashboard features beyond parity.
- External hosting/CDN.

## Codebase Context

| Area | Path | Notes |
|---|---|---|
| Current UI implementation | `packages/hub/src/ui.ts` | Inline HTML/CSS/JS strings |
| Current UI route handling/auth gate | `packages/hub/src/index.ts` | `/ui` availability currently depends on auth token |
| Current UI tests | `packages/hub/src/ui.test.ts` | Mostly string-presence assertions today |
| Events + WS contracts consumed by UI | `packages/hub/src/apiV1.ts`, `packages/hub/src/wsEndpoint.ts` | Preserve behavior |
| Packaging constraints | `packages/hub/package.json` | Current package publish model |
| Protocol docs | `docs/protocol.md` | Update UI/bootstrap behavior docs as needed |

## Locked Contracts (to reduce migration risk)

1. **Single runtime server:** no SvelteKit runtime in production.
2. **Publish determinism:** generated UI assets are committed as `packages/hub/src/uiAssets.generated.ts`.
3. **CI drift enforcement:** generation command runs in CI and fails if `uiAssets.generated.ts` changes.
4. **No-auth behavior preserved (namespace-wide):** if hub has no auth token, **all `/ui/*` endpoints** return 503 (UI unavailable), including `/ui/bootstrap`, deep client routes, and `/ui/assets/*`.
5. **Route precedence contract (exact):**
   - auth gate first for all `/ui/*` (no-auth => 503 before any route-specific handling)
   - if `HUB_UI_SPA_ENABLED=false` (auth-enabled): legacy handler owns `/ui` and deep `/ui/...`; `/ui/bootstrap` and `/ui/assets/*` return 404
   - if `HUB_UI_SPA_ENABLED=true` (auth-enabled):
     - `/ui/bootstrap` (JSON)
     - `/ui/assets/*` static assets (canonical prefix)
     - SPA fallback for client routes
     - missing `/ui/assets/*` requests return 404 (never SPA fallback)
6. **Cache policy contract (exact):**
   - SPA shell (`/ui` index) and `/ui/bootstrap`: `Cache-Control: no-store`
   - hashed JS/CSS assets: long-lived immutable cache
7. **Asset-test determinism:** CI tests must discover asset URLs dynamically from `/ui` shell (or emitted manifest); never hardcode hashed filenames.

## Architecture Snapshot (Target)

- New source package: `packages/hub-ui/` (Svelte 5 + Vite).
- Generated hub asset module: `packages/hub/src/uiAssets.generated.ts`.
- Hub serves:
  - `/ui/bootstrap` runtime config `{ baseUrl, wsUrl, authToken, buildVersion }`
  - static assets from generated map
  - SPA fallback for `/ui/*` client routes

---

## Gate: Establish deterministic packaging + scripts

### Deliverables
- `packages/hub-ui` scaffold with `dev`, `build`, `typecheck` scripts.
- Generation script (e.g. `ui:embed`) producing `packages/hub/src/uiAssets.generated.ts`.
- `packages/hub` scripts wired so `prepack` (or equivalent release script) guarantees fresh generated assets.
- CI stale check:
  - run UI build + embed
  - fail if git diff includes `uiAssets.generated.ts`
- Documented `npm pack` invariant for `@agentlip/hub`.

### Acceptance criteria
- Building from clean checkout yields deterministic generated file.
- `npm pack` contains embedded UI asset module and starts successfully from packed artifact.

### Verification
- `bun run typecheck`
- `bun test packages/hub`
- CI step for stale generated artifacts passes/fails as intended.
- `npm pack` artifact smoke in CI (packaging-focused at this gate):
  - pack `@agentlip/hub`
  - install tarball in a temp workspace
  - verify generated asset module is present and importable
  - start hub process successfully from packed artifact

---

## Gate: Add bootstrap endpoint and static serving contract

### Deliverables
- Implement `/ui/bootstrap` endpoint in hub.
- Implement static asset serving from generated map.
- Implement explicit route precedence + 404 behavior for missing assets.
- Implement cache-header policy from locked contract.
- Keep existing no-auth 503 gate for UI routes/bootstrap.

### Acceptance criteria
- `/ui` loads shell via static serving path.
- `/ui/bootstrap` returns runtime config only when auth token exists.
- Missing `/ui/assets/*` path returns 404, not SPA shell.
- In no-auth mode, all `/ui/*` routes return 503.

### Verification
- Add hub tests for:
  - `/ui` (auth-enabled) serves shell + `Cache-Control: no-store`
  - `/ui/bootstrap` success path + `Cache-Control: no-store`
  - `/ui/bootstrap` no-auth 503 path
  - `/ui` no-auth 503 path
  - `/ui/events` and `/ui/topics/:id` no-auth 503 paths
  - discover `/ui/assets/*` path dynamically from `/ui` shell/manifest (no hardcoded hash filenames)
  - `/ui/assets/<discovered-file>` content-type + immutable cache
  - `/ui/assets/<missing-file>` 404 (auth-enabled mode)
  - `/ui/assets/<discovered-file>` no-auth 503 path
  - `/ui/assets/<missing-file>` no-auth 503 path
  - deep `/ui/...` client route fallback to shell (auth-enabled + SPA enabled)
  - deep `/ui/...` responses return `Cache-Control: no-store` when they resolve to SPA shell
  - `/ui/bootstrap` and `/ui/assets/<discovered-file>` return 404 when auth-enabled + SPA disabled (legacy mode)
  - `/ui` and representative deep routes (e.g. `/ui/topics/:id`, `/ui/events`) render legacy-mode markers when auth-enabled + SPA disabled
- Add packed-artifact runtime smoke in CI (after Gate 2 wiring lands):
  - install `npm pack` tarball in temp workspace
  - start hub (auth-enabled)
  - verify `GET /ui` 200 and discover/verify one `/ui/assets/<discovered-file>` 200

---

## Gate: Migrate routes to Svelte SPA with parity

### Deliverables
- Implement SPA routes/components for channels/topics/messages/events.
- Implement shared WS client logic for:
  - hello/replay boundary
  - reconnect/backoff
  - dedupe by `event_id`
- Implement events-page behaviors:
  - filters
  - pause/resume with bounded buffer
  - bounded memory list
- Implement message deep-link behavior:
  - `#msg_<id>` scroll/highlight
  - “Message not currently loaded” hint when absent.

### Acceptance criteria
- Parity checklist (all required):
  - channels list loads and navigates to topics
  - topics list loads and navigates to messages
  - topic messages view renders latest messages and attachment panel
  - message hash deep-link (`#msg_<id>`) highlights target or shows not-loaded hint
  - events timeline loads, filters, and pause/resume buffer behavior works
  - events entity links navigate to the correct topic/message targets
  - malicious content payloads render inert (no script execution; no unsafe HTML injection)
- Event ordering, replay boundary, deep-link correctness, and XSS-safe rendering preserved.

### Verification
- `bun:test`:
  - Hub integration tests for route contracts + bootstrap/static behavior, including events entity-link href generation correctness
  - Security-regression integration tests with malicious payload fixtures (script tags, inline handlers, hostile URLs) asserting inert rendering/no execution
  - WS integration tests for reconnect/replay overlap, dedupe by `event_id`, and pause-buffer cap/flush semantics
  - Pure TS unit tests for extracted UI logic (hash parsing, pause-buffer, reconnect/backoff state machine)
- Minimal browser smoke tests (CI-enforced):
  - CI setup must start hub with explicit auth token fixture and fail-fast if `/ui/bootstrap` != 200
  - Seed deterministic fixtures via real API calls before tests (channel/topic/messages/events) and pass generated IDs to browser tests
  - `/ui` app boot and route navigation (channels → topics)
  - direct hard-load on deep route (`/ui/topics/:topic_id`) must boot successfully (asset/base-path correctness)
  - deep-link hash behavior (`#msg_<id>` highlight/hint)
  - `/ui/events` pause/resume behavior
  - events entity-link click-through verified (topic link + message link target correctness)
  - hard-load of entity-link targets succeeds
  - malicious payload smoke check: injected script/handler payloads are displayed inertly and do not execute
  - reconnect indicator path verified via deterministic disconnect trigger (test harness restarts hub or closes WS)
- Manual smoke:
  - create/test events and verify live updates + deep links.

---

## Gate: Hardening, cutover, and legacy removal

### Deliverables
- Soak period with feature flag + legacy path still present.
- During soak, CSP remains compatible with both modes (or conditionally applied by mode) so rollback remains valid.
- After soak/rollback window closure, tighten CSP to remove inline script requirements globally.
- Legacy inline HTML generators removed from `packages/hub/src/ui.ts` in the same follow-up change that tightens CSP globally.
- Feature flag removed in that same follow-up change.

### Rollback/feature-flag contract
- Temporary flag: `HUB_UI_SPA_ENABLED` gates SPA serving during rollout.
- Defaults:
  - dev: `true`
  - CI/integration: `true`
  - production release branch: `true` after cutover sign-off; rollback sets `false`
- Configuration source: hub runtime env var (documented in ops runbook).
- Rollback procedure during soak window (must be documented in runbook):
  1. Set `HUB_UI_SPA_ENABLED=false` and restart hub.
  2. Verify expected matrix:
     - auth-enabled + flag-off: `/ui` and deep `/ui/...` served by legacy UI; `/ui/bootstrap` and `/ui/assets/*` return 404.
     - no-auth + flag-off: all `/ui/*` return 503.
  3. Confirm no token leakage in responses when auth absent.
- Rollback procedure after legacy removal: redeploy previous known-good release (flag no longer available).
- Flag removed once:
  - minimum soak window of 7 days on `main` with SPA enabled,
  - CI jobs `typecheck` + `test` pass on first attempt for 2 consecutive `main` merge commits,
  - CI job `ui-browser-smoke` passes on first attempt for 20 consecutive `main` runs (manual reruns do not count toward streak),
  - manual smoke checklist passes,
  - no high-severity regressions open,
  - no sustained UI error-rate spike observed in soak logs/runbook checks.

### Acceptance criteria
- Hub UI path is materially simpler and easier to modify.
- No regressions in security posture and no-auth behavior.

### Verification
- `bun run typecheck`
- `bun test packages/hub`
- `bun test`
- Mandatory rollback drill during soak (flag off then back on) with recorded evidence of expected route matrix behavior.
- Manual CSP + reconnect checks.

---

## Test Strategy Matrix (explicit)

| Test type | Tool | Scope |
|---|---|---|
| Hub route/integration (SPA enabled) | `bun:test` | `/ui`, `/ui/bootstrap`, dynamically discovered `/ui/assets/*` paths, fallback precedence, no-auth namespace behavior, malicious payload inert-rendering checks |
| Hub route/integration (SPA disabled rollback mode) | `bun:test` | `HUB_UI_SPA_ENABLED=false`: legacy route ownership for `/ui` + deep routes; `/ui/bootstrap` + `/ui/assets/*` 404; no-auth namespace 503 |
| WS integration | `bun:test` | reconnect overlap, replay boundary ordering, `event_id` dedupe, pause-buffer cap/flush |
| UI logic unit tests | `bun:test` | extracted pure TS modules (hash/deep-link parsing, buffer limits, reconnect state) |
| Browser smoke (minimal) | Playwright (CI) | **auth-enabled hub precondition** (`/ui/bootstrap` must return 200), deterministic fixtures via API seeding, app boot, route navigation, deep-route hard-load, deep-link behavior, events entity-link navigation, malicious payload no-exec smoke, events pause/resume/reconnect UI |
| End-to-end smoke | manual | final human validation before flag removal |

> This plan explicitly introduces a minimal Playwright smoke suite; keep it narrow and deterministic.

## Risks and Mitigations

- **Generated asset drift** → enforced CI stale-check + deterministic generation.
- **Fallback route mistakes** → explicit precedence contract + tests for asset 404 vs SPA fallback.
- **XSS/rendering regression during SPA migration** → malicious-fixture integration + browser smoke checks are required gates.
- **Token exposure in browser** (known trust model) → localhost defaults + no-store bootstrap; no auth-model changes in this plan.

## Learnings

- _To be filled during execution per gate._
