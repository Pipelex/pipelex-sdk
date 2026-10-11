/**
 * `runMayHaveStarted`: whether a failed request that may create a run may still have started one.
 *
 * The status rows both SDKs share are driven by `error-verdicts.test.ts` through the case file's
 * `run_start` member. Here are the rest, which the two languages cannot share: the transport
 * failures, read off what fetch threw; the composite, whose start carries the reading and whose
 * wait does not; a route that starts nothing; and the structural reader.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError as MthdsApiResponseError } from "mthds/errors";

import { PipelexApiClient } from "../src/client.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  PipelineExecuteTimeoutError,
  RunFailedError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
  UploadTransportError,
  runMayHaveStartedOf,
} from "../src/errors.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A system error as Node raises it: its code, its number and the call that failed. */
function systemError(message: string, code: string, errno: number, syscall: string): Error {
  return Object.assign(new Error(message), { code, errno, syscall });
}

/** What a failure costs, once caught: whatever the promise rejected with. */
async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => expect.fail("expected the call to throw"),
    (thrown: unknown) => thrown,
  );
}

const HOSTED_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-hosted",
  implementation_version: "0.9.0",
};

const BARE_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-api",
  implementation_version: "1.2.3",
};

/** fetch answering each request by its method and path, a route's answers taken in order. */
function routeFetch(routes: Record<string, Array<() => Response | Promise<Response>>>): void {
  const calls = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const call = calls.get(key) ?? 0;
    calls.set(key, call + 1);
    const answer = routes[key]?.[call];
    if (answer === undefined) return Promise.resolve(jsonResponse(599, { detail: key }));
    return Promise.resolve().then(answer);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a transport failure of a start", () => {
  // Each shape is what Node's fetch throws: its own `TypeError`, undici's failure as its cause.
  it.each([
    ["a refused connection", systemError("connect ECONNREFUSED", "ECONNREFUSED", -61, "connect")],
    [
      "an unknown host",
      systemError("getaddrinfo ENOTFOUND api.test", "ENOTFOUND", -3008, "getaddrinfo"),
    ],
    [
      "no route to the host while connecting",
      systemError("connect EHOSTUNREACH", "EHOSTUNREACH", -65, "connect"),
    ],
    [
      "undici's connect time limit",
      Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    ],
    [
      "a refused certificate",
      Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
    ],
    [
      "every address refused",
      new AggregateError(
        [
          systemError("connect ECONNREFUSED ::1:80", "ECONNREFUSED", -61, "connect"),
          systemError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", -61, "connect"),
        ],
        "",
      ),
    ],
  ])("proves nothing was sent when it is %s, and stays retryable", async (_, failure) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: failure }),
    );

    const err = await failureOf(() => makeClient().start({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect((err as ApiUnreachableError).runMayHaveStarted).toBe(false);
    expect((err as ApiUnreachableError).retryable).toBe(true);
  });

  it.each([
    ["a reset", systemError("read ECONNRESET", "ECONNRESET", -54, "read")],
    [
      "no route to the host once connected",
      systemError("read EHOSTUNREACH", "EHOSTUNREACH", -65, "read"),
    ],
    [
      "a connection the other side closed",
      Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    ],
    ["a failure fetch names no cause of", undefined],
  ])("may have started a run after %s, and is not retryable", async (_, failure) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: failure }),
    );

    const err = await failureOf(() => makeClient().start({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect((err as ApiUnreachableError).runMayHaveStarted).toBe(true);
    expect((err as ApiUnreachableError).retryable).toBe(false);
  });

  it("may have started a run when the SDK's own time limit ran out", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("Request timed out.", "TimeoutError"),
    );

    const err = await failureOf(() => makeClient().start({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(ApiUnreachableError);
    const unreachable = err as ApiUnreachableError;
    expect(unreachable.code).toBe("ABORT_TIMEOUT");
    expect(unreachable.runMayHaveStarted).toBe(true);
    expect(unreachable.retryable).toBe(false);
    expect(unreachable.errorDomain).toBe("runtime");
  });

  it("may have started a run when the accepted answer's body could not be decoded", async () => {
    const failure = new TypeError("terminated", {
      cause: Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR" }),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new ReadableStream({ start: (controller) => controller.error(failure) }), {
        status: 202,
      }),
    );

    const err = await failureOf(() => makeClient().start({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect((err as ApiUnreachableError).runMayHaveStarted).toBe(true);
    expect((err as ApiUnreachableError).retryable).toBe(false);
  });

  it("is read the same on a blocking execute", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: systemError("read ECONNRESET", "ECONNRESET", -54, "read"),
        }),
      )
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: systemError("connect ECONNREFUSED", "ECONNREFUSED", -61, "connect"),
        }),
      );

    const reset = await failureOf(() => makeClient().execute({ pipe_code: "p" }));
    const refused = await failureOf(() => makeClient().execute({ pipe_code: "p" }));

    expect(runMayHaveStartedOf(reset)).toBe(true);
    expect(runMayHaveStartedOf(refused)).toBe(false);
  });
});

describe("a blocking execute", () => {
  it("cut off by the gateway may have started a run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(503, { detail: "cut off" }));
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(31_000);

    const err = await failureOf(() => makeClient().execute({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(PipelineExecuteTimeoutError);
    expect((err as PipelineExecuteTimeoutError).runMayHaveStarted).toBe(true);
    expect((err as PipelineExecuteTimeoutError).retryable).toBe(false);
  });

  it("degraded to a 202 names its run, so no run is lost", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(202, { pipeline_run_id: "run-1" }),
    );

    const err = await failureOf(() => makeClient().execute({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(RunStillRunningError);
    expect(runMayHaveStartedOf(err)).toBe(false);
  });
});

describe("startAndWaitForResult", () => {
  it("carries the reading on an error from its start", async () => {
    routeFetch({
      "GET /v1/version": [() => jsonResponse(200, HOSTED_VERSION)],
      "POST /v1/start": [() => jsonResponse(502, { detail: "bad gateway" })],
    });
    const onStarted = vi.fn();

    const err = await failureOf(() =>
      makeClient().startAndWaitForResult({ pipe_code: "p" }, { onStarted }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    expect(runMayHaveStartedOf(err)).toBe(true);
    expect((err as ApiResponseError).retryable).toBe(false);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("does not carry it on an error from its wait, once the run is named", async () => {
    routeFetch({
      "GET /v1/version": [() => jsonResponse(200, HOSTED_VERSION)],
      "POST /v1/start": [() => jsonResponse(202, { pipeline_run_id: "run-1" })],
      "GET /v1/runs/run-1/results": [() => jsonResponse(500, { detail: "the run store failed" })],
    });
    const onStarted = vi.fn();

    const err = await failureOf(() =>
      makeClient().startAndWaitForResult({ pipe_code: "p" }, { onStarted, intervalMs: 1 }),
    );

    expect(onStarted).toHaveBeenCalledOnce();
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(runMayHaveStartedOf(err)).toBe(false);
    // Waiting again on the named run can succeed.
    expect((err as ApiResponseError).retryable).toBe(true);
  });

  it("does not carry it on a failed run, which names its run", async () => {
    routeFetch({
      "GET /v1/version": [() => jsonResponse(200, HOSTED_VERSION)],
      "POST /v1/start": [() => jsonResponse(202, { pipeline_run_id: "run-1" })],
      "GET /v1/runs/run-1/results": [
        () =>
          jsonResponse(409, {
            detail: "Run finished with status FAILED: capacity.",
            run_status: "FAILED",
            error: {
              error_type: "InferenceCapacityError",
              error_domain: "runtime",
              retryable: true,
            },
          }),
      ],
    });

    const err = await failureOf(() => makeClient().startAndWaitForResult({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(RunFailedError);
    expect(runMayHaveStartedOf(err)).toBe(false);
    expect((err as RunFailedError).retryable).toBe(true);
  });

  it("carries the reading on an error from the blocking execute it falls back to", async () => {
    routeFetch({
      "GET /v1/version": [() => jsonResponse(200, BARE_VERSION)],
      "POST /v1/execute": [() => jsonResponse(500, { detail: "the runner failed" })],
    });

    const err = await failureOf(() => makeClient().startAndWaitForResult({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect(runMayHaveStartedOf(err)).toBe(true);
  });

  it("carries it on a fallback after a start the runner does not serve, and not on that start", async () => {
    routeFetch({
      "GET /v1/version": [() => jsonResponse(200, { protocol_version: "0.6.0" })],
      "POST /v1/start": [() => jsonResponse(404, { detail: "Not Found" })],
      "POST /v1/execute": [() => jsonResponse(504, { detail: "gateway timeout" })],
    });

    const err = await failureOf(() => makeClient().startAndWaitForResult({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(504);
    expect(runMayHaveStartedOf(err)).toBe(true);
  });

  it("starts nothing when the version handshake gets no answer", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", {
        cause: systemError("read ECONNRESET", "ECONNRESET", -54, "read"),
      }),
    );

    const err = await failureOf(() => makeClient().startAndWaitForResult({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect(runMayHaveStartedOf(err)).toBe(false);
  });
});

describe("a request that starts nothing", () => {
  it.each([
    ["getRunStatus", (client: PipelexApiClient) => client.getRunStatus("run-1")],
    ["getMe", (client: PipelexApiClient) => client.getMe()],
    ["validate", (client: PipelexApiClient) => client.validate(["domain = 'x'"])],
  ])("%s answered a 500 is false, and keeps the fallback's retryable", async (_, call) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(500, { detail: "boom" }));

    const err = await failureOf(() => call(makeClient()));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect(runMayHaveStartedOf(err)).toBe(false);
    expect((err as ApiResponseError).retryable).toBe(true);
  });

  it("uploadFile answered a 500 is false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(500, { detail: "boom" }));

    const err = await failureOf(() =>
      makeClient().uploadFile(new Uint8Array([1, 2, 3]), { filename: "a.pdf" }),
    );

    expect(err).toBeInstanceOf(UploadTransportError);
    expect(runMayHaveStartedOf(err)).toBe(false);
    expect(runMayHaveStartedOf((err as UploadTransportError).cause)).toBe(false);
  });

  it("a status read that gets no answer after a reset is false, and stays retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", {
        cause: systemError("read ECONNRESET", "ECONNRESET", -54, "read"),
      }),
    );

    const err = await failureOf(() => makeClient().getRunStatus("run-1"));

    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect(runMayHaveStartedOf(err)).toBe(false);
    expect((err as ApiUnreachableError).retryable).toBe(true);
  });

  it("a start a bare runner does not serve is a RunLifecycleUnavailableError, which started nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { detail: "Not Found" }));

    const err = await failureOf(() => makeClient().start({ pipe_code: "p" }));

    expect(err).toBeInstanceOf(RunLifecycleUnavailableError);
    expect(runMayHaveStartedOf(err)).toBe(false);
  });
});

describe("the errors built by hand", () => {
  it("ApiUnreachableError reads its cause only when told the request may create a run", () => {
    const reset = new TypeError("fetch failed", {
      cause: systemError("read ECONNRESET", "ECONNRESET", -54, "read"),
    });

    expect(
      new ApiUnreachableError("x", BASE_URL, "ECONNRESET", { cause: reset }).runMayHaveStarted,
    ).toBe(false);
    const flagged = new ApiUnreachableError("x", BASE_URL, "ECONNRESET", {
      cause: reset,
      mayStartRun: true,
    });
    expect(flagged.runMayHaveStarted).toBe(true);
    expect(flagged.retryable).toBe(false);
    // With no cause to read, nothing proves the request never left.
    expect(
      new ApiUnreachableError("x", BASE_URL, undefined, { mayStartRun: true }).runMayHaveStarted,
    ).toBe(true);
  });

  it("ApiResponseError keeps the server's members on its problem document", () => {
    const err = new ApiResponseError(
      "refused",
      BASE_URL,
      503,
      "Service Unavailable",
      '{"error_domain":"runtime","retryable":true}',
      undefined,
      undefined,
      undefined,
      "service_unavailable",
      {
        problem: { errorDomain: "runtime", retryable: true },
        problemDocument: { error_domain: "runtime", retryable: true },
        mayStartRun: true,
      },
    );

    expect(err.runMayHaveStarted).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.problemDocument?.retryable).toBe(true);
  });
});

describe("runMayHaveStartedOf", () => {
  it("reads the member off any Error carrying it as true, such as one from another copy of the SDK", () => {
    const foreign = Object.assign(new Error("from another copy"), { runMayHaveStarted: true });

    expect(runMayHaveStartedOf(foreign)).toBe(true);
    expect(runMayHaveStartedOf(Object.assign(new Error("no"), { runMayHaveStarted: false }))).toBe(
      false,
    );
    expect(
      runMayHaveStartedOf(Object.assign(new Error("mistyped"), { runMayHaveStarted: "yes" })),
    ).toBe(false);
  });

  it("is false for an mthds ApiResponseError, a plain Error and a value that is not an Error", () => {
    const mthds = new MthdsApiResponseError(
      "refused",
      BASE_URL,
      500,
      "",
      "{}",
      undefined,
      "refused",
      undefined,
    );

    expect(runMayHaveStartedOf(mthds)).toBe(false);
    expect(runMayHaveStartedOf(new Error("plain"))).toBe(false);
    expect(runMayHaveStartedOf({ runMayHaveStarted: true })).toBe(false);
    expect(runMayHaveStartedOf(undefined)).toBe(false);
    expect(runMayHaveStartedOf("boom")).toBe(false);
  });
});
