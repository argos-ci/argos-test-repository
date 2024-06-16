import { test, expect } from "@playwright/test";

test("has title", async ({ page }) => {
  await page.goto("https://playwright.dev/docs/test-sharding");

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Playwright/);

  if (process.env.GITHUB_RUN_ATTEMPT !== "2") {
    // Fail the test on the first attempt.
    throw new Error("Failing on purpose");
  }
});
