import { test, expect } from "@playwright/test";
import { requireLiveApi } from "./liveApi";

// This test hits the live Pipelex API configured by PIPELEX_BASE_URL +
// PIPELEX_API_KEY in `.env.local`, and costs an LLM call. It skips cleanly when
// no key is set (see e2e/liveApi.ts).
requireLiveApi();

// Runs in the default execution mode (durable: start + poll). The form is
// mode-agnostic, so this drives the same UI path a user gets out of the box.
test("extracts entities from sample text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /text entities/i }).click();

  const textarea = page.getByRole("textbox", { name: "Text" });
  await textarea.fill(
    "Apple announced new products in Cupertino on March 5th, 2026, with Tim Cook presenting alongside Jony Ive.",
  );

  await page.getByRole("button", { name: /extract entities/i }).click();

  const results = page.getByRole("region", { name: "Extracted entities" });
  await expect(results).toBeVisible({ timeout: 90_000 });

  // Spot-check the obvious entities. The LLM may format slightly differently
  // (e.g. "Apple Inc." vs "Apple"), so we use partial matches.
  await expect(results.getByText(/tim cook/i)).toBeVisible();
  await expect(results.getByText(/apple/i)).toBeVisible();
  await expect(results.getByText(/march/i)).toBeVisible();
});
