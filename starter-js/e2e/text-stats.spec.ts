import { test, expect } from "@playwright/test";
import { requireLiveApi } from "./liveApi";

// This test hits the live Pipelex API configured by PIPELEX_BASE_URL +
// PIPELEX_API_KEY in `.env.local`, and costs an LLM call. It skips cleanly when
// no key is set (see e2e/liveApi.ts).
requireLiveApi();

// The scaffolded slice, end to end. What makes it worth its own spec is that
// nothing it exercises was written by hand: `make add-method` wrote the action,
// the narrower, the form and the tab from the method's own contract, and the
// method itself is resolved by the address in `methods/text-stats/method.json`
// rather than shipped as a bundle in this repo. A break here says the scaffold's
// templates have drifted from the shared code they compose.
//
// It runs in the default execution mode (durable: start + poll), like the other
// happy-path specs — the form is mode-agnostic, so this is the path a consumer
// gets out of the box. Resolving a `method_ref` needs a base URL that advertises
// it; see the README's note on `PIPELEX_BASE_URL`.
test("reports statistics for pasted text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /text stats/i }).click();

  // The label is the humanized input name from the committed descriptor, not a
  // string this repo chose — query by role plus name, as the other specs do.
  const textarea = page.getByRole("textbox", { name: "Text" });
  await textarea.fill(
    "Playwright drives the browser. The starter renders the form from the method's own contract. Nothing here was written by hand.",
  );

  await page.getByRole("button", { name: /run text stats/i }).click();

  // The scaffold writes `<RunResult>`, whose region is named after the slice.
  const output = page.getByRole("region", { name: "Text stats" });
  await expect(output).toBeVisible({ timeout: 90_000 });

  // The method returns a Markdown statistics report as `native.Text`, and the
  // result view typesets it — so the word count arrives as rendered prose or a
  // table cell rather than as an escaped JSON string. Matched loosely: the
  // report's layout is the model's, and only the count itself is the point.
  await expect(output).toContainText(/words\D{0,30}\d+/i);
});
