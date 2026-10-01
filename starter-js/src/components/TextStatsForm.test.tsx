import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TextStatsForm } from "./TextStatsForm";
import {
  pollTextStatsRun,
  runTextStatsBlocking,
  startTextStatsRun,
} from "@/actions/runTextStatsPipeline";

// The scaffolded slice's own test, written by hand like the other four examples
// — `make add-method` emits only the fixture-free action test, deliberately.
// What is worth covering here is the same contract every example keeps: the
// form is derived from the method's committed descriptor, both modes work, and
// the generic result view renders the typed output.
vi.mock("@/actions/runTextStatsPipeline", () => ({
  runTextStatsBlocking: vi.fn(),
  startTextStatsRun: vi.fn(),
  pollTextStatsRun: vi.fn(),
}));

const blocking = vi.mocked(runTextStatsBlocking);
const start = vi.mocked(startTextStatsRun);
const poll = vi.mocked(pollTextStatsRun);

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

function submitForm() {
  const form = screen.getByRole("button", { name: /run text stats/i }).closest("form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

const REPORT = { text: "# Text statistics\n\n| Metric | Value |\n|---|---|\n| Words | 12 |" };
const USAGE = {
  calls: [],
  totalCostUsd: 0,
  hasCost: false,
  state: "records" as const,
  assemblyError: null,
};

describe("TextStatsForm", () => {
  it("renders the input the published method's contract declares", () => {
    render(<TextStatsForm />);
    // `text_stats.analyze_text` takes one `native.Text` input named `text`, and
    // the label is the kernel's humanization of that name. Nothing in the
    // component names it: the field comes from the committed descriptor, which
    // `npm run codegen` fetched from the address in methods/text-stats/method.json.
    expect(screen.getByLabelText("Text")).toBeInTheDocument();
  });

  it("gates Run on the contract's required inputs", () => {
    render(<TextStatsForm />);
    const runButton = screen.getByRole("button", { name: /run text stats/i });
    // The one input gates, and the scaffolded form seeds nothing — so an
    // untouched form cannot be submitted.
    expect(runButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Some prose." } });
    expect(runButton).toBeEnabled();
  });

  it("durable mode (default): streams live status, then renders the JSON result", async () => {
    start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
    poll
      .mockResolvedValueOnce({
        ok: true,
        state: "running",
        status: "RUNNING",
        degraded: false,
        retryAfterSeconds: null,
      })
      .mockResolvedValueOnce({ ok: true, state: "completed", output: REPORT, usage: USAGE });

    render(<TextStatsForm />);
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Some prose." } });
    submitForm();

    await flush();
    expect(screen.getByRole("status")).toBeInTheDocument();

    await flush(2000);
    // The result is rendered from the method's own output contract, so a
    // `native.Text` result is typeset as the markdown a model actually returns:
    // the heading is a heading and the table is a table, where a JSON view
    // printed the escapes. The header carries the stuff name this form passed.
    expect(screen.getByRole("heading", { name: "Text statistics" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Words" })).toBeInTheDocument();
    expect(screen.getByText("Text stats")).toBeInTheDocument();
    // The same seam every example turns on: the action gets the schema-shaped
    // dict the contract declares, not the raw run-values the form holds.
    expect(start).toHaveBeenCalledWith({ text: { text: "Some prose." } });
    expect(blocking).not.toHaveBeenCalled();
  });

  it("blocking mode: toggling to Blocking calls the blocking action", async () => {
    blocking.mockResolvedValueOnce({ ok: true, output: REPORT, usage: USAGE, runId: "run-b" });

    render(<TextStatsForm />);
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Some prose." } });
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    submitForm();

    await flush();
    expect(blocking).toHaveBeenCalledWith({ text: { text: "Some prose." } });
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Text statistics" })).toBeInTheDocument();
  });

  it("renders the structured error when a poll returns ok:false", async () => {
    start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
    poll.mockResolvedValueOnce({
      ok: false,
      transient: false,
      error: { kind: "run_failed", title: "Run failed", message: "boom", details: "d" },
    });

    render(<TextStatsForm />);
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Some prose." } });
    submitForm();

    await flush();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Run failed")).toBeInTheDocument();
  });

  it("surfaces a transport_error when the awaited action rejects", async () => {
    blocking.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<TextStatsForm />);
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Some prose." } });
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    submitForm();

    await flush();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server/i)).toBeInTheDocument();
  });
});
