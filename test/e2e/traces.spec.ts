// The Traces page (SPEC 16.1, 14.12): an answer's trace as a gantt of spans with a table view.
import { expect, test } from "@playwright/test";

test("the Traces page shows where the time went in an answer", async ({ page }) => {
  await page.goto("/traces");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("pa-lead@larkspur.example");
  await expect(picker).toHaveValue("pa-lead@larkspur.example");
  const r = await page.request.post("/api/dev/agent/turn", { data: { question: "Forecast voluntary departures in Finance over the next 90 days." } });
  expect(r.ok()).toBe(true);
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Traces");
  await expect(page.getByTestId("trace-list")).toContainText("Finance");
  await expect(page.getByTestId("trace").locator("svg.chart rect").first()).toBeVisible();
  await page.getByTestId("trace").getByRole("button", { name: "View as table" }).click();
  await expect(page.getByTestId("trace").locator("table")).toContainText("tool_call: forecast_departures");
});

test("a People Partner has no trace scope", async ({ page }) => {
  await page.goto("/traces");
  await page.getByLabel("Acting as (local role switcher)").selectOption("hrbp-engineering@larkspur.example");
  await expect(page.getByRole("note")).toContainText("NOT_PERMITTED");
});
