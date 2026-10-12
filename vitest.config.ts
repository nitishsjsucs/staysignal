import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        plugins: [agents(), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
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
});
