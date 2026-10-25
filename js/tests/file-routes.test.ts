/**
 * One file of an organization and what a client does with it: the detail with its uses
 * (`GET /v1/files/{file_id}`), the records of an address (`GET /v1/files/by-uri`), the rename
 * (`PATCH /v1/files/{file_id}`), the links (`POST /v1/files/links`) and the copy into a method's
 * draft (`POST /v1/methods/{id}/draft/files/from-file`). Pins the request each method builds, the
 * arguments it refuses before sending anything, and the answers it reads and refuses. The fetch
 * boundary is mocked, so the client's real request pipeline runs.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import { problemResponse } from "./helpers/problems.js";
import type {
  DraftFileFromFileInput,
  DraftFileFromFileResult,
  FileDetail,
  FileLink,
  FileLinkTarget,
  FileRecord,
  FileRecordList,
  MethodData,
} from "../src/index.js";

const BASE_URL = "http://localhost:8081";
const FILE_ID = "fl_0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const URI = "pipelex-storage://org_1/assets/5f0c.pdf";
const SIGNED_URL =
  "https://bucket.s3.amazonaws.com/org_1/assets/5f0c.pdf?X-Amz-Signature=deadbeef&response-content-disposition=inline";

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

/** A whole record as the platform serializes it, made up. */
const RECORD: FileRecord = {
  file_id: FILE_ID,
  uri: URI,
  source_uri: null,
  name: "March invoice.pdf",
  original_name: "invoice-03.pdf",
  media_type: "application/pdf",
  format: "pdf",
  size: 48213,
  sha256: "5f0c2d1e8b3a4c6e9d2f1a7b3c4d5e6f5f0c2d1e8b3a4c6e9d2f1a7b3c4d5e6f",
  kind: "uploaded",
  role: null,
  origin: { surface: "app", run_id: null, method_id: null, method_version: null },
  created_at: "2026-10-22T09:14:03.120000+00:00",
  created_by: "user_1",
  state: "stored",
};

const DETAIL: FileDetail = {
  ...RECORD,
  method_ids: ["mt_abc"],
  uses: {
    items: [
      {
        uri: URI,
        holder_type: "example",
        holder_id: "ex_1",
        method_id: "mt_abc",
        created_at: "2026-10-22T10:00:00+00:00",
        created_by: "user_1",
      },
      {
        uri: URI,
        holder_type: "run",
        holder_id: "run_1",
        method_id: "mt_abc",
        created_at: "2026-10-22T11:00:00+00:00",
        created_by: null,
      },
    ],
    next_cursor: "u2",
  },
};

/** A method as a draft write stores it, made up. */
const METHOD: MethodData = {
  method_id: "mt_abc",
  org_id: "org_1",
  created_by_user_id: "user_1",
  name: "Invoices",
  created_at: "2026-10-20T09:00:00+00:00",
  updated_at: "2026-10-22T12:00:00+00:00",
  draft_digest: "sha256:5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47",
  latest_version: null,
  latest_published: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getFile", () => {
  it("GETs /v1/files/{file_id} and returns the detail with its methods and uses", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, DETAIL));

    const detail = await makeClient().getFile(FILE_ID);

    const req = onlyRequest(spy);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE_URL}/v1/files/${FILE_ID}`);
    expect(detail).toEqual(DETAIL);
    expectTypeOf(detail).toEqualTypeOf<FileDetail>();
    expectTypeOf(detail.uses.next_cursor).toEqualTypeOf<string | null>();
    expectTypeOf(detail.uses.items[0].created_by).toEqualTypeOf<string | null>();
  });

  it("reads a use answered without created_by, as a platform that predates it answers, as null", async () => {
    const [example, run] = DETAIL.uses.items.map(({ created_by: _creator, ...use }) => use);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...DETAIL, uses: { items: [example, run], next_cursor: null } }),
    );

    const detail = await makeClient().getFile(FILE_ID);

    expect(detail.uses.items.map((use) => use.created_by)).toEqual([null, null]);
    expect(detail.uses.items[0]).toEqual({ ...DETAIL.uses.items[0], created_by: null });
    expect(detail.uses.next_cursor).toBeNull();
  });

  it("keeps the created_by each use carries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, DETAIL));

    const detail = await makeClient().getFile(FILE_ID);

    expect(detail.uses.items.map((use) => use.created_by)).toEqual(["user_1", null]);
  });

  it("pages the uses with uses_limit and uses_cursor", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, DETAIL));

    await makeClient().getFile(FILE_ID, { usesLimit: 20, usesCursor: "u2" });

    expect(onlyRequest(spy).url).toBe(
      `${BASE_URL}/v1/files/${FILE_ID}?uses_limit=20&uses_cursor=u2`,
    );
  });

  it.each([
    ["an empty id", "", "an empty string"],
    [
      "a dot segment",
      "..",
      '"..", a dot segment, which the URL would resolve into another route\'s path',
    ],
  ])("refuses %s before sending anything", async (_label, fileId, got) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .getFile(fileId)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      `getFile() takes a file id, the file's non-empty \`file_id\`; got ${got}.`,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["no uses", { ...RECORD, method_ids: [] }],
    ["uses whose items are not an array", { ...DETAIL, uses: { items: null, next_cursor: null } }],
    ["uses with no cursor", { ...DETAIL, uses: { items: [] } }],
  ])("throws a typed ApiResponseError for a file with %s", async (_label, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await makeClient()
      .getFile(FILE_ID)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API GET /v1/files/${FILE_ID} answered 200 with a file whose \`uses\` is not a page of ` +
        "`items` and `next_cursor`",
    );
    expect((err as ProblemError).problem).toMatchObject({ domain: "runtime", retry: "no" });
  });

  it("surfaces a file that is not the organization's as a 404 pipelex.storage.not_found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("pipelex.storage.not_found", 404, { detail: "Item not found." }),
    );

    const err = await makeClient()
      .getFile(FILE_ID)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("pipelex.storage.not_found");
  });
});

describe("getFilesByUri", () => {
  it("GETs /v1/files/by-uri with the address encoded and returns the records", async () => {
    const pending: FileRecord = { ...RECORD, file_id: "fl_2", state: "pending", created_by: "u2" };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [RECORD, pending] }));

    const list = await makeClient().getFilesByUri(URI, { runId: "run_1" });

    const url = new URL(onlyRequest(spy).url);
    expect(url.pathname).toBe("/v1/files/by-uri");
    expect([...url.searchParams.entries()]).toEqual([
      ["uri", URI],
      ["run_id", "run_1"],
    ]);
    expect(list).toEqual({ items: [RECORD, pending] });
    expectTypeOf(list).toEqualTypeOf<FileRecordList>();
  });

  it("answers an address no record holds as an empty list", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: [] }));

    const list = await makeClient().getFilesByUri(URI);

    expect(new URL(onlyRequest(spy).url).search).toBe(`?uri=${encodeURIComponent(URI)}`);
    expect(list.items).toEqual([]);
  });

  it.each([
    ["an empty address", "", "an empty string"],
    ["no address", undefined, "undefined"],
  ])("refuses %s before sending anything", async (_label, uri, got) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .getFilesByUri(uri as unknown as string)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      `getFilesByUri() takes a \`pipelex-storage://\` address, a non-empty string; got ${got}.`,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws a typed ApiResponseError for an answer whose items are not an array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: RECORD }));

    const err = await makeClient()
      .getFilesByUri(URI)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toMatch(
      /answered 200 with an answer whose `items` is not an array$/,
    );
  });

  it("surfaces another organization's address as a 403 pipelex.org.mismatch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("pipelex.org.mismatch", 403, { detail: "Not your organization's." }),
    );

    const err = await makeClient()
      .getFilesByUri("pipelex-storage://org_2/assets/x.pdf")
      .catch((thrown: unknown) => thrown);

    expect((err as ApiResponseError).code).toBe("pipelex.org.mismatch");
  });
});

describe("renameFile", () => {
  it("PATCHes the name alone to /v1/files/{file_id} and returns the record as it now stands", async () => {
    const renamed = { ...RECORD, name: "March invoice final.pdf" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, renamed));

    const record = await makeClient().renameFile(FILE_ID, {
      name: "March invoice final",
      extra: "dropped",
    } as unknown as { name: string });

    const req = onlyRequest(spy);
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe(`${BASE_URL}/v1/files/${FILE_ID}`);
    expect(req.body).toEqual({ name: "March invoice final" });
    expect(record.name).toBe("March invoice final.pdf");
    expectTypeOf(record).toEqualTypeOf<FileRecord>();
  });

  it("sends an empty name for the platform to refuse with its own rule", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("request.invalid", 422, {
        detail: "Empty name.",
        location: { field: "name" },
      }),
    );

    const err = await makeClient()
      .renameFile(FILE_ID, { name: "" })
      .catch((thrown: unknown) => thrown);

    expect(onlyRequest(spy).body).toEqual({ name: "" });
    expect((err as ApiResponseError).code).toBe("request.invalid");
  });

  it("refuses a name that is not a string before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .renameFile(FILE_ID, { name: null } as unknown as { name: string })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "renameFile() takes the file's new name, a string; got null.",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a runner renaming another member's file as a 403 auth.forbidden", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("auth.forbidden", 403, {
        domain: "account",
        detail: "Your role in this organization is runner.",
        params: { requirement: "a role that may change files" },
      }),
    );

    const err = await makeClient()
      .renameFile(FILE_ID, { name: "x" })
      .catch((thrown: unknown) => thrown);

    expect((err as ApiResponseError).code).toBe("auth.forbidden");
    expect((err as ApiResponseError).problem).toMatchObject({ domain: "account", retry: "no" });
  });
});

describe("linkFiles", () => {
  const LINKED: FileLink = {
    file_id: FILE_ID,
    uri: URI,
    name: "March invoice.pdf",
    media_type: "application/pdf",
    url: SIGNED_URL,
    expires_at: "2026-10-22T09:29:03Z",
    error: null,
  };
  const REFUSED: FileLink = {
    file_id: null,
    uri: "pipelex-storage://org_2/assets/x.pdf",
    name: null,
    media_type: null,
    url: null,
    expires_at: null,
    error: { code: "forbidden", detail: "Not your organization's." },
  };

  it("POSTs each file as { file_id } or { uri } and returns one item per file, in order", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [LINKED, REFUSED] }));

    const result = await makeClient().linkFiles([
      { file_id: FILE_ID },
      { uri: "pipelex-storage://org_2/assets/x.pdf", file_id: null } as unknown as FileLinkTarget,
    ]);

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/v1/files/links`);
    expect(req.body).toEqual({
      files: [{ file_id: FILE_ID }, { uri: "pipelex-storage://org_2/assets/x.pdf" }],
    });
    expect(result.items).toEqual([LINKED, REFUSED]);
    const [first] = result.items;
    if (first!.error !== null) throw new Error("the first file is linked");
    expectTypeOf(first!.url).toEqualTypeOf<string>();
  });

  it.each([
    ["an item naming both", [{ file_id: FILE_ID, uri: URI }], "an object naming both"],
    ["an item naming neither", [{}], "an object naming neither"],
    ["an empty file id", [{ file_id: "" }], "an empty string"],
    ["an item that is a string", [FILE_ID], "string"],
  ])("refuses %s before sending anything", async (_label, files, got) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .linkFiles(files as unknown as FileLinkTarget[])
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "linkFiles() takes a file to link, an object naming exactly one of `file_id` and `uri`, " +
        `each a non-empty string; got ${got}.`,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses files that are not a list before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .linkFiles({ file_id: FILE_ID } as unknown as FileLinkTarget[])
      .catch((thrown: unknown) => thrown);

    expect((err as Error).message).toBe("linkFiles() takes a list of files to link; got object.");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "fewer items than files",
      { items: [LINKED] },
      "an answer that is not one item per requested file",
    ],
    ["no items", {}, "an answer that is not one item per requested file"],
    [
      "an item with neither a link nor an error",
      { items: [LINKED, { ...LINKED, url: null }] },
      "an item that carries neither a link nor an error",
    ],
  ])("throws a typed ApiResponseError hiding every link for %s", async (_label, body, what) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await makeClient()
      .linkFiles([{ file_id: FILE_ID }, { uri: URI }])
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API POST /v1/files/links answered 200 with ${what}`,
    );
    expect((err as ApiResponseError).responseBody).not.toContain("X-Amz-Signature=deadbeef");
  });
});

describe("copyFileIntoDraft", () => {
  const RESULT: DraftFileFromFileResult = {
    blob: "copied",
    file: { path: "assets/logo.png", sha256: "a".repeat(64), size: 18342 },
    method: METHOD,
  };

  it("POSTs the file, its path and the token to …/draft/files/from-file and returns the result", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, RESULT));

    const result = await makeClient().copyFileIntoDraft("mt_abc", {
      file_id: FILE_ID,
      path: "assets/logo.png",
      expected_updated_at: "2026-10-22T11:00:00+00:00",
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/v1/methods/mt_abc/draft/files/from-file`);
    expect(req.body).toEqual({
      file_id: FILE_ID,
      path: "assets/logo.png",
      expected_updated_at: "2026-10-22T11:00:00+00:00",
    });
    expect(result).toEqual(RESULT);
    expectTypeOf(result.blob).toEqualTypeOf<"copied" | "already_held">();
  });

  it("sends no token when none is given, null included, and reads already_held", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ...RESULT, blob: "already_held" }));

    const result = await makeClient().copyFileIntoDraft("mt_abc", {
      file_id: FILE_ID,
      path: "assets/logo.png",
      expected_updated_at: null,
    } as unknown as DraftFileFromFileInput);

    expect(onlyRequest(spy).body).toEqual({ file_id: FILE_ID, path: "assets/logo.png" });
    expect(result.blob).toBe("already_held");
  });

  it.each([
    [
      "no file id",
      { path: "assets/logo.png" },
      "a file id, the file's non-empty `file_id`; got undefined",
    ],
    [
      "an empty path",
      { file_id: FILE_ID, path: "" },
      "the tree path the file takes in the draft, a non-empty string; got an empty string",
    ],
    [
      "a token that is not a string",
      { file_id: FILE_ID, path: "a.png", expected_updated_at: 3 },
      "the draft token the caller last read, the method's `updated_at`, a string, or none; got 3",
    ],
  ])("refuses %s before sending anything", async (_label, input, what) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .copyFileIntoDraft("mt_abc", input as unknown as DraftFileFromFileInput)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(`copyFileIntoDraft() takes ${what}.`);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .copyFileIntoDraft("mt_abc@2", { file_id: FILE_ID, path: "a.png" })
      .catch((thrown: unknown) => thrown);

    expect((err as Error).message).toContain('"mt_abc@2" carries a version suffix');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a blob it does not know",
      { ...RESULT, blob: "moved" },
      "whose `blob` is not `copied` or `already_held`",
    ],
    ["no file", { blob: "copied", method: METHOD }, "whose `file` is not an object"],
    ["no method", { blob: "copied", file: RESULT.file }, "whose `method` is not an object"],
  ])("throws a typed ApiResponseError for an answer with %s", async (_label, body, what) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await makeClient()
      .copyFileIntoDraft("mt_abc", { file_id: FILE_ID, path: "a.png" })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API POST /v1/methods/mt_abc/draft/files/from-file answered 200 with a copy into a draft ${what}`,
    );
  });

  it("surfaces a stale draft token as a 409 pipelex.catalog.update_conflict", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("pipelex.catalog.update_conflict", 409, { detail: "The draft moved." }),
    );

    const err = await makeClient()
      .copyFileIntoDraft("mt_abc", { file_id: FILE_ID, path: "a.png", expected_updated_at: "t" })
      .catch((thrown: unknown) => thrown);

    expect((err as ApiResponseError).code).toBe("pipelex.catalog.update_conflict");
  });
});
