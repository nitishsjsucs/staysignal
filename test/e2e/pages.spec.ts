// Screenshot baselines (SPEC 16.4): Forecast, Data health and Reviews at desktop and mobile in light and dark, on the
// demo's initial state. Generated and compared only in the amd64 Playwright container (npm run test:e2e), with the
// mouse parked outside the page and live values masked; the comparison is exact.
import { expect, type Page, test } from "@playwright/test";

const PAGES: [string, string, string][] = [
  ["forecast", "/?cohort=org%3AEngineering&h=3", "hero-figure"],
  ["data-health", "/quality", "heatmap"],
  ["reviews", "/reviews", "prepare-review"],
];

async function signIn(page: Page): Promise<void> {
  const picker = page.getByLabel("Acting as (local role switcher)");
  await expect(picker).toBeVisible();
  if ((await picker.inputValue()) !== "pa-lead@larkspur.example") await picker.selectOption("pa-lead@larkspur.example");
  await expect(picker).toHaveValue("pa-lead@larkspur.example");
}

for (const [name, path, ready] of PAGES) {
  test(`${name} page`, async ({ page }) => {
    await page.goto(path);
    await signIn(page);
    await expect(page.getByTestId(ready)).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: true,
      mask: [page.getByText(/Audit log head/), page.locator(".dock-fab")],
    });
  });
}
