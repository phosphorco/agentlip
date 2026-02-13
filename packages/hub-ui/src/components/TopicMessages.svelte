<script lang="ts">
  import type { ApiClient, Message, Attachment, Topic, Channel } from "../lib/api";
  import type { WsClient } from "../lib/ws";
  import { WsStatus } from "../lib/ws";
  import { isValidId, isValidUrl } from "../lib/security";

  interface Props {
    api: ApiClient;
    ws: WsClient;
    topicId: string;
    onNavigate: (path: string) => void;
  }

  let { api, ws, topicId, onNavigate }: Props = $props();

  let topicData = $state<{ topic: Topic; channel: Channel } | null>(null);
  let messages = $state<Map<string, Message>>(new Map());
  let attachments = $state<Attachment[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let wsStatus = $state<WsStatus>(WsStatus.Disconnected);
  let hashHintShown = $state(false);

  // Computed sorted messages
  let sortedMessages = $derived(
    Array.from(messages.values()).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )
  );

  async function load() {
    loading = true;
    error = null;
    hashHintShown = false;

    try {
      topicData = await api.findTopic(topicId);
      if (!topicData) {
        error = `Topic not found: ${topicId}`;
        loading = false;
        return;
      }

      const [msgs, atts] = await Promise.all([
        api.getMessages(topicId, 50),
        api.getAttachments(topicId),
      ]);

      messages = new Map(msgs.map((m) => [m.id, m]));
      attachments = atts;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function handleWsEvent(event: any) {
    if (event.scope?.topic_id !== topicId) return;

    if (event.name === "message.created" || event.name === "message.edited" || event.name === "message.deleted") {
      if (event.data?.message) {
        messages.set(event.data.message.id, event.data.message);
        messages = messages; // Trigger reactivity
      }
    } else if (event.name === "topic.attachment_added" && event.data?.attachment) {
      const exists = attachments.find((a) => a.id === event.data.attachment.id);
      if (!exists) {
        attachments = [...attachments, event.data.attachment];
      }
    }
  }

  function handleHashNavigation() {
    const hash = window.location.hash;
    if (!hash.startsWith("#msg_")) return;

    const msgId = hash.slice(5);
    if (!msgId || !isValidId(msgId)) return;

    hashHintShown = false;

    let attempts = 0;
    const maxAttempts = 24;

    const tryResolve = () => {
      const el = document.getElementById(`msg_${msgId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("highlighted");
        return;
      }

      attempts += 1;
      if (attempts < maxAttempts) {
        requestAnimationFrame(tryResolve);
        return;
      }

      hashHintShown = true;
    };

    requestAnimationFrame(tryResolve);
  }

  $effect(() => {
    let active = true;

    window.addEventListener("hashchange", handleHashNavigation);

    const unsubscribe = ws.onEvent(handleWsEvent);
    const unsubscribeStatus = ws.onStatus((status) => {
      wsStatus = status;
    });

    (async () => {
      await load();
      if (!active) return;
      handleHashNavigation();
      ws.connect(0, { topics: [topicId] });
    })();

    return () => {
      active = false;
      window.removeEventListener("hashchange", handleHashNavigation);
      unsubscribe();
      unsubscribeStatus();
    };
  });

  $effect(() => {
    if (!loading) {
      sortedMessages.length;
      handleHashNavigation();
    }
  });
</script>

<div class="topic-messages">
  <header>
    <nav>
      <a href="/ui" onclick={(e) => { e.preventDefault(); onNavigate("/"); }}>
        ← Channels
      </a>
      {#if topicData}
        <span> / {topicData.channel.name}</span>
      {/if}
      <span class="nav-separator">|</span>
      <a href="/ui/events" onclick={(e) => { e.preventDefault(); onNavigate("/events"); }}>
        📊 Events
      </a>
    </nav>
    <h1>{topicData?.topic.title || "Messages"}</h1>
    {#if wsStatus === WsStatus.Connected}
      <div class="status connected">● Live</div>
    {:else if wsStatus === WsStatus.Connecting}
      <div class="status connecting">○ Connecting...</div>
    {:else}
      <div class="status disconnected">○ Disconnected</div>
    {/if}
  </header>

  {#if loading}
    <div class="loading">Loading messages...</div>
  {:else if error}
    <div class="error">Error: {error}</div>
  {:else}
    <div class="layout">
      <div class="messages-column">
        {#if hashHintShown}
          <div class="hash-hint">
            Message not currently loaded (showing last 50 messages only)
          </div>
        {/if}

        {#if sortedMessages.length === 0}
          <div class="no-messages">No messages yet</div>
        {:else}
          <div class="messages-list">
            {#each sortedMessages as message (message.id)}
              <div class="message" class:highlighted={false} id={isValidId(message.id) ? `msg_${message.id}` : undefined} data-message-id={message.id}>
                <div class="message-header">
                  <span class="sender">{message.sender}</span>
                  <span class="timestamp">{new Date(message.created_at).toLocaleString()}</span>
                  {#if message.version > 1}
                    <span class="badge">v{message.version}</span>
                  {/if}
                  {#if message.edited_at}
                    <span class="badge">edited</span>
                  {/if}
                </div>
                <div class="content" class:deleted={!!message.deleted_at}>
                  {#if message.deleted_at}
                    [deleted by {message.deleted_by || "unknown"}]
                  {:else}
                    {message.content_raw}
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="attachments-column">
        <h2>Attachments</h2>
        {#if attachments.length === 0}
          <div class="no-attachments">No attachments</div>
        {:else}
          <div class="attachments-list">
            {#each attachments as attachment (attachment.id)}
              <div class="attachment">
                <div class="attachment-kind">{attachment.kind}</div>
                {#if attachment.kind === "url" && attachment.value_json?.url}
                  {#if isValidUrl(attachment.value_json.url)}
                    <a
                      class="attachment-url"
                      href={attachment.value_json.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {attachment.value_json.url}
                    </a>
                  {:else}
                    <div class="attachment-url">{attachment.value_json.url}</div>
                  {/if}
                {:else}
                  <pre class="attachment-value">{JSON.stringify(attachment.value_json, null, 2)}</pre>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .topic-messages {
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

  h2 {
    font-size: 1.3em;
    margin-bottom: 15px;
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

  .nav-separator {
    margin: 0 8px;
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

  .hash-hint {
    padding: 12px;
    margin: 12px 0;
    background: rgba(255, 165, 0, 0.1);
    border: 1px solid rgba(255, 165, 0, 0.3);
    border-radius: 6px;
    color: #ff8c00;
    font-size: 0.9em;
  }

  .layout {
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }

  .messages-column {
    flex: 1;
    min-width: 0;
  }

  .attachments-column {
    width: 300px;
    flex-shrink: 0;
  }

  .message {
    border-bottom: 1px solid var(--border-color);
    padding: 12px 0;
  }

  .message:last-child {
    border-bottom: none;
  }

  .message.highlighted {
    background: rgba(0, 102, 204, 0.1);
    border-left: 3px solid var(--primary-color);
    padding-left: 9px;
  }

  .message-header {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 6px;
    font-size: 0.9em;
  }

  .sender {
    font-weight: 600;
    color: var(--primary-color);
  }

  .timestamp {
    color: var(--meta-color);
    font-size: 0.9em;
  }

  .badge {
    font-size: 0.85em;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--border-color);
    color: var(--meta-color);
  }

  .content {
    margin: 8px 0;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .content.deleted {
    color: var(--meta-color);
    font-style: italic;
  }

  .no-messages,
  .no-attachments {
    color: var(--meta-color);
    padding: 12px 0;
  }

  .attachment {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 8px;
    margin-bottom: 8px;
  }

  .attachment-kind {
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--meta-color);
    margin-bottom: 4px;
  }

  .attachment-url {
    word-break: break-all;
    font-size: 0.9em;
  }

  .attachment-value {
    margin: 0;
    font-size: 0.85em;
    overflow: auto;
    font-family: "Monaco", "Menlo", "Consolas", monospace;
  }

  @media (max-width: 768px) {
    .layout {
      flex-direction: column;
    }

    .attachments-column {
      width: 100%;
    }
  }
</style>
