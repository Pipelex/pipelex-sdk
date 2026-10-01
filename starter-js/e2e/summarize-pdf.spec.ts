import { test, expect } from "@playwright/test";
import { requireLiveApi } from "./liveApi";

// This test hits the live Pipelex API configured by PIPELEX_BASE_URL +
// PIPELEX_API_KEY in `.env.local`, and costs an LLM call. It uses the sample
// PDF shipped in public/ — the "Use sample PDF" button runs it through the
// same path as a real drop: a grant from the PDF's Server Action, then a `PUT`
// straight from the browser to Pipelex storage, so the base URL must serve
// `POST /v1/upload/grant`. It skips cleanly when no key is set (see
// e2e/liveApi.ts).
requireLiveApi();

// Runs in the default execution mode (durable: start + poll).
test("summarizes the sample PDF", async ({ page }) => {
  await page.goto("/");
  // Until the page has hydrated, the shortcut's click handler is not attached.
  await page.waitForSelector("html[data-hydrated]");
  await page.getByRole("tab", { name: /pdf summary/i }).click();

  await page.getByRole("button", { name: /use sample pdf/i }).click();

  // The sample is fetched and stored; submit enables once the form holds its
  // `pipelex-storage://` reference.
  const summarize = page.getByRole("button", { name: /summarize pdf/i });
  await expect(summarize).toBeEnabled();
  await summarize.click();

  const result = page.getByRole("region", { name: "Document summary" });
  await expect(result).toBeVisible({ timeout: 90_000 });
  await expect(result.getByText("Key points")).toBeVisible();
});
