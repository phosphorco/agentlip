# Security Boundary Test Suite Summary (bd-16d.6.14)

This document maps the **security boundary checklist** in `AGENTLIP_PLAN.md` (Gate J + “Security boundary tests”) to concrete, automated test coverage in this repo.

Scope note:
- Where a plan item depends on **future Phase 3 plugin isolation** or **finalized logging plumbing**, this document marks it as **deferred** and explains why.
- This doc intentionally avoids brittle line-number references.

---

## Gate J: Security Baseline (AGENTLIP_PLAN.md §0.7)

| Gate J requirement | Coverage status | Evidence (tests / code) |
|---|---:|---|
| Auth token is ≥128-bit cryptographically random | ✅ | `packages/hub/src/securityBaseline.test.ts` → `generateAuthToken` suite (64 hex chars = 256-bit; uniqueness + prefix variance). |
| Auth token is stored with mode 0600 (and .zulip dir 0700) | ✅ | `packages/hub/src/securityBaseline.test.ts` → `server.json security` suite (`writeServerJson` creates 0600; `.zulip/` dir 0700). |
| Hub binds localhost only by default (reject 0.0.0.0 unless explicitly allowed) | ✅ | `packages/hub/src/securityBaseline.test.ts` → `assertLocalhostBind` + `startHub localhost binding` suites. |
| Prepared statements / SQL injection resistance | ✅ | `packages/hub/src/securityBaseline.test.ts` → `SQL injection resistance` suite (channel/topic/message content + query param vectors stored/handled safely). |
| Rate limits enforced (per-client + global) | ✅ | Unit: `packages/hub/src/rateLimiter.test.ts`, `packages/hub/src/rateLimiter.edge.test.ts` (new). Integration: `packages/hub/src/index.test.ts` rate limiting cases + headers. |
| Input size limits enforced (msg≤64KB, attach≤16KB, WS≤256KB) | ✅ | HTTP parsing: `packages/hub/src/bodyParser.test.ts` + `packages/hub/src/index.test.ts` (“oversized JSON body”). API contracts: `packages/hub/src/apiV1.test.ts` (oversized message + oversized attachment `value_json`). WS: `packages/hub/src/bodyParser.test.ts` (`validateWsMessageSize` / `parseWsMessage`) + `packages/hub/src/wsEndpoint.test.ts` (oversized hello). |
| Logs never contain auth tokens or full message content | ⚠️ (partial) | Implementation: `packages/hub/src/index.ts` structured request logs omit headers/body; request logging is disabled in test env (`emitLog` no-op). Automated *response* leakage tests exist (see below). A direct “scan stdout for token” test is deferred until logging is finalized (see Deferred Items). |
| Plugin isolation: plugins cannot write to `.zulip/` | ⏸️ deferred | Requires Phase 3 plugin runtime/isolation (`bd-16d.4.*`). Will be enforced + tested when plugin execution exists. |
| Workspace config loaded only from discovered workspace root (no upward traversal surprises) | ✅ | `packages/workspace/src/index.test.ts` (workspace discovery + boundary behavior + `.zulip` perms). `packages/cli/src/index.test.ts` (CLI workspace discovery + read-only open). |

### Token leakage prevention (responses)
Covered by:
- `packages/hub/src/authMiddleware.test.ts` (no token leakage via auth parsing / WS close reason)
- `packages/hub/src/securityBaseline.test.ts` → `token leakage prevention` suite (401 bodies don’t echo expected/provided token; validation errors don’t echo arbitrary user payload)

---

## Plan “Security boundary tests” checklist (AGENTLIP_PLAN.md)

| Checklist item | Coverage status | Evidence |
|---|---:|---|
| SQL injection in message content / channel name / topic title / query params | ✅ | `packages/hub/src/securityBaseline.test.ts` → `SQL injection resistance` suite |
| Oversized message (e.g. 100KB) rejected | ✅ | `packages/hub/src/apiV1.test.ts` → “rejects oversized content (>64KB)” + `packages/hub/src/bodyParser.test.ts` |
| Oversized attachment metadata rejected | ✅ | `packages/hub/src/apiV1.test.ts` → “rejects oversized value_json (>16KB)” |
| Oversized WS message closes connection | ✅ | `packages/hub/src/bodyParser.test.ts` (`validateWsMessageSize`/`parseWsMessage`) + `packages/hub/src/wsEndpoint.test.ts` (“oversized hello message”) |
| Auth token not echoed in error responses | ✅ | `packages/hub/src/securityBaseline.test.ts` (401 + validation) + `packages/hub/src/authMiddleware.test.ts` |
| server.json permissions (0600) + .zulip dir permissions (0700) | ✅ | `packages/hub/src/securityBaseline.test.ts` (`writeServerJson` + dir perms) |
| Localhost bind safety | ✅ | `packages/hub/src/securityBaseline.test.ts` |
| Workspace traversal/discovery boundaries | ✅ | `packages/workspace/src/index.test.ts` + `packages/cli/src/index.test.ts` |
| Plugin write attempt blocked | ⏸️ deferred | Needs Phase 3 plugin isolation implementation |
| Auth token not present in logs | ⏸️ deferred | Needs a stable logging capture strategy (see Deferred Items) |

---

## How to verify locally

```bash
bun test
bun run typecheck

# Focused:
bun test packages/hub/src/securityBaseline.test.ts
bun test packages/hub/src/authMiddleware.test.ts
bun test packages/hub/src/bodyParser.test.ts
bun test packages/hub/src/wsEndpoint.test.ts
bun test packages/hub/src/apiV1.test.ts
bun test packages/hub/src/index.test.ts
bun test packages/workspace/src/index.test.ts
bun test packages/cli/src/index.test.ts
```

---

## Deferred items (explicit)

### 1) Plugin write isolation
Deferred because the plugin runtime/isolation does not exist yet in Phase 2. Once Phase 3 lands, add a test that runs an actual plugin (Worker/subprocess) and asserts it cannot write under `.zulip/`.

### 2) “Token not in logs” automated audit
Currently `emitLog()` is a no-op in test environments, so unit tests cannot trivially capture request logs. When logging is finalized, add an integration test that:
1) runs the hub in a subprocess with logging enabled,
2) sends requests containing a known token,
3) asserts the token string never appears in stdout/stderr.

---

**Last updated:** 2026-02-05
