// npm run docs:screenshots: the README walkthrough's screenshots (docs/screenshots/*.png), taken from the public demo
// (ADR 0018) as a visitor sees it. It builds the app, serves the public demo over https on 8795 (scripts/serve.ts),
// walks the guided tour in Chromium at 1440 by 900 in the light theme, writes one PNG per beat, and stops the server.
// Every number on screen is synthetic and every model answer is a replayed recording.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { serve } from "./serve.ts";
import { stopAll } from "./lib/pids.ts";

const OUT = join("docs", "screenshots");
// the Secure session cookie needs https: wrangler dev serves it with a self-signed certificate, under a host name that
// Chromium maps to 127.0.0.1 (as the public demo's e2e does)
const HOST = "staysignal-demo.test";
const BASE = `https://${HOST}:8795`;
const LEAD = "pa-lead@larkspur.example";

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: "disabled", caret: "hide" });
  console.log(`[screenshots] ${name}.png`);
}

async function role(page: Page, principal: string): Promise<void> {
  const picker = page.getByLabel("Acting as (demo role)");
  if ((await picker.inputValue()) !== principal) await picker.selectOption(principal);
  await expect(page.getByLabel("Acting as (demo role)")).toHaveValue(principal, { timeout: 30_000 });
}

async function ask(page: Page, question: string): Promise<void> {
  const box = page.locator("#ask-dock");
  const chip = page.locator(".dock .suggestions button", { hasText: question });
  if (await chip.count()) await chip.first().click();
  else {
    await box.fill(question);
    await box.press("Enter");
  }
  await page.locator(".dock .msg.assistant .msg-meta").last().waitFor();
}

async function go(page: Page, href: string): Promise<void> {
  await page.goto(`${BASE}${href}`);
  await page.locator("main.content h1").first().waitFor();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await serve({ build: true, publicDemo: true, https: true, llm: "stub", dataMode: "fixtures" });
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, colorScheme: "light", timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });
    const page = await ctx.newPage();
    page.on("dialog", (d) => void d.accept());

    await page.goto(`${BASE}/`);
    await page.getByTestId("demo-landing").waitFor();
    await shot(page, "01-landing");

    await page.getByTestId("demo-start").click();
    await page.getByTestId("demo-banner").waitFor();
    await go(page, "/?cohort=org%3AEngineering&h=3");
    // the tour opens by itself on a first visit
    if (!(await page.getByTestId("tour-panel").isVisible())) await page.getByTestId("tour-toggle").click();
    await page.getByTestId("tour-panel").waitFor();
    await shot(page, "02-guided-tour");
    await page.getByRole("button", { name: "Close the guided tour" }).click();

    await page.getByTestId("hero-figure").waitFor();
    await ask(page, "Forecast voluntary departures in Engineering over the next 90 days.");
    await page.getByTestId("fan").locator("svg.chart").waitFor();
    await shot(page, "03-forecast");

    await go(page, "/changes?cohort=org%3AEngineering&h=3");
    await page.getByTestId("waterfall").waitFor();
    await shot(page, "04-what-changed");

    await go(page, "/quality");
    await page.getByTestId("simulate-arrival").click();
    await page.getByTestId("held-banner").waitFor({ timeout: 60_000 });
    await page.getByTestId("investigation").waitFor();
    await shot(page, "05-data-health-held");

    await role(page, "data-eng@larkspur.example");
    await page.getByTestId("mapping").getByTestId("mapping-approve").getByRole("button", { name: "Approve" }).click();
    await page.getByTestId("repaired-banner").waitFor({ timeout: 60_000 });
    await page.getByTestId("replay").getByText("Identical business-result hash").waitFor({ timeout: 60_000 });
    await shot(page, "06-data-health-repaired");

    await role(page, LEAD);
    await go(page, "/reviews");
    await ask(page, "Prepare a People Partner review for Platform Engineering.");
    await page.getByTestId("submit-review").click();
    const review = page.getByTestId("review-REV-0001");
    await review.waitFor();
    await review.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await review.getByTestId("approval-refusal").waitFor();
    await shot(page, "07-reviews-self-approval-refused");

    await role(page, "people-ops-director@larkspur.example");
    const again = page.getByTestId("review-REV-0001");
    await again.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await again.getByText("approved", { exact: false }).first().waitFor();
    await again.getByRole("button", { name: "Roll back approval" }).click();
    await again.getByRole("button", { name: "Confirm rollback" }).click();
    await again.getByText("rolled back").first().waitFor();
    await page.getByTestId("audit").getByText("Chain verified").waitFor();
    await page.getByTestId("audit").scrollIntoViewIfNeeded();
    await shot(page, "08-reviews-approved-and-rolled-back");

    await role(page, LEAD);
    for (const [href, name, testId] of [
      ["/trust?cohort=company&h=3", "09-trust", "trust-summary"],
      ["/research", "10-research", "research-hypotheses"],
      ["/lab", "11-scenario-lab", "lab-recorded"],
      ["/workforce?cohort=org%3AEngineering&h=3", "12-workforce", "flow-tiles"],
      ["/governance", "13-governance", "action-audit"],
    ] as const) {
      await go(page, href);
      await page.getByTestId(testId).waitFor();
      await shot(page, name);
    }
    await role(page, "pa-analyst@larkspur.example");
    await go(page, "/memory");
    await page.getByTestId("memory-log").waitFor();
    await shot(page, "14-memory");
    await role(page, LEAD);
    await go(page, "/traces");
    await page.getByTestId("trace-list").waitFor();
    await page.getByTestId("trace").waitFor();
    await shot(page, "15-traces");
    await ctx.close();
  } finally {
    await browser.close();
    await stopAll(8000, ["wrangler"]);
  }
}

await main();
