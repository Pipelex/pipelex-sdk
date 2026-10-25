import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProblem, type RunProgress } from "@pipelex/sdk";
import { fetchRunProgress, readProgressSnapshot } from "./fetchRunProgress";
import { toProgressSnapshot } from "./runProgress";
import { claimsFinished, claimsMidRun } from "@/test/fixtures/runProgress";

/** An invocation's failure as the SDK reads it, a problem whose detail is the provider's text. */
const FAILURE_PROBLEM = { ...buildProblem("runtime.unexpected", {}), detail: "provider text" };

const fetchSpy = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function answering(body: unknown, init: ResponseInit = {}): void {
  fetchSpy.mockResolvedValueOnce(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      ...init,
    }),
  );
}

function read(runId = "run-1") {
  return fetchRunProgress(runId, new AbortController().signal);
}

describe("fetchRunProgress", () => {
  it("reads this app's route for the run, uncached, with the caller's signal", async () => {
    answering({ state: "none" });
    const controller = new AbortController();
    await fetchRunProgress("run/1 ?", controller.signal);
    expect(fetchSpy).toHaveBeenCalledWith("/api/runs/run%2F1%20%3F/progress", {
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("reads a snapshot", async () => {
    const snapshot = claimsMidRun();
    answering({ state: "snapshot", snapshot });
    expect(await read()).toEqual({ kind: "snapshot", snapshot });
  });

  it("reads none and unavailable", async () => {
    answering({ state: "none" });
    expect(await read()).toEqual({ kind: "none" });
    answering({ state: "unavailable" });
    expect(await read()).toEqual({ kind: "unavailable" });
  });

  it("is failed for an error status, whatever its body", async () => {
    answering({ state: "snapshot", snapshot: claimsMidRun() }, { status: 502 });
    expect(await read()).toEqual({ kind: "failed" });
    answering("", { status: 500 });
    expect(await read()).toEqual({ kind: "failed" });
  });

  it("is failed for a body it cannot read", async () => {
    answering("<html>Bad gateway</html>");
    expect(await read()).toEqual({ kind: "failed" });
    answering({ state: "a state the route never sends" });
    expect(await read()).toEqual({ kind: "failed" });
    answering([{ state: "none" }]);
    expect(await read()).toEqual({ kind: "failed" });
    answering({ state: "snapshot", snapshot: { ...claimsMidRun(), status: "RUNNING" } });
    expect(await read()).toEqual({ kind: "failed" });
  });

  it("is failed, never throwing, when the network fails or the read is aborted", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await read()).toEqual({ kind: "failed" });
    fetchSpy.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));
    expect(await read()).toEqual({ kind: "failed" });
  });
});

describe("readProgressSnapshot", () => {
  it("reads every snapshot the route sends, every optional member included", () => {
    // The server's mapping, then the browser's reader: what one sends, the other reads.
    const progress: RunProgress = {
      pipeline_run_id: "run-1",
      mode: "live",
      status: "running",
      version: 12,
      assembled_at: "2026-10-16T09:00:12.000Z",
      summary: "Running check_each_claim (step 2 of 4)",
      root_path: "check_claims.check_claims",
      chain: [{ execution: "exec-1", attempt: 1 }],
      degradation: { reason: "workflow_task_failing", failed_attempts: 2 },
      invocations: [
        {
          path: "check_claims.check_claims",
          pipe_code: "check_claims",
          pipe_ref: "check_claims.check_claims",
          pipe_type: "PipeSequence",
          status: "running",
          started_at: "2026-10-16T09:00:00.000Z",
          ended_at: null,
          step_count: 4,
          degradation: { reason: "workflow_task_failing" },
        },
        {
          path: "check_claims.check_claims/step_2",
          pipe_code: "check_each_claim",
          pipe_ref: "check_claims.check_each_claim",
          pipe_type: "PipeBatch",
          status: "running",
          started_at: "2026-10-16T09:00:04.000Z",
          ended_at: null,
          batch: { total: 3, done: 1, running: 1, failed: 1 },
          attempts: 2,
          last_failure: { problem: FAILURE_PROBLEM, at: "2026-10-16T09:00:03Z" },
        },
        {
          path: "check_claims.check_claims/step_3",
          pipe_code: "word_verdict",
          pipe_ref: "check_claims.word_verdict",
          pipe_type: "PipeCondition",
          status: "skipped",
          started_at: null,
          ended_at: null,
          branch_count: 2,
          skip_reason: "not taken",
          condition: { selected_outcome: null },
          last_failure: { problem: FAILURE_PROBLEM },
        },
      ],
    };
    const sent = toProgressSnapshot(progress);
    expect(readProgressSnapshot(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
    // And the fixtures every other test reads.
    for (const fixture of [claimsMidRun(), claimsFinished()]) {
      expect(readProgressSnapshot(fixture)).toEqual(fixture);
    }
  });

  it("drops a member the route did not send, at every level", () => {
    const snapshot = claimsMidRun();
    const [root, ...rest] = snapshot.invocations;
    const read = readProgressSnapshot({
      ...snapshot,
      extra: "dropped",
      invocations: [{ ...root, extra: "dropped" }, ...rest],
    });
    expect(read).toEqual(snapshot);
  });

  it.each([
    ["a missing run id", { pipeline_run_id: undefined }],
    ["an unknown mode", { mode: "replay" }],
    ["an unknown run status", { status: "RUNNING" }],
    ["a negative version", { version: -1 }],
    ["a fractional version", { version: 1.5 }],
    ["a missing summary", { summary: undefined }],
    ["an invocations member that is not a list", { invocations: {} }],
    ["an unreadable chain", { chain: [{ execution: 1, attempt: 1 }] }],
    ["an unreadable degradation", { degradation: { reason: "x", message: "y" } }],
    ["a root path that is not text", { root_path: null }],
  ])("refuses a snapshot with %s", (_label, change) => {
    expect(readProgressSnapshot({ ...claimsMidRun(), ...change })).toBeNull();
  });

  it.each([
    ["an unknown status", { status: "done" }],
    ["a start that is not text or null", { started_at: 0 }],
    ["a missing pipe code", { pipe_code: undefined }],
    ["a batch missing a count", { batch: { total: 3, done: 1, running: 2 } }],
    ["a condition without its outcome", { condition: {} }],
    ["a failure without its message", { last_failure: { at: "2026-10-16T09:00:03Z" } }],
    ["attempts that are not a count", { attempts: "2" }],
    ["a step count that is null", { step_count: null }],
  ])("refuses a snapshot holding an invocation with %s", (_label, change) => {
    const snapshot = claimsMidRun();
    const [root, ...rest] = snapshot.invocations;
    expect(
      readProgressSnapshot({ ...snapshot, invocations: [{ ...root, ...change }, ...rest] }),
    ).toBeNull();
  });

  it("refuses what is not an object", () => {
    for (const value of [null, "snapshot", 7, [claimsMidRun()]]) {
      expect(readProgressSnapshot(value)).toBeNull();
    }
  });
});
