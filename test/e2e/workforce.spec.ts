// The Workforce page (SPEC 16.1, 16.2): cohort flows from the semantic catalog as a Sankey with tiles and a table view.
import { expect, test } from "@playwright/test";

test("the Workforce page shows where a cohort's people came from and went", async ({ page }) => {
  await page.goto("/workforce?cohort=org%3AEngineering&h=3");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("pa-lead@larkspur.example");
  await expect(picker).toHaveValue("pa-lead@larkspur.example");
  await expect(page.locator("h1")).toHaveText("Workforce flows");
  await expect(page.getByTestId("flow-tiles")).toContainText("People at the start (2025-10)");
  await expect(page.getByTestId("flows")).toContainText("workforce_flows|organization|none");
  await expect(page.getByTestId("flows").locator("svg.chart path").first()).toBeVisible();
  await page.getByTestId("flows").getByRole("button", { name: "View as table" }).click();
  await expect(page.getByTestId("flows").locator("table")).toContainText("Voluntary exits");
  await expect(page.getByText("Synthetic data").first()).toBeVisible();
});

test("a People Partner cannot read another organization's flows", async ({ page }) => {
  await page.goto("/workforce?cohort=org%3ASales&h=3");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("hrbp-engineering@larkspur.example");
  await expect(picker).toHaveValue("hrbp-engineering@larkspur.example");
  await expect(page.getByRole("note")).toContainText("NOT_ASSIGNED");
});

test("the Workforce page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workforce?cohort=company&h=3");
  await page.getByLabel("Acting as (local role switcher)").selectOption("pa-analyst@larkspur.example");
  await expect(page.getByTestId("flows").locator("svg.chart")).toBeVisible();
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow).toBe(0);
});
