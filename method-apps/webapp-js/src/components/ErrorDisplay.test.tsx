import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunFailedError, type Problem } from "@pipelex/sdk";
import { classifyPipelineError } from "@/lib/errors";
import { refusedStart } from "@/test/fixtures/refusals";
import {
  MODEL_NOT_SERVED,
  MODEL_NOT_SERVED_PROVIDER_TEXT,
  RATE_LIMITED,
  WRONG_ITEM_COUNT,
  runFailedAnswer,
} from "@/test/fixtures/runProblems";
import { ErrorDisplay } from "./ErrorDisplay";

const ENV = { apiUrl: undefined, hasApiKey: true };
const FINISHED_AT = "2026-09-26T10:01:00+00:00";

/** A failed durable run as `pollDurableRun` classifies it, then shows it. */
function showFailedRun(runError: Problem | null) {
  const problem = runFailedAnswer(runError);
  const error = classifyPipelineError(
    new RunFailedError(problem.detail, "run-1", "FAILED", { problem }),
    ENV,
    { finishedAt: FINISHED_AT },
  );
  return render(<ErrorDisplay error={error} runId="run-1" />);
}

describe("ErrorDisplay — a failed run", () => {
  it("shows the run's reason, who must act, the next step and the support line, and offers no re-run for an input fault", () => {
    showFailedRun(WRONG_ITEM_COUNT);
    const alert = screen.getByRole("alert");
    expect(
      screen.getByRole("heading", {
        name: `The pipeline run failed: ${WRONG_ITEM_COUNT.title}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(WRONG_ITEM_COUNT.detail)).toBeInTheDocument();
    expect(screen.getByText("The inputs need to change before this can run.")).toBeInTheDocument();
    expect(screen.getByText(WRONG_ITEM_COUNT.next_step.detail)).toBeInTheDocument();
    expect(
      screen.getByText("Running it again unchanged will fail the same way."),
    ).toBeInTheDocument();
    expect(alert).not.toHaveTextContent(/run it again\./);
    expect(
      screen.getByText(
        "run run-1 · input.wrong_multiplicity · failed 2026-09-26T10:01:00Z · request req_results_409",
      ),
    ).toBeInTheDocument();
    expect(alert).toHaveTextContent(/For support:/);
    // A fault on the caller's side is a caution, not an alarm.
    expect(alert).toHaveAttribute("data-domain", "input");
    expect(alert.className).toMatch(/amber/);
  });

  it("offers a re-run, after the delay, for a failure in the service", () => {
    showFailedRun(RATE_LIMITED);
    const alert = screen.getByRole("alert");
    expect(
      screen.getByText("This failure can pass on a second try: run it again in 20 seconds."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The service failed on its side; nothing you entered caused it."),
    ).toBeInTheDocument();
    expect(alert.className).toMatch(/red/);
  });

  it("never shows the provider's raw text, even under the technical details", () => {
    showFailedRun(MODEL_NOT_SERVED);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(MODEL_NOT_SERVED.next_step.detail);
    expect(alert.textContent).not.toContain(MODEL_NOT_SERVED_PROVIDER_TEXT);
    expect(alert).not.toHaveTextContent(/not allowed for this integration/);
  });

  it("shows the request's id where it can be copied", () => {
    showFailedRun(MODEL_NOT_SERVED);
    const line = screen.getByText(/request req_gw_5f1c/);
    expect(line).toHaveClass("select-all");
  });

  it("keeps the lookup's sentence and the bare run id for a run with no problem of its own", () => {
    showFailedRun(null);
    const alert = screen.getByRole("alert");
    expect(screen.getByRole("heading", { name: "The pipeline run failed" })).toBeInTheDocument();
    expect(
      screen.getByText("The run 'run-1' ended as 'FAILED', without success."),
    ).toBeInTheDocument();
    expect(alert).not.toHaveTextContent(/For support:/);
    expect(alert).not.toHaveTextContent(/run it again|fail the same way/);
    expect(alert).toHaveTextContent(/Run run-1/);
  });
});

describe("ErrorDisplay — a refusal", () => {
  it("says who must act from the problem's domain and puts the run ahead of the support line", () => {
    const error = classifyPipelineError(refusedStart(), ENV);
    render(<ErrorDisplay error={error} runId="run-9" />);
    expect(
      screen.getByText("The method needs a change from whoever authors it."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("run run-9 · method.invalid · request req-run-422"),
    ).toBeInTheDocument();
  });

  it("names nobody for a failure that carries no problem", () => {
    render(
      <ErrorDisplay
        error={{
          kind: "transport_error",
          title: "Could not reach the server",
          message: "x",
          details: "",
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveAttribute("data-domain");
    expect(alert).not.toHaveTextContent(/needs|failed on its side/);
  });
});
