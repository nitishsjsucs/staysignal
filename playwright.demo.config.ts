// The public demo's e2e (ADR 0018): the guided tour clicked through against wrangler dev in SS_AUTH_MODE=demo, served
// over https with wrangler's self-signed certificate and reached under a non-localhost host name that Chromium maps to
// 127.0.0.1, so the demo's own sign-in and Secure cookie are exercised, never the localhost-only dev sign-in. Global
// setup builds the app and starts the Worker on 8795 with a throwaway session key; teardown stops it.
import { defineConfig, devices } from "@playwright/test";

export const DEMO_HOST = "staysignal-demo.test";

export default defineConfig({
  testDir: "test/e2e-public-demo",
  outputDir: "test-results/public-demo",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/public-demo" }]] : [["list"]],
  globalSetup: "./test/e2e-public-demo/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  use: {
    baseURL: `https://${DEMO_HOST}:8795`,
    ignoreHTTPSErrors: true,
    timezoneId: "UTC",
    locale: "en-US",
    trace: "retain-on-failure",
    contextOptions: { reducedMotion: "reduce" },
    // Local Network Access checks off: the tour's page on another origin of the same site (fulfilled by the test, so
    // Chromium places it in the public address space) must reach the Worker on 127.0.0.1 as another Worker's page
    // would reach the public demo, so that the Worker's own refusal is what the test sees
    launchOptions: { args: [`--host-resolver-rules=MAP ${DEMO_HOST} 127.0.0.1`, "--disable-features=LocalNetworkAccessChecks"] },
  },
  projects: [{ name: "public-demo", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "light" } }],
});
