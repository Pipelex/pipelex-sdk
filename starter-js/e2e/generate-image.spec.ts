import { test, expect } from "@playwright/test";
import { DEFAULT_API_BASE_URL } from "@pipelex/sdk";
import { requireLiveApi } from "./liveApi";

// These tests hit the live Pipelex API configured by PIPELEX_BASE_URL +
// PIPELEX_API_KEY in `.env.local`, and cost an image-generation call. Image
// generation is slow, so the timeouts are generous. They skip cleanly when no
// key is set (see e2e/liveApi.ts).
requireLiveApi();

test("durable mode: streams live status, then generates an image", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("tab", { name: /image generation/i }).click();

  // Durable is the default mode. Image generation outlives the ~30s hosted cap,
  // so this is the mode that actually returns an image.
  await page
    .getByRole("textbox", { name: "Image prompt" })
    .fill("A simple red circle on a plain white background.");
  await page.getByRole("button", { name: /generate image/i }).click();

  // The durable path streams a live-status card while it polls. Image gen is
  // slow enough that this is reliably observable before the result.
  await expect(page.getByRole("status")).toBeVisible({ timeout: 30_000 });

  const result = page.getByRole("region", { name: "Generated image" });
  await expect(result).toBeVisible({ timeout: 150_000 });

  // `locator("img")` rather than `getByRole("img")`, deliberately. The result
  // is rendered by the form kernel's `StuffViewer`, whose own chrome sits
  // inside this region — and its Download button carries a lucide icon, an
  // inline `<svg>` that ARIA counts as role `img`. So the accessible query
  // matches two elements and fails on strict mode. The element selector is the
  // stable one here: kernel icons are always `<svg>`, a rendered file is always
  // an `<img>`. Its `alt` is no better a handle — the kernel fills it with the
  // payload's caption or filename and only falls back to "Preview".
  const image = result.locator("img");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", /\S/);
});

test("blocking mode: demonstrates the ~30s hosted cap with a timeout error", async ({ page }) => {
  // The ~30s synchronous cap is a hosted-gateway behavior (prod and the
  // env-suffixed gateways, e.g. api-dev / api-staging). Other endpoints may
  // not enforce it — blocking mode may simply succeed there — so this spec
  // only makes sense against a hosted gateway.
  const baseUrl = (process.env.PIPELEX_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  test.skip(
    !/^https:\/\/api(-\w+)?\.pipelex\.com$/.test(baseUrl),
    "Hosted gateway only: other endpoints may not enforce the ~30s blocking cap.",
  );

  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("tab", { name: /image generation/i }).click();

  // Flip this example to Blocking — image generation overruns the hosted
  // gateway's ~30s synchronous limit, which surfaces as a classified
  // `execute_timeout` error pointing the user back at Durable mode.
  await page.getByRole("radio", { name: "Blocking" }).click();
  await page
    .getByRole("textbox", { name: "Image prompt" })
    .fill("A simple red circle on a plain white background.");
  await page.getByRole("button", { name: /generate image/i }).click();

  const alert = page.getByRole("alert").filter({ hasText: /30s/ });
  await expect(alert).toBeVisible({ timeout: 90_000 });
  await expect(alert).toContainText(/Durable/i);
});
