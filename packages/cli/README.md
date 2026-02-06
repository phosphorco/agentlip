# agentlip

Stateless CLI for Agentlip workspaces. Provides:

- **Workspace discovery** - finds `.agentlip/db.sqlite3` by walking upward from cwd
- **Read-only DB access** - opens DB with `PRAGMA query_only=ON` for safe concurrent reads

## Installation

Part of the agentlip monorepo. Link via workspace dependencies.

## Library Usage

```typescript
import {
  discoverWorkspaceRoot,
  openWorkspaceDbReadonly,
  isQueryOnly,
  WorkspaceNotFoundError,
} from "agentlip";

// Discover workspace (returns null if not found)
const discovered = await discoverWorkspaceRoot("/path/to/start");
if (!discovered) {
  console.log("No workspace found");
}

// Open DB read-only
try {
  const { db, workspaceRoot, dbPath } = await openWorkspaceDbReadonly();
  
  // Verify query_only is on
  console.log("Query only:", isQueryOnly(db));  // true
  
  // Safe to read while hub is running
  const row = db.query("SELECT * FROM messages LIMIT 1").get();
  
  db.close();
} catch (err) {
  if (err instanceof WorkspaceNotFoundError) {
    console.log("No workspace found");
  }
}
```

## CLI Usage

```bash
# Run diagnostics on workspace
agentlip doctor

# With explicit workspace path
agentlip doctor --workspace /path/to/workspace

# JSON output
agentlip doctor --json
```

## Safety Guarantees

1. **Discovery never initializes** - `discoverWorkspaceRoot` only searches, never creates
2. **Read-only enforced** - `openWorkspaceDbReadonly` sets `PRAGMA query_only=ON`
3. **Concurrent safe** - Multiple CLI readers can coexist with hub (single writer)
4. **Boundary safe** - Discovery stops at filesystem root and user home directory

## Testing

```bash
# Run tests
bun test

# Run verification script
bun verify.ts
```
