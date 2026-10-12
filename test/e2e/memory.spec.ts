// The Memory page (SPEC 16.1, 14.10): search answers "what did we decide last time?", the notes by kind with the
// timeline tiers, a note's dated bullets and the commit log.
import { expect, test } from "@playwright/test";

test("the Memory page answers what was decided and shows the notes and commits", async ({ page }) => {
  await page.goto("/memory");
  const picker = page.getByLabel("Acting as (local role switcher)");
  await picker.selectOption("pa-analyst@larkspur.example");
  await expect(picker).toHaveValue("pa-analyst@larkspur.example");
  await expect(page.locator("h1")).toHaveText("Memory");
  await expect(page.getByTestId("memory-search")).toContainText("decisions/DEC-2026-09-20-01.md");
  await expect(page.getByTestId("memory-files")).toContainText("Timeline, monthly");
  await expect(page.getByTestId("memory-note")).toContainText("voluntary_departures@2");
  await expect(page.getByTestId("memory-log")).toContainText("memory: coarsen the timeline as of 2026-10-05");
  await page.getByLabel("Search memory").fill("Do we use performance ratings?");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByTestId("memory-search")).toContainText("decisions/DEC-2026-03-10-01.md");
});

test("the Memory page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/memory");
  await page.getByLabel("Acting as (local role switcher)").selectOption("pa-analyst@larkspur.example");
  await expect(page.getByTestId("memory-note")).toBeVisible();
  const overflow = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  expect(overflow).toBe(0);
});
