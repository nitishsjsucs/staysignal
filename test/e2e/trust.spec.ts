// The Trust page (SPEC 16.1): recorded evaluation shown as cohort aggregates, with every chart and a table view.
import { expect, test } from "@playwright/test";

test("the Trust page shows backtests, calibration, coverage and the model comparison", async ({ page }) => {
  await page.goto("/trust?cohort=company&h=3");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("pa-lead@larkspur.example");
  await expect(picker).toHaveValue("pa-lead@larkspur.example");
  await expect(page.locator("h1")).toHaveText("Trust");
  await expect(page.getByTestId("trust-summary")).toContainText("Observed over expected");
  await expect(page.getByTestId("trust-summary")).toContainText("80% range held");
  await expect(page.getByTestId("backtest")).toContainText("independent windows");
  await expect(page.getByTestId("backtest").locator("svg.chart circle").first()).toBeVisible();
  await expect(page.getByTestId("reliability").locator("svg.chart")).toBeVisible();
  // the chart groups rows under a heading per level with short names; the table view keeps the full labels
  await expect(page.getByTestId("coverage").locator("svg.chart")).toContainText("Organizations");
  await expect(page.getByTestId("coverage").locator("svg.chart")).toContainText("Model, monthly");
  await page.getByTestId("coverage").getByRole("button", { name: "View as table" }).click();
  await expect(page.getByTestId("coverage").locator("table")).toContainText("Model, company (monthly)");
  await expect(page.getByTestId("comparison")).toContainText("Oracle (knows the truth)");
  // C15: the challenger and the like-for-like model on the same origins, with the row cap stated
  await expect(page.getByTestId("comparison")).toContainText("SurvivalBoost challenger (12,000 rows)");
  await expect(page.getByTestId("comparison")).toContainText("capped at 12,000 person-landmarks");
  await page.getByTestId("backtest").getByRole("button", { name: "View as table" }).click();
  await expect(page.getByTestId("backtest").locator("table tbody tr")).toHaveCount(24);
  await expect(page.getByTestId("effects")).toContainText("Associational, not causal");
  await expect(page.getByTestId("effects").locator("svg.chart")).toHaveCount(6);
  await page.getByTestId("effects").getByRole("button", { name: "View as table" }).click();
  await expect(page.getByTestId("effects").locator("table tbody tr")).toHaveCount(35);
  await expect(page.getByText("Synthetic data").first()).toBeVisible();
});

test("a People Partner sees no company-wide feature effects", async ({ page }) => {
  await page.goto("/trust?cohort=org%3AEngineering&h=3");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("hrbp-engineering@larkspur.example");
  await expect(picker).toHaveValue("hrbp-engineering@larkspur.example");
  await expect(page.getByTestId("coverage")).toBeVisible();
  await expect(page.getByTestId("effects")).toHaveCount(0);
});

test("the Trust page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trust?cohort=company&h=3");
  await page.getByLabel("Acting as (local role switcher)").selectOption("pa-lead@larkspur.example");
  await expect(page.getByTestId("comparison")).toBeVisible();
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow).toBe(0);
});
