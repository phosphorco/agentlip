/**
 * Agentlip Hub UI handler
 * 
 * Minimal HTML UI served at /ui/* routes with:
 * - Channel list (/ui)
 * - Topic list (/ui/channels/:channel_id)
 * - Messages view (/ui/topics/:topic_id) with live updates via WS
 * 
 * No build step: inline HTML/CSS/JS.
 * Security: all user content escaped via textContent, URLs validated.
 */

interface UiContext {
  baseUrl: string;
  authToken: string;
}

/**
 * Handle UI requests.
 * Returns Response if route matches, null if not found.
 */
export function handleUiRequest(req: Request, ctx: UiContext): Response | null {
  const url = new URL(req.url);
  const path = url.pathname;

  // Only accept GET requests
  if (req.method !== "GET") {
    return null;
  }

  // GET /ui → Channels list page
  if (path === "/ui" || path === "/ui/") {
    return renderChannelsListPage(ctx);
  }

  // GET /ui/channels/:channel_id → Topics list for a channel
  const channelMatch = path.match(/^\/ui\/channels\/([^/]+)$/);
  if (channelMatch) {
    const channelId = channelMatch[1];
    return renderTopicsListPage(ctx, channelId);
  }

  // GET /ui/topics/:topic_id → Messages view for a topic
  const topicMatch = path.match(/^\/ui\/topics\/([^/]+)$/);
  if (topicMatch) {
    const topicId = topicMatch[1];
    return renderTopicMessagesPage(ctx, topicId);
  }

  // Route not found
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page Renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderChannelsListPage(ctx: UiContext): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agentlip - Channels</title>
  <style>${getCommonStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Channels</h1>
    </header>
    <main>
      <div id="loading">Loading channels...</div>
      <div id="error" style="display:none"></div>
      <ul id="channels-list" style="display:none"></ul>
    </main>
  </div>

  <script>
    const API_BASE = ${JSON.stringify(ctx.baseUrl)};
    const AUTH_TOKEN = ${JSON.stringify(ctx.authToken)};

    async function loadChannels() {
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');
      const list = document.getElementById('channels-list');

      try {
        const res = await fetch(API_BASE + '/api/v1/channels', {
          headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN }
        });

        if (!res.ok) {
          throw new Error('Failed to load channels: ' + res.status);
        }

        const data = await res.json();
        const channels = data.channels || [];

        loading.style.display = 'none';

        if (channels.length === 0) {
          error.textContent = 'No channels found';
          error.style.display = 'block';
          return;
        }

        // Render channels
        list.innerHTML = '';
        for (const channel of channels) {
          const li = document.createElement('li');
          const link = document.createElement('a');
          link.href = '/ui/channels/' + encodeURIComponent(channel.id);
          link.textContent = channel.name;
          
          if (channel.description) {
            const desc = document.createElement('div');
            desc.className = 'description';
            desc.textContent = channel.description;
            li.appendChild(link);
            li.appendChild(desc);
          } else {
            li.appendChild(link);
          }
          
          list.appendChild(li);
        }

        list.style.display = 'block';
      } catch (err) {
        loading.style.display = 'none';
        error.textContent = 'Error: ' + err.message;
        error.style.display = 'block';
      }
    }

    loadChannels();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderTopicsListPage(ctx: UiContext, channelId: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agentlip - Topics</title>
  <style>${getCommonStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <nav>
        <a href="/ui">← Channels</a>
      </nav>
      <h1 id="channel-name">Topics</h1>
    </header>
    <main>
      <div id="loading">Loading topics...</div>
      <div id="error" style="display:none"></div>
      <ul id="topics-list" style="display:none"></ul>
    </main>
  </div>

  <script>
    const API_BASE = ${JSON.stringify(ctx.baseUrl)};
    const AUTH_TOKEN = ${JSON.stringify(ctx.authToken)};
    const CHANNEL_ID = ${JSON.stringify(channelId)};

    async function loadChannel() {
      try {
        const res = await fetch(API_BASE + '/api/v1/channels', {
          headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN }
        });

        if (res.ok) {
          const data = await res.json();
          const channel = data.channels.find(ch => ch.id === CHANNEL_ID);
          if (channel) {
            document.getElementById('channel-name').textContent = channel.name;
          }
        }
      } catch (err) {
        // Best effort - don't block topics load
      }
    }

    async function loadTopics() {
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');
      const list = document.getElementById('topics-list');

      try {
        const res = await fetch(
          API_BASE + '/api/v1/channels/' + encodeURIComponent(CHANNEL_ID) + '/topics',
          { headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN } }
        );

        if (!res.ok) {
          throw new Error('Failed to load topics: ' + res.status);
        }

        const data = await res.json();
        const topics = data.topics || [];

        loading.style.display = 'none';

        if (topics.length === 0) {
          error.textContent = 'No topics found';
          error.style.display = 'block';
          return;
        }

        // Render topics
        list.innerHTML = '';
        for (const topic of topics) {
          const li = document.createElement('li');
          const link = document.createElement('a');
          link.href = '/ui/topics/' + encodeURIComponent(topic.id);
          link.textContent = topic.title;
          
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = 'Updated: ' + new Date(topic.updated_at).toLocaleString();
          
          li.appendChild(link);
          li.appendChild(meta);
          list.appendChild(li);
        }

        list.style.display = 'block';
      } catch (err) {
        loading.style.display = 'none';
        error.textContent = 'Error: ' + err.message;
        error.style.display = 'block';
      }
    }

    loadChannel();
    loadTopics();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderTopicMessagesPage(ctx: UiContext, topicId: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agentlip - Messages</title>
  <style>${getCommonStyles()}
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
    .deleted {
      color: var(--meta-color);
      font-style: italic;
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
    @media (max-width: 768px) {
      .layout {
        flex-direction: column;
      }
      .attachments-column {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <nav>
        <a href="/ui">← Channels</a>
        <span id="breadcrumb"></span>
      </nav>
      <h1 id="topic-title">Messages</h1>
    </header>
    <main>
      <div id="loading">Loading messages...</div>
      <div id="error" style="display:none"></div>
      <div id="content" class="layout" style="display:none">
        <div class="messages-column">
          <div id="messages-list"></div>
        </div>
        <div class="attachments-column">
          <h2>Attachments</h2>
          <div id="attachments-list"></div>
        </div>
      </div>
    </main>
  </div>

  <script>
    const API_BASE = ${JSON.stringify(ctx.baseUrl)};
    const AUTH_TOKEN = ${JSON.stringify(ctx.authToken)};
    const TOPIC_ID = ${JSON.stringify(topicId)};

    const state = {
      messages: new Map(), // message_id -> message object
      attachments: [],
      highestEventId: 0,
      ws: null,
      topicData: null,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // URL Validation (security)
    // ─────────────────────────────────────────────────────────────────────────

    function isValidUrl(urlString) {
      try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Rendering
    // ─────────────────────────────────────────────────────────────────────────

    function renderMessage(msg) {
      const messageEl = document.createElement('div');
      messageEl.className = 'message';
      messageEl.dataset.messageId = msg.id;

      const header = document.createElement('div');
      header.className = 'message-header';

      const sender = document.createElement('span');
      sender.className = 'sender';
      sender.textContent = msg.sender;
      header.appendChild(sender);

      const timestamp = document.createElement('span');
      timestamp.className = 'timestamp';
      timestamp.textContent = new Date(msg.created_at).toLocaleString();
      header.appendChild(timestamp);

      if (msg.version > 1) {
        const versionBadge = document.createElement('span');
        versionBadge.className = 'badge';
        versionBadge.textContent = 'v' + msg.version;
        header.appendChild(versionBadge);
      }

      if (msg.edited_at) {
        const editedBadge = document.createElement('span');
        editedBadge.className = 'badge';
        editedBadge.textContent = 'edited';
        header.appendChild(editedBadge);
      }

      messageEl.appendChild(header);

      const content = document.createElement('div');
      content.className = 'content';

      if (msg.deleted_at) {
        content.classList.add('deleted');
        content.textContent = '[deleted by ' + (msg.deleted_by || 'unknown') + ']';
      } else {
        content.textContent = msg.content_raw;
      }

      messageEl.appendChild(content);

      return messageEl;
    }

    function renderMessages() {
      const list = document.getElementById('messages-list');
      list.innerHTML = '';

      // Sort messages by created_at
      const sorted = Array.from(state.messages.values())
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      for (const msg of sorted) {
        list.appendChild(renderMessage(msg));
      }
    }

    function updateMessage(msg) {
      state.messages.set(msg.id, msg);

      // Find existing message element
      const existing = document.querySelector('[data-message-id="' + msg.id + '"]');
      if (existing) {
        existing.replaceWith(renderMessage(msg));
      } else {
        // New message - re-render all to maintain sort order
        renderMessages();
      }
    }

    function renderAttachment(att) {
      const attEl = document.createElement('div');
      attEl.className = 'attachment';
      attEl.dataset.attachmentId = att.id;

      const kind = document.createElement('div');
      kind.className = 'attachment-kind';
      kind.textContent = att.kind;
      attEl.appendChild(kind);

      if (att.kind === 'url' && att.value_json && att.value_json.url) {
        const url = att.value_json.url;
        
        if (isValidUrl(url)) {
          const link = document.createElement('a');
          link.className = 'attachment-url';
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = url;
          attEl.appendChild(link);
        } else {
          const text = document.createElement('div');
          text.className = 'attachment-url';
          text.textContent = url;
          attEl.appendChild(text);
        }
      } else {
        const value = document.createElement('pre');
        value.style.fontSize = '0.85em';
        value.style.overflow = 'auto';
        value.textContent = JSON.stringify(att.value_json, null, 2);
        attEl.appendChild(value);
      }

      return attEl;
    }

    function renderAttachments() {
      const list = document.getElementById('attachments-list');
      list.innerHTML = '';

      if (state.attachments.length === 0) {
        list.textContent = 'No attachments';
        return;
      }

      for (const att of state.attachments) {
        list.appendChild(renderAttachment(att));
      }
    }

    function addAttachment(att) {
      // Check if already exists (dedupe)
      const exists = state.attachments.find(a => a.id === att.id);
      if (!exists) {
        state.attachments.push(att);
        renderAttachments();
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Data Loading
    // ─────────────────────────────────────────────────────────────────────────

    async function loadTopic() {
      try {
        const res = await fetch(
          API_BASE + '/api/v1/channels',
          { headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN } }
        );

        if (res.ok) {
          const channelsData = await res.json();
          // Find the channel that contains this topic
          for (const channel of channelsData.channels || []) {
            const topicsRes = await fetch(
              API_BASE + '/api/v1/channels/' + encodeURIComponent(channel.id) + '/topics',
              { headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN } }
            );
            
            if (topicsRes.ok) {
              const topicsData = await topicsRes.json();
              const topic = topicsData.topics.find(t => t.id === TOPIC_ID);
              
              if (topic) {
                state.topicData = { ...topic, channel };
                document.getElementById('topic-title').textContent = topic.title;
                document.getElementById('breadcrumb').textContent = ' / ' + channel.name;
                return;
              }
            }
          }
        }
      } catch (err) {
        // Best effort - don't block messages load
      }
    }

    async function loadMessages() {
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');
      const content = document.getElementById('content');

      try {
        const res = await fetch(
          API_BASE + '/api/v1/messages?topic_id=' + encodeURIComponent(TOPIC_ID) + '&limit=50',
          { headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN } }
        );

        if (!res.ok) {
          throw new Error('Failed to load messages: ' + res.status);
        }

        const data = await res.json();
        const messages = data.messages || [];

        // Store messages
        for (const msg of messages) {
          state.messages.set(msg.id, msg);
        }

        loading.style.display = 'none';
        content.style.display = 'flex';

        renderMessages();
      } catch (err) {
        loading.style.display = 'none';
        error.textContent = 'Error loading messages: ' + err.message;
        error.style.display = 'block';
      }
    }

    async function loadAttachments() {
      try {
        const res = await fetch(
          API_BASE + '/api/v1/topics/' + encodeURIComponent(TOPIC_ID) + '/attachments',
          { headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN } }
        );

        if (res.ok) {
          const data = await res.json();
          state.attachments = data.attachments || [];
          renderAttachments();
        }
      } catch (err) {
        // Best effort - don't block page load
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WebSocket Live Updates
    // ─────────────────────────────────────────────────────────────────────────

    function connectWebSocket() {
      // Determine highest event_id from messages
      let highestEventId = 0;
      for (const msg of state.messages.values()) {
        // We don't have event_id on message objects, so we'll use 0
        // The WS will send all new events after connection
      }
      state.highestEventId = highestEventId;

      const wsUrl = new URL(API_BASE);
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.pathname = '/ws';
      wsUrl.searchParams.set('token', AUTH_TOKEN);

      const ws = new WebSocket(wsUrl.toString());
      state.ws = ws;

      ws.onopen = () => {
        // Send hello message
        ws.send(JSON.stringify({
          type: 'hello',
          after_event_id: state.highestEventId,
          subscriptions: {
            topics: [TOPIC_ID]
          }
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'hello_ok') {
            state.highestEventId = msg.replay_until;
            return;
          }

          if (msg.type === 'event') {
            handleEvent(msg);
            state.highestEventId = Math.max(state.highestEventId, msg.event_id);
          }
        } catch (err) {
          console.error('WS message parse error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };

      ws.onclose = () => {
        // Attempt to reconnect after 5s
        setTimeout(connectWebSocket, 5000);
      };
    }

    function handleEvent(event) {
      if (event.name === 'message.created' && event.data.message) {
        updateMessage(event.data.message);
      } else if (event.name === 'message.edited' && event.data.message) {
        updateMessage(event.data.message);
      } else if (event.name === 'message.deleted' && event.data.message) {
        updateMessage(event.data.message);
      } else if (event.name === 'topic.attachment_added' && event.data.attachment) {
        addAttachment(event.data.attachment);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialize
    // ─────────────────────────────────────────────────────────────────────────

    async function init() {
      await Promise.all([
        loadTopic(),
        loadMessages(),
        loadAttachments(),
      ]);

      // Start WebSocket connection after initial load
      connectWebSocket();
    }

    init();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Common Styles
// ─────────────────────────────────────────────────────────────────────────────

function getCommonStyles(): string {
  return `
    :root {
      --bg-color: #ffffff;
      --text-color: #1a1a1a;
      --border-color: #e0e0e0;
      --primary-color: #0066cc;
      --meta-color: #666;
      --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-color: #1a1a1a;
        --text-color: #e0e0e0;
        --border-color: #333;
        --primary-color: #4d9fff;
        --meta-color: #999;
      }
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--font-family);
      background: var(--bg-color);
      color: var(--text-color);
      line-height: 1.6;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    header {
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid var(--border-color);
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

    ul {
      list-style: none;
    }

    li {
      padding: 12px 0;
      border-bottom: 1px solid var(--border-color);
    }

    li:last-child {
      border-bottom: none;
    }

    li a {
      color: var(--primary-color);
      text-decoration: none;
      font-size: 1.1em;
    }

    li a:hover {
      text-decoration: underline;
    }

    .description {
      color: var(--meta-color);
      font-size: 0.9em;
      margin-top: 4px;
    }

    .meta {
      color: var(--meta-color);
      font-size: 0.85em;
      margin-top: 4px;
    }

    #loading {
      color: var(--meta-color);
      padding: 20px 0;
    }

    #error {
      color: #cc0000;
      padding: 20px;
      background: rgba(255, 0, 0, 0.1);
      border-radius: 6px;
      border: 1px solid rgba(255, 0, 0, 0.3);
    }
  `;
}
