# Agentlip Hub UI (Svelte 5 SPA)

This package contains the Svelte 5 Single Page Application for the Agentlip Hub UI.

## Architecture

- **Framework**: Svelte 5 (runes mode)
- **Build Tool**: Vite
- **Routing**: History API client-side routing under `/ui/*`
- **State Management**: Svelte runes (`$state`, `$derived`, `$effect`)
- **WebSocket**: Custom WsClient with reconnect/backoff/dedupe logic

## Project Structure

```
src/
  lib/
    bootstrap.ts       # Runtime config loader (/ui/bootstrap endpoint)
    api.ts             # HTTP API client wrapper
    ws.ts              # WebSocket client with reconnect logic
    router.ts          # Hash-based router (unused - routing in App.svelte)
    security.ts        # URL/ID validation utilities
  components/
    ChannelsList.svelte      # /ui (channels list)
    TopicsList.svelte        # /ui/channels/:id (topics list)
    TopicMessages.svelte     # /ui/topics/:id (messages + attachments + live WS)
    EventsTimeline.svelte    # /ui/events (events with filters/pause/buffer)
  App.svelte           # Root component with routing
  main.ts              # Entry point (mounts App)
```

## Routes

| Path                      | Component           | Description                          |
| ------------------------- | ------------------- | ------------------------------------ |
| `/ui`                     | ChannelsList        | List all channels                    |
| `/ui/channels/:id`        | TopicsList          | List topics in a channel             |
| `/ui/topics/:id`          | TopicMessages       | View messages/attachments + live WS  |
| `/ui/topics/:id#msg_<id>` | TopicMessages       | Deep link to specific message        |
| `/ui/events`              | EventsTimeline      | Event timeline with filters/pause    |

## Security

- **No inline scripts**: All JavaScript is in external files (CSP-ready)
- **No innerHTML usage**: All user content rendered via `textContent`
- **URL validation**: `isValidUrl()` checks before creating links
- **ID validation**: `isValidId()` checks before generating hrefs or element IDs

## WebSocket Behavior

- **Reconnect**: Exponential backoff (1s, 2s, 4s, 8s, up to 30s max)
- **Dedupe**: Client dedupes by `event_id` to prevent duplicates during replay/live overlap
- **Pause/Resume**: Events timeline supports pause with bounded buffer (500 events max)
- **Subscriptions**: Can filter WS events by `topics: [...]` or `channels: [...]`

## Development

```bash
# Install dependencies
bun install

# Start dev server (with HMR)
bun run dev

# Build for production
bun run build

# Typecheck
bun run typecheck
```

## Production Build

The production build is embedded into `@agentlip/hub` as base64-encoded assets:

```bash
cd ../hub
bun run ui:embed
```

This generates `packages/hub/src/uiAssets.generated.ts` which is committed to git.

## Testing

Hub integration tests verify:
- SPA shell serving with correct cache headers
- Bootstrap endpoint contract
- Deep link fallback behavior
- Security (no inline scripts, malicious payloads inert)
- WebSocket replay/dedupe/reconnect

Browser smoke tests (future work) will verify:
- Client-side routing navigation
- Hash deep link scroll/highlight
- Pause/resume buffer behavior
- Reconnect UI indicators
- Malicious payload rendering (no script execution)
