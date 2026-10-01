import { test, expect } from "@playwright/test";
import { DEFAULT_API_BASE_URL } from "@pipelex/sdk";

// Verifies the developer-friendly error UX when the Pipelex API isn't reachable.
// Runs against whatever PIPELEX_BASE_URL the dev server is using — the failure
// mode this UX serves is "PIPELEX_BASE_URL points somewhere unreachable, or the
// network is down", and the rendered alert steers the developer to verify the
// URL (or, when no override is set, their connection).
//
// In the default durable mode this exercises the `start` call failing with an
// unreachable API — the classification (api_unreachable) is identical to the
// blocking path, so the error UX is the same.
//
// Skip the whole suite if the API responds — we'd hit the live happy path
// instead, which is already covered by extract.spec.ts.
//
// Probe `/v1/version`, the protocol's always-public handshake, NOT `/health`:
// the hosted gateway 404s `/health` at the origin root even though the API is
// fully reachable under `/v1/*`, which would wrongly conclude "unreachable" and
// run this offline test against a live API.
test.describe("offline-API error display", () => {
  test.beforeAll(async () => {
    // Probe the SAME URL the app will use: the bare PipelexApiClient falls
    // back to the SDK's hosted default when PIPELEX_BASE_URL is unset, so the
    // probe must too — otherwise this spec runs while the app hits a live
    // (hosted) API and renders an auth error instead of api_unreachable.
    const apiUrl = process.env.PIPELEX_BASE_URL ?? DEFAULT_API_BASE_URL;
    let reachable = false;
    try {
      const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/version`, {
        signal: AbortSignal.timeout(3000),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    test.skip(
      reachable,
      `Pipelex API at ${apiUrl} is reachable; offline test would hit the live API`,
    );
  });

  test("renders structured error with title, recovery hint, and details", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("textbox", { name: "Text" }).fill("Apple announced new products today.");
    await page.getByRole("button", { name: /extract entities/i }).click();

    // Next.js renders its own role="alert" route announcer, so scope to ours
    // by filtering for the title text that ErrorDisplay always renders.
    const alert = page.getByRole("alert").filter({ hasText: "Pipelex API not reachable" });
    await expect(alert).toBeVisible({ timeout: 30_000 });

    // The message names the endpoint that failed to answer — the same URL this
    // spec probed (the app and the spec read the same env, since
    // playwright.config.ts loads .env.local).
    const apiUrl = (process.env.PIPELEX_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    await expect(alert).toContainText(apiUrl);

    // The recovery hint is branch-specific: with a *customized* PIPELEX_BASE_URL
    // the copy steers to verifying it; on the default hosted URL it steers to
    // the network, since there is nothing in the config to fix. Setting the
    // variable to the SDK default (what `.env.example` does) counts as default,
    // so compare values rather than testing whether the variable exists.
    if (apiUrl !== DEFAULT_API_BASE_URL.replace(/\/+$/, "")) {
      await expect(alert).toContainText("Verify PIPELEX_BASE_URL in .env.local");
    } else {
      await expect(alert).toContainText("Check your network connection");
    }

    // Technical details are collapsible but present in the DOM.
    await expect(alert.getByText("Technical details")).toBeVisible();
  });
});
