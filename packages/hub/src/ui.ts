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

  // GET /ui/events → Events timeline page
  if (path === "/ui/events") {
    return renderEventsPage(ctx);
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
      <nav>
        <a href="/ui/events">📊 Events</a>
      </nav>
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
        <span style="margin: 0 8px">|</span>
        <a href="/ui/events">📊 Events</a>
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
    .message.highlighted {
      background: rgba(0, 102, 204, 0.1);
      border-left: 3px solid var(--primary-color);
      padding-left: 9px;
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
        <span style="margin: 0 8px">|</span>
        <a href="/ui/events">📊 Events</a>
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
      
      // Add stable ID for hash navigation (validate first)
      const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
      if (ID_REGEX.test(msg.id)) {
        messageEl.id = 'msg_' + msg.id;
      }

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
    // Hash Navigation
    // ─────────────────────────────────────────────────────────────────────────

    function handleHashNavigation() {
      const hash = window.location.hash;
      if (!hash || !hash.startsWith('#msg_')) return;

      const messageId = hash.substring(5); // Remove '#msg_'
      const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
      
      if (!ID_REGEX.test(messageId)) return;

      const messageEl = document.getElementById('msg_' + messageId);
      
      if (messageEl) {
        // Scroll to message
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Highlight message
        messageEl.classList.add('highlighted');
      } else {
        // Message not in current view - show hint
        const messagesList = document.getElementById('messages-list');
        const hint = document.createElement('div');
        hint.className = 'hash-hint';
        hint.textContent = 'Message not currently loaded (showing last 50 messages only)';
        messagesList.insertBefore(hint, messagesList.firstChild);
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

      // Handle hash navigation after messages are loaded
      handleHashNavigation();

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

function renderEventsPage(ctx: UiContext): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agentlip - Events</title>
  <style>${getCommonStyles()}
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
    .status {
      font-size: 0.9em;
      padding: 8px 12px;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    .status.info {
      background: rgba(0, 102, 204, 0.1);
      border: 1px solid rgba(0, 102, 204, 0.3);
      color: var(--primary-color);
    }
    .status.warning {
      background: rgba(255, 165, 0, 0.1);
      border: 1px solid rgba(255, 165, 0, 0.3);
      color: #ff8c00;
    }
    .status.error {
      background: rgba(255, 0, 0, 0.1);
      border: 1px solid rgba(255, 0, 0, 0.3);
      color: #cc0000;
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
    .event-details {
      display: none;
      margin: 8px 0;
      padding: 12px;
      background: rgba(0, 0, 0, 0.02);
      border-radius: 4px;
      border: 1px solid var(--border-color);
    }
    .event-row.expanded .event-details {
      display: block;
    }
    .event-details pre {
      margin: 0;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-size: 0.85em;
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
    }
    .event-id {
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
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
    .separator {
      text-align: center;
      padding: 12px;
      font-size: 0.85em;
      color: var(--meta-color);
      background: rgba(255, 165, 0, 0.1);
      border: 1px solid rgba(255, 165, 0, 0.3);
      margin: 8px 0;
    }
    @media (prefers-color-scheme: dark) {
      .event-details {
        background: rgba(255, 255, 255, 0.05);
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <nav>
        <a href="/ui">← Channels</a>
      </nav>
      <h1>Event Timeline</h1>
    </header>
    <main>
      <div class="controls">
        <input type="text" id="filter-name" placeholder="Filter by event name...">
        <input type="text" id="filter-channel" placeholder="Filter by channel_id...">
        <input type="text" id="filter-topic" placeholder="Filter by topic_id...">
        <button id="pause-btn">Pause</button>
        <button id="retry-btn" style="display:none">Retry Connection</button>
      </div>
      
      <div id="status-container"></div>
      <div id="loading">Loading events...</div>
      <div id="error" style="display:none"></div>
      
      <table class="event-table" id="events-table" style="display:none">
        <thead>
          <tr>
            <th style="width: 80px">Event ID</th>
            <th style="width: 180px">Timestamp</th>
            <th style="width: 200px">Name</th>
            <th style="width: 150px">Scope</th>
            <th>Entity</th>
          </tr>
        </thead>
        <tbody id="events-tbody"></tbody>
      </table>
    </main>
  </div>

  <script>
    const API_BASE = ${JSON.stringify(ctx.baseUrl)};
    const AUTH_TOKEN = ${JSON.stringify(ctx.authToken)};

    const MAX_EVENTS = 2000;
    const MAX_BUFFER = 500;
    const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
    
    const state = {
      events: new Map(), // event_id -> event object
      eventOrder: [], // ordered event_ids
      paused: false,
      pausedBuffer: [],
      ws: null,
      highestEventId: 0,
      reconnectAttempts: 0,
      reconnectTimer: null,
      filters: {
        name: '',
        channelId: '',
        topicId: ''
      }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Status Messages
    // ─────────────────────────────────────────────────────────────────────────

    function showStatus(message, type = 'info') {
      const container = document.getElementById('status-container');
      const statusEl = document.createElement('div');
      statusEl.className = 'status ' + type;
      statusEl.textContent = message;
      container.innerHTML = '';
      container.appendChild(statusEl);
    }

    function clearStatus() {
      document.getElementById('status-container').innerHTML = '';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // URL Validation (security)
    // ─────────────────────────────────────────────────────────────────────────

    function isValidId(id) {
      return typeof id === 'string' && ID_REGEX.test(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Rendering
    // ─────────────────────────────────────────────────────────────────────────

    function formatTimestamp(ts) {
      const date = new Date(ts);
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }

    function renderScope(scope) {
      const parts = [];
      if (scope.channel_id) parts.push('ch:' + scope.channel_id);
      if (scope.topic_id) parts.push('tp:' + scope.topic_id);
      if (scope.topic_id2) parts.push('tp2:' + scope.topic_id2);
      return parts.join(', ') || '-';
    }

    function renderEntity(entity, scope) {
      if (!entity) return '-';
      
      const typeText = document.createTextNode(entity.type + ':' + entity.id);
      
      // Create link if possible
      if (entity.type === 'topic' && isValidId(entity.id)) {
        const link = document.createElement('a');
        link.className = 'entity-link';
        link.href = '/ui/topics/' + encodeURIComponent(entity.id);
        link.textContent = entity.type + ':' + entity.id;
        return link;
      }
      
      if (entity.type === 'message' && scope && scope.topic_id && isValidId(scope.topic_id) && isValidId(entity.id)) {
        const link = document.createElement('a');
        link.className = 'entity-link';
        link.href = '/ui/topics/' + encodeURIComponent(scope.topic_id) + '#msg_' + encodeURIComponent(entity.id);
        link.textContent = entity.type + ':' + entity.id;
        return link;
      }
      
      const span = document.createElement('span');
      span.appendChild(typeText);
      return span;
    }

    function createEventRow(event) {
      const row = document.createElement('tr');
      row.className = 'event-row';
      row.dataset.eventId = event.event_id;

      // Event ID
      const idCell = document.createElement('td');
      const idSpan = document.createElement('span');
      idSpan.className = 'event-id';
      idSpan.textContent = event.event_id;
      idCell.appendChild(idSpan);
      row.appendChild(idCell);

      // Timestamp
      const tsCell = document.createElement('td');
      tsCell.textContent = formatTimestamp(event.ts);
      row.appendChild(tsCell);

      // Name
      const nameCell = document.createElement('td');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'event-name';
      nameSpan.textContent = event.name;
      nameCell.appendChild(nameSpan);
      row.appendChild(nameCell);

      // Scope
      const scopeCell = document.createElement('td');
      const scopeSpan = document.createElement('span');
      scopeSpan.className = 'scope-info';
      scopeSpan.textContent = renderScope(event.scope || {});
      scopeCell.appendChild(scopeSpan);
      row.appendChild(scopeCell);

      // Entity
      const entityCell = document.createElement('td');
      const entityContent = renderEntity(event.entity, event.scope);
      entityCell.appendChild(entityContent);
      row.appendChild(entityCell);

      // Click handler to expand/collapse details
      row.addEventListener('click', (e) => {
        // Don't toggle if clicking on a link
        if (e.target.tagName === 'A') return;
        
        e.preventDefault();
        toggleEventDetails(event.event_id);
      });

      return row;
    }

    function createDetailsRow(event) {
      const detailsRow = document.createElement('tr');
      detailsRow.className = 'event-details-row';
      detailsRow.dataset.eventId = event.event_id;
      detailsRow.style.display = 'none';

      const detailsCell = document.createElement('td');
      detailsCell.colSpan = 5;

      const detailsDiv = document.createElement('div');
      detailsDiv.className = 'event-details';

      const pre = document.createElement('pre');
      
      // Lazy render JSON when expanded
      detailsDiv.dataset.eventId = event.event_id;
      detailsDiv.dataset.rendered = 'false';

      detailsDiv.appendChild(pre);
      detailsCell.appendChild(detailsDiv);
      detailsRow.appendChild(detailsCell);

      return detailsRow;
    }

    function toggleEventDetails(eventId) {
      const row = document.querySelector('.event-row[data-event-id="' + eventId + '"]');
      const detailsRow = document.querySelector('.event-details-row[data-event-id="' + eventId + '"]');
      
      if (!row || !detailsRow) return;

      const isExpanded = row.classList.contains('expanded');
      
      if (isExpanded) {
        row.classList.remove('expanded');
        detailsRow.style.display = 'none';
      } else {
        row.classList.add('expanded');
        detailsRow.style.display = 'table-row';
        
        // Lazy render JSON
        const detailsDiv = detailsRow.querySelector('.event-details');
        if (detailsDiv.dataset.rendered === 'false') {
          const event = state.events.get(eventId);
          if (event) {
            const pre = detailsDiv.querySelector('pre');
            // XSS-safe: use textContent, never innerHTML
            pre.textContent = JSON.stringify({
              event_id: event.event_id,
              ts: event.ts,
              name: event.name,
              scope: event.scope,
              entity: event.entity,
              data: event.data_json
            }, null, 2);
            detailsDiv.dataset.rendered = 'true';
          }
        }
      }
    }

    function renderEvents() {
      const tbody = document.getElementById('events-tbody');
      const table = document.getElementById('events-table');
      
      // Apply filters
      const filtered = state.eventOrder
        .map(id => state.events.get(id))
        .filter(event => {
          if (!event) return false;
          
          // Name filter
          if (state.filters.name && !event.name.toLowerCase().includes(state.filters.name.toLowerCase())) {
            return false;
          }
          
          // Channel filter
          if (state.filters.channelId && event.scope?.channel_id !== state.filters.channelId) {
            return false;
          }
          
          // Topic filter
          if (state.filters.topicId && event.scope?.topic_id !== state.filters.topicId) {
            return false;
          }
          
          return true;
        });

      // Use DocumentFragment for batch DOM insertion
      const fragment = document.createDocumentFragment();
      
      for (const event of filtered) {
        fragment.appendChild(createEventRow(event));
        fragment.appendChild(createDetailsRow(event));
      }

      tbody.innerHTML = '';
      tbody.appendChild(fragment);
      
      table.style.display = filtered.length > 0 ? 'table' : 'none';
      
      if (filtered.length === 0 && state.eventOrder.length > 0) {
        showStatus('No events match current filters', 'info');
      } else if (state.eventOrder.length >= MAX_EVENTS) {
        showStatus('Showing last ' + MAX_EVENTS + ' events (oldest evicted)', 'info');
      }
    }

    function addEvent(event) {
      // Dedupe by event_id
      if (state.events.has(event.event_id)) return;
      
      state.events.set(event.event_id, event);
      state.eventOrder.push(event.event_id);
      
      // Track highest event_id
      if (event.event_id > state.highestEventId) {
        state.highestEventId = event.event_id;
      }
      
      // Evict oldest if over limit
      if (state.eventOrder.length > MAX_EVENTS) {
        const evictId = state.eventOrder.shift();
        state.events.delete(evictId);
      }
    }

    function addEvents(events) {
      for (const event of events) {
        addEvent(event);
      }
      renderEvents();
    }

    function createSeparator(message) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'separator';
      td.textContent = message;
      tr.appendChild(td);
      return tr;
    }

    function flushPausedBuffer() {
      if (state.pausedBuffer.length === 0) return;
      
      const tbody = document.getElementById('events-tbody');
      
      // Show separator
      tbody.insertBefore(
        createSeparator(state.pausedBuffer.length + ' events received while paused'),
        tbody.firstChild
      );
      
      // Add buffered events
      addEvents(state.pausedBuffer);
      state.pausedBuffer = [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Data Loading
    // ─────────────────────────────────────────────────────────────────────────

    async function loadEvents() {
      const loading = document.getElementById('loading');
      const error = document.getElementById('error');

      try {
        const res = await fetch(
          API_BASE + '/api/v1/events?tail=200',
          { headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN } }
        );

        if (!res.ok) {
          if (res.status === 503) {
            const retryAfter = res.headers.get('Retry-After');
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
            showStatus('Hub busy, retrying in ' + (delay / 1000) + 's...', 'warning');
            setTimeout(loadEvents, delay);
            return;
          }
          
          if (res.status === 401 || res.status === 403) {
            throw new Error('Authentication failed');
          }
          
          throw new Error('Failed to load events: ' + res.status);
        }

        const data = await res.json();
        
        if (!data.events || !Array.isArray(data.events)) {
          throw new Error('Invalid response from hub');
        }

        state.highestEventId = data.replay_until || 0;
        
        addEvents(data.events);

        loading.style.display = 'none';
        
        if (data.events.length === 0) {
          showStatus('No events yet', 'info');
        } else {
          clearStatus();
        }

        // Start WebSocket after successful HTTP load
        connectWebSocket();
        
      } catch (err) {
        loading.style.display = 'none';
        error.textContent = 'Error: ' + err.message;
        error.style.display = 'block';
        console.error('Failed to load events:', err);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WebSocket Live Tail
    // ─────────────────────────────────────────────────────────────────────────

    function connectWebSocket() {
      if (state.ws) {
        state.ws.close();
        state.ws = null;
      }

      const wsUrl = new URL(API_BASE);
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.pathname = '/ws';
      wsUrl.searchParams.set('token', AUTH_TOKEN);

      console.log('Connecting WebSocket...');
      const ws = new WebSocket(wsUrl.toString());
      state.ws = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        state.reconnectAttempts = 0;
        clearStatus();
        
        // Send hello with after_event_id
        const hello = {
          type: 'hello',
          after_event_id: state.highestEventId
        };
        
        // Add subscriptions if filters are active
        if (state.filters.channelId || state.filters.topicId) {
          hello.subscriptions = {};
          if (state.filters.channelId) {
            hello.subscriptions.channels = [state.filters.channelId];
          }
          if (state.filters.topicId) {
            hello.subscriptions.topics = [state.filters.topicId];
          }
        }
        
        ws.send(JSON.stringify(hello));
      };

      ws.onmessage = (msgEvent) => {
        try {
          const msg = JSON.parse(msgEvent.data);

          if (msg.type === 'hello_ok') {
            console.log('WebSocket hello_ok, replay_until:', msg.replay_until);
            return;
          }

          if (msg.type === 'event') {
            handleWsEvent(msg);
          }
        } catch (err) {
          console.error('WS message parse error:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };

      ws.onclose = () => {
        console.log('WebSocket closed');
        state.ws = null;
        attemptReconnect();
      };
    }

    function handleWsEvent(envelope) {
      const event = {
        event_id: envelope.event_id,
        ts: envelope.ts,
        name: envelope.name,
        data_json: envelope.data || {},
        scope: envelope.scope || {},
        entity: envelope.entity || null
      };

      if (state.paused) {
        // Buffer event while paused
        state.pausedBuffer.push(event);
        
        // Drop oldest if buffer exceeds limit
        if (state.pausedBuffer.length > MAX_BUFFER) {
          const dropped = state.pausedBuffer.shift();
          const droppedCount = state.pausedBuffer.length - MAX_BUFFER + 1;
          showStatus('Dropped ' + droppedCount + ' events while paused (buffer full)', 'warning');
        }
      } else {
        addEvents([event]);
      }
    }

    function attemptReconnect() {
      if (state.reconnectAttempts >= 3) {
        showStatus('Connection lost. Click to retry.', 'error');
        document.getElementById('retry-btn').style.display = 'inline-block';
        return;
      }

      const delay = Math.min(30000, 1000 * Math.pow(2, state.reconnectAttempts));
      state.reconnectAttempts++;
      
      showStatus('Disconnected. Reconnecting in ' + (delay / 1000) + 's... (attempt ' + state.reconnectAttempts + '/3)', 'warning');
      
      state.reconnectTimer = setTimeout(() => {
        connectWebSocket();
      }, delay);
    }

    function manualRetry() {
      state.reconnectAttempts = 0;
      document.getElementById('retry-btn').style.display = 'none';
      clearStatus();
      connectWebSocket();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Controls
    // ─────────────────────────────────────────────────────────────────────────

    function togglePause() {
      state.paused = !state.paused;
      const btn = document.getElementById('pause-btn');
      
      if (state.paused) {
        btn.textContent = 'Resume';
        btn.classList.add('active');
        showStatus('Paused (buffering up to ' + MAX_BUFFER + ' events)', 'info');
      } else {
        btn.textContent = 'Pause';
        btn.classList.remove('active');
        flushPausedBuffer();
        clearStatus();
      }
    }

    function setupFilters() {
      const nameFilter = document.getElementById('filter-name');
      const channelFilter = document.getElementById('filter-channel');
      const topicFilter = document.getElementById('filter-topic');

      const applyFilters = () => {
        state.filters.name = nameFilter.value.trim();
        state.filters.channelId = channelFilter.value.trim();
        state.filters.topicId = topicFilter.value.trim();
        renderEvents();
      };

      nameFilter.addEventListener('input', applyFilters);
      channelFilter.addEventListener('input', applyFilters);
      topicFilter.addEventListener('input', applyFilters);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialize
    // ─────────────────────────────────────────────────────────────────────────

    function init() {
      setupFilters();
      
      document.getElementById('pause-btn').addEventListener('click', togglePause);
      document.getElementById('retry-btn').addEventListener('click', manualRetry);
      
      loadEvents();
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
