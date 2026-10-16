import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunProgressPanel } from "./RunProgressPanel";
import type { RunState } from "@/hooks/useRun";
import { fetchRunProgress } from "@/lib/fetchRunProgress";
import type { ProgressRead } from "@/lib/progressReader";
import type { UsageReport } from "@/lib/usageReport";
import { claimsFinished, claimsMidRun, claimsPending } from "@/test/fixtures/runProgress";

// The panel reads through this app's route by default; here, a fake source
// answering from what each test sets, so no test fetches anything.
vi.mock("@/lib/fetchRunProgress", () => ({ fetchRunProgress: vi.fn() }));
const read = vi.mocked(fetchRunProgress);

let answers: Record<string, ProgressRead[]> = {};

beforeEach(() => {
  answers = {};
  read.mockReset();
  read.mockImplementation(async (runId) => answers[runId]?.shift() ?? { kind: "none" });
});

const USAGE: UsageReport = {
  calls: [],
  totalCostUsd: null,
  hasCost: false,
  state: "no-inference",
  assemblyError: null,
};

function running(runId: string | null): RunState<unknown> {
  return {
    phase: "running",
    mode: runId === null ? "blocking" : "durable",
    status: runId === null ? null : "RUNNING",
    elapsedMs: 0,
    health: null,
    runId,
  };
}

function done(runId: string): RunState<unknown> {
  return { phase: "done", output: { verdict: "ok" }, usage: USAGE, runId };
}

function failed(runId: string | null): RunState<unknown> {
  return {
    phase: "error",
    error: { kind: "run_failed", title: "Run failed", message: "The run failed.", details: "" },
    runId,
  };
}

/** The timeline's own region, the one landmark the panel adds. */
function timeline() {
  return screen.queryByRole("region", { name: "Run progress" });
}

describe("RunProgressPanel", () => {
  it("follows a durable run while it goes, and draws its timeline", async () => {
    answers["run-1"] = [{ kind: "snapshot", snapshot: claimsMidRun("run-1") }];
    render(<RunProgressPanel state={running("run-1")} />);
    // The timeline's own region, once it has loaded, with no wrapper of the panel's.
    const drawn = await screen.findByRole("region", { name: "Run progress" });
    expect(drawn).toHaveTextContent("check_each_claim");
    expect(screen.getAllByRole("region")).toEqual([drawn]);
    expect(read).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
  });

  it("never follows a blocking run, which has no id until it has ended", async () => {
    const { rerender } = render(<RunProgressPanel state={running(null)} />);
    rerender(<RunProgressPanel state={done("run-b")} />);
    rerender(<RunProgressPanel state={failed("run-b")} />);
    await vi.waitFor(() => expect(timeline()).toBeNull());
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a durable run's timeline once it is done, with its final snapshot", async () => {
    answers["run-1"] = [
      { kind: "snapshot", snapshot: claimsMidRun("run-1") },
      { kind: "snapshot", snapshot: claimsFinished("run-1") },
    ];
    const { rerender } = render(<RunProgressPanel state={running("run-1")} />);
    await screen.findByRole("region", { name: "Run progress" });

    rerender(<RunProgressPanel state={done("run-1")} />);
    await vi.waitFor(() => expect(timeline()).toHaveTextContent("word_verdict"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed run's timeline, so it shows where the run stopped", async () => {
    answers["run-1"] = [{ kind: "snapshot", snapshot: claimsMidRun("run-1") }];
    const { rerender } = render(<RunProgressPanel state={running("run-1")} />);
    await screen.findByRole("region", { name: "Run progress" });

    rerender(<RunProgressPanel state={failed("run-1")} />);
    expect(timeline()).toHaveTextContent("check_each_claim");
  });

  it("starts afresh on a new submit, and follows the new run alone", async () => {
    answers["run-1"] = [{ kind: "snapshot", snapshot: claimsMidRun("run-1") }];
    answers["run-2"] = [{ kind: "snapshot", snapshot: claimsFinished("run-2") }];
    const { rerender } = render(<RunProgressPanel state={running("run-1")} />);
    await screen.findByRole("region", { name: "Run progress" });
    rerender(<RunProgressPanel state={done("run-1")} />);

    // The submit, before `start` has answered with the new run's id.
    rerender(<RunProgressPanel state={running(null)} />);
    expect(timeline()).toBeNull();

    rerender(<RunProgressPanel state={running("run-2")} />);
    await vi.waitFor(() => expect(timeline()).toHaveTextContent("word_verdict"));
    expect(read).toHaveBeenLastCalledWith("run-2", expect.any(AbortSignal));
  });

  it("clears once the form resets its run", async () => {
    answers["run-1"] = [{ kind: "snapshot", snapshot: claimsMidRun("run-1") }];
    const { rerender } = render(<RunProgressPanel state={running("run-1")} />);
    await screen.findByRole("region", { name: "Run progress" });
    rerender(<RunProgressPanel state={{ phase: "idle" }} />);
    expect(timeline()).toBeNull();
  });

  it("draws nothing before the run reaches an invocation, nor where no progress is served", async () => {
    answers["run-1"] = [{ kind: "snapshot", snapshot: claimsPending("run-1") }];
    answers["run-2"] = [{ kind: "unavailable" }];
    const { container, rerender } = render(<RunProgressPanel state={running("run-1")} />);
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith("run-1", expect.any(AbortSignal)));
    // Nothing at all in the page, so the form's column keeps no empty region or gap.
    expect(container).toBeEmptyDOMElement();

    rerender(<RunProgressPanel state={running("run-2")} />);
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith("run-2", expect.any(AbortSignal)));
    rerender(<RunProgressPanel state={done("run-2")} />);
    expect(container).toBeEmptyDOMElement();
    // `unavailable` stops the reading: not even the final reads.
    expect(read.mock.calls.filter(([runId]) => runId === "run-2")).toHaveLength(1);
  });
});
