// Playwright (SPEC 16.4): flow specs against the built app under wrangler dev in fixtures mode with the stub model and
// the fixture runner (no Python, no LLM). Global setup builds and starts it on 8795 with fresh local state; teardown
// stops every process it started. The screenshot baselines of M3 run the same specs in the amd64 container.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  snapshotPathTemplate: "test/e2e/__screenshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:8795",
    timezoneId: "UTC",
    locale: "en-US",
    trace: "retain-on-failure",
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "light" } }],
});
