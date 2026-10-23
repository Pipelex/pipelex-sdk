/**
 * Zips of an organization's files: `requestFileArchive` (`POST /v1/files/archives`, answered `202`
 * with the archive `queued`) and `getFileArchive` (`GET /v1/files/archives/{archive_id}`, read
 * until it is `ready` or `failed`). Pins the body each request sends, the arguments refused before
 * sending anything, the archive read back with its `state` checked, the cap a
 * `file_archive_too_large` refusal names, and a ready archive's link kept out of every error. The
 * fetch boundary is mocked, so the client's real request pipeline runs.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError, errorVerdictOf } from "../src/errors.js";
import type { FileArchive, FileArchiveLimit, FileArchiveRequest } from "../src/index.js";

const BASE_URL = "http://localhost:8081";
const ARCHIVE_ID = "arc_5f0c2d1e-8b3a-4c6e-9d2f-1a7b3c4d5e6f";
const SIGNED_URL = `https://archives.s3.amazonaws.com/org_1/${ARCHIVE_ID}.zip?X-Amz-Signature=deadbeef`;

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The URL, method and parsed body of the one fetch call the spy recorded. */
function onlyRequest(spy: ReturnType<typeof vi.spyOn>): {
  url: string;
  method: string;
  body: unknown;
} {
  expect(spy).toHaveBeenCalledTimes(1);
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
  };
}

/** An archive as the `202` answers it, made up. */
const QUEUED: FileArchive = {
  archive_id: ARCHIVE_ID,
  name: "March invoices.zip",
  state: "queued",
  source: "files",
  run_id: null,
  file_count: 2,
  total_bytes: 3145728,
  created_at: "2026-10-23T09:00:00.000000Z",
  expires_at: "2026-10-24T09:00:00.000000Z",
  archive_bytes: null,
  ready_at: null,
  failure: null,
  url: null,
  url_expires_at: null,
};

const READY: FileArchive = {
  ...QUEUED,
  state: "ready",
  archive_bytes: 3101422,
  ready_at: "2026-10-23T09:00:07.512330Z",
  url: SIGNED_URL,
  url_expires_at: "2026-10-23T09:15:41.000000Z",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestFileArchive", () => {
  it("POSTs the file ids and the name to /v1/files/archives and returns the archive queued", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(202, QUEUED));

    const archive = await makeClient().requestFileArchive({
      file_ids: ["fl_1", "fl_2"],
      name: "March invoices",
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/v1/files/archives`);
    expect(req.body).toEqual({ file_ids: ["fl_1", "fl_2"], name: "March invoices" });
    expect(archive).toEqual(QUEUED);
    expectTypeOf(archive).toEqualTypeOf<FileArchive>();
  });

  it("POSTs a run's files by run_id alone, a null member reading as not given", async () => {
    const runArchive = { ...QUEUED, source: "run", run_id: "run_7", name: "files-run_7.zip" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(202, runArchive));

    const archive = await makeClient().requestFileArchive({
      run_id: "run_7",
      file_ids: null,
      name: null,
    } as unknown as FileArchiveRequest);

    expect(onlyRequest(spy).body).toEqual({ run_id: "run_7" });
    expect(archive.source).toBe("run");
    expect(archive.run_id).toBe("run_7");
  });

  it.each([
    [
      "both",
      { file_ids: ["fl_1"], run_id: "run_7" },
      /exactly one of file_ids and run_id; got both\.$/,
    ],
    ["neither", { name: "x" }, /exactly one of file_ids and run_id; got neither\.$/],
    [
      "an empty list of file ids",
      { file_ids: [] },
      /takes file_ids, a non-empty list of the file ids to zip; got an empty list\.$/,
    ],
    ["file ids that are a string", { file_ids: "fl_1" }, /; got string\.$/],
    [
      "an empty file id",
      { file_ids: ["fl_1", ""] },
      /takes a file id to zip, a non-empty string; got an empty string\.$/,
    ],
    ["an empty run id", { run_id: "" }, /takes a run_id naming the run whose files to zip/],
    [
      "a name that is not a string",
      { run_id: "run_7", name: 3 },
      /takes a name for the zip, a string, or none; got 3\.$/,
    ],
    ["a request that is not an object", "run_7", /takes an archive request, an object naming/],
  ])("refuses %s before sending anything", async (_label, request, message) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .requestFileArchive(request as unknown as FileArchiveRequest)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toMatch(/^requestFileArchive\(\) /);
    expect((err as Error).message).toMatch(message);
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a selection past a cap as a 422 whose limit names it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, {
        type: "about:blank",
        title: "Archive too large",
        status: 422,
        detail: "An archive holds at most 2000000000 bytes; this selection adds up to 2147483648.",
        code: "file_archive_too_large",
        error_domain: "input",
        retryable: false,
        limit: { name: "max_total_bytes", value: 2000000000, reached: 2147483648 },
      }),
    );

    const err = await makeClient()
      .requestFileArchive({ file_ids: ["fl_1", "fl_2"] })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refusal = err as ApiResponseError;
    expect(refusal.code).toBe("file_archive_too_large");
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
    const limit = refusal.problemDocument?.limit as FileArchiveLimit;
    expect(limit).toEqual({ name: "max_total_bytes", value: 2000000000, reached: 2147483648 });
  });

  it("surfaces a run whose files are not recorded yet as a retryable 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, {
        status: 409,
        code: "conflict",
        error_domain: "runtime",
        retryable: true,
        detail: "The run's files are not all recorded yet.",
      }),
    );

    const err = await makeClient()
      .requestFileArchive({ run_id: "run_7" })
      .catch((thrown: unknown) => thrown);

    expect((err as ApiResponseError).code).toBe("conflict");
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: true });
  });

  it.each([
    [
      "no archive id",
      { ...QUEUED, archive_id: undefined },
      "an archive whose `archive_id` is not a string",
    ],
    [
      "a state it does not know",
      { ...QUEUED, state: "expired" },
      "an archive whose `state` is not `queued`, `building`, `ready` or `failed`",
    ],
  ])("throws a typed ApiResponseError for an answer with %s", async (_label, body, what) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(202, body));

    const err = await makeClient()
      .requestFileArchive({ run_id: "run_7" })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API POST /v1/files/archives answered 202 with ${what}`,
    );
  });
});

describe("getFileArchive", () => {
  it("GETs /v1/files/archives/{archive_id} and returns a ready archive with its link", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, READY));

    const archive = await makeClient().getFileArchive(ARCHIVE_ID);

    const req = onlyRequest(spy);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE_URL}/v1/files/archives/${ARCHIVE_ID}`);
    expect(archive).toEqual(READY);
    expect(archive.url).toBe(SIGNED_URL);
  });

  it("returns a failed archive with its failure, never an error", async () => {
    const failed: FileArchive = {
      ...QUEUED,
      state: "failed",
      failure: {
        code: "file_gone",
        detail: "The file 'March invoice.pdf' was deleted before the zip was ready.",
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, failed));

    const archive = await makeClient().getFileArchive(ARCHIVE_ID);

    expect(archive.state).toBe("failed");
    expect(archive.failure?.code).toBe("file_gone");
  });

  it("follows the documented loop: read again while queued or building, until ready", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, QUEUED))
      .mockResolvedValueOnce(jsonResponse(200, { ...QUEUED, state: "building" }))
      .mockResolvedValueOnce(jsonResponse(200, READY));
    const client = makeClient();

    let archive = await client.getFileArchive(ARCHIVE_ID);
    while (archive.state === "queued" || archive.state === "building") {
      archive = await client.getFileArchive(ARCHIVE_ID);
    }

    expect(spy).toHaveBeenCalledTimes(3);
    expect(archive.state).toBe("ready");
  });

  it("refuses an empty archive id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .getFileArchive("")
      .catch((thrown: unknown) => thrown);

    expect((err as Error).message).toBe(
      "getFileArchive() takes an archive id, the archive's non-empty `archive_id`; got an empty string.",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("hides a ready archive's link in the error of an answer it cannot read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { ...READY, state: "done" }));

    const err = await makeClient()
      .getFileArchive(ARCHIVE_ID)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).responseBody).not.toContain("X-Amz-Signature=deadbeef");
  });

  it("surfaces an expired archive as a 404 not_found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { status: 404, code: "not_found", detail: "Item not found." }),
    );

    const err = await makeClient()
      .getFileArchive(ARCHIVE_ID)
      .catch((thrown: unknown) => thrown);

    expect((err as ApiResponseError).code).toBe("not_found");
  });
});
