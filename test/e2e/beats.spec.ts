// Beats 1 to 5 click through (SPEC 3): the stub model routes each question to one governed tool and every assertion
// reads what a person would see. In fixtures mode (Gate A) the fixture runner completes the engine jobs from committed
// outputs; in engine mode (npm run test:e2e:engine, Gate B) the local engine computes every job live.
import { expect, type Page, test } from "@playwright/test";

const LEAD = "pa-lead@larkspur.example";
const DIRECTOR = "people-ops-director@larkspur.example";
const DATA_ENG = "data-eng@larkspur.example";

async function signIn(page: Page, principal: string): Promise<void> {
  const picker = page.getByLabel("Acting as (local role switcher)");
  await expect(picker).toBeVisible();
  if ((await picker.inputValue()) !== principal) await picker.selectOption(principal);
  await expect(picker).toHaveValue(principal);
}

async function ask(page: Page, question: string): Promise<void> {
  const box = page.locator("#ask-dock");
  if (!(await box.isVisible())) await page.getByRole("button", { name: "Ask", exact: true }).first().click();
  await expect(box).toBeVisible();
  await box.fill(question);
  await box.press("Enter");
}

/** The newest assistant message in the dock once its turn has finished (it carries the turn chips). */
function lastAnswer(page: Page) {
  return page.locator(".dock .msg.assistant").filter({ has: page.locator(".msg-meta") }).last();
}

test.describe.configure({ mode: "serial" });

test("beats 1 to 5 click through", async ({ page }) => {
  await page.goto("/?cohort=company&h=6");
  await signIn(page, LEAD);
  await expect(page.locator("h1")).toContainText("Larkspur");

  await test.step("beat 1: forecast", async () => {
    await ask(page, "Forecast voluntary departures in Engineering over the next 90 days.");
    await expect(lastAnswer(page)).toContainText("Grounding:");
    await expect(page).toHaveURL(/cohort=org%3AEngineering/);
    await expect(page).toHaveURL(/h=3/);
    await expect(page.getByTestId("hero-figure")).toHaveText("13.1");
    await expect(page.getByTestId("hero")).toContainText("80% range 8 to 18");
    await expect(page.getByTestId("hero")).toContainText("Trailing-rate status quo");
    await expect(page.getByTestId("trust-strip")).toBeVisible();
    await expect(page.getByTestId("fan").locator("svg.chart")).toBeVisible();
    await expect(page.getByTestId("history").locator("svg.chart")).toBeVisible();
    // the narrated number links to the computed result
    await expect(lastAnswer(page).locator("a.num-link").first()).toHaveAttribute("href", /^\/r\/res_[a-z2-7]{26}$/);
  });

  await test.step("boundary: an individual-level question is refused before any model call", async () => {
    await ask(page, "Which engineers in Platform Engineering are most likely to quit?");
    await expect(lastAnswer(page)).toContainText("Refused: INDIVIDUAL_LEVEL");
    await expect(lastAnswer(page)).toContainText("Refused before any model call");
  });

  await test.step("beat 2: what changed", async () => {
    await ask(page, "What changed in Engineering since the previous forecast?");
    await expect(lastAnswer(page)).toContainText("Grounding:");
    await expect(page).toHaveURL(/\/changes\?/);
    const waterfall = page.getByTestId("waterfall");
    await expect(waterfall).toContainText("Engineering · 3 months · R-2026-09-01#1 to R-2026-10-01#1");
    await waterfall.getByRole("button", { name: "View as table" }).click();
    for (const factor of ["Calendar", "Composition", "Input data", "Model", "Definition"]) await expect(waterfall.locator("table")).toContainText(factor);
  });

  await test.step("beat 3: a payroll arrival with a new pay-basis code is held", async () => {
    await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Data health" }).click();
    await page.getByTestId("simulate-arrival").click();
    const held = page.getByTestId("held-banner");
    await expect(held).toBeVisible({ timeout: 60_000 });
    await expect(held).toContainText("Held for review: R-2026-10-01#2");
    await expect(held).toContainText("C01");
    await expect(page.getByTestId("routine-steps")).toContainText("held");
    await expect(page.getByTestId("ranking")).toContainText("1.");
    await expect(page.getByTestId("ranking").locator("span.mono").first()).toContainText("pay_basis");
    await expect(page.getByTestId("mapping")).toContainText("ANN");
    await expect(page.getByTestId("mapping")).toContainText("Waiting for a data engineer");
  });

  await test.step("beat 4: a data engineer approves the mapping fix; the repair publishes and replays", async () => {
    await signIn(page, DATA_ENG);
    const mapping = page.getByTestId("mapping");
    await mapping.getByTestId("mapping-approve").getByRole("button", { name: "Approve" }).click();
    const repaired = page.getByTestId("repaired-banner");
    await expect(repaired).toBeVisible({ timeout: 60_000 });
    await expect(repaired).toContainText("Repaired: R-2026-10-01#3 replaced the held R-2026-10-01#2");
    await expect(page.getByTestId("replay")).toContainText("Identical business-result hash", { timeout: 60_000 });
    await expect(page.getByTestId("replay")).toContainText("Forced to payroll@1, the hash differs");
  });

  await test.step("beat 5: an approved review, a refused self-approval and a rollback", async () => {
    await signIn(page, LEAD);
    await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Reviews" }).click();
    await ask(page, "Prepare a People Partner review for Platform Engineering.");
    await expect(lastAnswer(page)).toContainText("Grounding:");
    await expect(page).toHaveURL(/draft=res_/);
    const draft = page.getByTestId("draft");
    await expect(draft).toContainText("Compensation position against band midpoints");
    await expect(draft).toContainText("Career progression");
    await expect(draft).toContainText("Hiring coverage");
    await page.getByTestId("submit-review").click();
    await expect(page.getByTestId("prepare-review")).toContainText("you are the proposer of record");

    const review = page.getByTestId("review-REV-0001");
    await expect(review).toContainText("Platform Engineering");
    await review.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await expect(review.getByTestId("approval-refusal")).toContainText("SELF_APPROVAL");

    await signIn(page, DIRECTOR);
    const again = page.getByTestId("review-REV-0001");
    await again.getByTestId("review-approve").getByRole("button", { name: "Approve" }).click();
    await expect(again).toContainText("approved");
    await expect(again.locator("table")).toContainText("compensation");
    await expect(again.locator("table")).toContainText("hrbp-engineering@larkspur.example");
    await expect(again.locator("table")).toContainText("Pay-equity check by Compensation");

    await again.getByRole("button", { name: "Roll back approval" }).click();
    await expect(again.getByLabel("Rollback reason")).toHaveValue("approved against the wrong cohort");
    await again.getByRole("button", { name: "Confirm rollback" }).click();
    await expect(again).toContainText("rolled back");
    await expect(again.locator("table")).toContainText("cancelled");
    await expect(page.getByTestId("audit")).toContainText("Chain verified");
    await expect(page.getByTestId("audit")).toContainText("approved against the wrong cohort");
  });
});
