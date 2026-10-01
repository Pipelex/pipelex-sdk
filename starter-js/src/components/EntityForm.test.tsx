import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { EntityForm } from "./EntityForm";
import {
  pollExtractEntitiesRun,
  runExtractEntitiesBlocking,
  startExtractEntitiesRun,
} from "@/actions/runExtractEntitiesPipeline";

vi.mock("@/actions/runExtractEntitiesPipeline", () => ({
  runExtractEntitiesBlocking: vi.fn(),
  startExtractEntitiesRun: vi.fn(),
  pollExtractEntitiesRun: vi.fn(),
}));

const blocking = vi.mocked(runExtractEntitiesBlocking);
const start = vi.mocked(startExtractEntitiesRun);
const poll = vi.mocked(pollExtractEntitiesRun);

beforeEach(() => {
  vi.useFakeTimers();
  blocking.mockReset();
  start.mockReset();
  poll.mockReset();
});
afterEach(() => vi.useRealTimers());

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Reached through the submit button rather than the input's label: the labels
// are the kernel's humanized contract names now, so a bundle rename would
// otherwise break every test in this file rather than just the one asserting it.
function submitForm() {
  const form = screen.getByRole("button", { name: /extract entities/i }).closest("form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

const ENTITIES = { people: ["Tim Cook"], orgs: ["Apple"], dates: ["2026-03-05"] };
const USAGE = {
  calls: [
    {
      modelName: "gpt-4o",
      modelType: "llm",
      pipeCode: "extract_entities",
      tokensByCategory: { input: 1200, output: 340 },
      costUsd: 0.0042,
    },
  ],
  totalCostUsd: 0.0042,
  hasCost: true,
  state: "records" as const,
  assemblyError: null,
};

describe("EntityForm", () => {
  it("renders the input the method's contract declares, seeded with the sample", () => {
    render(<EntityForm />);
    // The bundle's `text` input → "Text" through the kernel's `app`
    // presentation. Nothing in this component names the input: the label, the
    // control and the readiness rule all come from the generated contract.
    expect(screen.getByLabelText("Text")).toHaveDisplayValue(/Tim Cook/);
  });

  it("gates Run on the contract's required inputs, not a hand-written check", () => {
    render(<EntityForm />);
    const runButton = screen.getByRole("button", { name: /extract entities/i });
    expect(runButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "" } });
    expect(runButton).toBeDisabled();
  });

  it("durable mode (default): streams live status, then renders the result", async () => {
    start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
    poll
      .mockResolvedValueOnce({
        ok: true,
        state: "running",
        status: "RUNNING",
        degraded: false,
        retryAfterSeconds: null,
      })
      .mockResolvedValueOnce({ ok: true, state: "completed", output: ENTITIES, usage: USAGE });

    render(<EntityForm />);
    submitForm();

    await flush(); // start + first poll (running)
    expect(screen.getByRole("status")).toBeInTheDocument();

    await flush(2000); // scheduled second poll → completed
    expect(screen.getByText("Tim Cook")).toBeInTheDocument();
    // The cost report is wired in beside the result.
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
    expect(blocking).not.toHaveBeenCalled();
    // The seam this whole branch turns on: the action receives the
    // *schema-shaped* dict the contract declares, not the raw run-values the
    // form holds. `run(values)` in place of `run(toData())` sends
    // `{text: "…"}`, every real run is rejected by the gate as `bad_request`,
    // and without this assertion the suite stays green all the way to ship.
    expect(start).toHaveBeenCalledWith({ text: { text: expect.stringContaining("Tim Cook") } });
  });

  it("blocking mode: toggling to Blocking calls the blocking action and renders the result", async () => {
    blocking.mockResolvedValueOnce({ ok: true, output: ENTITIES, usage: USAGE, runId: "run-b" });

    render(<EntityForm />);
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    submitForm();

    await flush();
    expect(blocking).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByText("Tim Cook")).toBeInTheDocument();
    // Both modes hand over the same shape — the forms are mode-agnostic.
    expect(blocking).toHaveBeenCalledWith({ text: { text: expect.stringContaining("Tim Cook") } });
  });

  it("renders the structured error when a poll returns ok:false", async () => {
    start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
    poll.mockResolvedValueOnce({
      ok: false,
      transient: false,
      error: { kind: "run_failed", title: "Run failed", message: "boom", details: "d" },
    });

    render(<EntityForm />);
    submitForm();

    await flush();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Run failed")).toBeInTheDocument();
  });

  it("surfaces a transport_error when the awaited blocking action rejects", async () => {
    // Regression guard: a rejected await must route through <ErrorDisplay>, not
    // React's error boundary.
    blocking.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<EntityForm />);
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    submitForm();

    await flush();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server/i)).toBeInTheDocument();
    expect(screen.getByText(/Failed to fetch/i)).toBeInTheDocument();
  });
});
