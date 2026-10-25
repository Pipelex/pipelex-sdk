import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";

import { PipelexApiClient } from "../src/client.js";
import {
  ApiResponseError,
  RequestArgumentError,
  RunLifecycleUnavailableError,
} from "../src/errors.js";
import { isFresherRunProgress } from "../src/runs.js";
import type { ProgressInvocation, RunDegradation, RunProgress } from "../src/runs.js";
import type { PipelineRun } from "../src/product-models.js";
import * as sdk from "../src/index.js";
import { problemResponse } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const PROGRESS_URL = `${BASE_URL}/v1/runs/run-1/progress`;
const RESULTS_URL = `${BASE_URL}/v1/runs/run-1/results`;

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** A run still going, as the results route answers it while the run runs. */
const running = (): Response => emptyResponse(202, { "Retry-After": "0" });
const completed = (): Response =>
  jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: { ok: true } });

/**
 * Answer each request from the queue of the route its path ends with, in order, an `Error`
 * thrown as fetch throws a network failure. A request no queue answers fails the test.
 */
function serve(routes: Record<string, (Response | Error)[]>): { urls: string[] } {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    const path = new URL(url).pathname;
    const route = Object.keys(routes).find((suffix) => path.endsWith(suffix));
    const answer = route === undefined ? undefined : routes[route]!.shift();
    if (answer === undefined) throw new Error(`No answer left for ${url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { urls };
}

/** A snapshot of the whole run, with no invocation unless given. */
function snapshot(overrides: Partial<RunProgress> = {}): RunProgress {
  return {
    pipeline_run_id: "run-1",
    mode: "live",
    status: "running",
    version: 1,
    assembled_at: "2026-10-12T09:30:00.000Z",
    summary: "Running review_filings",
    invocations: [],
    ...overrides,
  };
}

const STUCK: RunDegradation = {
  reason: "workflow_task_failing",
  message: "One of this run's batch branches has failed 4 times in a row.",
  failed_attempts: 4,
  failing_since: "2026-10-12T09:30:33.480Z",
  ends_at: "2026-10-12T09:45:33.480Z",
};

/** Part of the contract's worked example: a snapshot taken mid-run. */
const MID_RUN: RunProgress = {
  pipeline_run_id: "run-1",
  mode: "live",
  status: "running",
  version: 26,
  assembled_at: "2026-10-12T09:31:20.512Z",
  summary:
    "Running summarize_filing_batch (step 3 of 4): 1 of 3 items done, 2 running; not progressing " +
    "at summarize_filing (step 3 of 4, item 3 of 3) after 4 failed attempts",
  degradation: STUCK,
  invocations: [
    {
      path: "filings.review_filings",
      pipe_code: "review_filings",
      pipe_ref: "filings.review_filings",
      pipe_type: "PipeSequence",
      status: "running",
      started_at: "2026-10-12T09:30:00.104Z",
      ended_at: null,
      step_count: 4,
    },
    {
      path: "filings.review_filings/step_2",
      pipe_code: "choose_depth",
      pipe_ref: "filings.choose_depth",
      pipe_type: "PipeCondition",
      status: "succeeded",
      started_at: "2026-10-12T09:30:06.902Z",
      ended_at: "2026-10-12T09:30:19.415Z",
      condition: { selected_outcome: "detailed" },
    },
    {
      path: "filings.review_filings/step_3",
      pipe_code: "summarize_filing_batch",
      pipe_ref: "filings.summarize_filing_batch",
      pipe_type: "PipeBatch",
      status: "running",
      started_at: "2026-10-12T09:30:19.440Z",
      ended_at: null,
      batch: { total: 3, done: 1, running: 2, failed: 0 },
    },
    {
      path: "filings.review_filings/step_3/item_2/step_2",
      pipe_code: "condense_filing",
      pipe_ref: "filings.condense_filing",
      pipe_type: "PipeLLM",
      status: "running",
      started_at: "2026-10-12T09:30:31.930Z",
      ended_at: null,
      attempts: 2,
      last_failure: { message: "An internal error occurred.", at: "2026-10-12T09:30:52.317Z" },
    },
    {
      path: "filings.review_filings/step_3/item_3",
      pipe_code: "summarize_filing",
      pipe_ref: "filings.summarize_filing",
      pipe_type: "PipeSequence",
      status: "running",
      started_at: "2026-10-12T09:30:19.702Z",
      ended_at: null,
      step_count: 2,
      degradation: STUCK,
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelexApiClient.getRunProgress", () => {
  it("GETs /v1/runs/{id}/progress with the key and returns the snapshot as sent", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, MID_RUN));

    const progress = await client.getRunProgress("run-1");

    expect(progress).toEqual(MID_RUN);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(PROGRESS_URL);
    expect(init).toMatchObject({ method: "GET" });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("keeps optional members absent and relays members it does not name", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, snapshot({ status: "pending", summary: "Waiting to start", later: 1 })),
    );

    const progress = await client.getRunProgress("run-1");

    expect(progress.status).toBe("pending");
    expect(Object.hasOwn(progress, "degradation")).toBe(false);
    expect(Object.hasOwn(progress, "root_path")).toBe(false);
    expect(progress.later).toBe(1);
  });

  it("drops a degradation it cannot read, on the snapshot and on an invocation", async () => {
    const client = makeClient();
    const invocation: ProgressInvocation = {
      ...MID_RUN.invocations[4]!,
      degradation: { message: "no reason" } as unknown as RunDegradation,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        200,
        snapshot({ degradation: "stuck" as unknown as RunDegradation, invocations: [invocation] }),
      ),
    );

    const progress = await client.getRunProgress("run-1");

    expect(Object.hasOwn(progress, "degradation")).toBe(false);
    expect(Object.hasOwn(progress.invocations[0]!, "degradation")).toBe(false);
    expect(progress.invocations[0]!.step_count).toBe(2);
  });

  it("checks a degradation field by field, as the status read does", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        200,
        snapshot({
          degradation: { ...STUCK, failed_attempts: "four" } as unknown as RunDegradation,
        }),
      ),
    );

    const progress = await client.getRunProgress("run-1");

    expect(progress.degradation?.reason).toBe("workflow_task_failing");
    expect(progress.degradation?.ends_at).toBe(STUCK.ends_at);
    expect(Object.hasOwn(progress.degradation!, "failed_attempts")).toBe(false);
  });

  it.each([
    ["a missing version", { version: undefined }, "`version` is not a non-negative integer"],
    ["a negative version", { version: -1 }, "`version` is not a non-negative integer"],
    ["a fractional version", { version: 1.5 }, "`version` is not a non-negative integer"],
    ["a status that is not a string", { status: 3 }, "`status` is not a string"],
    ["no invocations list", { invocations: {} }, "`invocations` is not a list"],
    [
      "an invocation that is not an object",
      { invocations: [1] },
      "`invocations[0]` is not an object",
    ],
    [
      "an invocation without a path",
      { invocations: [{ ...MID_RUN.invocations[0], path: undefined }] },
      "`invocations[0].path` is not a string",
    ],
    [
      "an invocation whose start is not a string or null",
      { invocations: [{ ...MID_RUN.invocations[0], started_at: 0 }] },
      "`invocations[0].started_at` is not a string or null",
    ],
  ])("refuses a snapshot with %s as an answer it cannot read", async (_name, overrides, fault) => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...snapshot(), ...overrides }),
    );

    const error = await client.getRunProgress("run-1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).message).toBe(
      `API GET /v1/runs/run-1/progress answered 200 with a snapshot whose ${fault}`,
    );
    expect((error as ProblemError).problem).toMatchObject({ domain: "runtime", retry: "no" });
  });

  it("surfaces the platform's run-not-found 404 as ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("run.not_found", 404, { detail: "Run not found" }),
    );

    const error = await client.getRunProgress("run-1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).status).toBe(404);
  });

  it("maps a route-absent 404 to RunLifecycleUnavailableError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { detail: "Not Found" }));

    const error = await client.getRunProgress("run-1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunLifecycleUnavailableError);
    expect((error as Error).message).toContain("older than the progress route");
  });

  it("refuses a run id the URL would resolve before any request", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(client.getRunProgress("..")).rejects.toBeInstanceOf(RequestArgumentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("isFresherRunProgress", () => {
  it("takes anything read when nothing is held", () => {
    expect(isFresherRunProgress(snapshot(), undefined)).toBe(true);
  });

  it("takes the higher version, whatever the times", () => {
    const held = snapshot({ version: 5, assembled_at: "2026-10-12T09:31:00.000Z" });
    expect(isFresherRunProgress(snapshot({ version: 6 }), held)).toBe(true);
    expect(
      isFresherRunProgress(snapshot({ version: 4, assembled_at: "2026-10-12T10:00:00Z" }), held),
    ).toBe(false);
  });

  it("at the same version, takes the later assembly, and keeps the held one on a tie", () => {
    const held = snapshot({ version: 5, assembled_at: "2026-10-12T09:31:00.000Z" });
    expect(
      isFresherRunProgress(
        snapshot({ version: 5, assembled_at: "2026-10-12T09:31:00.001Z" }),
        held,
      ),
    ).toBe(true);
    expect(
      isFresherRunProgress(
        snapshot({ version: 5, assembled_at: "2026-10-12T09:30:59.999Z" }),
        held,
      ),
    ).toBe(false);
    expect(
      isFresherRunProgress(snapshot({ version: 5, assembled_at: "2026-10-12T09:31:00Z" }), held),
    ).toBe(false);
  });

  it("compares the assembly times as instants, microseconds and offsets included", () => {
    // As text, `06.870Z` sorts after `06.870123Z`.
    const held = snapshot({ assembled_at: "2026-10-12T09:30:06.870Z" });
    expect(
      isFresherRunProgress(snapshot({ assembled_at: "2026-10-12T09:30:06.870123Z" }), held),
    ).toBe(true);
    expect(
      isFresherRunProgress(held, snapshot({ assembled_at: "2026-10-12T09:30:06.870123Z" })),
    ).toBe(false);
    expect(
      isFresherRunProgress(snapshot({ assembled_at: "2026-10-12T11:30:07+02:00" }), held),
    ).toBe(true);
  });

  it("keeps the held one when the times cannot be compared", () => {
    const held = snapshot({ assembled_at: "2026-10-12T09:30:06.870Z" });
    expect(isFresherRunProgress(snapshot({ assembled_at: "yesterday" }), held)).toBe(false);
    expect(isFresherRunProgress(snapshot(), snapshot({ assembled_at: "yesterday" }))).toBe(false);
  });

  it.each(["succeeded", "failed", "canceled"] as const)(
    "never trades a snapshot of the run %s for one still going, whatever its version",
    (ended) => {
      const held = snapshot({ status: ended, version: 20, assembled_at: "2026-10-12T09:31:00Z" });
      for (const going of ["pending", "running"] as const) {
        const read = snapshot({ status: going, version: 26, assembled_at: "2026-10-12T09:32:00Z" });
        expect(isFresherRunProgress(read, held)).toBe(false);
        // And the other way round: the ended one wins even from a lower version.
        expect(isFresherRunProgress(held, read)).toBe(true);
      }
    },
  );

  it("takes a later snapshot of an ended run by version, then by assembly", () => {
    const held = snapshot({ status: "failed", version: 20, assembled_at: "2026-10-12T09:31:00Z" });
    expect(isFresherRunProgress(snapshot({ status: "failed", version: 21 }), held)).toBe(true);
    expect(isFresherRunProgress(snapshot({ status: "canceled", version: 19 }), held)).toBe(false);
    expect(
      isFresherRunProgress(
        snapshot({ status: "failed", version: 20, assembled_at: "2026-10-12T09:31:01Z" }),
        held,
      ),
    ).toBe(true);
  });

  it("is exported from the entry point", () => {
    expect(sdk.isFresherRunProgress).toBe(isFresherRunProgress);
  });
});

describe("PipelexApiClient.waitForResult onProgress", () => {
  it("reads no progress without onProgress", async () => {
    const client = makeClient();
    const { urls } = serve({ "/results": [running(), running(), completed()] });

    await client.waitForResult("run-1", { intervalMs: 0 });

    expect(urls).toEqual([RESULTS_URL, RESULTS_URL, RESULTS_URL]);
  });

  it("delivers each snapshot fresher than the last it delivered, and only those", async () => {
    const client = makeClient();
    const first = snapshot({ version: 1 });
    const same = snapshot({ version: 1 });
    const later = snapshot({ version: 3 });
    const lagging = snapshot({ version: 2, assembled_at: "2026-10-12T09:35:00Z" });
    const reassembled = snapshot({ version: 3, assembled_at: "2026-10-12T09:36:00Z" });
    const { urls } = serve({
      "/results": [running(), running(), running(), running(), running(), completed()],
      "/progress": [first, same, later, lagging, reassembled].map((s) => jsonResponse(200, s)),
    });
    const delivered: RunProgress[] = [];

    const result = await client.waitForResult("run-1", {
      intervalMs: 0,
      onProgress: (progress) => delivered.push(progress),
    });

    expect(result.main_stuff).toEqual({ ok: true });
    expect(delivered).toEqual([first, later, reassembled]);
    // One progress read per poll that found the run running, after its results read; none once
    // the results read finds the run ended.
    expect(urls).toEqual([
      ...Array.from({ length: 5 }, () => [RESULTS_URL, PROGRESS_URL]).flat(),
      RESULTS_URL,
    ]);
  });

  it("never trades a delivered snapshot of the ended run for one still going", async () => {
    const client = makeClient();
    const ended = snapshot({ status: "failed", version: 9, summary: "Failed at check_figures" });
    const stale = snapshot({ status: "running", version: 12 });
    serve({
      "/results": [running(), running(), completed()],
      "/progress": [jsonResponse(200, ended), jsonResponse(200, stale)],
    });
    const delivered: RunProgress[] = [];

    await client.waitForResult("run-1", {
      intervalMs: 0,
      onProgress: (progress) => delivered.push(progress),
    });

    expect(delivered).toEqual([ended]);
  });

  it("skips a poll whose progress read fails and never fails the wait", async () => {
    const client = makeClient();
    const later = snapshot({ version: 4 });
    serve({
      "/results": [running(), running(), running(), running(), completed()],
      "/progress": [
        jsonResponse(503, { code: "service_unavailable", detail: "Read it again later." }),
        new TypeError("fetch failed"),
        jsonResponse(200, { ...snapshot(), version: "four" }),
        jsonResponse(200, later),
      ],
    });
    const delivered: RunProgress[] = [];
    const polls: number[] = [];

    const result = await client.waitForResult("run-1", {
      intervalMs: 0,
      onProgress: (progress) => delivered.push(progress),
      onPoll: (info) => polls.push(info.attempt),
    });

    expect(result.main_stuff).toEqual({ ok: true });
    expect(delivered).toEqual([later]);
    expect(polls).toEqual([1, 2, 3, 4]);
  });

  it("stops reading progress once the server answers that it has no progress route", async () => {
    const client = makeClient();
    const { urls } = serve({
      "/results": [running(), running(), running(), completed()],
      "/progress": [jsonResponse(404, { detail: "Not Found" })],
    });
    const onProgress = vi.fn();

    await client.waitForResult("run-1", { intervalMs: 0, onProgress });

    expect(onProgress).not.toHaveBeenCalled();
    expect(urls.filter((url) => url === PROGRESS_URL)).toHaveLength(1);
  });

  it("ends the wait with the caller's abort during a progress read", async () => {
    const client = makeClient();
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === RESULTS_URL) return running();
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const onProgress = vi.fn();

    const error = await client
      .waitForResult("run-1", { intervalMs: 0, signal: controller.signal, onProgress })
      .catch((e: unknown) => e);

    expect((error as Error).name).toBe("AbortError");
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("propagates an exception onProgress throws", async () => {
    const client = makeClient();
    serve({ "/results": [running()], "/progress": [jsonResponse(200, snapshot())] });
    const failure = new Error("the caller's own bug");

    await expect(
      client.waitForResult("run-1", {
        intervalMs: 0,
        onProgress: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it("is honoured by startAndWaitForResult on the hosted path", async () => {
    const client = makeClient();
    serve({
      "/version": [
        jsonResponse(200, {
          protocol_version: "0.6.0",
          implementation: "pipelex-hosted",
          implementation_version: "0.9.0",
        }),
      ],
      "/start": [
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }),
      ],
      "/results": [running(), completed()],
      "/progress": [jsonResponse(200, MID_RUN)],
    });
    const delivered: RunProgress[] = [];

    await client.startAndWaitForResult(
      { pipe_code: "p" },
      { intervalMs: 0, onProgress: (progress) => delivered.push(progress) },
    );

    expect(delivered).toEqual([MID_RUN]);
  });
});

describe("the run record's per-pipe statuses", () => {
  it("are gone from PipelineRun: progress is the snapshot's", () => {
    expectTypeOf<PipelineRun>().not.toHaveProperty("pipe_statuses");
    expectTypeOf<RunProgress["invocations"][number]["status"]>().toEqualTypeOf<
      "scheduled" | "running" | "succeeded" | "failed" | "skipped" | "canceled"
    >();
  });
});
