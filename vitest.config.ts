import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";
import { generateDevSecrets } from "./scripts/dev-keys.ts";

export default defineConfig(async () => {
  // Fresh dev keys per test run: only public JWKS ever exist on disk in the repository.
  const secrets = await generateDevSecrets();
  return {
    test: {
      passWithNoTests: true,
      projects: [
        {
          plugins: [agents(), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { ...secrets, SS_AUTH_MODE: "dev", SS_DATA_MODE: "fixtures", SS_LLM: "stub", SS_DEMO: "0" } } })],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            fileParallelism: false,
            testTimeout: 60_000,
          },
        },
        {
          // demo mode (npm run demo) with a live model named in SS_LLM: every model output must be a recording, and no
          // path may reach the live model
          plugins: [agents(), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { ...secrets, SS_AUTH_MODE: "dev", SS_DATA_MODE: "fixtures", SS_LLM: "mlx", SS_DEMO: "1" } } })],
          test: {
            name: "worker-demo",
            include: ["test/worker-demo/**/*.test.ts"],
            fileParallelism: false,
            testTimeout: 60_000,
          },
        },
        {
          // the fixtures deployment's configuration: no runner, engine jobs completed inline from the fixtures
          plugins: [agents(), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { ...secrets, SS_AUTH_MODE: "dev", SS_DATA_MODE: "fixtures", SS_LLM: "stub", SS_DEMO: "0", SS_RUNNER: "inline" } } })],
          test: {
            name: "worker-inline",
            include: ["test/worker-inline/**/*.test.ts"],
            fileParallelism: false,
            testTimeout: 60_000,
          },
        },
        {
          test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" },
        },
        {
          plugins: [react()],
          test: { name: "web", include: ["test/web/**/*.test.{ts,tsx}"], environment: "happy-dom" },
        },
      ],
    },
  };
});
