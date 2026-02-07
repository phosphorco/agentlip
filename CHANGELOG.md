# Changelog

All notable changes to Agentlip will be documented in this file.

## [Unreleased]

## [0.1.1-rc.1] - 2026-02-07

### Added
- Node v22+ ESM local client (`agentlip/local-client`) and Node-friendly SDK exports (conditional exports + built `dist/`)
- Hub daemon idle auto-shutdown (opt-in, daemon-mode only)
- npm Trusted Publishing (OIDC) + provenance support in publish workflow

## [0.1.0] - 2025-02-06

### Added
- Initial release of Agentlip local hub
- SQLite-backed event stream for agent coordination
- HTTP + WebSocket API for channels, topics, and messages
- TypeScript SDK (`@agentlip/client`) with workspace discovery
- CLI tool (`agentlip`) for channel/topic/message operations
- Plugin runtime with worker-based isolation
- Optimistic locking for concurrent writes
- Message tombstone deletion with event emission
- FTS (Full-Text Search) support (opt-in via `AGENTLIP_ENABLE_FTS=1`)

### Packages
- `@agentlip/protocol` - Shared types and error codes
- `@agentlip/kernel` - SQLite schema, queries, mutations
- `@agentlip/workspace` - Workspace discovery with security boundaries
- `@agentlip/client` - TypeScript SDK
- `@agentlip/hub` - Bun HTTP+WS server and plugin runtime
- `agentlip` - CLI tool
