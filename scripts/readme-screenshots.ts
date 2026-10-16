// npm run docs:screenshots: the README walkthrough's screenshots (docs/screenshots/*.png), taken from the public demo
// (ADR 0018) as a visitor sees it. It builds the app, serves the public demo over https on 8795 (scripts/serve.ts),
// clicks each beat of the guided tour in Chromium at 1440 by 900 in the light theme (the beat's "Open as" or "Then as"
// button, which switches the role, opens the page and closes the panel), writes one PNG per beat, and stops the server.
// Beside each main beat it writes a detail crop of the element that matters (docs/screenshots/detail/*.png, at twice the
// pixel density) for the README's walkthrough grid; the full screenshot stays one CSS pixel per pixel. Every number on
// screen is synthetic and every model answer is a replayed recording, or a refusal made before any model call.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, type Locator, type Page } from "@playwright/test";
import { serve } from "./serve.ts";
import { stopAll } from "./lib/pids.ts";

const OUT = join("docs", "screenshots");
const DETAIL = join(OUT, "detail");
// the Secure session cookie needs https: wrangler dev serves it with a self-signed certificate, under a host name that
// Chromium maps to 127.0.0.1 (as the public demo's e2e does)
const HOST = "staysignal-demo.test";
const BASE = `https://${HOST}:8795`;
const LEAD = "pa-lead@larkspur.example";

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: "disabled", caret: "hide", scale: "css" });
  console.log(`[screenshots] ${name}.png`);
}

/** A detail crop: the union of the elements' boxes with a margin, inside the viewport, at the device pixel density. */
async function detail(page: Page, name: string, parts: Locator[], maxHeight = 560): Promise<void> {
  // the first element's top just below the sticky page header (about 140 pixels), so the header never covers the crop
  await parts[0]!.evaluate((e) => {
    // this runs in the page; the node scripts' TypeScript config has no DOM library, so the page globals are typed here
    const win = globalThis as unknown as { getComputedStyle: (el: unknown) => { overflowY: string }; document: { scrollingElement: { scrollBy: (x: number, y: number) => void } | null } };
    e.scrollIntoView({ block: "start", inline: "nearest" });
    let p = e.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight && /(auto|scroll)/.test(win.getComputedStyle(p).overflowY))) p = p.parentElement;
    (p ?? win.document.scrollingElement)?.scrollBy(0, -170);
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const boxes = (await Promise.all(parts.map((l) => l.boundingBox()))).filter((b): b is NonNullable<typeof b> => b !== null);
  if (!boxes.length) throw new Error(`detail ${name}: nothing to crop`);
  const vp = page.viewportSize()!;
  const pad = 12;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad, y + maxHeight);
  await page.screenshot({ path: join(DETAIL, `${name}.png`), clip: { x, y, width: right - x, height: bottom - y }, animations: "disabled", caret: "hide", scale: "device" });
  console.log(`[screenshots] detail/${name}.png`);
}

/** Clicks a beat of the guided tour as a visitor does: its first role, or (then) its second. */
async function beat(page: Page, title: string, as: string, then = false): Promise<void> {
  if (!(await page.getByTestId("tour-panel").isVisible())) await page.getByTestId("tour-toggle").click();
  const item = page.getByTestId("tour-panel").locator("li", { has: page.locator(".tour-beat-title", { hasText: new RegExp(`^\\d+${title}$`) }) });
  await item.getByRole("button", { name: then ? /^Then as/ : /^Open as/ }).click();
  await page.getByTestId("tour-panel").waitFor({ state: "hidden" });
  await expect(page.getByLabel("Acting as (demo role)")).toHaveValue(as, { timeout: 30_000 });
  await page.locator("main.content h1").first().waitFor();
}

/** Asks the chat dock a question (its suggestion chip when there is one) and waits for the new answer's footer. */
async function ask(page: Page, question: string): Promise<void> {
  const box = page.locator("#ask-dock");
  const answers = page.locator(".dock .msg.assistant .msg-meta");
  const before = await answers.count();
  const chip = page.locator(".dock .suggestions button", { hasText: question });
  if (await chip.count()) await chip.first().click();
  else {
    await box.fill(question);
    await box.press("Enter");
  }
  await expect(answers).toHaveCount(before + 1, { timeout: 60_000 });
}

async function main(): Promise<void> {
  mkdirSync(DETAIL, { recursive: true });
  await serve({ build: true, publicDemo: true, https: true, llm: "stub", dataMode: "fixtures" });
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });
    const page = await ctx.newPage();
    page.on("dialog", (d) => void d.accept());

    await page.goto(`${BASE}/`);
    await page.getByTestId("demo-landing").waitFor();
    await shot(page, "01-landing");

    await page.getByTestId("demo-start").click();
    await page.getByTestId("demo-banner").waitFor();
    // the tour opens by itself on a first visit
    await page.getByTestId("tour-panel").waitFor();
    await page.getByTestId("hero-figure").waitFor();
    await shot(page, "02-guided-tour");

    await beat(page, "Forecast", LEAD);
    await page.getByTestId("hero-figure").waitFor();
    await ask(page, "Forecast voluntary departures in Engineering over the next 90 days.");
    await page.getByTestId("fan").locator("svg.chart").waitFor();
    await shot(page, "03-forecast");

    // the boundary: an individual-level question, refused by the deterministic pre-router before any model call
    await ask(page, "Which engineers in Platform Engineering are most likely to leave?");
    await expect(page.locator(".dock .msg.assistant .msg-meta").last()).toContainText("Refused before any model call");
    await shot(page, "16-individual-refused");
    await detail(page, "16-individual-refused", [page.locator(".dock .msg.user").last(), page.locator(".dock .msg.assistant", { has: page.locator(".msg-meta") }).last()]);
    await detail(page, "03-forecast", [page.getByTestId("hero")]);

    await beat(page, "What changed", LEAD);
    await page.getByTestId("waterfall").waitFor();
    await shot(page, "04-what-changed");
    await detail(page, "04-what-changed", [page.getByTestId("waterfall")]);

    await beat(page, "Data health", LEAD);
    await page.getByTestId("simulate-arrival").click();
    await page.getByTestId("held-banner").waitFor({ timeout: 60_000 });
    await page.getByTestId("investigation").waitFor();
    await shot(page, "05-data-health-held");
    await detail(page, "05-data-health-held", [page.getByTestId("held-banner"), page.getByTestId("routine-steps")]);

    await beat(page, "Data health", "data-eng@larkspur.example", true);
    await page.getByTestId("mapping").getByTestId("mapping-approve").getByRole("button", { name: "Approve" }).click();
    await page.getByTestId("repaired-banner").waitFor({ timeout: 60_000 });
    await page.getByTestId("replay").getByText("Identical business-result hash").waitFor({ timeout: 60_000 });
    await shot(page, "06-data-health-repaired");
    await detail(page, "06-data-health-repaired", [page.getByTestId("repaired-banner"), page.getByTestId("routine-steps")]);

    await beat(page, "Reviews", LEAD);
    await ask(page, "Prepare a People Partner review for Platform Engineering.");
    await page.getByTestId("submit-review").click();
    const review = page.getByTestId("review-REV-0001");
    await review.waitFor();
    await review.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await review.getByTestId("approval-refusal").waitFor();
    await shot(page, "07-reviews-self-approval-refused");
    await detail(page, "07-reviews-self-approval-refused", [review]);

    await beat(page, "Reviews", "people-ops-director@larkspur.example", true);
    const again = page.getByTestId("review-REV-0001");
    await again.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await again.getByText("approved", { exact: false }).first().waitFor();
    await again.getByRole("button", { name: "Roll back approval" }).click();
    await again.getByRole("button", { name: "Confirm rollback" }).click();
    await again.getByText("rolled back").first().waitFor();
    await page.getByTestId("audit").getByText("Chain verified").waitFor();
    await page.getByTestId("audit").scrollIntoViewIfNeeded();
    await shot(page, "08-reviews-approved-and-rolled-back");
    await detail(page, "08-reviews-approved-and-rolled-back", [page.getByTestId("audit")]);

    for (const [title, name, testId] of [
      ["Trust", "09-trust", "trust-summary"],
      ["Research", "10-research", "research-hypotheses"],
      ["Scenario Lab", "11-scenario-lab", "lab-recorded"],
      ["Workforce", "12-workforce", "flow-tiles"],
      ["Governance", "13-governance", "action-audit"],
    ] as const) {
      await beat(page, title, LEAD);
      await page.getByTestId(testId).waitFor();
      await shot(page, name);
      if (name === "09-trust") await detail(page, name, [page.getByTestId(testId), page.locator(".card", { hasText: "did forecasts track actual departures" }).last()], 600);
      if (name === "10-research") await detail(page, name, [page.getByTestId(testId)]);
    }
    await beat(page, "Memory", "pa-analyst@larkspur.example");
    await page.getByTestId("memory-log").waitFor();
    await shot(page, "14-memory");
    await beat(page, "Traces", LEAD);
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
