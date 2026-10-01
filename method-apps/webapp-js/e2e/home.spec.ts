import { test, expect } from "@playwright/test";
import { SITE } from "@/site";

// The page, offline: it needs no key and runs no method. What it pins is that
// the app serves its own identity and renders its registry — the empty state on
// a fresh clone, a method's form once one is registered — and that it hydrates
// cleanly when driven the way a script should drive it: wait for the mark
// `HydrationMark` sets, then act. A screenshot taken before hydration would
// itself raise a mismatch (Playwright hides the caret by rewriting every input's
// inline style), which is the script's fault, not the app's.
test("renders the app's heading, and either the empty state or a method", async ({
  page,
}, testInfo) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.waitForSelector("html[data-hydrated]");

  await expect(page.getByRole("heading", { level: 1, name: SITE.title })).toBeVisible();
  await expect(page).toHaveTitle(SITE.title);

  const emptyState = page.getByRole("heading", { name: "No method yet" });
  const methodForm = page.locator("form").first();
  await expect(emptyState.or(methodForm)).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("home.png") });
  expect(hydrationErrors).toEqual([]);
});
