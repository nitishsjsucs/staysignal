// The Scenario Lab page (SPEC 15, 16.4): the label, the placeholder banner, the synthetic persona chips on quotes and
// the persona handles, both proposals and the persona interview (a labeled placeholder in fixtures mode); it fits a
// phone screen.
import { expect, test } from "@playwright/test";

const LABEL = "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.";

test("the Lab shows its label, the placeholder banner and the persona chips", async ({ page }) => {
  await page.goto("/lab");
  await page.getByLabel("Acting as (local role switcher)").selectOption("pa-analyst@larkspur.example");
  await expect(page.locator("h1")).toHaveText("Scenario Lab");
  await expect(page.getByText(LABEL).first()).toBeVisible();
  await expect(page.getByTestId("lab-placeholder")).toContainText("scripted stub provider");
  await expect(page.getByTestId("lab-sanity")).toContainText("A consistency check, not validation");
  await expect(page.getByTestId("lab-pilot").getByText("Synthetic persona").first()).toBeVisible();
  await expect(page.getByTestId("lab-personas")).toContainText("P01 ·");
  await page.getByRole("button", { name: "One group for Infrastructure and Data" }).click();
  await expect(page.getByTestId("lab-personas")).toContainText("Infrastructure Engineering");
});

test("a persona answers a question, labeled with its source and the Lab label", async ({ page }) => {
  await page.goto("/lab");
  await page.getByLabel("Acting as (local role switcher)").selectOption("pa-analyst@larkspur.example");
  const card = page.getByTestId("lab-interview");
  await card.getByLabel("Persona", { exact: true }).selectOption("P03");
  await card.getByLabel("Question to the persona").fill("What would you ask first?");
  await card.getByTestId("lab-ask").click();
  const answer = card.getByTestId("lab-answer");
  await expect(answer).toContainText("Synthetic persona");
  await expect(answer).toContainText("P03 ·");
  await expect(answer).toContainText("Placeholder: scripted stub text, not a model");
  await expect(answer).toContainText(LABEL);
});

test("a data engineer without lab:read is refused", async ({ page }) => {
  await page.goto("/lab");
  await page.getByLabel("Acting as (local role switcher)").selectOption("data-eng@larkspur.example");
  await expect(page.getByText("The Scenario Lab needs lab:read.")).toBeVisible();
});

test("the Lab page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/lab");
  await page.getByLabel("Acting as (local role switcher)").selectOption("pa-analyst@larkspur.example");
  await expect(page.getByTestId("lab-personas")).toBeVisible();
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow).toBe(0);
});
