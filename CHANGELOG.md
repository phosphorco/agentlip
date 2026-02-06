# Changelog

All notable changes to Agentlip will be documented in this file.

## [Unreleased]

### Added
- Initial changelog setup for Craft release workflow

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
