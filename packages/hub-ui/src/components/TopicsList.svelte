<script lang="ts">
  import type { ApiClient, Channel, Topic } from "../lib/api";

  interface Props {
    api: ApiClient;
    channelId: string;
    onNavigate: (path: string) => void;
  }

  let { api, channelId, onNavigate }: Props = $props();

  let channel = $state<Channel | null>(null);
  let topics = $state<Topic[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;

    try {
      channel = await api.findChannel(channelId);
      if (!channel) {
        error = `Channel not found: ${channelId}`;
        loading = false;
        return;
      }

      topics = await api.getTopics(channelId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });
</script>

<div class="topics-list">
  <header>
    <nav>
      <a href="/ui" onclick={(e) => { e.preventDefault(); onNavigate("/"); }}>
        ← Channels
      </a>
      <span class="nav-separator">|</span>
      <a href="/ui/events" onclick={(e) => { e.preventDefault(); onNavigate("/events"); }}>
        📊 Events
      </a>
    </nav>
    <h1>{channel?.name || "Topics"}</h1>
  </header>

  {#if loading}
    <div class="loading">Loading topics...</div>
  {:else if error}
    <div class="error">Error: {error}</div>
  {:else if topics.length === 0}
    <div class="error">No topics found</div>
  {:else}
    <ul class="topics">
      {#each topics as topic (topic.id)}
        <li>
          <a
            href="/ui/topics/{topic.id}"
            onclick={(e) => {
              e.preventDefault();
              onNavigate(`/topics/${topic.id}`);
            }}
          >
            {topic.title}
          </a>
          <div class="meta">
            Updated: {new Date(topic.updated_at).toLocaleString()}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .topics-list {
    padding: 0;
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

  .topics {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .topics li {
    padding: 12px 0;
    border-bottom: 1px solid var(--border-color);
  }

  .topics li:last-child {
    border-bottom: none;
  }

  .topics a {
    color: var(--primary-color);
    text-decoration: none;
    font-size: 1.1em;
  }

  .topics a:hover {
    text-decoration: underline;
  }

  .meta {
    color: var(--meta-color);
    font-size: 0.85em;
    margin-top: 4px;
  }
</style>
