import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],
  build: {
    // Deterministic asset naming for embedding
    rollupOptions: {
      output: {
        // Use content hash for cache busting (deterministic)
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
    // Output to dist/ (standard Vite convention)
    outDir: "dist",
    // Emit manifest for asset discovery
    manifest: true,
    // Clear output directory on build
    emptyOutDir: true,
  },
  // Base path for assets (served at /ui/assets/)
  base: "/ui/assets/",
});
