// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  errorVerdictOf,
  RunLifecycleUnavailableError,
  type RunProgress,
} from "@pipelex/sdk";

const getRunProgress = vi.fn();
const buildClient = vi.fn(() => ({ getRunProgress }));

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => buildClient(),
}));

import { GET } from "./route";
import { FAILURE_TEXT_SHOWN } from "@/lib/runProgress";

beforeEach(() => {
  getRunProgress.mockReset();
  buildClient.mockClear();
});

function progressRequest(runId = "run-1", init?: RequestInit): Request {
  return new Request(`http://127.0.0.1:4300/api/runs/${runId}/progress`, init);
}

function call(runId = "run-1", request = progressRequest(runId)) {
  return GET(request, { params: Promise.resolve({ runId }) });
}

/** A progress read that settles only on its signal's abort, rethrowing the reason as the SDK's client does. */
function readUntilAborted(_runId: string, options: { signal: AbortSignal }): Promise<never> {
  const { signal } = options;
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function apiError(status: number): ApiResponseError {
  return new ApiResponseError(
    `API GET /v1/runs/run-1/progress answered ${status}`,
    "https://api-dev.pipelex.com",
    status,
    "",
    "",
    undefined,
    undefined,
    undefined,
    status === 404 ? "run_not_found" : undefined,
  );
}

/** A `200` the SDK could not read, as its client raises one: the answer's status and raw text, no problem member. */
function unreadableAnswer(body: string): ApiResponseError {
  return new ApiResponseError(
    "API GET /v1/runs/run-1/progress answered 200 with a snapshot it could not read",
    "https://api-dev.pipelex.com",
    200,
    "OK",
    body,
    undefined,
    undefined,
    undefined,
    undefined,
    { cause: new SyntaxError("Unexpected end of JSON input") },
  );
}

const PROGRESS: RunProgress = {
  pipeline_run_id: "run-1",
  mode: "live",
  status: "running",
  version: 7,
  assembled_at: "2026-10-16T09:00:12.000Z",
  summary: "Running split_claims (step 1 of 4)",
  a_member_a_later_platform_adds: "never sent on",
  invocations: [
    {
      path: "check_claims.check_claims/step_1",
      pipe_code: "split_claims",
      pipe_ref: "check_claims.split_claims",
      pipe_type: "PipeLLM",
      status: "running",
      started_at: "2026-10-16T09:00:01.000Z",
      ended_at: null,
      attempts: 2,
      last_failure: { message: "provider said: upstream refused", at: "2026-10-16T09:00:09Z" },
    },
  ],
};

describe("GET /api/runs/{runId}/progress", () => {
  it("answers the snapshot as toProgressSnapshot made it, never cached", async () => {
    getRunProgress.mockResolvedValueOnce(PROGRESS);
    const response = await call();

    expect(getRunProgress).toHaveBeenCalledWith("run-1", { signal: expect.any(AbortSignal) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.state).toBe("snapshot");
    expect(body.snapshot.pipeline_run_id).toBe("run-1");
    expect(body.snapshot).not.toHaveProperty("a_member_a_later_platform_adds");
    expect(body.snapshot.invocations[0].last_failure).toEqual({
      message: FAILURE_TEXT_SHOWN,
      at: "2026-10-16T09:00:09Z",
    });
    expect(JSON.stringify(body)).not.toContain("upstream refused");
  });

  it("hands the SDK the request's own signal, so the browser leaving cancels the upstream read", async () => {
    getRunProgress.mockResolvedValueOnce(PROGRESS);
    const request = progressRequest();
    await call("run-1", request);
    expect(getRunProgress).toHaveBeenCalledOnce();
    expect(getRunProgress.mock.calls[0][1].signal).toBe(request.signal);
  });

  it("answers a read the browser aborted with no body, never classifying what the abort threw", async () => {
    // The SDK rethrows the caller's abort untouched, so the route sees the
    // signal's reason. One carrying a final verdict shows the abort is checked
    // before any classification: unchecked, it would answer `unavailable`.
    for (const reason of [undefined, apiError(403)]) {
      const browser = new AbortController();
      getRunProgress.mockImplementationOnce(readUntilAborted);
      const pending = call("run-1", progressRequest("run-1", { signal: browser.signal }));
      browser.abort(reason);
      const response = await pending;
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
    expect(getRunProgress).toHaveBeenCalledTimes(2);
  });

  it("answers none for a run the platform does not know yet", async () => {
    getRunProgress.mockRejectedValueOnce(apiError(404));
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "none" });
  });

  it("answers unavailable when the base URL serves no progress route", async () => {
    getRunProgress.mockRejectedValueOnce(
      new RunLifecycleUnavailableError("no progress route", "http://127.0.0.1:8081"),
    );
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "unavailable" });
  });

  it("answers unavailable for any refusal the SDK judges final", async () => {
    // A hosted gateway answers a path it does not route with 403 Forbidden, as
    // it answers a key it refuses: reading again helps in neither case.
    for (const failure of [
      apiError(403),
      apiError(401),
      apiError(400),
      apiError(405),
      apiError(501),
    ]) {
      getRunProgress.mockRejectedValueOnce(failure);
      const response = await call();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "unavailable" });
    }
  });

  it("answers an error status with no body for a failure reading again can fix", async () => {
    for (const failure of [
      apiError(503),
      apiError(429),
      new ApiUnreachableError("connect ECONNREFUSED", "https://api.pipelex.com", "ECONNREFUSED"),
      new Error("a failure that carries no verdict"),
    ]) {
      getRunProgress.mockRejectedValueOnce(failure);
      const response = await call();
      expect(response.ok).toBe(false);
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  it("answers an error status, never unavailable, for a 200 the SDK could not read", async () => {
    // The SDK judges such an answer `runtime` and not retryable: a fault in one
    // answer, which the next read may well not repeat, so the browser reads again.
    for (const body of ['{"pipeline_run_id": "run-1", "invocations": [', "", '{"status": 7}']) {
      const failure = unreadableAnswer(body);
      expect(errorVerdictOf(failure)).toEqual({ errorDomain: "runtime", retryable: false });
      getRunProgress.mockRejectedValueOnce(failure);
      const response = await call();
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  it("reads nothing when the client cannot be built, and still answers", async () => {
    buildClient.mockImplementationOnce(() => {
      throw new Error("the client could not be built");
    });
    const response = await call();
    expect(response.status).toBe(502);
    expect(getRunProgress).not.toHaveBeenCalled();
  });
});
