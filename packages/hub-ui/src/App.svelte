<script lang="ts">
  import { getBootstrap, type BootstrapConfig } from "./lib/bootstrap";
  import { ApiClient } from "./lib/api";
  import { WsClient } from "./lib/ws";
  import ChannelsList from "./components/ChannelsList.svelte";
  import TopicsList from "./components/TopicsList.svelte";
  import TopicMessages from "./components/TopicMessages.svelte";
  import EventsTimeline from "./components/EventsTimeline.svelte";

  let config = $state<BootstrapConfig | null>(null);
  let api = $state<ApiClient | null>(null);
  let ws = $state<WsClient | null>(null);
  let error = $state<string | null>(null);

  // Route state
  let currentRoute = $state<string>("/");
  let routeParams = $state<Record<string, string>>({});

  async function init() {
    try {
      config = await getBootstrap();
      api = new ApiClient(config);
      ws = new WsClient(config);
      handleLocationChange(); // Initial route
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function getUiRelativePathname(): string {
    const pathname = window.location.pathname;

    if (pathname === "/ui" || pathname === "/ui/") return "/";
    if (!pathname.startsWith("/ui/")) return "/";

    const relative = pathname.slice(3); // keep leading slash
    if (relative.length > 1 && relative.endsWith("/")) {
      return relative.slice(0, -1);
    }

    return relative;
  }

  function handleLocationChange() {
    parseRoute(getUiRelativePathname());
  }

  function parseRoute(path: string) {
    // Simple pattern matching
    if (path === "/" || path === "") {
      currentRoute = "/";
      routeParams = {};
    } else if (path === "/events") {
      currentRoute = "/events";
      routeParams = {};
    } else if (path.match(/^\/channels\/([^/]+)$/)) {
      const match = path.match(/^\/channels\/([^/]+)$/);
      currentRoute = "/channels/:id";
      routeParams = { id: match![1] };
    } else if (path.match(/^\/topics\/([^/]+)$/)) {
      const match = path.match(/^\/topics\/([^/]+)$/);
      currentRoute = "/topics/:id";
      routeParams = { id: match![1] };
    } else {
      // Unknown route - redirect to home
      currentRoute = "/";
      routeParams = {};
      history.replaceState({}, "", "/ui");
    }
  }

  function navigate(path: string) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    history.pushState({}, "", `/ui${normalized}`);
    handleLocationChange();
  }

  $effect(() => {
    init();

    window.addEventListener("popstate", handleLocationChange);

    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      ws?.disconnect();
    };
  });
</script>

<div class="app">
  {#if error}
    <div class="error-page">
      <h1>Error</h1>
      <p>{error}</p>
    </div>
  {:else if !config || !api || !ws}
    <div class="loading-page">
      <div class="spinner"></div>
      <p>Loading...</p>
    </div>
  {:else}
    <div class="container">
      {#if currentRoute === "/"}
        <ChannelsList {api} onNavigate={navigate} />
      {:else if currentRoute === "/channels/:id"}
        <TopicsList {api} channelId={routeParams.id} onNavigate={navigate} />
      {:else if currentRoute === "/topics/:id"}
        <TopicMessages {api} {ws} topicId={routeParams.id} onNavigate={navigate} />
      {:else if currentRoute === "/events"}
        <EventsTimeline {api} {ws} onNavigate={navigate} />
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(:root) {
    --bg-color: #ffffff;
    --text-color: #1a1a1a;
    --border-color: #e0e0e0;
    --primary-color: #0066cc;
    --meta-color: #666;
    --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg-color: #1a1a1a;
      --text-color: #e0e0e0;
      --border-color: #333;
      --primary-color: #4d9fff;
      --meta-color: #999;
    }
  }

  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(body) {
    font-family: var(--font-family);
    background: var(--bg-color);
    color: var(--text-color);
    line-height: 1.6;
    padding: 20px;
  }

  .app {
    min-height: 100vh;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
  }

  .loading-page,
  .error-page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    text-align: center;
  }

  .loading-page .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid var(--border-color);
    border-top-color: var(--primary-color);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 20px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading-page p,
  .error-page p {
    color: var(--meta-color);
    font-size: 1.1em;
  }

  .error-page h1 {
    color: #cc0000;
    margin-bottom: 20px;
  }

  .error-page p {
    color: #cc0000;
    max-width: 600px;
    padding: 20px;
    background: rgba(255, 0, 0, 0.1);
    border-radius: 8px;
    border: 1px solid rgba(255, 0, 0, 0.3);
  }
</style>
