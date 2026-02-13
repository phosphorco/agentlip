<script lang="ts">
  import type { ApiClient, Channel } from "../lib/api";

  interface Props {
    api: ApiClient;
    onNavigate: (path: string) => void;
  }

  let { api, onNavigate }: Props = $props();

  let channels = $state<Channel[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;

    try {
      channels = await api.getChannels();
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

<div class="channels-list">
  <header>
    <nav>
      <a href="/ui/events" onclick={(e) => { e.preventDefault(); onNavigate("/events"); }}>
        📊 Events
      </a>
    </nav>
    <h1>Channels</h1>
  </header>

  {#if loading}
    <div class="loading">Loading channels...</div>
  {:else if error}
    <div class="error">Error: {error}</div>
  {:else if channels.length === 0}
    <div class="error">No channels found</div>
  {:else}
    <ul class="channels">
      {#each channels as channel (channel.id)}
        <li>
          <a
            href="/ui/channels/{channel.id}"
            onclick={(e) => {
              e.preventDefault();
              onNavigate(`/channels/${channel.id}`);
            }}
          >
            {channel.name}
          </a>
          {#if channel.description}
            <div class="description">{channel.description}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .channels-list {
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

  .channels {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .channels li {
    padding: 12px 0;
    border-bottom: 1px solid var(--border-color);
  }

  .channels li:last-child {
    border-bottom: none;
  }

  .channels a {
    color: var(--primary-color);
    text-decoration: none;
    font-size: 1.1em;
  }

  .channels a:hover {
    text-decoration: underline;
  }

  .description {
    color: var(--meta-color);
    font-size: 0.9em;
    margin-top: 4px;
  }
</style>
