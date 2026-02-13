<script lang="ts">
  import type { ApiClient, Event } from "../lib/api";
  import type { WsClient } from "../lib/ws";
  import { WsStatus } from "../lib/ws";
  import { isValidId } from "../lib/security";

  interface Props {
    api: ApiClient;
    ws: WsClient;
    onNavigate: (path: string) => void;
  }

  let { api, ws, onNavigate }: Props = $props();

  const MAX_EVENTS = 2000;
  const MAX_BUFFER = 500;

  let events = $state<Map<number, Event>>(new Map());
  let eventOrder = $state<number[]>([]);
  let paused = $state(false);
  let pausedBuffer = $state<Event[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let wsStatus = $state<WsStatus>(WsStatus.Disconnected);
  let reconnectAttempts = $state(0);
  let expandedEvents = $state<Set<number>>(new Set());

  let filterName = $state("");
  let filterChannelId = $state("");
  let filterTopicId = $state("");

  // Computed filtered events
  let filteredEvents = $derived(
    eventOrder
      .map((id) => events.get(id)!)
      .filter((event) => {
        if (!event) return false;

        if (filterName && !event.name.toLowerCase().includes(filterName.toLowerCase())) {
          return false;
        }

        if (filterChannelId && event.scope?.channel_id !== filterChannelId) {
          return false;
        }

        if (filterTopicId && event.scope?.topic_id !== filterTopicId) {
          return false;
        }

        return true;
      })
  );

  async function load(): Promise<number> {
    loading = true;
    error = null;

    // Reset view state before loading
    events = new Map();
    eventOrder = [];

    try {
      const { events: evts, replay_until } = await api.getEvents(200);

      for (const event of evts) {
        addEvent(event);
      }

      return replay_until;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return 0;
    } finally {
      loading = false;
    }
  }

  function addEvent(event: Event) {
    // Dedupe by event_id
    if (events.has(event.event_id)) return;

    events.set(event.event_id, event);
    eventOrder.push(event.event_id);

    // Evict oldest if over limit
    if (eventOrder.length > MAX_EVENTS) {
      const evictId = eventOrder.shift()!;
      events.delete(evictId);
    }

    events = events; // Trigger reactivity
    eventOrder = eventOrder;
  }

  function handleWsEvent(event: Event) {
    if (paused) {
      pausedBuffer.push(event);

      // Drop oldest if buffer exceeds limit
      if (pausedBuffer.length > MAX_BUFFER) {
        pausedBuffer.shift();
      }

      pausedBuffer = pausedBuffer; // Trigger reactivity
    } else {
      addEvent(event);
    }
  }

  function togglePause() {
    paused = !paused;

    if (!paused && pausedBuffer.length > 0) {
      // Flush buffer
      for (const event of pausedBuffer) {
        addEvent(event);
      }
      pausedBuffer = [];
    }
  }

  function toggleEventDetails(eventId: number) {
    if (expandedEvents.has(eventId)) {
      expandedEvents.delete(eventId);
    } else {
      expandedEvents.add(eventId);
    }
    expandedEvents = expandedEvents; // Trigger reactivity
  }

  function renderScope(scope: Event["scope"]): string {
    const parts: string[] = [];
    if (scope.channel_id) parts.push(`ch:${scope.channel_id}`);
    if (scope.topic_id) parts.push(`tp:${scope.topic_id}`);
    if (scope.topic_id2) parts.push(`tp2:${scope.topic_id2}`);
    return parts.join(", ") || "-";
  }

  function getEntityLink(entity: Event["entity"], scope: Event["scope"]): string | null {
    if (!entity) return null;

    if (entity.type === "topic" && isValidId(entity.id)) {
      return `/ui/topics/${entity.id}`;
    }

    if (
      entity.type === "message" &&
      scope?.topic_id &&
      isValidId(scope.topic_id) &&
      isValidId(entity.id)
    ) {
      return `/ui/topics/${scope.topic_id}#msg_${entity.id}`;
    }

    return null;
  }

  function handleEntityClick(event: Event, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    const link = getEntityLink(event.entity, event.scope);
    if (link) {
      const path = link.startsWith("/ui") ? link.slice(3) : link;
      onNavigate(path);
    }
  }

  $effect(() => {
    let active = true;

    const unsubscribe = ws.onEvent(handleWsEvent);
    const unsubscribeStatus = ws.onStatus((status) => {
      wsStatus = status;
      if (status === WsStatus.Disconnected) {
        reconnectAttempts = reconnectAttempts + 1;
      } else if (status === WsStatus.Connected) {
        reconnectAttempts = 0;
      }
    });

    (async () => {
      const replayUntil = await load();
      if (!active) return;
      ws.connect(replayUntil);
    })();

    return () => {
      active = false;
      unsubscribe();
      unsubscribeStatus();
    };
  });
</script>

<div class="events-timeline">
  <header>
    <nav>
      <a href="/ui" onclick={(e) => { e.preventDefault(); onNavigate("/"); }}>
        ← Channels
      </a>
    </nav>
    <h1>Event Timeline</h1>
    {#if wsStatus === WsStatus.Connected}
      <div class="status connected">● Live</div>
    {:else if wsStatus === WsStatus.Connecting}
      <div class="status connecting">○ Connecting...</div>
    {:else}
      <div class="status disconnected">○ Disconnected (retry {reconnectAttempts}/3)</div>
    {/if}
  </header>

  <div class="controls">
    <input type="text" bind:value={filterName} placeholder="Filter by event name..." />
    <input type="text" bind:value={filterChannelId} placeholder="Filter by channel_id..." />
    <input type="text" bind:value={filterTopicId} placeholder="Filter by topic_id..." />
    <button class:active={paused} onclick={togglePause}>
      {paused ? "Resume" : "Pause"}
    </button>
    {#if wsStatus === WsStatus.Error || (wsStatus === WsStatus.Disconnected && reconnectAttempts >= 3)}
      <button onclick={() => ws.manualReconnect()}>Retry Connection</button>
    {/if}
  </div>

  {#if paused && pausedBuffer.length > 0}
    <div class="status-message info">
      Paused (buffering {pausedBuffer.length}/{MAX_BUFFER} events)
    </div>
  {/if}

  {#if eventOrder.length >= MAX_EVENTS}
    <div class="status-message info">
      Showing last {MAX_EVENTS} events (oldest evicted)
    </div>
  {/if}

  {#if loading}
    <div class="loading">Loading events...</div>
  {:else if error}
    <div class="error">Error: {error}</div>
  {:else if filteredEvents.length === 0 && eventOrder.length > 0}
    <div class="status-message info">No events match current filters</div>
  {:else if filteredEvents.length === 0}
    <div class="status-message info">No events yet</div>
  {:else}
    <table class="event-table">
      <thead>
        <tr>
          <th style="width: 80px">Event ID</th>
          <th style="width: 180px">Timestamp</th>
          <th style="width: 200px">Name</th>
          <th style="width: 150px">Scope</th>
          <th>Entity</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredEvents as event (event.event_id)}
          <tr
            class="event-row"
            class:expanded={expandedEvents.has(event.event_id)}
            onclick={() => toggleEventDetails(event.event_id)}
          >
            <td>
              <span class="event-id">{event.event_id}</span>
            </td>
            <td>{new Date(event.ts).toLocaleString()}</td>
            <td>
              <span class="event-name">{event.name}</span>
            </td>
            <td>
              <span class="scope-info">{renderScope(event.scope)}</span>
            </td>
            <td>
              {#if event.entity}
                {#if getEntityLink(event.entity, event.scope)}
                  <a
                    class="entity-link"
                    href={getEntityLink(event.entity, event.scope)}
                    onclick={(e) => handleEntityClick(event, e)}
                  >
                    {event.entity.type}:{event.entity.id}
                  </a>
                {:else}
                  <span>{event.entity.type}:{event.entity.id}</span>
                {/if}
              {:else}
                <span>-</span>
              {/if}
            </td>
          </tr>
          {#if expandedEvents.has(event.event_id)}
            <tr class="event-details-row">
              <td colspan="5">
                <div class="event-details">
                  <pre>{JSON.stringify(
                    {
                      event_id: event.event_id,
                      ts: event.ts,
                      name: event.name,
                      scope: event.scope,
                      entity: event.entity,
                      data: event.data_json,
                    },
                    null,
                    2
                  )}</pre>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .events-timeline {
    padding: 0;
  }

  header {
    margin-bottom: 30px;
    padding-bottom: 20px;
    border-bottom: 2px solid var(--border-color);
    position: relative;
  }

  h1 {
    font-size: 2em;
    margin-bottom: 10px;
  }

  nav {
    margin-bottom: 10px;
    font-size: 0.9em;
  }

  nav a {
    color: var(--primary-color);
    text-decoration: none;
  }

  nav a:hover {
    text-decoration: underline;
  }

  .status {
    position: absolute;
    top: 0;
    right: 0;
    font-size: 0.85em;
    padding: 4px 8px;
    border-radius: 4px;
  }

  .status.connected {
    color: #28a745;
  }

  .status.connecting {
    color: #ffa500;
  }

  .status.disconnected {
    color: #dc3545;
  }

  .controls {
    margin-bottom: 20px;
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .controls input {
    padding: 6px 12px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-color);
    color: var(--text-color);
    font-family: var(--font-family);
    font-size: 0.9em;
  }

  .controls button {
    padding: 6px 16px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-color);
    color: var(--text-color);
    cursor: pointer;
    font-family: var(--font-family);
    font-size: 0.9em;
  }

  .controls button:hover {
    background: var(--border-color);
  }

  .controls button.active {
    background: var(--primary-color);
    color: white;
    border-color: var(--primary-color);
  }

  .status-message {
    font-size: 0.9em;
    padding: 8px 12px;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .status-message.info {
    background: rgba(0, 102, 204, 0.1);
    border: 1px solid rgba(0, 102, 204, 0.3);
    color: var(--primary-color);
  }

  .loading {
    color: var(--meta-color);
    padding: 20px 0;
  }

  .error {
    color: #cc0000;
    padding: 20px;
    background: rgba(255, 0, 0, 0.1);
    border-radius: 6px;
    border: 1px solid rgba(255, 0, 0, 0.3);
  }

  .event-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9em;
  }

  .event-table th {
    text-align: left;
    padding: 8px;
    border-bottom: 2px solid var(--border-color);
    font-weight: 600;
    position: sticky;
    top: 0;
    background: var(--bg-color);
    z-index: 1;
  }

  .event-table td {
    padding: 8px;
    border-bottom: 1px solid var(--border-color);
    vertical-align: top;
  }

  .event-row {
    cursor: pointer;
  }

  .event-row:hover {
    background: rgba(0, 102, 204, 0.05);
  }

  .event-row.expanded {
    background: rgba(0, 102, 204, 0.08);
  }

  .event-details-row {
    background: rgba(0, 102, 204, 0.08);
  }

  .event-details {
    margin: 8px 0;
    padding: 12px;
    background: rgba(0, 0, 0, 0.02);
    border-radius: 4px;
    border: 1px solid var(--border-color);
  }

  .event-details pre {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.85em;
    font-family: "Monaco", "Menlo", "Consolas", monospace;
  }

  .event-id {
    font-family: "Monaco", "Menlo", "Consolas", monospace;
    color: var(--meta-color);
  }

  .event-name {
    font-weight: 500;
    color: var(--primary-color);
  }

  .scope-info {
    font-size: 0.85em;
    color: var(--meta-color);
  }

  .entity-link {
    color: var(--primary-color);
    text-decoration: none;
    font-size: 0.85em;
  }

  .entity-link:hover {
    text-decoration: underline;
  }

  @media (prefers-color-scheme: dark) {
    .event-details {
      background: rgba(255, 255, 255, 0.05);
    }
  }
</style>
