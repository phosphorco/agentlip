# Plugin Runtime Integration Guide

This document describes how to integrate the Worker-based plugin runtime harness (bd-16d.4.3) with the Agentlip hub.

## Architecture Overview

The plugin runtime provides:
- **Worker isolation**: Plugins run in separate Bun Worker threads
- **Timeout enforcement**: Wall-clock timeouts (default 5s) with Worker termination
- **Circuit breaker**: Automatic failure tracking and circuit opening after repeated failures
- **RPC protocol**: Structured request/response with type validation
- **Error handling**: Graceful handling of crashes, timeouts, and invalid outputs

## Core Modules

### `pluginRuntime.ts`
Main runtime harness implementing:
- `runPlugin<T>(options)` - Execute a plugin with timeout and circuit breaker
- `CircuitBreaker` - Global failure tracking and circuit state management
- Output validation for enrichments and attachments

### `pluginWorker.ts`
Worker script that executes plugin code in isolated context:
- Dynamically imports plugin modules
- Calls `enrich()` or `extract()` based on plugin type
- Sends RPC responses back to main thread

## Integration Points

### 1. Message Creation (`apiV1.ts` POST /api/v1/messages)

After inserting a new message, trigger plugin execution:

```typescript
// In handlePostMessages after successful message.created event emission:
const message = { /* message data */ };

// Execute linkifier plugins (enrichments)
for (const linkifier of pluginConfig.linkifiers ?? []) {
  const result = await runPlugin<Enrichment[]>({
    type: "linkifier",
    modulePath: linkifier.modulePath,
    input: {
      message: {
        id: message.id,
        content_raw: message.content_raw,
        sender: message.sender,
        topic_id: message.topic_id,
        channel_id: message.channel_id,
        created_at: message.created_at,
      },
      config: linkifier.config ?? {},
    },
    timeoutMs: linkifier.timeout ?? 5000,
    pluginName: linkifier.name,
  });

  if (result.ok) {
    // Insert enrichments + emit message.enriched events
    // (with staleness guard - verify content_raw unchanged)
  } else {
    // Log error; continue with other plugins
    console.error(`Linkifier ${linkifier.name} failed: ${result.error}`);
  }
}

// Execute extractor plugins (attachments)
for (const extractor of pluginConfig.extractors ?? []) {
  const result = await runPlugin<Attachment[]>({
    type: "extractor",
    modulePath: extractor.modulePath,
    input: { /* same as above */ },
    timeoutMs: extractor.timeout ?? 5000,
    pluginName: extractor.name,
  });

  if (result.ok) {
    // Insert attachments with dedupe_key + emit topic.attachment_added
    // (with staleness guard)
  } else {
    console.error(`Extractor ${extractor.name} failed: ${result.error}`);
  }
}
```

### 2. Message Edit (`apiV1.ts` PATCH /api/v1/messages/:message_id)

After successful edit event emission, re-run plugins on new content:

```typescript
// Same pattern as message creation
// Staleness guard is critical here to avoid race conditions
```

### 3. Staleness Guard (Critical for Correctness)

Before committing plugin outputs, verify message content hasn't changed:

```typescript
// Re-read current message state inside transaction
const current = db.query<{ content_raw: string; deleted_at: string | null }, [string]>(
  'SELECT content_raw, deleted_at FROM messages WHERE id = ?'
).get(messageId);

if (current.content_raw !== originalContent || current.deleted_at !== null) {
  // Discard plugin outputs; do not commit or emit events
  return;
}

// Safe to commit enrichments/attachments
```

### 4. Plugin Configuration Loading (Future: bd-16d.4.2)

Load plugin configuration from `agentlip.config.ts`:

```typescript
interface PluginConfig {
  linkifiers?: Array<{
    name: string;
    modulePath: string;
    timeout?: number;
    config?: Record<string, unknown>;
  }>;
  extractors?: Array<{
    name: string;
    modulePath: string;
    timeout?: number;
    config?: Record<string, unknown>;
  }>;
}
```

## Error Codes

- `TIMEOUT`: Plugin exceeded wall-clock timeout (Worker terminated)
- `WORKER_CRASH`: Plugin threw unhandled error
- `INVALID_OUTPUT`: Output validation failed (missing fields, wrong types)
- `CIRCUIT_OPEN`: Circuit breaker tripped (N failures, cooldown active)
- `LOAD_ERROR`: Failed to load plugin module
- `EXECUTION_ERROR`: Other execution errors

## Circuit Breaker Behavior

- **Threshold**: 3 consecutive failures
- **Cooldown**: 60 seconds
- **State**: per-plugin (tracked by `pluginName`)
- **Reset**: successful execution resets failure count to 0

## Testing

See `pluginRuntime.test.ts` for comprehensive test coverage:
- Timeout enforcement (Worker termination)
- Circuit breaker (skip after failures, reset on success)
- Output validation (enrichments, attachments)
- Worker crash handling
- Concurrent plugin execution

## Security Notes

- **v1 limitation**: Plugins CAN access network and filesystem (Worker limitations)
- **No write access to `.agentlip/`**: Enforced by file permissions (future: bd-16d.4.4)
- **Timeout bounds hangs**: Even infinite loops are terminated
- **Circuit breaker prevents cascade**: Broken plugins don't block hub

## Performance Considerations

- **Worker spawn overhead**: ~5-10ms per execution
- **Timeout default**: 5s (configurable per plugin)
- **Parallel execution**: Multiple plugins can run concurrently (bounded by CPU)
- **Circuit breaker saves CPU**: Skip execution when plugin is broken

## Future Enhancements

- **Subprocess isolation** (v2): Stronger isolation with child processes
- **Capability grants**: Explicit network/filesystem permissions
- **Plugin caching**: Reuse Worker instances for better performance
- **Metrics**: Track execution times, failure rates, circuit state
