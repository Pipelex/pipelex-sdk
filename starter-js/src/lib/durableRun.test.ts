import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  RequestArgumentError,
  RunLifecycleUnavailableError,
  buildProblem,
  type Problem,
  type RunResults,
} from "@pipelex/sdk";

const start = vi.fn();
const getRunStatus = vi.fn();
const getRunResult = vi.fn();

const buildClient = vi.fn(() => ({ start, getRunStatus, getRunResult }));

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => buildClient(),
}));

import { pollDurableRun, startDurableRun } from "./durableRun";
import {
  MODEL_NOT_SERVED,
  MODEL_NOT_SERVED_PROVIDER_TEXT,
  RATE_LIMITED,
  WRONG_ITEM_COUNT,
  runFailedAnswer,
} from "@/test/fixtures/runProblems";
import { REFUSAL_BODY, refusedStart } from "@/test/fixtures/refusals";
import { BadPipelineOutputError } from "@/types/pipelineError";

beforeEach(() => {
  start.mockReset();
  getRunStatus.mockReset();
  getRunResult.mockReset();
});

const OPTIONS = {
  pipe_code: "extract_entities",
  contents: { "main.mthds": "BUNDLE" },
  inputs: { text: "x" },
};
const FIXTURE = { items: ["Ada"] };

// Inline fixture narrower, so the shared-helper tests import no removable
// example's adapter (the examples stay deletable without touching this file).
// It honors the real `parseXxx` contract: read `main_stuff`, throw a tagged
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
    expect(result.error.message).toBe(REFUSAL_BODY.detail);
    expect(result.error.hint?.summary).toBe(REFUSAL_BODY.next_step.detail);
    expect(result.error.retry?.verdict).toBe("no");
    expect(result.error.details).toContain("suggestions: gpt-5");
  });

  it("says a start that failed after it left may have started the run", async () => {
    start.mockRejectedValueOnce(
      new ApiUnreachableError("socket hang up", "https://api.pipelex.com", "ECONNRESET", {
        mayStartRun: true,
      }),
    );
    const result = await startDurableRun(async () => OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("outcome_unknown");
    expect(result.error.retry?.verdict).toBe("outcome_unknown");
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
        calls: [],
        totalCostUsd: null,
        hasCost: false,
        state: "unavailable",
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
        tokens_usages: [
          { inference_model_name: "gpt-4o", pipe_code: "extract_entities", cost: 0.002 },
        ],
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

  /** The results read's `failed` arm, as the SDK reads a `run.failed` answer. */
  function failedResult(runError: Problem | null, status = "FAILED") {
    const problem = runFailedAnswer(runError, "run-1", status);
    return {
      state: "failed",
      pipeline_run_id: "run-1",
      status,
      message: problem.detail,
      problem,
      error: runError,
    };
  }

  it("classifies a failed terminal status as run_failed (constructed from the result lookup)", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "FAILED", degraded: false, error: null });
    getRunResult.mockResolvedValueOnce(failedResult(null));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("run_failed");
    expect(result.error.message).toBe("The run 'run-1' ended as 'FAILED', without success.");
    expect(result.transient).toBe(false); // a real run failure is terminal
  });

  it("classifies a failed run from the problem the results read nests, dated by the status read", async () => {
    getRunStatus.mockResolvedValueOnce({
      status: "FAILED",
      degraded: false,
      finished_at: "2026-09-26T10:01:00+00:00",
      error: WRONG_ITEM_COUNT,
    });
    getRunResult.mockResolvedValueOnce(failedResult(MODEL_NOT_SERVED));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transient).toBe(false);
    expect(result.error.title).toBe(`The pipeline run failed: ${MODEL_NOT_SERVED.title}`);
    expect(result.error.hint?.summary).toBe(MODEL_NOT_SERVED.next_step.detail);
    expect(result.error.domain).toBe("operator");
    expect(result.error.retry?.verdict).toBe("no");
    expect(result.error.support).toBe(
      "run run-1 · model.unavailable · failed 2026-09-26T10:01:00Z · request req_gw_5f1c",
    );
    expect(JSON.stringify(result.error)).not.toContain(MODEL_NOT_SERVED_PROVIDER_TEXT);
  });

  it("takes the run's problem from the status read on a platform whose results read nests none", async () => {
    getRunStatus.mockResolvedValueOnce({
      status: "FAILED",
      degraded: false,
      finished_at: null,
      error: RATE_LIMITED,
    });
    getRunResult.mockResolvedValueOnce(failedResult(null));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe(RATE_LIMITED.detail);
    expect(result.error.hint).toBeUndefined(); // a `wait` step is the retry line's to say
    expect(result.error.retry?.verdict).toBe("yes");
    // The run's problem names no request, so the results read's is the one to quote.
    expect(result.error.support).toBe(
      "run run-1 · provider.rate_limited · request req_results_409",
    );
  });

  it("keeps the lookup's sentence for a run that ended with no problem", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "CANCELLED", degraded: false, error: null });
    getRunResult.mockResolvedValueOnce(failedResult(null, "CANCELLED"));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBe("The pipeline run failed");
    expect(result.error.message).toBe("The run 'run-1' ended as 'CANCELLED', without success.");
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

  /** A status read the API refused, as the SDK's client throws it. */
  function refusedRead(
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): ApiResponseError {
    return new ApiResponseError(
      `API GET /v1/runs/run-1/status failed (${status}): ${body}`,
      "https://api.pipelex.com",
      status,
      "",
      body,
      { headers },
    );
  }

  it("flags a 5xx gateway error during polling as a transient server_error", async () => {
    getRunStatus.mockRejectedValueOnce(refusedRead(502, ""));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("server_error");
    expect(result.transient).toBe(true); // the run is still executing server-side
  });

  // The problem's verdict on the read decides, and the error offers no re-run:
  // the run may still be executing, so running it again would start a second one.
  it.each([
    [429, true],
    [408, true],
    [503, true],
    [501, false],
    [404, false],
  ])("reads a poll tick answered %i by its problem's verdict", async (status, transient) => {
    getRunStatus.mockRejectedValueOnce(refusedRead(status, ""));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transient).toBe(transient);
    expect(result.error.retry).toBeUndefined();
  });

  it("hands the poll loop the delay a transient read's problem asks for", async () => {
    const body = JSON.stringify({
      ...buildProblem("runtime.unavailable", {}, { retryAfter: 9 }),
      status: 503,
    });
    getRunStatus.mockRejectedValueOnce(refusedRead(503, body));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result).toMatchObject({ ok: false, transient: true, retryAfterSeconds: 9 });
  });

  it("reads the delay from a bare answer's Retry-After header", async () => {
    getRunStatus.mockRejectedValueOnce(refusedRead(429, "", { "retry-after": "4" }));
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result).toMatchObject({ ok: false, transient: true, retryAfterSeconds: 4 });
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

  it("classifies a base URL the SDK refuses while building the client", async () => {
    buildClient.mockImplementationOnce(() => {
      throw new RequestArgumentError("Invalid API base URL with a path: it must be host-only.", {
        problem: buildProblem("client.not_configured", { setting: "base_url" }),
      });
    });
    const result = await pollDurableRun("run-1", parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config_invalid");
    expect(result.transient).toBe(false);
  });
});
