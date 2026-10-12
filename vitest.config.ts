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
          plugins: [agents(), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { ...secrets, SS_AUTH_MODE: "dev", SS_DATA_MODE: "fixtures", SS_LLM: "stub", SS_DEMO: "1" } } })],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
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
