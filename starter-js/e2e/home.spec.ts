import { test, expect } from "@playwright/test";

// The page, offline: it needs no key and runs no method. What it pins is that
// the gallery serves its heading and its tabs, and that it hydrates cleanly when
// driven the way a script should drive it: wait for the mark `HydrationMark`
// sets, then act. A screenshot taken before hydration would itself raise a
// mismatch (Playwright hides the caret by rewriting every input's inline
// style), which is the script's fault, not the app's.
test("renders the heading and the tabs, and hydrates cleanly", async ({ page }, testInfo) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });

  await page.goto("/");
  await page.waitForSelector("html[data-hydrated]");

  // The name is the project's own, which `/bootstrap` rewrites in the layout and
  // the page but not here, so the spec only asks that the two agree.
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  const name = (await heading.innerText()).trim();
  expect(name).not.toBe("");
  await expect(page).toHaveTitle(name);
  await expect(page.getByRole("tab", { name: /pdf summary/i })).toBeVisible();
  // The first tab's form is live: its controls rendered from the method's contract.
  await expect(page.locator("form").first()).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("home.png") });
  expect(hydrationErrors).toEqual([]);
});
