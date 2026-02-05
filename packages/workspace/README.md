# @agentlip/workspace

Workspace discovery and initialization for Agentlip.

## Overview

This package provides workspace discovery by walking upward from the current directory to find a `.agentlip/db.sqlite3` marker. If no workspace is found within security boundaries, it can initialize a new workspace.

## Security Boundaries

The upward traversal stops at:

1. **Filesystem boundary** - Detected by device ID change (prevents crossing mount points)
2. **User home directory** - Never traverses above `$HOME`
3. **Filesystem root** - Stops at `/` (or drive root on Windows)

This prevents:
- Accidentally discovering workspaces outside the intended scope
- Traversing into system directories
- Crossing network mounts or containerized filesystems

## API

### `discoverWorkspaceRoot(startPath?: string)`

Discover workspace root by walking upward from `startPath` (defaults to `cwd`).

**Returns:** `WorkspaceDiscoveryResult | null`

- Returns `null` if no workspace found within security boundaries
- Returns discovery result if `.agentlip/db.sqlite3` exists in current or parent directory

```typescript
const result = await discoverWorkspaceRoot();
if (result) {
  console.log(`Workspace root: ${result.root}`);
  console.log(`Database: ${result.dbPath}`);
}
```

### `ensureWorkspaceInitialized(workspaceRoot: string)`

Ensure workspace is initialized at the given directory.

**Returns:** `WorkspaceInitResult`

Creates:
- `.agentlip/` directory with mode `0700` (owner rwx only)
- `db.sqlite3` file with mode `0600` (owner rw only)

Idempotent - safe to call multiple times.

```typescript
const result = await ensureWorkspaceInitialized('/path/to/project');
console.log(`Created: ${result.created}`);
console.log(`DB Path: ${result.dbPath}`);
```

### `discoverOrInitWorkspace(startPath?: string)`

Combined discovery + initialization.

**Returns:** `WorkspaceDiscoveryResult` (never null)

Workflow:
1. Attempts discovery from `startPath` (or cwd)
2. If found, returns discovered workspace
3. If not found, initializes workspace at `startPath` and returns it

```typescript
const result = await discoverOrInitWorkspace();
if (result.discovered) {
  console.log(`Found existing workspace at ${result.root}`);
} else {
  console.log(`Initialized new workspace at ${result.root}`);
}
```

## Types

```typescript
interface WorkspaceDiscoveryResult {
  /** Absolute path to workspace root directory */
  root: string;
  /** Absolute path to db.sqlite3 file */
  dbPath: string;
  /** Whether workspace was discovered (true) or initialized (false) */
  discovered: boolean;
}

interface WorkspaceInitResult {
  /** Absolute path to workspace root directory */
  root: string;
  /** Absolute path to db.sqlite3 file */
  dbPath: string;
  /** Whether workspace was newly created (true) or already existed (false) */
  created: boolean;
}
```

## Testing

```bash
# Run unit tests
bun test

# Run verification script
bun verify.ts
```

## Implementation Notes

- Uses `lstat()` to detect filesystem boundaries via device ID
- Stops at user home directory using `os.homedir()`
- Creates files with restrictive permissions (Unix-like systems only)
- Handles symlinks safely by using `lstat()` instead of `stat()`
- Resolves all paths to absolute form to prevent confusion
