import { test, expect } from "@playwright/test";
import { isProblemError, PipelexApiClient } from "@pipelex/sdk";
import { requireLiveApi } from "./liveApi";

// This test hits the live Pipelex API configured by PIPELEX_BASE_URL +
// PIPELEX_API_KEY in `.env.local`, and costs a few cheap LLM calls. It skips
// cleanly when no key is set (see e2e/liveApi.ts).
requireLiveApi();

/** A well-formed run id no run has: the nil UUID. */
const NO_SUCH_RUN = "run_00000000-0000-0000-0000-000000000000";

/**
 * Whether the configured base URL serves the progress route, found out before
 * anything is spent: where the route is served, a run id no run has is the
 * platform's `run.not_found` problem, read by its code as the route reads it.
 * Anything else means it is not: production's gateway answers a path it does
 * not route with a bare `403`, and a bare runner answers with the SDK's
 * `runtime.unsupported`.
 */
async function servesProgress(): Promise<boolean> {
  try {
    await new PipelexApiClient().getRunProgress(NO_SUCH_RUN);
    return false;
  } catch (caught) {
    return isProblemError(caught) && caught.code === "run.not_found";
  }
}

// The run timeline, end to end: the progress route reading the snapshot on the
// server, the browser's reader following it, and `RunTimeline` drawing it. It
// runs the "Check claims" demo, whose sequence, batch and condition give the
// timeline more than one row to draw, in Durable mode, the only mode with a
// run id to follow while the run goes.
test.describe("the run timeline", () => {
  test.beforeAll(async () => {
    // The beforeEach of requireLiveApi runs after this, and the probe needs the key.
    test.skip(!process.env.PIPELEX_API_KEY, "Live-API e2e: set PIPELEX_API_KEY in .env.local.");
    test.skip(
      !(await servesProgress()),
      "The base URL serves no progress route: set PIPELEX_BASE_URL=https://api-dev.pipelex.com to run this spec.",
    );
  });

  test("draws a durable run's progress while it goes, and keeps it under the result", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await page.waitForSelector("html[data-hydrated]");
    await page.getByRole("tab", { name: /check claims/i }).click();

    const panel = page.getByRole("tabpanel", { name: /check claims/i });
    await panel.getByRole("radio", { name: /durable/i }).click();
    await panel
      .getByRole("textbox", { name: "Text" })
      .fill(
        "The Eiffel Tower stands in Paris. Water boils at 100 degrees Celsius at sea level. The Moon is made of cheese. Mount Everest is the highest mountain above sea level.",
      );
    await panel.getByRole("button", { name: /run check claims/i }).click();

    // The timeline's own region, one row per invocation the run has reached.
    const timeline = panel.getByRole("region", { name: "Run progress" });
    const rows = timeline.getByRole("listitem");

    // At least one row while the run still goes: the submit button says so
    // until the status poll sees the run end.
    const going = panel.getByRole("button", { name: "Running…" });
    await expect
      .poll(async () => (await going.isVisible()) && (await rows.count()) > 0, {
        timeout: 90_000,
        intervals: [250],
      })
      .toBe(true);
    // Kept in the test's output directory, as the evidence of what the gallery drew.
    await panel.screenshot({ path: testInfo.outputPath("timeline-running.png") });

    // The result shows, and the timeline stays under it with its rows.
    const result = panel.getByRole("region", { name: "Check claims" });
    await expect(result).toBeVisible({ timeout: 150_000 });
    await expect(timeline).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);

    // The batch's items, each a row of the pipe the batch ran, once the final
    // snapshot is in: the method splits the text into at least two claims.
    await expect
      .poll(() => timeline.getByText("check_claim", { exact: true }).count(), {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(2);
    await panel.screenshot({ path: testInfo.outputPath("timeline-after-result.png") });
  });
});
