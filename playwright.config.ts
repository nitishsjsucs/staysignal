// Playwright (SPEC 16.4): flow specs against the built app under wrangler dev in fixtures mode with the stub model and
// the fixture runner (no Python, no LLM). Global setup builds and starts it on 8795 with fresh local state; teardown
// stops every process it started. The screenshot baselines of M3 run the same specs in the amd64 container.
import { defineConfig, devices } from "@playwright/test";

const SHOTS = process.env.SS_E2E_SCREENSHOTS === "1";
const DESKTOP = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };
const MOBILE = { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: "test/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000, toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" } },
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  snapshotPathTemplate: "test/e2e/__screenshots__/{testFilePath}/{projectName}/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:8795",
    timezoneId: "UTC",
    locale: "en-US",
    trace: "retain-on-failure",
    contextOptions: { reducedMotion: "reduce" },
  },
  // Screenshot baselines (SPEC 16.4) run only inside the amd64 Playwright container (npm run test:e2e), where
  // SS_E2E_SCREENSHOTS=1, because Chromium rasterizes differently on arm64; they run first, on the initial state.
  projects: [
    ...(SHOTS
      ? (
          [
            ["desktop-light", DESKTOP, "light"],
            ["desktop-dark", DESKTOP, "dark"],
            ["mobile-light", MOBILE, "light"],
            ["mobile-dark", MOBILE, "dark"],
          ] as const
        ).map(([name, device, colorScheme]) => ({ name: `shots-${name}`, testMatch: /pages\.spec\.ts/, use: { ...device, colorScheme } }))
      : []),
    {
      name: "desktop",
      testIgnore: /pages\.spec\.ts/,
      dependencies: SHOTS ? ["shots-desktop-light", "shots-desktop-dark", "shots-mobile-light", "shots-mobile-dark"] : [],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "light" },
    },
  ],
});
