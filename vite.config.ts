import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// The agents() plugin adds the TC39 decorator transform that Vite 8's Oxc lacks (needed for @callable()).
// SS_WRANGLER_CONFIG points the Cloudflare plugin at a rendered deployment config (scripts/deploy.ts); the default is
// wrangler.jsonc, the local and test configuration.
export default defineConfig({
  plugins: [agents(), react(), cloudflare(process.env.SS_WRANGLER_CONFIG ? { configPath: process.env.SS_WRANGLER_CONFIG } : {})],
  server: { host: "127.0.0.1", port: 5175, strictPort: true },
  environments: {
    // Unminified Worker bundle keeps class names; Agent workflow callbacks route by constructor name.
    staysignal: { build: { minify: false } },
  },
});
