// The Research page (SPEC 11, 16.1): the pre-registered verdicts, each factor's cells against the equivalence band,
// and coverage by shock size, with table views; synthetic research worlds only.
import { expect, test } from "@playwright/test";

test("the Research page shows the verdicts, the arms and coverage by sigma", async ({ page }) => {
  await page.goto("/research");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("pa-analyst@larkspur.example");
  await expect(page.locator("h1")).toHaveText("Research");
  const verdicts = page.getByTestId("research-hypotheses");
  for (const h of ["H1. Late reporting", "H2. Missing extract", "H3a.", "H3b.", "H4. Duplicates", "H5. Interaction"]) await expect(verdicts).toContainText(h);
  await expect(page.getByTestId("arm-A").locator("svg.chart circle").first()).toBeVisible();
  await page.getByTestId("arm-A").getByRole("button", { name: "View as table" }).click();
  await expect(page.getByTestId("arm-A").locator("table tbody tr")).toHaveCount(6);
  await expect(page.getByTestId("coverage-sigma").locator("svg.chart path").first()).toBeVisible();
  await expect(page.getByText("Synthetic worlds only.")).toBeVisible();
});

test("the Research page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/research");
  await expect(page.getByTestId("research-hypotheses")).toBeVisible();
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow).toBe(0);
});
