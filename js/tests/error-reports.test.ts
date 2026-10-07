/**
 * A failed run's stored report and a problem document's members, carried whole.
 *
 * The bodies under `fixtures/problems/` are recorded rather than written by hand. The code that
 * produced them ran in-process: pipelex-server's `platform` package behind a FastAPI
 * `TestClient`, and `pipelex`'s own error classes. Only the fault itself was chosen, a model the
 * inference gateway refuses.
 *
 * - `results-409-failed.json` and `results-409-cancelled.json` are what the platform's error
 *   handler rendered for `RunFinishedWithoutResultError`. The first carries the VERBOSE report
 *   `pipelex` builds for an `LLMCompletionError` (with its next step and provider metadata),
 *   read back the way the run store hands it over, every number a `Decimal` — which is why its
 *   `provider_metadata.status_code` and `retry_after_seconds` arrive as strings.
 * - `runner-500-model-unavailable.json` is `ErrorReport.to_problem_document` for the same fault,
 *   the body a runner answers `/v1/execute` with.
 * - `platform-422-field-errors.json` is the platform's request-validation `422`, with `errors[]`.
 */

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  ProblemDetails as MthdsProblemDetails,
  UserAction as MthdsUserAction,
} from "mthds/errors";

import { PipelexApiClient } from "../src/client.js";
import { readRunErrorReport } from "../src/error-models.js";
import type { ProblemDetails, RunErrorReport, UserAction } from "../src/error-models.js";
import { ApiResponseError, RunFailedError } from "../src/errors.js";
import type { RunRead, RunResultState } from "../src/runs.js";
import type { RunHistoryItem } from "../src/product-models.js";

const BASE_URL = "http://localhost:8081";
const FIXTURES = new URL("./fixtures/problems/", import.meta.url);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<string, unknown>;
}

const FAILED_409 = fixture("results-409-failed.json");
const CANCELLED_409 = fixture("results-409-cancelled.json");
const RUNNER_500 = fixture("runner-500-model-unavailable.json");
const PLATFORM_422 = fixture("platform-422-field-errors.json");

const HOSTED_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-hosted",
  implementation_version: "0.9.0",
};

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function problemResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail("expected the call to throw"),
    (err: unknown) => err,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the results read's 409 — a failed run's report", () => {
  it("yields a failed arm carrying the whole report, typed, and the status from the body", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(409, FAILED_409, { "X-Request-ID": String(FAILED_409.request_id) }),
    );

    const state = await client.getRunResult("run-1");

    expect(state.state).toBe("failed");
    if (state.state !== "failed") return;
    expect(state.pipeline_run_id).toBe("run-1");
    expect(state.status).toBe("FAILED");
    expect(state.message).toBe(FAILED_409.detail);
    // Every field of the stored report, exactly as the platform served it.
    expect(state.error).toEqual(FAILED_409.error);
    expect(state.error?.error_domain).toBe("config");
    expect(state.error?.retryable).toBe(false);
    expect(state.error?.user_action).toEqual({
      kind: "change_model",
      detail:
        "This model is not enabled on the inference gateway; choose another model for the pipe.",
    });
    expect(state.error?.type_uri).toBe(
      "https://docs.pipelex.com/latest/errors/llm-completion-error/",
    );
    expect(state.error?.model).toBe("claude-4.8-opus");
    // The run store hands its numbers back as decimals, which the platform serves as strings.
    expect(state.error?.provider_metadata?.status_code).toBe("412");
    expectTypeOf<
      Extract<RunResultState, { state: "failed" }>["error"]
    >().toEqualTypeOf<RunErrorReport | null>();
  });

  it("yields a report-less failure with the run's own status when `error` is null", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(409, CANCELLED_409));

    const state = await client.getRunResult("run-1");

    expect(state).toEqual({
      state: "failed",
      pipeline_run_id: "run-1",
      status: "CANCELLED",
      message: "Run finished with status CANCELLED; no result available",
      error: null,
    });
  });

  it("reads the status from `run_status` first, and from the sentence only without it", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        problemResponse(409, {
          ...CANCELLED_409,
          detail: "Run finished with status FAILED; no result available",
          run_status: "TIMED_OUT",
        }),
      )
      // What a platform that predates `run_status` answers for a terminated run.
      .mockResolvedValueOnce(
        problemResponse(409, {
          type: "https://pipelex.com/errors/conflict",
          title: "Conflict",
          status: 409,
          code: "conflict",
          detail: "Run finished with status TERMINATED; no result available",
          errors: [],
        }),
      )
      // The 409 the route answers for a stored result it refuses to read names no status.
      .mockResolvedValueOnce(
        problemResponse(409, {
          type: "https://pipelex.com/errors/conflict",
          code: "conflict",
          detail: "Conflict",
        }),
      );

    const fromMember = await client.getRunResult("run-1");
    const fromSentence = await client.getRunResult("run-2");
    const fromNeither = await client.getRunResult("run-3");

    expect(fromMember).toMatchObject({ state: "failed", status: "TIMED_OUT", error: null });
    expect(fromSentence).toMatchObject({ state: "failed", status: "TERMINATED", error: null });
    expect(fromNeither).toMatchObject({ state: "failed", status: "FAILED", error: null });
  });

  it("reads an unknown status or a non-object report as absent", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(409, {
        ...FAILED_409,
        detail: "Run finished with status EXPLODED",
        run_status: "EXPLODED",
        error: "not a report",
      }),
    );

    const state = await client.getRunResult("run-1");

    expect(state).toMatchObject({ state: "failed", status: "FAILED", error: null });
  });

  it("makes waitForResult throw a RunFailedError carrying the whole report", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(emptyResponse(202, { "Retry-After": "0" }))
      .mockResolvedValueOnce(problemResponse(409, FAILED_409));

    const err = await caught(client.waitForResult("run-1", { intervalMs: 0 }));

    expect(err).toBeInstanceOf(RunFailedError);
    const failure = err as RunFailedError;
    expect(failure.runId).toBe("run-1");
    expect(failure.status).toBe("FAILED");
    expect(failure.message).toBe(FAILED_409.detail);
    expect(failure.error).toEqual(FAILED_409.error);
    expectTypeOf(failure.error).toEqualTypeOf<RunErrorReport | null>();
  });

  it("makes waitForResult throw a report-less RunFailedError when `error` is null", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(409, CANCELLED_409));

    const err = await caught(client.waitForResult("run-1", { intervalMs: 0 }));

    expect(err).toBeInstanceOf(RunFailedError);
    expect((err as RunFailedError).status).toBe("CANCELLED");
    expect((err as RunFailedError).error).toBeNull();
  });

  it("makes startAndWaitForResult throw the report of the run it started", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(problemResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        problemResponse(202, { pipeline_run_id: "run-9", state: "STARTED", created_at: "t0" }),
      )
      .mockResolvedValueOnce(problemResponse(409, FAILED_409));

    const err = await caught(
      client.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] }, { intervalMs: 0 }),
    );

    expect(err).toBeInstanceOf(RunFailedError);
    expect((err as RunFailedError).runId).toBe("run-9");
    expect((err as RunFailedError).error).toEqual(FAILED_409.error);
  });
});

describe("the status read — `RunRead.error`", () => {
  it("exposes the stored report typed on the run", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(200, {
        pipeline_run_id: "run-1",
        status: "FAILED",
        created_at: "2026-09-26T10:00:00+00:00",
        finished_at: "2026-09-26T10:01:00+00:00",
        degraded: false,
        error: FAILED_409.error,
      }),
    );

    const run = await client.getRunStatus("run-1");

    expect(run.error).toEqual(FAILED_409.error);
    expect(run.error?.message).toContain("Pipe 'summarize'");
    expectTypeOf<RunRead["error"]>().toEqualTypeOf<RunErrorReport | null | undefined>();
  });
});

describe("ApiResponseError — the problem document's members", () => {
  it("exposes each member a platform problem carries, `errors[]` included", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(422, PLATFORM_422));

    const err = await caught(client.createPipelexApiKey({ label: "" }));

    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.status).toBe(422);
    expect(e.code).toBe("validation_failed");
    expect(e.type).toBe("https://pipelex.com/errors/validation_failed");
    expect(e.title).toBe("Validation failed");
    expect(e.instance).toBe("urn:pipelex:request:a9a249b93c024bf08ac9a5fd0704ea92");
    expect(e.requestId).toBe("a9a249b93c024bf08ac9a5fd0704ea92");
    expect(e.serverMessage).toBe(PLATFORM_422.detail);
    expect(e.errors).toEqual([
      {
        field: "label",
        code: "string_too_short",
        detail: "String should have at least 1 character",
      },
    ]);
    // The platform does not classify its own refusals yet, so the verdict is the fallback's
    // reading of a 422; the document still shows the server sent neither member.
    expect(e.errorDomain).toBe("input");
    expect(e.retryable).toBe(false);
    expect(e.problemDocument).toEqual(PLATFORM_422);
    expect(e.problemDocument).not.toHaveProperty("error_domain");
    expect(e.problemDocument).not.toHaveProperty("retryable");
  });

  it("exposes each member a runner's problem carries", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(500, RUNNER_500));

    const err = await caught(client.execute({ pipe_code: "p", mthds_contents: ["x"] }));

    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.type).toBe("https://docs.pipelex.com/latest/errors/llm-completion-error/");
    expect(e.title).toBe("LLM completion");
    expect(e.instance).toBe("/v1/execute");
    expect(e.requestId).toBe("9f2c1ab3-5d1e-4c2a-9a41-0c7f3e2b8d10");
    expect(e.errorType).toBe("LLMCompletionError");
    expect(e.errorDomain).toBe("config");
    expect(e.errorCategory).toBe("configuration");
    expect(e.retryable).toBe(false);
    expect(e.userAction).toEqual({
      kind: "change_model",
      detail:
        "This model is not enabled on the inference gateway; choose another model for the pipe.",
    });
    expect(e.model).toBe("claude-4.8-opus");
    expect(e.provider).toBe("pipelex_gateway");
    // A runner renders the provider's numbers as numbers.
    expect(e.providerMetadata?.status_code).toBe(412);
    expect(e.providerMetadata).toEqual(RUNNER_500.provider_metadata);
    expect(e.code).toBeUndefined();
    expect(e.errors).toBeUndefined();
    // A member this SDK does not name stays reachable on the decoded document.
    expect(e.problemDocument?.status).toBe(500);
  });

  it("reads the request id from the X-Request-ID header when the body carries none", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "X-Request-ID": " gw-7f3a " },
        }),
      )
      .mockResolvedValueOnce(
        problemResponse(500, RUNNER_500, { "X-Request-ID": "from-the-header" }),
      );

    const headerOnly = (await caught(client.getMe())) as ApiResponseError;
    const both = (await caught(client.getMe())) as ApiResponseError;

    expect(headerOnly.requestId).toBe("gw-7f3a");
    expect(headerOnly.problemDocument).toBeUndefined();
    // The body's own id wins over the header's.
    expect(both.requestId).toBe(RUNNER_500.request_id);
  });

  it("reads a member of the wrong type as absent, and still yields the message", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, {
        type: 42,
        title: "",
        detail: "Input 'document' is missing.",
        request_id: ["r"],
        error_domain: "",
        error_category: 3,
        retryable: "no",
        user_action: { kind: "change_input" },
        model: null,
        provider_metadata: ["openai"],
        migration: "stale",
        errors: [{ field: "document", code: "missing" }, "not an item", null],
      }),
    );

    const e = (await caught(client.getMe())) as ApiResponseError;

    expect(e.serverMessage).toBe("Input 'document' is missing.");
    expect(e.type).toBeUndefined();
    expect(e.title).toBeUndefined();
    expect(e.requestId).toBeUndefined();
    // A verdict member of the wrong type is not taken: the fallback's reading of a 422 is.
    expect(e.errorDomain).toBe("input");
    expect(e.errorCategory).toBeUndefined();
    expect(e.retryable).toBe(false);
    expect(e.userAction).toBeUndefined();
    expect(e.model).toBeUndefined();
    expect(e.providerMetadata).toBeUndefined();
    expect(e.migration).toBeUndefined();
    expect(e.errors).toEqual([{ field: "document", code: "missing" }]);
  });

  it("keeps the problem members when constructed directly", () => {
    const e = new ApiResponseError(
      "boom",
      BASE_URL,
      409,
      "Conflict",
      "{}",
      undefined,
      "boom",
      undefined,
      "conflict",
      {
        cause: new Error("root"),
        problem: { type: "https://pipelex.com/errors/conflict", requestId: "r-1", retryable: true },
        problemDocument: { code: "conflict" },
      },
    );

    expect(e.type).toBe("https://pipelex.com/errors/conflict");
    expect(e.requestId).toBe("r-1");
    expect(e.retryable).toBe(true);
    expect(e.problemDocument).toEqual({ code: "conflict" });
    expect((e.cause as Error).message).toBe("root");
  });
});

describe("the vocabulary is the standard client's", () => {
  it("declares the problem members under mthds's names and types", () => {
    // `@pipelex/sdk` depends on `mthds` only through `mthds/protocol`, so these are declared
    // here rather than imported; this pins them to the standard client's declarations, so a
    // consumer reads one vocabulary whichever client raised the error.
    expectTypeOf<UserAction>().toEqualTypeOf<MthdsUserAction>();
    expectTypeOf<ProblemDetails>().toExtend<MthdsProblemDetails>();
    expectTypeOf<
      Pick<ProblemDetails, keyof MthdsProblemDetails>
    >().toEqualTypeOf<MthdsProblemDetails>();
  });
});

// ── A stored report is checked field by field ────────────────────────

/**
 * A report with a field of the wrong type in each kind the check knows: a string field, a
 * boolean, `user_action` without a `detail`, `provider_metadata` with a numeric `message`,
 * `validation_errors` holding a non-object, and a `migration` with a mistyped flag and a stray
 * plan — beside fields that fit, `null`s, an empty string and members the SDK does not name.
 */
const MALFORMED_REPORT = {
  error_type: "LLMCompletionError",
  message: 42,
  title: "",
  type_uri: null,
  error_domain: "config",
  error_category: ["configuration"],
  retryable: "no",
  caller_facing_message: true,
  user_action: { kind: "change_model" },
  model: "claude-4.8-opus",
  provider: 7,
  provider_metadata: {
    provider: "openai",
    message: 412,
    status_code: "412",
    retry_after_seconds: 1.5,
    request_id: ["req"],
    gateway_region: "eu-west-1",
  },
  migration: {
    remedy: "pipelex-agent migrate",
    would_write: "yes",
    needs_attention: false,
    plans: [{ file: "backends.toml" }, "not a plan", null],
  },
  validation_errors: [
    {
      category: "dry_run",
      message: "Pipe 'summarize' failed its dry run.",
      pipe_code: "summarize",
    },
    "not an item",
    { category: "dry_run" },
    null,
  ],
  runner_trace_id: "tr-1",
};

/** What the check keeps of it: each misfit read as absent, the rest and the extensions kept. */
const CHECKED_REPORT = {
  error_type: "LLMCompletionError",
  title: "",
  type_uri: null,
  error_domain: "config",
  caller_facing_message: true,
  model: "claude-4.8-opus",
  provider_metadata: {
    provider: "openai",
    status_code: "412",
    retry_after_seconds: 1.5,
    gateway_region: "eu-west-1",
  },
  migration: {
    remedy: "pipelex-agent migrate",
    needs_attention: false,
    plans: [{ file: "backends.toml" }],
  },
  validation_errors: [
    {
      category: "dry_run",
      message: "Pipe 'summarize' failed its dry run.",
      pipe_code: "summarize",
    },
  ],
  runner_trace_id: "tr-1",
};

function failedRun(error?: unknown): Record<string, unknown> {
  const run: Record<string, unknown> = {
    pipeline_run_id: "run-1",
    status: "FAILED",
    created_at: "2026-09-26T10:00:00+00:00",
    finished_at: "2026-09-26T10:01:00+00:00",
    pipe_code: "summarize",
  };
  if (error !== undefined) run.error = error;
  return run;
}

function failed409(error: unknown): Record<string, unknown> {
  return {
    ...CANCELLED_409,
    detail: "Run finished with status FAILED: boom",
    run_status: "FAILED",
    error,
  };
}

/**
 * Each read that hands a report back, given the run record (or the `409`'s `error` member) the
 * server answers with, and returning the report the caller gets — `undefined` when the record
 * carries no `error` key at all.
 */
const READS: [string, (error?: unknown) => Promise<{ present: boolean; report: unknown }>][] = [
  [
    "getRunResult's failed arm",
    async (error) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(409, failed409(error ?? null)),
      );
      const state = await makeClient().getRunResult("run-1");
      if (state.state !== "failed") return expect.fail("expected the failed arm");
      return { present: true, report: state.error };
    },
  ],
  [
    "getRunStatus",
    async (error) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(200, { ...failedRun(error), degraded: false }),
      );
      const run = await makeClient().getRunStatus("run-1");
      return { present: Object.hasOwn(run, "error"), report: run.error };
    },
  ],
  [
    "listRuns",
    async (error) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(200, { items: [failedRun(error)], next_cursor: null }),
      );
      const page = await makeClient().listRuns("mt_1");
      const row = page.items[0]!;
      return { present: Object.hasOwn(row, "error"), report: row.error };
    },
  ],
  [
    "iterateRuns",
    async (error) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(200, { items: [failedRun(error)], next_cursor: null }),
      );
      const rows: RunHistoryItem[] = [];
      for await (const run of makeClient().iterateRuns("mt_1")) rows.push(run);
      const row = rows[0]!;
      return { present: Object.hasOwn(row, "error"), report: row.error };
    },
  ],
  [
    "getRunDetail",
    async (error) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(200, { ...failedRun(error), method_id: "mt_1", mthds_contents: ["x"] }),
      );
      const detail = await makeClient().getRunDetail("run-1");
      return { present: Object.hasOwn(detail, "error"), report: detail.error };
    },
  ],
];

describe("a stored report is checked field by field on every read", () => {
  describe.each(READS)("%s", (_, read) => {
    it("reads each misfit field as absent and keeps the rest and its extension members", async () => {
      const { report } = await read(MALFORMED_REPORT);

      expect(report).toEqual(CHECKED_REPORT);
    });

    it("keeps a report that fits whole", async () => {
      const { report } = await read(FAILED_409.error);

      expect(report).toEqual(FAILED_409.error);
    });

    it("reads a report that is not an object as null", async () => {
      expect((await read("not a report")).report).toBeNull();
      expect((await read(["not", "a", "report"])).report).toBeNull();
      expect((await read(42)).report).toBeNull();
      expect((await read(null)).report).toBeNull();
    });
  });

  it.each(READS.filter(([name]) => name !== "getRunResult's failed arm"))(
    "%s leaves an absent error key absent",
    async (_, read) => {
      const { present, report } = await read(undefined);

      expect(present).toBe(false);
      expect(report).toBeUndefined();
    },
  );
});

describe("readRunErrorReport", () => {
  it("keeps an empty string, null and a user_action whole, extra members included", () => {
    const report = readRunErrorReport({
      message: "",
      title: null,
      retryable: null,
      user_action: { kind: "unknown", detail: "", hint: "kept" },
    });

    expect(report).toEqual({
      message: "",
      title: null,
      retryable: null,
      user_action: { kind: "unknown", detail: "", hint: "kept" },
    });
  });

  it("drops a nested member that is not an object, and plans or items that are not arrays", () => {
    const report = readRunErrorReport({
      user_action: "change the model",
      provider_metadata: ["openai"],
      migration: { plans: "all of them", remedy: 3 },
      validation_errors: { category: "dry_run", message: "not a list" },
    });

    expect(report).toEqual({ migration: {} });
  });

  it("does not change the value it reads", () => {
    const sent = structuredClone(MALFORMED_REPORT);

    readRunErrorReport(sent);

    expect(sent).toEqual(MALFORMED_REPORT);
  });
});

describe("RunFailedError's verdict follows the run's report", () => {
  const cases: [string, unknown, { errorDomain: string; retryable: boolean }][] = [
    [
      "a report saying retryable",
      { error_domain: "runtime", retryable: true },
      { errorDomain: "runtime", retryable: true },
    ],
    [
      "a report saying not retryable",
      { error_domain: "config", retryable: false },
      { errorDomain: "config", retryable: false },
    ],
    [
      "a report saying nothing about retrying",
      { error_domain: "input" },
      { errorDomain: "input", retryable: false },
    ],
    ["no report", null, { errorDomain: "runtime", retryable: false }],
  ];

  it.each(cases)("%s", async (_, report, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(409, failed409(report)));

    const err = await caught(makeClient().waitForResult("run-1", { intervalMs: 0 }));

    expect(err).toBeInstanceOf(RunFailedError);
    const failure = err as RunFailedError;
    expect(failure.error).toEqual(report);
    expect({ errorDomain: failure.errorDomain, retryable: failure.retryable }).toEqual(expected);
  });

  it("carries the checked report, and a mistyped retryable reads as not retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(409, failed409(MALFORMED_REPORT)),
    );

    const err = (await caught(
      makeClient().waitForResult("run-1", { intervalMs: 0 }),
    )) as RunFailedError;

    expect(err.error).toEqual(CHECKED_REPORT);
    expect(err.errorDomain).toBe("config");
    expect(err.retryable).toBe(false);
  });
});
