import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunFailedError, type RunErrorReport } from "@pipelex/sdk";
import { classifyPipelineError } from "@/lib/errors";
import {
  MODEL_NOT_ENABLED,
  MODEL_NOT_ENABLED_PROVIDER_TEXT,
  RATE_LIMITED,
  WRONG_ITEM_COUNT,
} from "@/test/fixtures/runReports";
import { ErrorDisplay } from "./ErrorDisplay";

const ENV = { apiUrl: undefined, hasApiKey: true };
const FINISHED_AT = "2026-09-26T10:01:00+00:00";

/** A failed durable run as `pollDurableRun` classifies it, then shows it. */
function showFailedRun(report: RunErrorReport | null, message: string) {
  const error = classifyPipelineError(
    new RunFailedError(message, "run-1", "FAILED", { error: report }),
    ENV,
    { finishedAt: FINISHED_AT },
  );
  return render(<ErrorDisplay error={error} runId="run-1" />);
}

describe("ErrorDisplay — a failed run", () => {
  it("shows the report's reason, next step and support line, and offers no re-run for a change_input fault", () => {
    showFailedRun(WRONG_ITEM_COUNT, `Run finished with status FAILED: ${WRONG_ITEM_COUNT.message}`);
    const alert = screen.getByRole("alert");
    expect(
      screen.getByRole("heading", {
        name: "The pipeline run failed: Multiplicity count mismatch",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(WRONG_ITEM_COUNT.message as string)).toBeInTheDocument();
    expect(screen.getByText("Provide exactly 2 items for input 'pages'.")).toBeInTheDocument();
    expect(
      screen.getByText("Running it again unchanged will fail the same way."),
    ).toBeInTheDocument();
    expect(alert).not.toHaveTextContent(/run it again/);
    expect(
      screen.getByText("run run-1 · MultiplicityCountMismatchError · failed 2026-09-26T10:01:00Z"),
    ).toBeInTheDocument();
    expect(alert).toHaveTextContent(/For support:/);
    expect(alert).not.toHaveTextContent(/no result available/);
  });

  it("offers a re-run for a retryable failure", () => {
    showFailedRun(RATE_LIMITED, `Run finished with status FAILED: ${RATE_LIMITED.message}`);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/retry automatically/);
    expect(
      screen.getByText("This failure can pass on a second try: run it again."),
    ).toBeInTheDocument();
  });

  it("never shows the provider's raw text, even under the technical details", () => {
    showFailedRun(
      MODEL_NOT_ENABLED,
      `Run finished with status FAILED: ${MODEL_NOT_ENABLED.message}`,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "This model is not enabled on the inference gateway; choose another model for the pipe.",
    );
    expect(alert.textContent).not.toContain(MODEL_NOT_ENABLED_PROVIDER_TEXT);
    expect(alert).not.toHaveTextContent(/not allowed for this integration/);
  });

  it("keeps today's sentence and the bare run id for a run with no report", () => {
    showFailedRun(null, "Run finished with status FAILED; no result available");
    const alert = screen.getByRole("alert");
    expect(screen.getByRole("heading", { name: "The pipeline run failed" })).toBeInTheDocument();
    expect(
      screen.getByText("Run finished with status FAILED; no result available"),
    ).toBeInTheDocument();
    expect(alert).not.toHaveTextContent(/For support:/);
    expect(alert).not.toHaveTextContent(/run it again|fail the same way/);
    expect(alert).toHaveTextContent(/Run run-1/);
  });
});
