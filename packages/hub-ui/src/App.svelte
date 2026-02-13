<script lang="ts">
  // Placeholder SPA shell for Gate 1 (packaging scaffold only)
  // Full routing/components will be implemented in Gate 3
  
  let message = "Agentlip Hub UI (SPA scaffold - Gate 1)";
</script>

<main>
  <h1>{message}</h1>
  <p>This is a minimal Svelte 5 SPA scaffold for deterministic packaging verification.</p>
  <p>Full UI routes and components will be implemented in Gate 3.</p>
</main>

<style>
  :global(body) {
    margin: 0;
    padding: 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
  }

  main {
    max-width: 800px;
    margin: 0 auto;
    padding: 40px;
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  h1 {
    color: #0066cc;
  }

  p {
    line-height: 1.6;
    color: #333;
  }
</style>
