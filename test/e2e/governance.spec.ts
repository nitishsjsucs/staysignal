// The Governance page (SPEC 16.1, 17.7): the action audit (impact ratios against the four-fifths line), the roles and
// scopes, and the disclosure rules; the audit-only age screen is for the auditor.
import { expect, test } from "@playwright/test";

test("a lead sees the proxy screens, the roles and the disclosure rules", async ({ page }) => {
  await page.goto("/governance");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("pa-lead@larkspur.example");
  await expect(picker).toHaveValue("pa-lead@larkspur.example");
  await expect(page.locator("h1")).toHaveText("Governance");
  await expect(page.getByTestId("action-audit")).toContainText("Tenure band (proxy screen)");
  await expect(page.getByTestId("action-audit")).toContainText("Location (proxy screen)");
  await expect(page.getByTestId("action-audit")).not.toContainText("audit-only attribute)");
  await expect(page.getByTestId("action-audit").locator("svg.chart circle").first()).toBeVisible();
  await page.getByTestId("action-audit").getByRole("button", { name: "View as table" }).click();
  await expect(page.getByTestId("action-audit").locator("table")).toContainText("Vancouver");
  await expect(page.getByTestId("roles")).toContainText("People Partner");
  await expect(page.getByTestId("disclosure")).toContainText("10 people or more");
});

test("the auditor also sees the age screen and the proxy strength", async ({ page }) => {
  await page.goto("/governance");
  await page.getByLabel("Acting as (local role switcher)").selectOption("audit@larkspur.example");
  await expect(page.getByTestId("action-audit")).toContainText("Age 40 or over (audit-only attribute)");
  await expect(page.getByTestId("proxy-strength")).toContainText("AUC");
});

test("the Governance page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/governance");
  await page.getByLabel("Acting as (local role switcher)").selectOption("pa-lead@larkspur.example");
  await expect(page.getByTestId("action-audit").locator("svg.chart").first()).toBeVisible();
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow).toBe(0);
});
