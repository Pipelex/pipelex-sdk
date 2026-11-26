/**
 * The PDF preview of an Office file: `getFilePreview` (`GET /v1/files/preview?uri=`), a `200`
 * discriminated on `state`. Pins the request it sends, each state read back with exactly the
 * members it fills, the argument refused before sending anything, the platform's refusals surfaced
 * as its problems, and a ready preview's link kept out of every error. The fetch boundary is
 * mocked, so the client's real request pipeline runs.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import type { FilePreview, FilePreviewFailure } from "../src/index.js";
import { problemResponse } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const URI = "pipelex-storage://org_1/runs/run_7/outputs/Quarterly review.pptx";
const SIGNATURE = "X-Amz-Signature=deadbeef";
const SIGNED_URL = `https://app-bucket.s3.amazonaws.com/org_1/runs/run_7/outputs/review.pptx.pdf?${SIGNATURE}`;

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Every state the platform answers, as it serializes it: all four members, null where unfilled. */
const READY = {
  state: "ready",
  url: SIGNED_URL,
  url_expires_at: "2026-11-26T09:15:00.000000Z",
  failure: null,
};
const PREPARING = { state: "preparing", url: null, url_expires_at: null, failure: null };
const UNAVAILABLE = { state: "unavailable", url: null, url_expires_at: null, failure: null };
const FAILED = {
  state: "failed",
  url: null,
  url_expires_at: null,
  failure: {
    code: "file_unreadable",
    detail: "The file could not be opened: it may be protected by a password or damaged.",
  },
};

/** The error `getFilePreview` threw on `body`, answered with `status`. */
async function errorOf(status: number, body: unknown): Promise<unknown> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(status, body));
  return makeClient()
    .getFilePreview(URI)
    .catch((thrown: unknown) => thrown);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getFilePreview", () => {
  it("GETs /v1/files/preview with the address as its uri and returns a ready preview", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, READY));

    const preview = await makeClient().getFilePreview(URI);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const sent = new URL(url);
    expect(`${sent.origin}${sent.pathname}`).toBe(`${BASE_URL}/v1/files/preview`);
    expect([...sent.searchParams.entries()]).toEqual([["uri", URI]]);
    expect(preview).toEqual(READY);
    expectTypeOf(preview).toEqualTypeOf<FilePreview>();
    if (preview.state === "ready") {
      expectTypeOf(preview.url).toEqualTypeOf<string>();
    }
  });

  it.each([
    ["preparing", PREPARING],
    ["unavailable", UNAVAILABLE],
  ])("returns a %s preview with every other member null", async (_label, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    expect(await makeClient().getFilePreview(URI)).toEqual(body);
  });

  it("returns a failed preview with its failure, never an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, FAILED));

    const preview = await makeClient().getFilePreview(URI);

    expect(preview).toEqual(FAILED);
    if (preview.state === "failed") {
      expectTypeOf(preview.failure).toEqualTypeOf<FilePreviewFailure>();
      expect(preview.failure.code).toBe("file_unreadable");
    }
  });

  it("reads a failure code a later platform adds, as the type promises", async () => {
    const failure = { code: "converter_retired", detail: "A sentence for a person." };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { ...FAILED, failure }));

    const preview = await makeClient().getFilePreview(URI);

    expect(preview.failure).toEqual(failure);
  });

  it("answers exactly the members its state fills, whatever else the platform sends", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...PREPARING, url: "https://stray.example/x", queued_at: "now" }),
    );

    expect(await makeClient().getFilePreview(URI)).toEqual(PREPARING);
  });

  it("follows the documented loop: ask again while preparing, until ready", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, PREPARING))
      .mockResolvedValueOnce(jsonResponse(200, PREPARING))
      .mockResolvedValueOnce(jsonResponse(200, READY));
    const client = makeClient();

    let preview = await client.getFilePreview(URI);
    while (preview.state === "preparing") preview = await client.getFilePreview(URI);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(preview.state).toBe("ready");
  });

  it.each([
    ["an empty string", "", "an empty string"],
    ["a number", 7, "number"],
    ["null", null, "null"],
  ])("refuses a uri that is %s before sending anything", async (_label, uri, got) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .getFilePreview(uri as unknown as string)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      `getFilePreview() takes a \`pipelex-storage://\` address, a non-empty string; got ${got}.`,
    );
    expect((err as ProblemError).problem).toMatchObject({ domain: "input", retry: "no" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a malformed address",
      "pipelex.storage.uri_invalid",
      422,
      { domain: "input", retry: "no", detail: "The storage URI is not valid." },
    ],
    [
      "another organization's address",
      "pipelex.org.mismatch",
      403,
      { domain: "auth", retry: "no", detail: "The address belongs to another organization." },
    ],
    [
      "a conversion that could not be queued",
      "runtime.unavailable",
      503,
      { domain: "runtime", retry: "yes", detail: "The conversion queue is unavailable." },
    ],
  ])("surfaces %s as its problem", async (_label, code, status, members) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(code, status, members));

    const err = await makeClient()
      .getFilePreview(URI)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refusal = err as ApiResponseError;
    expect(refusal.status).toBe(status);
    expect(refusal.code).toBe(code);
    expect(refusal.problem).toMatchObject({ domain: members.domain, retry: members.retry });
  });

  it.each([
    [
      "a state it does not know",
      { ...PREPARING, state: "queued" },
      "a preview whose `state` is not `ready`, `preparing`, `failed` or `unavailable`",
    ],
    [
      "no state",
      { url: null, url_expires_at: null, failure: null },
      "a preview whose `state` is not `ready`, `preparing`, `failed` or `unavailable`",
    ],
    [
      "a ready preview without its link",
      { ...READY, url: null },
      "a ready preview whose `url` is not a non-empty string",
    ],
    [
      "a ready preview with an empty link",
      { ...READY, url: "" },
      "a ready preview whose `url` is not a non-empty string",
    ],
    [
      "a ready preview without its expiry",
      { ...READY, url_expires_at: null },
      "a ready preview whose `url_expires_at` is not a string",
    ],
    [
      "a failed preview without its failure",
      { ...FAILED, failure: null },
      "a failed preview whose `failure` is not a `code` and a `detail`",
    ],
    [
      "a failed preview whose failure has no detail",
      { ...FAILED, failure: { code: "file_gone" } },
      "a failed preview whose `failure` is not a `code` and a `detail`",
    ],
  ])("throws a typed ApiResponseError for an answer with %s", async (_label, body, what) => {
    const err = await errorOf(200, body);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refusal = err as ApiResponseError;
    expect(refusal.message).toBe(
      `API GET /v1/files/preview?uri=${encodeURIComponent(URI).replace(/%20/g, "+")} answered 200 with ${what}`,
    );
    expect(refusal.problem).toMatchObject({ code: "client.response_unreadable" });
  });

  it("throws a typed ApiResponseError for an answer that is not an object", async () => {
    const err = await errorOf(200, ["ready"]);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem).toMatchObject({ code: "client.response_unreadable" });
  });

  it.each([
    ["an unknown state", { ...READY, state: "done" }],
    ["no expiry", { ...READY, url_expires_at: 900 }],
  ])("keeps a ready preview's link out of the error of an answer with %s", async (_label, body) => {
    const err = await errorOf(200, body);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refusal = err as ApiResponseError;
    expect(refusal.responseBody).not.toContain(SIGNATURE);
    expect(refusal.responseBody).not.toContain(SIGNED_URL);
    expect(refusal.message).not.toContain(SIGNATURE);
    expect(refusal.cause).toBeUndefined();
    expect(JSON.stringify(refusal.problem)).not.toContain(SIGNATURE);
  });

  it("keeps the link out of the error of a body that is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`{"state":"ready","url":"${SIGNED_URL}"`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const err = await makeClient()
      .getFilePreview(URI)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).responseBody).not.toContain(SIGNATURE);
    expect((err as ApiResponseError).cause).toBeUndefined();
  });
});
