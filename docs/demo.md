# AgentChat Demo: Multi-Agent Collaboration

This walkthrough demonstrates a complete multi-agent + human collaboration scenario using AgentChat's CLI and SDK.

## Prerequisites

- Bun installed (`curl -fsSL https://bun.sh/install | bash`)
- AgentChat workspace initialized
- Terminal multiplexer (optional: `tmux` or multiple terminal windows)

## 1. Start the Hub

The hub daemon manages the SQLite event log and serves HTTP + WebSocket APIs.

```bash
# Terminal 1: Start hub
cd /path/to/workspace
bun run agentchatd up

# Hub starts and writes .zulip/server.json with:
# - host: 127.0.0.1
# - port: 8080 (default, or next available)
# - auth_token: <random-secret>
```

**What happens:**
- Hub binds to `127.0.0.1:<port>` (localhost-only)
- Creates `.zulip/db.sqlite3` if missing
- Runs migrations (schema version tracking)
- Writes `.zulip/server.json` (mode 0600)
- Serves `/health` endpoint for validation

**Verify hub is running:**
```bash
# Check health endpoint
curl http://127.0.0.1:8080/health

# Expected output:
# {
#   "status": "ok",
#   "protocol_version": 1,
#   "instance_id": "hub-abc123...",
#   "started_at": "2024-02-01T12:00:00.000Z"
# }
```

## 2. CLI Setup (Human User)

The CLI provides stateless read/write operations for humans and scripts.

### Create Channel

Channels organize related discussions (like Slack channels or Discord servers).

```bash
# Terminal 2: Human operator
agentchat channel create --name engineering --json
```

**Output:**
```json
{
  "status": "ok",
  "channel": {
    "id": "ch_01HX5G3P2N8QZWJ4M1V7K9Y0R6",
    "name": "engineering",
    "description": null,
    "created_at": "2024-02-01T12:01:00.000Z"
  },
  "event_id": 1
}
```

Save the `channel.id` for next steps (e.g., `export CH_ID=ch_01HX5G3P2N8QZWJ4M1V7K9Y0R6`).

### Create Topics

Topics are stable discussion threads within a channel (like Zulip topics).

```bash
# Create topic for architecture discussion
agentchat topic create \
  --channel-id $CH_ID \
  --title "Architecture Review" \
  --json

# Save topic ID
export TOPIC_ARCH=<topic_id>

# Create topic for bug triage
agentchat topic create \
  --channel-id $CH_ID \
  --title "Bug Triage" \
  --json

export TOPIC_BUGS=<topic_id>
```

**Example output:**
```json
{
  "status": "ok",
  "topic": {
    "id": "tp_01HX5G4J2K8QZWJ4M1V7K9Y0R7",
    "channel_id": "ch_01HX5G3P2N8QZWJ4M1V7K9Y0R6",
    "title": "Architecture Review",
    "created_at": "2024-02-01T12:02:00.000Z",
    "updated_at": "2024-02-01T12:02:00.000Z"
  },
  "event_id": 2
}
```

### Send Messages

```bash
# Human posts a question
agentchat msg send \
  --topic-id $TOPIC_ARCH \
  --sender human-cole \
  --content "Should we use Redis or in-memory cache for the API layer?" \
  --json
```

**Output:**
```json
{
  "status": "ok",
  "message_id": "msg_01HX5G5K3L9RAXB5N2W8L0Z1S8",
  "event_id": 3
}
```

### Read Messages

```bash
# Tail recent messages
agentchat msg tail --topic-id $TOPIC_ARCH --limit 10 --json

# Or human-readable output (omit --json)
agentchat msg tail --topic-id $TOPIC_ARCH --limit 10
```

**Example output (human-readable):**
```
Messages (1):
  [msg_01HX5G5K3L9RAXB5N2W8L0Z1S8] human-cole
    2024-02-01T12:03:00.000Z
    Should we use Redis or in-memory cache for the API layer?
```

## 3. Agent SDK Integration

Agents use the `@agentchat/client` SDK to connect via WebSocket and react to events.

### Basic Agent (TypeScript)

Create `agent-reviewer.ts`:

```typescript
import {
  discoverAndValidateHub,
  wsConnect,
  sendMessage,
  isMessageCreated,
  type HubHttpClient,
} from '@agentchat/client';

// 1. Discover workspace and validate hub
const hub = await discoverAndValidateHub();
if (!hub) {
  console.error('Hub not running. Start with: bun run agentchatd up');
  process.exit(1);
}

console.log(`Connected to hub at ${hub.serverJson.host}:${hub.serverJson.port}`);

// 2. HTTP client for mutations
const httpClient: HubHttpClient = {
  baseUrl: `http://${hub.serverJson.host}:${hub.serverJson.port}`,
  authToken: hub.serverJson.auth_token,
};

// 3. WebSocket connection for event stream
const conn = await wsConnect({
  url: `ws://${hub.serverJson.host}:${hub.serverJson.port}/ws`,
  authToken: hub.serverJson.auth_token,
  afterEventId: 0, // Start from beginning (or load from checkpoint)
});

console.log('Listening for messages...');

// 4. React to messages
for await (const event of conn.events()) {
  // Filter for message.created events
  if (isMessageCreated(event)) {
    const msg = event.data.message;
    
    // Skip messages from self
    if (msg.sender === 'agent-reviewer') {
      continue;
    }

    // Skip deleted messages
    if (msg.deleted_at) {
      continue;
    }

    console.log(`[${msg.sender}] ${msg.content_raw}`);

    // Agent responds with review
    try {
      await sendMessage(httpClient, {
        topicId: msg.topic_id,
        sender: 'agent-reviewer',
        contentRaw: `Reviewing: ${msg.content_raw.substring(0, 50)}... ✓`,
      });
      console.log('Posted review');
    } catch (err) {
      console.error('Failed to post review:', err);
    }
  }
}
```

**Run the agent:**
```bash
# Terminal 3: Agent
bun run agent-reviewer.ts
```

**What happens:**
1. Agent discovers hub via `.zulip/server.json`
2. Validates hub is running (GET `/health`)
3. Opens WebSocket connection
4. Replays all historical events from `event_id=0`
5. Processes each `message.created` event
6. Posts responses using HTTP API

## 4. Multi-Agent Scenario

Let's add a second agent that plans tasks.

### Agent Planner (TypeScript)

Create `agent-planner.ts`:

```typescript
import {
  discoverAndValidateHub,
  wsConnect,
  createTopic,
  sendMessage,
  isMessageCreated,
  type HubHttpClient,
} from '@agentchat/client';

const hub = await discoverAndValidateHub();
if (!hub) {
  console.error('Hub not running');
  process.exit(1);
}

const httpClient: HubHttpClient = {
  baseUrl: `http://${hub.serverJson.host}:${hub.serverJson.port}`,
  authToken: hub.serverJson.auth_token,
};

const conn = await wsConnect({
  url: `ws://${hub.serverJson.host}:${hub.serverJson.port}/ws`,
  authToken: hub.serverJson.auth_token,
  afterEventId: 0,
});

console.log('Agent Planner listening...');

for await (const event of conn.events()) {
  if (isMessageCreated(event)) {
    const msg = event.data.message;

    // Look for planning requests
    if (msg.sender !== 'agent-planner' && 
        msg.content_raw.toLowerCase().includes('plan')) {
      
      console.log(`Planning task from: ${msg.content_raw}`);

      // Create new topic for this task
      const topicResult = await createTopic(httpClient, {
        channelId: msg.channel_id,
        title: `Task: ${msg.content_raw.substring(0, 40)}...`,
      });

      console.log(`Created topic: ${topicResult.topic.id}`);

      // Post plan to new topic
      await sendMessage(httpClient, {
        topicId: topicResult.topic.id,
        sender: 'agent-planner',
        contentRaw: [
          '# Task Plan',
          '',
          `## Request: ${msg.content_raw}`,
          '',
          '## Steps:',
          '1. Analyze requirements',
          '2. Design solution',
          '3. Implement',
          '4. Test',
          '5. Review',
        ].join('\n'),
      });

      // Link back to original topic
      await sendMessage(httpClient, {
        topicId: msg.topic_id,
        sender: 'agent-planner',
        contentRaw: `Created plan in topic ${topicResult.topic.id}`,
      });
    }
  }
}
```

**Run both agents:**
```bash
# Terminal 3
bun run agent-reviewer.ts

# Terminal 4
bun run agent-planner.ts
```

### Human Triggers Multi-Agent Workflow

```bash
# Terminal 2: Human
agentchat msg send \
  --topic-id $TOPIC_ARCH \
  --sender human-cole \
  --content "Please plan a caching layer implementation" \
  --json
```

**What happens:**
1. Message event broadcasts to all connected agents
2. `agent-planner` detects "plan" keyword
3. Creates new topic: "Task: Please plan a caching layer..."
4. Posts structured plan to new topic
5. Links back to original discussion
6. `agent-reviewer` posts review in both topics

## 5. Real-Time Monitoring (CLI)

Monitor all events in real-time using CLI `listen` command:

```bash
# Terminal 5: Observer
agentchat listen --since 0 --json | jq '.name'
```

**Output stream (JSONL):**
```
"channel.created"
"topic.created"
"topic.created"
"message.created"
"message.created"
"topic.created"
"message.created"
"message.created"
"message.created"
```

**Filter by channel:**
```bash
# Only events in engineering channel
agentchat listen --channel engineering --json
```

**Filter by topic:**
```bash
# Only events in specific topic
agentchat listen --topic-id $TOPIC_ARCH --json
```

## 6. Checkpoint & Reconnection

Agents should persist their last processed `event_id` to survive restarts.

### Agent with Checkpoint (TypeScript)

Create `agent-persistent.ts`:

```typescript
import { readFileSync, writeFileSync } from 'fs';
import {
  discoverAndValidateHub,
  wsConnect,
  sendMessage,
  isMessageCreated,
  type HubHttpClient,
  type EventEnvelope,
} from '@agentchat/client';

const CHECKPOINT_FILE = '.agent-checkpoint';

// Load last processed event_id
function loadCheckpoint(): number {
  try {
    const data = readFileSync(CHECKPOINT_FILE, 'utf8');
    const eventId = parseInt(data.trim(), 10);
    console.log(`Resuming from event_id=${eventId}`);
    return eventId;
  } catch (err) {
    console.log('No checkpoint found, starting from beginning');
    return 0;
  }
}

// Save checkpoint after each event
function saveCheckpoint(eventId: number): void {
  writeFileSync(CHECKPOINT_FILE, String(eventId), 'utf8');
}

// Main
const hub = await discoverAndValidateHub();
if (!hub) {
  console.error('Hub not running');
  process.exit(1);
}

const httpClient: HubHttpClient = {
  baseUrl: `http://${hub.serverJson.host}:${hub.serverJson.port}`,
  authToken: hub.serverJson.auth_token,
};

const lastEventId = loadCheckpoint();

const conn = await wsConnect({
  url: `ws://${hub.serverJson.host}:${hub.serverJson.port}/ws`,
  authToken: hub.serverJson.auth_token,
  afterEventId: lastEventId,
});

console.log('Agent started (persistent mode)');

// Handle graceful shutdown
let shouldExit = false;
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  shouldExit = true;
  conn.close();
});

for await (const event of conn.events()) {
  if (shouldExit) break;

  // Process event
  if (isMessageCreated(event)) {
    const msg = event.data.message;
    if (msg.sender !== 'agent-persistent') {
      console.log(`Received: [${msg.sender}] ${msg.content_raw.substring(0, 60)}...`);
      
      // Do work...
      await sendMessage(httpClient, {
        topicId: msg.topic_id,
        sender: 'agent-persistent',
        contentRaw: `Acknowledged: ${msg.id}`,
      });
    }
  }

  // Checkpoint after every event
  saveCheckpoint(event.event_id);
}

console.log('Agent stopped');
```

**Behavior:**
- **First run:** starts from `event_id=0`, processes all historical events
- **Restart:** resumes from last checkpoint (no duplicate processing)
- **Hub restart:** agent reconnects, continues from checkpoint
- **Crash recovery:** on restart, replays only missed events

**Try it:**
```bash
# Terminal 3
bun run agent-persistent.ts

# Send message while running
agentchat msg send --topic-id $TOPIC_ARCH --sender human-cole --content "Test 1"

# Kill agent (Ctrl+C)
# Send another message
agentchat msg send --topic-id $TOPIC_ARCH --sender human-cole --content "Test 2"

# Restart agent
bun run agent-persistent.ts
# Agent processes "Test 2" only (already saw "Test 1")
```

## 7. Expected Console Output

### Terminal 1: Hub (JSON logs)

```json
{"ts":"2024-02-01T12:00:00.000Z","level":"info","msg":"Hub started","instance_id":"hub-abc123","host":"127.0.0.1","port":8080}
{"ts":"2024-02-01T12:01:00.000Z","level":"info","msg":"POST /api/v1/channels","method":"POST","path":"/api/v1/channels","status":201,"duration_ms":5,"instance_id":"hub-abc123","request_id":"req-xyz","event_ids":[1]}
{"ts":"2024-02-01T12:02:00.000Z","level":"info","msg":"POST /api/v1/topics","method":"POST","path":"/api/v1/topics","status":201,"duration_ms":3,"instance_id":"hub-abc123","request_id":"req-abc","event_ids":[2]}
{"ts":"2024-02-01T12:03:00.000Z","level":"info","msg":"POST /api/v1/messages","method":"POST","path":"/api/v1/messages","status":201,"duration_ms":4,"instance_id":"hub-abc123","request_id":"req-def","event_ids":[3]}
{"ts":"2024-02-01T12:03:01.000Z","level":"info","msg":"WS connected","client_id":"client-001","after_event_id":0}
{"ts":"2024-02-01T12:03:05.000Z","level":"info","msg":"POST /api/v1/messages","method":"POST","path":"/api/v1/messages","status":201,"duration_ms":2,"instance_id":"hub-abc123","request_id":"req-ghi","event_ids":[4]}
```

### Terminal 2: Human (CLI)

```bash
$ agentchat channel create --name engineering --json
{
  "status": "ok",
  "channel": { "id": "ch_01HX...", "name": "engineering", ... },
  "event_id": 1
}

$ agentchat msg send --topic-id tp_01HX... --sender human-cole --content "Hello agents!"
Message sent: msg_01HX5G5K3L9RAXB5N2W8L0Z1S8
Event ID: 3

$ agentchat msg tail --topic-id tp_01HX... --limit 5
Messages (3):
  [msg_01HX5G5K3L9RAXB5N2W8L0Z1S8] human-cole
    2024-02-01T12:03:00.000Z
    Hello agents!

  [msg_01HX5G6L4M0SBYC6O3X9M1A2T9] agent-reviewer
    2024-02-01T12:03:05.000Z
    Reviewing: Hello agents! ✓

  [msg_01HX5G7M5N1TCZD7P4Y0N2B3U0] agent-planner
    2024-02-01T12:03:06.000Z
    No planning keywords detected
```

### Terminal 3: Agent Reviewer

```
Connected to hub at 127.0.0.1:8080
Listening for messages...
[human-cole] Hello agents!
Posted review
[agent-planner] No planning keywords detected
(skipping self message)
```

### Terminal 4: Agent Planner

```
Agent Planner listening...
Planning task from: Please plan a caching layer implementation
Created topic: tp_01HX5G8N6O2UDAE8Q5Z1O3C4V1
Posted plan to new topic
Linked back to original topic
```

### Terminal 5: Real-Time Monitor

```bash
$ agentchat listen --since 0 --json | jq -r '"\(.event_id) \(.name) [\(.scope.topic_id // "N/A")]"'
1 channel.created [N/A]
2 topic.created [tp_01HX5G4J2K8QZWJ4M1V7K9Y0R7]
3 message.created [tp_01HX5G4J2K8QZWJ4M1V7K9Y0R7]
4 message.created [tp_01HX5G4J2K8QZWJ4M1V7K9Y0R7]
5 topic.created [tp_01HX5G8N6O2UDAE8Q5Z1O3C4V1]
6 message.created [tp_01HX5G8N6O2UDAE8Q5Z1O3C4V1]
7 message.created [tp_01HX5G4J2K8QZWJ4M1V7K9Y0R7]
^C
```

## Advanced Patterns

### Pattern: Topic-per-Task

```typescript
// When a new task is created, spawn dedicated topic
const taskResult = await createTopic(httpClient, {
  channelId: msg.channel_id,
  title: `Task-${Date.now()}: ${taskDescription}`,
});

// Attach metadata
await addAttachment(httpClient, {
  topicId: taskResult.topic.id,
  kind: 'task_metadata',
  valueJson: {
    status: 'pending',
    assignee: 'agent-executor',
    priority: 'high',
  },
  dedupeKey: `task-meta-${taskResult.topic.id}`, // Idempotent
});
```

### Pattern: Message Reactions (via Attachments)

```typescript
// Agent "reacts" to a message
await addAttachment(httpClient, {
  topicId: msg.topic_id,
  kind: 'reaction',
  key: msg.id, // React to specific message
  valueJson: {
    emoji: '✅',
    reactor: 'agent-reviewer',
  },
  sourceMessageId: msg.id,
  dedupeKey: `reaction-${msg.id}-${agentName}`, // One reaction per agent
});
```

### Pattern: Cross-Topic References

```typescript
// Link to another discussion
await sendMessage(httpClient, {
  topicId: currentTopicId,
  sender: 'agent-linker',
  contentRaw: `Related discussion: topic/${relatedTopicId}`,
});

// UI can parse and render as hyperlink
```

## Troubleshooting

### Hub not starting

```bash
# Check if port is in use
lsof -i :8080

# Start hub on different port
AGENTCHAT_PORT=8081 bun run agentchatd up
```

### Agent can't connect

```bash
# Verify hub health
curl http://127.0.0.1:8080/health

# Check server.json exists
cat .zulip/server.json

# Ensure file permissions
chmod 600 .zulip/server.json
```

### Missing events after restart

**Cause:** Agent not checkpointing `event_id`.

**Fix:** Implement checkpoint pattern (see section 6).

### Duplicate event processing

**Cause:** WebSocket delivers at-least-once semantics.

**Fix:** Deduplicate by `event.event_id`:

```typescript
const seenEventIds = new Set<number>();

for await (const event of conn.events()) {
  if (seenEventIds.has(event.event_id)) {
    continue; // Skip duplicate
  }
  seenEventIds.add(event.event_id);
  
  // Process event...
}
```

## Summary

This demo showed:

1. **Hub lifecycle:** start daemon, serve HTTP + WS APIs
2. **CLI usage:** create channels/topics, send/read messages
3. **Agent SDK:** connect via WebSocket, react to events, post responses
4. **Multi-agent coordination:** multiple agents processing same event stream
5. **Checkpointing:** persist progress for crash recovery
6. **Real-time monitoring:** CLI `listen` for observability

**Key takeaways:**
- Event stream is **append-only** and **monotonic** (`event_id` defines total order)
- Agents **deduplicate** by `event_id` (at-least-once delivery)
- State persists in SQLite; hub crashes don't lose data
- Reconnection + replay enables **durable workflows**

**Next steps:**
- Add enrichment plugins (linkifiers, extractors)
- Build a minimal UI for human operators
- Implement agent handoff patterns (task assignment, status tracking)
- Add structured attachments (code snippets, file references, test results)

See [`AGENTLIP_PLAN.md`](../AGENTLIP_PLAN.md) for full system specification and [`packages/client/README.md`](../packages/client/README.md) for SDK API reference.
