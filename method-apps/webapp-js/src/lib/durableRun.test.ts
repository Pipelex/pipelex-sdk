import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  RunLifecycleUnavailableError,
  type RunResults,
} from "@pipelex/sdk";

const start = vi.fn();
const getRunStatus = vi.fn();
const getRunResult = vi.fn();

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ start, getRunStatus, getRunResult }),
}));

import { pollDurableRun, startDurableRun } from "./durableRun";
import { MODEL_NOT_ENABLED, RATE_LIMITED, WRONG_ITEM_COUNT } from "@/test/fixtures/runReports";
import { refusedStart } from "@/test/fixtures/refusals";
import { BadPipelineOutputError } from "@/types/pipelineError";

beforeEach(() => {
  start.mockReset();
  getRunStatus.mockReset();
  getRunResult.mockReset();
});

const OPTIONS = {
  pipe_code: "fixture_pipe",
  mthds_contents: ["BUNDLE"],
  inputs: { text: "x" },
};
const FIXTURE = { items: ["Ada"] };

// Inline fixture narrower, so the shared-helper tests import no method's
// adapter — the template ships no method, and a scaffolded one stays removable
// without touching this file. It honors the real `parseXxx` contract: read `main_stuff`, throw a tagged
// error on shape mismatch.
function parseFixture(results: RunResults): { items: string[] } {
  const stuff = results.main_stuff;
  if (typeof stuff !== "object" || stuff === null || !("items" in stuff)) {
    throw new BadPipelineOutputError("fixture output is missing `items`");
  }
  return stuff as { items: string[] };
}

describe("startDurableRun", () => {
  it("returns the run id on success", async () => {
    start.mockResolvedValueOnce({ pipeline_run_id: "run-1" });
    const result = await startDurableRun(async () => OPTIONS);
    expect(start).toHaveBeenCalledWith(OPTIONS);
    expect(result).toEqual({ ok: true, runId: "run-1" });
  });

  it("classifies a bare-runner RunLifecycleUnavailableError into lifecycle_unavailable", async () => {
    start.mockRejectedValueOnce(
      new RunLifecycleUnavailableError("no run store", "https://api.unreachable.example"),
    );
    const result = await startDurableRun(async () => OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("lifecycle_unavailable");
  });

  it("classifies a refused start from its problem document", async () => {
    start.mockRejectedValueOnce(refusedStart());
    const result = await startDurableRun(async () => OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_request");
    expect(result.error.message).toBe("The method is invalid.");
    expect(result.error.hint?.summary).toBe("Fix the bundle, then run it again.");
    expect(result.error.retry?.retryable).toBe(false);
    expect(result.error.details).toContain("(model reference: gpt-5.1; suggestions: gpt-5)");
  });

  it("classifies a transport error thrown by start", async () => {
    start.mockRejectedValueOnce(
      new ApiUnreachableError("unreachable", "https://api.unreachable.example", "ECONNREFUSED"),
    );
    const result = await startDurableRun(async () => OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_unreachable");
  });
});

describe("pollDurableRun", () => {
  it("reports running while the status is non-terminal (no result lookup)", async () => {
    getRunStatus.mockResolvedValueOnce({
      status: "RUNNING",
      degraded: false,
      retry_after_seconds: null,
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(getRunResult).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      state: "running",
      status: "RUNNING",
      degraded: false,
      retryAfterSeconds: null,
    });
  });

  it("passes through degraded + retry_after_seconds", async () => {
    getRunStatus.mockResolvedValueOnce({
      status: "PENDING",
      degraded: true,
      retry_after_seconds: 7,
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result).toEqual({
      ok: true,
      state: "running",
      status: "PENDING",
      degraded: true,
      retryAfterSeconds: 7,
    });
  });

  it("narrows the result on a completed terminal status", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "COMPLETED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "completed",
      pipeline_run_id: "run-1",
      result: { pipeline_run_id: "run-1", main_stuff: FIXTURE },
    });
    const result = await pollDurableRun("run-1", parseFixture);
    // No usage on the result → an "unavailable" report rides alongside the output.
    expect(result).toEqual({
      ok: true,
      state: "completed",
      output: FIXTURE,
      usage: {
        state: "unavailable",
        calls: [],
        totalCostUsd: null,
        costPartial: false,
        assemblyError: null,
      },
    });
  });

  it("builds the usage report from the completed result's tokens_usages", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "COMPLETED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "completed",
      pipeline_run_id: "run-1",
      result: {
        pipeline_run_id: "run-1",
        main_stuff: FIXTURE,
        tokens_usages: [{ inference_model_name: "gpt-4o", pipe_code: "fixture_pipe", cost: 0.002 }],
        usage_assembly_error: null,
      },
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(true);
    if (!result.ok || result.state !== "completed") return;
    expect(result.usage.state).toBe("records");
    expect(result.usage.totalCostUsd).toBeCloseTo(0.002);
    expect(result.usage.calls[0].modelName).toBe("gpt-4o");
  });

  it("classifies a failed terminal status as run_failed (constructed from the result lookup)", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "FAILED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "failed",
      pipeline_run_id: "run-1",
      status: "FAILED",
      message: "pipe blew up",
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("run_failed");
    expect(result.error.message).toContain("pipe blew up");
    expect(result.transient).toBe(false); // a real run failure is terminal
  });

  it("classifies a failed run from the report the results read carries, dated by the status read", async () => {
    getRunStatus.mockResolvedValueOnce({
      status: "FAILED",
      degraded: false,
      finished_at: "2026-09-26T10:01:00+00:00",
      error: WRONG_ITEM_COUNT,
    });
    getRunResult.mockResolvedValueOnce({
      state: "failed",
      pipeline_run_id: "run-1",
      status: "FAILED",
      message: `Run finished with status FAILED: ${MODEL_NOT_ENABLED.message}`,
      error: MODEL_NOT_ENABLED,
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transient).toBe(false);
    expect(result.error.title).toBe("The pipeline run failed: LLM completion");
    expect(result.error.hint?.summary).toBe(MODEL_NOT_ENABLED.user_action?.detail);
    expect(result.error.retry?.retryable).toBe(false);
    expect(result.error.support).toBe(
      "run run-1 · LLMCompletionError · failed 2026-09-26T10:01:00Z",
    );
    expect(JSON.stringify(result.error)).not.toContain("not allowed for this integration");
  });

  it("takes the report from the status read on a platform whose results read has none", async () => {
    getRunStatus.mockResolvedValueOnce({
      status: "FAILED",
      degraded: false,
      finished_at: null,
      error: RATE_LIMITED,
    });
    getRunResult.mockResolvedValueOnce({
      state: "failed",
      pipeline_run_id: "run-1",
      status: "FAILED",
      message: "Run finished with status FAILED; no result available",
      error: null,
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain("no result available");
    expect(result.error.hint).toBeUndefined(); // wait_and_retry advice is stale on a failed run
    expect(result.error.retry?.retryable).toBe(true);
    expect(result.error.support).toBe("run run-1 · LLMCompletionError");
  });

  it("keeps the lookup's sentence for a run that ended with no report", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "CANCELLED", degraded: false, error: null });
    getRunResult.mockResolvedValueOnce({
      state: "failed",
      pipeline_run_id: "run-1",
      status: "CANCELLED",
      message: "Run finished with status CANCELLED; no result available",
      error: null,
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBe("The pipeline run failed");
    expect(result.error.message).toBe("Run finished with status CANCELLED; no result available");
    expect(result.error.hint).toBeUndefined();
    expect(result.error.retry).toBeUndefined();
    expect(result.error.support).toBeUndefined();
  });

  it("re-reports running on the mid-write race (terminal status, result still running)", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "COMPLETED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "running",
      pipeline_run_id: "run-1",
      retry_after_seconds: 2,
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result).toEqual({
      ok: true,
      state: "running",
      status: "COMPLETED",
      degraded: false,
      retryAfterSeconds: 2,
    });
  });

  it("classifies a narrower throw on a completed run as bad_response", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "COMPLETED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "completed",
      pipeline_run_id: "run-1",
      result: { pipeline_run_id: "run-1", main_stuff: { foo: "bar" } },
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_response");
  });

  it("classifies a thrown SDK error during polling as a transient api_unreachable", async () => {
    getRunStatus.mockRejectedValueOnce(
      new ApiUnreachableError("unreachable", "https://api.pipelex.com", "ENOTFOUND"),
    );
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_unreachable");
    expect(result.transient).toBe(true); // a network blip — keep polling
  });

  it("flags a 5xx gateway error during polling as a transient server_error", async () => {
    getRunStatus.mockRejectedValueOnce(
      new ApiResponseError(
        "bad gateway",
        "https://api.pipelex.com",
        502,
        "Bad Gateway",
        "",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    );
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("server_error");
    expect(result.transient).toBe(true); // the run is still executing server-side
  });

  it("classifies a RunLifecycleUnavailableError thrown during polling as terminal", async () => {
    getRunStatus.mockRejectedValueOnce(
      new RunLifecycleUnavailableError("no run store", "https://api.unreachable.example"),
    );
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("lifecycle_unavailable");
    expect(result.transient).toBe(false); // retrying won't conjure a run store
  });
});
