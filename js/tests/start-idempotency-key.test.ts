/**
 * The idempotency key of a run start: `start` and `startAndWaitForResult` send
 * `options.idempotencyKey` as the `Idempotency-Key` header of `POST /v1/start` and send none
 * without it, keep it and the body identical across a caller's retry, refuse a malformed key
 * before anything is sent, and read the hosted API's refusals of a key by their code. The Python
 * SDK holds the same request to the same tests in `tests/unit/test_client_start_idempotency_key.py`.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import type { PipelexStartOptions } from "../src/client.js";
import { ApiResponseError, ApiUnreachableError, RequestArgumentError } from "../src/errors.js";
import type { IdempotencyErrorCode } from "../src/errors.js";
import { problemResponse } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const KEY = "5f0c6a52-2d3e-4c8b-9a51-7e1f0b6c2d44";
const HOSTED_VERSION = { protocol_version: "0.6.0", implementation: "pipelex-hosted" };
const BARE_VERSION = { protocol_version: "0.6.0", implementation: "pipelex-api" };
const ACK = { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" };

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

/** A completed blocking-execute answer, for a bare runner's path. */
function executeBody(runId: string): Record<string, unknown> {
  return {
    pipeline_run_id: runId,
    created_at: "t0",
    state: "COMPLETED",
    main_stuff_name: "result",
    pipe_output: {
      working_memory: {
        root: { result: { concept: "native.Text", content: { text: "hello" } } },
        aliases: { main_stuff: "result" },
      },
      pipeline_run_id: runId,
    },
  };
}

/** The request the client sent on the fetch spy's call at `index`. */
function sentRequest(
  fetchSpy: { mock: { calls: unknown[][] } },
  index: number,
): { url: string; method: string; headers: Record<string, string>; body: string | undefined } {
  const [url, init] = fetchSpy.mock.calls[index] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    headers: init.headers as Record<string, string>,
    body: init.body as string | undefined,
  };
}

/** What a call rejected with. */
async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => expect.fail("expected the call to throw"),
    (thrown: unknown) => thrown,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelexApiClient.start — the idempotency key", () => {
  it("sends the key as the Idempotency-Key header of POST /v1/start, beside the usual headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(202, ACK));

    const ack = await makeClient().start({ method_id: "mt_abc123", idempotencyKey: KEY });

    expect(ack.pipeline_run_id).toBe("run-1");
    const request = sentRequest(fetchSpy, 0);
    expect(request.url).toBe(`${BASE_URL}/v1/start`);
    expect(request.method).toBe("POST");
    expect(request.headers["Idempotency-Key"]).toBe(KEY);
    expect(request.headers["Authorization"]).toBe("Bearer test-token");
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(request.headers["Accept"]).toBe("application/json");
    // A header, never a run argument: the body is the run request alone.
    expect(JSON.parse(request.body!)).toEqual({ method_id: "mt_abc123" });
  });

  it.each([
    ["absent", {}],
    ["undefined", { idempotencyKey: undefined }],
    ["null", { idempotencyKey: null }],
  ])("sends no Idempotency-Key header when the key is %s", async (_, keyOption) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(202, ACK));

    await makeClient().start({ method_id: "mt_abc123", ...keyOption });

    const request = sentRequest(fetchSpy, 0);
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain(
      "idempotency-key",
    );
    expect(JSON.parse(request.body!)).toEqual({ method_id: "mt_abc123" });
  });

  it("sends the same key and the same body on a caller's retry of a start that may have started a run", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
            errno: -54,
            syscall: "read",
          }),
        }),
      )
      .mockResolvedValueOnce(jsonResponse(202, ACK, { "Idempotent-Replayed": "true" }));
    const client = makeClient();
    const options: PipelexStartOptions = {
      method_id: "mt_abc123@3",
      inputs: { text: { concept: "native.Text", content: { text: "hello" } } },
      idempotencyKey: KEY,
    };

    const err = await failureOf(() => client.start(options));
    // The key changes what the caller can do, not the verdict: the run may have started, so its
    // outcome is unknown, and the caller that sent a key sends the same start again.
    expect(err).toBeInstanceOf(ApiUnreachableError);
    expect((err as ApiUnreachableError).code).toBe("client.outcome_unknown");
    expect((err as ApiUnreachableError).retry).toBe("outcome_unknown");
    const ack = await client.start(options);

    expect(ack.pipeline_run_id).toBe("run-1");
    const first = sentRequest(fetchSpy, 0);
    const retry = sentRequest(fetchSpy, 1);
    expect(retry.headers["Idempotency-Key"]).toBe(KEY);
    expect(retry.headers).toEqual(first.headers);
    // The hosted API refuses the same key with another body, so the retry's bytes must match.
    expect(retry.body).toBe(first.body);
  });

  it.each([
    ["is empty", "", "this one is empty"],
    ["holds a space", "run 42", "this one holds a character outside visible ASCII"],
    [
      "holds a line break",
      "k\r\nX-Injected: 1",
      "this one holds a character outside visible ASCII",
    ],
    [
      "holds a character outside ASCII",
      "clé-42",
      "this one holds a character outside visible ASCII",
    ],
    ["is longer than 255 characters", "k".repeat(256), "this one is 256 characters long"],
    ["is not a string", 42 as unknown as string, "this one is not a string"],
  ])("refuses a key that %s before anything is sent", async (_, idempotencyKey, fault) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().start({ method_id: "mt_abc123", idempotencyKey }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    const refused = err as RequestArgumentError;
    expect(refused.message).toContain(fault);
    expect(refused.message).toContain("1 to 255 visible ASCII characters");
    expect(refused.code).toBe("client.argument_invalid");
    expect(refused.problem).toMatchObject({ domain: "input", retry: "no" });
    expect(refused.problem.params?.argument).toBe("idempotency_key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never quotes the refused key in its message", async () => {
    vi.spyOn(globalThis, "fetch");
    const secretish = `user-4711 ${"x".repeat(10)}`;

    const err = await failureOf(() =>
      makeClient().start({ method_id: "mt_abc123", idempotencyKey: secretish }),
    );

    expect((err as Error).message).not.toContain("user-4711");
  });

  it.each([
    ["the longest key", "k".repeat(255)],
    ["every visible ASCII character", "!\"#$%&'()*+,-./0123456789:;<=>?@AZ[\\]^_`az{|}~"],
    ["a single character", "k"],
  ])("sends %s as it is", async (_, idempotencyKey) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(202, ACK));

    await makeClient().start({ method_id: "mt_abc123", idempotencyKey });

    expect(sentRequest(fetchSpy, 0).headers["Idempotency-Key"]).toBe(idempotencyKey);
  });

  it("reads a key an earlier start still holds as a retryable refusal that started nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      problemResponse(
        "request.idempotency_key_in_use",
        409,
        {
          detail:
            "An earlier request with idempotency key 'k' and the same body is still being processed.",
          domain: "runtime",
          retry: "yes",
          next_step: { kind: "wait", detail: "Send the same request again under the same key." },
        },
        { "Retry-After": "2" },
      ),
    );

    const err = await failureOf(() =>
      makeClient().start({ method_id: "mt_abc123", idempotencyKey: KEY }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    const refused = err as ApiResponseError;
    const inUse: IdempotencyErrorCode = "request.idempotency_key_in_use";
    expect(refused.code).toBe(inUse);
    expect(refused.status).toBe(409);
    // Nothing ran for this request: a retry after the wait the answer names is safe.
    expect({
      domain: refused.domain,
      retry: refused.retry,
      retryAfter: refused.retryAfter,
    }).toEqual({ domain: "runtime", retry: "yes", retryAfter: 2 });
  });

  it("reads a key used before with another body as a conflict that is not retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      problemResponse("request.idempotency_conflict", 409, {
        detail: "The idempotency key 'k' was already used with a different request body.",
      }),
    );

    const err = await failureOf(() =>
      makeClient().start({ method_id: "mt_abc123", idempotencyKey: KEY }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    const refused = err as ApiResponseError;
    const conflict: IdempotencyErrorCode = "request.idempotency_conflict";
    expect(refused.code).toBe(conflict);
    expect({ domain: refused.domain, retry: refused.retry }).toEqual({
      domain: "input",
      retry: "no",
    });
  });

  it("types the option as an optional string or null, and the code as its literal", () => {
    expectTypeOf<PipelexStartOptions["idempotencyKey"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<IdempotencyErrorCode>().toEqualTypeOf<
      "request.idempotency_key_in_use" | "request.idempotency_conflict"
    >();
  });
});

describe("PipelexApiClient.startAndWaitForResult — the idempotency key", () => {
  it("sends the key on the durable start and on no other request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(jsonResponse(202, ACK))
      .mockResolvedValueOnce(jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: "done" }));

    const result = await makeClient().startAndWaitForResult({
      method_id: "mt_abc123",
      idempotencyKey: KEY,
    });

    expect(result.pipeline_run_id).toBe("run-1");
    const [version, start, results] = [0, 1, 2].map((index) => sentRequest(fetchSpy, index));
    expect(version!.url).toBe(`${BASE_URL}/v1/version`);
    expect(start!.url).toBe(`${BASE_URL}/v1/start`);
    expect(results!.url).toBe(`${BASE_URL}/v1/runs/run-1/results`);
    expect(start!.headers["Idempotency-Key"]).toBe(KEY);
    expect(version!.headers).not.toHaveProperty("Idempotency-Key");
    expect(results!.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("sends no key on a bare runner's blocking execute", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(jsonResponse(200, executeBody("run-2")));

    const result = await makeClient().startAndWaitForResult({
      pipe_code: "p",
      files: { "main.mthds": 'domain = "d"\n' },
      idempotencyKey: KEY,
    });

    expect(result.pipeline_run_id).toBe("run-2");
    const execute = sentRequest(fetchSpy, 1);
    expect(execute.url).toBe(`${BASE_URL}/v1/execute`);
    expect(execute.headers).not.toHaveProperty("Idempotency-Key");
    expect(JSON.parse(execute.body!)).not.toHaveProperty("idempotencyKey");
  });

  it("refuses a malformed key before the version handshake", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().startAndWaitForResult({ method_id: "mt_abc123", idempotencyKey: "" }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
