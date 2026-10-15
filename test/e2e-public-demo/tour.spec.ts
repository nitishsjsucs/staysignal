// The public demo's guided tour, clicked through as a visitor would (ADR 0018): the landing page, the banner, every
// beat of the tour in order (Forecast, What changed, Data health with the payroll simulation, Reviews with the refused
// self-approval and the rollback, Trust, Research, Scenario Lab, Workforce, Governance, Memory, Traces), recorded and
// stub chat answers labeled as such, role switches inside one sandbox, a second visitor who sees none of it, and the
// reset. Every request the page makes is counted against the sandbox's units.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { CAPS, UNITS } from "../../src/shared/demo/budget";

const LEAD = "pa-lead@larkspur.example";
const DIRECTOR = "people-ops-director@larkspur.example";
const DATA_ENG = "data-eng@larkspur.example";
const ANALYST = "pa-analyst@larkspur.example";

const BEATS = ["Forecast", "What changed", "Data health", "Reviews", "Trust", "Research", "Scenario Lab", "Workforce", "Governance", "Memory", "Traces"];

/** Units the page spends, as the Worker counts them (src/worker/demo/routes.ts, src/shared/demo/budget.ts). */
function meter(page: Page) {
  const m = { requests: 0, units: 0, sockets: 0, turns: 0 };
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!/^\/(api|demo|agents-ws)\//.test(u.pathname)) return;
    m.requests++;
    if (u.pathname.startsWith("/demo/")) return; // sign-in, role switches and reset spend no sandbox units
    if (u.pathname.startsWith("/agents-ws/")) return;
    m.units += r.method() === "GET" ? UNITS.read : u.pathname === "/api/demo/arrival" ? UNITS.routine : UNITS.write;
  });
  page.on("websocket", (ws) => {
    m.sockets++;
    m.units += UNITS.read;
    ws.on("framesent", (f) => {
      if (typeof f.payload === "string" && f.payload.includes("cf_agent_use_chat_request")) m.turns++;
    });
  });
  return m;
}

async function start(page: Page, principal?: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("demo-landing")).toBeVisible();
  if (principal) await page.getByLabel("Start as (demo role)").selectOption(principal);
  await page.getByTestId("demo-start").click();
  await expect(page.getByTestId("demo-banner")).toBeVisible();
}

async function closeTour(page: Page): Promise<void> {
  if (await page.getByTestId("tour-panel").isVisible()) await page.getByRole("button", { name: "Close the guided tour" }).click();
  await expect(page.getByTestId("tour-panel")).toBeHidden();
}

/** Opens a beat from the guided tour, in its first role or (then) its second, and closes the panel. */
async function beat(page: Page, title: string, as: string, then = false): Promise<void> {
  if (!(await page.getByTestId("tour-panel").isVisible())) await page.getByTestId("tour-toggle").click();
  const item = page.getByTestId("tour-panel").locator("li", { has: page.locator(".tour-beat-title", { hasText: new RegExp(`^\\d+${title}$`) }) });
  await item.getByRole("button", { name: then ? /^Then as/ : /^Open as/ }).click();
  await expect(page.getByLabel("Acting as (demo role)")).toHaveValue(as);
  await closeTour(page);
}

async function ask(page: Page, question: string): Promise<void> {
  const box = page.locator("#ask-dock");
  if (!(await box.isVisible())) await page.getByRole("button", { name: "Ask", exact: true }).first().click();
  await expect(box).toBeVisible();
  const chip = page.locator(".dock .suggestions button", { hasText: question });
  if (await chip.count()) await chip.first().click();
  else {
    await box.fill(question);
    await box.press("Enter");
  }
}

function lastAnswer(page: Page) {
  return page.locator(".dock .msg.assistant").filter({ has: page.locator(".msg-meta") }).last();
}

test.describe.configure({ mode: "serial" });

// Cloudflare sets CF-Connecting-IP in production; wrangler dev passes the header through, so each visitor here gets its
// own client address and the gate's per-client cap applies to each separately
test.use({ extraHTTPHeaders: { "CF-Connecting-IP": "198.51.100.10" } });
const asClient = (n: number) => ({ ignoreHTTPSErrors: true, extraHTTPHeaders: { "CF-Connecting-IP": `198.51.100.${n}` } });

test("a visitor clicks through the guided tour in a private sandbox", async ({ page, browser }) => {
  const m = meter(page);
  page.on("dialog", (d) => void d.accept());

  await test.step("the landing page explains the demo in two sentences and signs the visitor in", async () => {
    await page.goto("/");
    const text = page.getByTestId("demo-explainer");
    for (const s of ["Larkspur Systems, a fictional company", "every number you will see are synthetic", "recorded from Qwen3.6-27B", "labeled deterministic stub", "private sandbox that resets after 4 hours"]) await expect(text).toContainText(s);
    expect((await text.innerText()).split(/(?<=\.)\s+/).filter(Boolean)).toHaveLength(2);
    await expect(page.getByLabel("Start as (demo role)")).toHaveValue(LEAD);
    // the localhost-only dev sign-in does not exist here
    // (from the page: Chromium maps the demo host name, Node's resolver does not)
    const status = (path: string, method = "GET") => page.evaluate(async ([p, m]) => (await fetch(p!, { method: m, ...(m === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) })).status, [path, method]);
    expect(await status("/dev/principals")).toBe(404);
    expect(await status("/mcp", "POST")).toBe(404);
    await page.getByTestId("demo-start").click();
    await expect(page.getByTestId("demo-banner")).toContainText(/Public demo: synthetic company, recorded model output, your sandbox resets in [34] h \d+ min/);
    const cookie = (await page.context().cookies()).find((c) => c.name === "ss_demo")!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
  });

  await test.step("the guided tour lists the eleven beats in order", async () => {
    const panel = page.getByTestId("tour-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".tour-beat-title")).toHaveText(BEATS.map((t, i) => `${i + 1}${t}`));
  });

  await test.step("1. Forecast, with a recorded chat turn labeled as recorded", async () => {
    await beat(page, "Forecast", LEAD);
    await expect(page.getByTestId("hero-figure")).toHaveText("13.1");
    await expect(page.locator(".dock .suggestions button", { hasText: "Recorded turn" }).first()).toBeVisible();
    await expect(page.locator(".dock .suggestions button", { hasText: "Stub" }).first()).toBeVisible();
    await ask(page, "Forecast voluntary departures in Engineering over the next 90 days.");
    await expect(lastAnswer(page)).toContainText("Recorded from Qwen3.6-27B on the author's laptop");
    await expect(lastAnswer(page).locator("a.num-link").first()).toHaveAttribute("href", /^\/r\/res_[a-z2-7]{26}$/);
  });

  await test.step("2. What changed", async () => {
    await beat(page, "What changed", LEAD);
    await expect(page.getByTestId("waterfall")).toContainText("Engineering · 3 months · R-2026-09-01#1 to R-2026-10-01#1");
  });

  await test.step("3. Data health: the payroll simulation is held, then the data engineer's fix publishes and replays", async () => {
    await beat(page, "Data health", LEAD);
    await page.getByTestId("simulate-arrival").click();
    const held = page.getByTestId("held-banner");
    await expect(held).toBeVisible({ timeout: 60_000 });
    await expect(held).toContainText("Held for review: R-2026-10-01#2");
    await expect(page.getByTestId("investigation")).toContainText("Data-quality investigator");
    await beat(page, "Data health", DATA_ENG, true);
    await page.getByTestId("mapping").getByTestId("mapping-approve").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("repaired-banner")).toContainText("Repaired: R-2026-10-01#3 replaced the held R-2026-10-01#2", { timeout: 60_000 });
    await expect(page.getByTestId("replay")).toContainText("Identical business-result hash", { timeout: 60_000 });
  });

  await test.step("4. Reviews: a refused self-approval, a second lead's approval and a rollback", async () => {
    await beat(page, "Reviews", LEAD);
    await ask(page, "Prepare a People Partner review for Platform Engineering.");
    await expect(lastAnswer(page)).toContainText("Recorded from Qwen3.6-27B on the author's laptop");
    await expect(page).toHaveURL(/draft=res_/);
    await page.getByTestId("submit-review").click();
    const review = page.getByTestId("review-REV-0001");
    await expect(review).toContainText("Platform Engineering");
    await review.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await expect(review.getByTestId("approval-refusal")).toContainText("SELF_APPROVAL");
    await beat(page, "Reviews", DIRECTOR, true);
    const again = page.getByTestId("review-REV-0001");
    await again.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await expect(again).toContainText("approved");
    await again.getByRole("button", { name: "Roll back approval" }).click();
    await again.getByRole("button", { name: "Confirm rollback" }).click();
    await expect(again).toContainText("rolled back");
    await expect(page.getByTestId("audit")).toContainText("Chain verified");
  });

  await test.step("5 to 11. Trust, Research, Scenario Lab, Workforce, Governance, Memory and Traces", async () => {
    await beat(page, "Trust", LEAD);
    await expect(page.getByTestId("trust-summary")).toContainText("Observed over expected");
    await beat(page, "Research", LEAD);
    await expect(page.getByTestId("research-hypotheses")).toBeVisible();
    await beat(page, "Scenario Lab", LEAD);
    await expect(page.getByTestId("lab-recorded")).toContainText("Recorded from Qwen3.6-27B on the author's laptop");
    await beat(page, "Workforce", LEAD);
    await expect(page.getByTestId("flow-tiles")).toContainText("People at the start");
    await beat(page, "Governance", LEAD);
    await expect(page.getByTestId("action-audit")).toContainText("Tenure band (proxy screen)");
    await beat(page, "Memory", ANALYST);
    await expect(page.getByTestId("memory-log")).toContainText("decision");
    await beat(page, "Traces", LEAD);
    await expect(page.getByTestId("trace-list")).toContainText("Engineering");
  });

  await test.step("a question without a recording gets the labeled stub, never a model", async () => {
    await ask(page, "Which checks failed on the payroll data?");
    await expect(lastAnswer(page)).toContainText("Stub model (deterministic template)");
  });

  await test.step("a second visitor sees none of the first one's sandbox", async () => {
    const other: BrowserContext = await browser.newContext(asClient(11));
    const p2 = await other.newPage();
    await start(p2);
    await closeTour(p2);
    await p2.goto("/reviews");
    await expect(p2.locator("h1")).toContainText("Reviews");
    await expect(p2.getByTestId("review-REV-0001")).toHaveCount(0);
    await p2.goto("/quality");
    await expect(p2.getByTestId("simulate-arrival")).toBeEnabled();
    await expect(p2.getByTestId("held-banner")).toHaveCount(0);
    await expect(p2.getByTestId("repaired-banner")).toHaveCount(0);
    await other.close();
  });

  await test.step("the whole tour fits the sandbox's units", async () => {
    m.units += m.turns * UNITS.chatTurn;
    console.log(`[public-demo] ${m.requests} Worker requests, ${m.sockets} WebSocket upgrades, about ${m.units} units of ${CAPS.unitsPerSandbox}`);
    expect(m.units).toBeLessThan(CAPS.unitsPerSandbox);
  });

  await test.step("reset my sandbox starts over from the committed state", async () => {
    await page.getByTestId("demo-reset").click();
    await expect(page.getByTestId("demo-banner")).toContainText(/resets in (4 h 0 min|3 h 59 min)/);
    await page.goto("/reviews");
    await expect(page.locator("h1")).toContainText("Reviews");
    await expect(page.getByTestId("review-REV-0001")).toHaveCount(0);
  });
});

test("the landing page, the banner and the guided tour fit a phone screen", async ({ browser }) => {
  const phone = await browser.newContext({ ...asClient(12), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await phone.newPage();
  const noSideScroll = async () => expect(await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")).toBeLessThanOrEqual(0);
  await page.goto("/");
  await expect(page.getByTestId("demo-landing")).toBeVisible();
  await noSideScroll();
  await page.getByTestId("demo-start").click();
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByTestId("tour-panel")).toBeVisible();
  await noSideScroll();
  await page.getByTestId("tour-panel").locator("li").nth(1).getByRole("button", { name: /^Open as/ }).click();
  // on a phone the panel closes so the beat is visible
  await expect(page.getByTestId("tour-panel")).toBeHidden();
  await expect(page.getByTestId("waterfall")).toBeVisible();
  await noSideScroll();
  await phone.close();
});

test("a client that starts too many sandboxes in an hour is told the demo is busy", async ({ browser }) => {
  const ctx = await browser.newContext(asClient(13));
  const page = await ctx.newPage();
  for (let i = 0; i < 3; i++) {
    await page.context().clearCookies();
    await page.goto("/");
    await page.getByTestId("demo-start").click();
    await expect(page.getByTestId("demo-banner")).toBeVisible();
  }
  await page.context().clearCookies();
  await page.goto("/");
  await page.getByTestId("demo-start").click();
  await expect(page.getByTestId("demo-busy")).toContainText("The demo is busy, try again later in about");
  await ctx.close();
});
