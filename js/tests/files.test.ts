/**
 * An organization's files, `GET /v1/files`. Pins: the request `listFiles` sends (every query
 * member under its wire name, `format` and `media_type` as one repeated parameter per value, an
 * empty list refused before any request), the typed page it returns, and `iterateFiles`
 * following the cursor through filtered empty pages. The fetch boundary is mocked, so the
 * client's real request pipeline runs.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { RequestArgumentError } from "../src/errors.js";
import type { FileKind, FileOrigin, FilePage, FileSummary, ListFilesQuery } from "../src/index.js";

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

/** Every URL the spy was called with, parsed. */
function requestedUrls(spy: ReturnType<typeof vi.spyOn>): URL[] {
  return spy.mock.calls.map((call: unknown[]) => new URL((call as [string, RequestInit])[0]));
}

const UPLOADED: FileSummary = {
  file_id: "fl_0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  uri: "pipelex-storage://org_1/assets/5f0c.pdf",
  name: "March invoice.pdf",
  media_type: "application/pdf",
  format: "pdf",
  size: 48213,
  kind: "uploaded",
  origin: { surface: "app", run_id: null, method_id: null, method_version: null },
  created_at: "2026-10-22T09:14:03.120000+00:00",
  created_by: "user_1",
};

const GENERATED: FileSummary = {
  file_id: "fl_0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
  uri: "pipelex-storage://org_1/mt_abc/run_1/outputs/summary.docx",
  name: "summary.docx",
  media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  format: "docx",
  size: 9120,
  kind: "generated",
  origin: { surface: null, run_id: "run_1", method_id: "mt_abc", method_version: 3 },
  created_at: "2026-10-22T09:10:00.000000+00:00",
  created_by: "user_2",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listFiles", () => {
  it("GETs a bare /v1/files and returns the typed page, next_cursor read as nextCursor", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [UPLOADED, GENERATED], next_cursor: "c1" }));

    const page = await client.listFiles();

    expect(requestedUrls(spy).map(String)).toEqual(["http://localhost:8081/v1/files"]);
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(page).toEqual({ items: [UPLOADED, GENERATED], nextCursor: "c1" });
    expectTypeOf(page).toEqualTypeOf<FilePage>();
    expectTypeOf(page.items).toEqualTypeOf<FileSummary[]>();
  });

  it("sends every query member under its wire name, format and media_type repeated per value", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listFiles({
      q: "invoice",
      kind: "test",
      format: ["pdf", "image"],
      mediaType: ["image/png", "image/jpeg"],
      methodId: "mt_abc",
      runId: "run_1",
      createdBy: "me",
      createdFrom: "2026-10-01T00:00:00Z",
      createdTo: "2026-10-31T23:59:59+02:00",
      limit: 20,
      cursor: "c1",
    });

    const [url] = requestedUrls(spy);
    expect(url!.pathname).toBe("/v1/files");
    // The server's own names and order, each array as one parameter per value.
    expect([...url!.searchParams.entries()]).toEqual([
      ["method_id", "mt_abc"],
      ["run_id", "run_1"],
      ["created_by", "me"],
      ["kind", "test"],
      ["format", "pdf"],
      ["format", "image"],
      ["media_type", "image/png"],
      ["media_type", "image/jpeg"],
      ["created_from", "2026-10-01T00:00:00Z"],
      ["created_to", "2026-10-31T23:59:59+02:00"],
      ["q", "invoice"],
      ["limit", "20"],
      ["cursor", "c1"],
    ]);
  });

  it("sends an explicit empty q rather than dropping it into an unfiltered list", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listFiles({ q: "" });

    expect(requestedUrls(spy)[0]!.searchParams.has("q")).toBe(true);
  });

  it.each([
    ["format", { format: [] }],
    ["mediaType", { mediaType: [] }],
  ] as const)(
    "refuses an empty %s before any request, since no parameter would list everything",
    async (name, query) => {
      const client = makeClient();
      const spy = vi.spyOn(globalThis, "fetch");

      const error = await client.listFiles(query).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RequestArgumentError);
      expect((error as RequestArgumentError).message).toContain(`"${name}"`);
      expect((error as RequestArgumentError).errorDomain).toBe("input");
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("refuses a format that is not a list of strings as a bug in the calling code", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    await expect(client.listFiles({ format: "pdf" as unknown as string[] })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      client.listFiles({ mediaType: [42] as unknown as string[] }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("types the query and the rows as the server's contract states them", () => {
    expectTypeOf<FileKind>().toEqualTypeOf<"uploaded" | "generated" | "test">();
    expectTypeOf<FileOrigin["method_version"]>().toEqualTypeOf<number | "draft" | null>();
    expectTypeOf<FileOrigin["surface"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ListFilesQuery["kind"]>().toEqualTypeOf<FileKind | undefined>();
    expectTypeOf<ListFilesQuery["format"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<ListFilesQuery["mediaType"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<FilePage["nextCursor"]>().toEqualTypeOf<string | null>();
  });
});

describe("iterateFiles", () => {
  it("follows the cursor past EMPTY filtered pages, sending the filters on every page", async () => {
    // The filters run after the index read, so a page can hold no row and still carry a cursor:
    // stopping there would drop every later match.
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c1" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [UPLOADED], next_cursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c3" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [GENERATED], next_cursor: null }));

    const seen: string[] = [];
    for await (const file of client.iterateFiles({ q: "march", format: ["pdf", "docx"] })) {
      seen.push(file.file_id);
    }

    expect(seen).toEqual([UPLOADED.file_id, GENERATED.file_id]);
    const urls = requestedUrls(spy);
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "c1", "c2", "c3"]);
    for (const url of urls) {
      expect(url.searchParams.get("q")).toBe("march");
      expect(url.searchParams.getAll("format")).toEqual(["pdf", "docx"]);
    }
  });

  it("stops on a cursor the server failed to advance, yielding each row once", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [UPLOADED], next_cursor: "stuck" })),
      );

    const seen: string[] = [];
    for await (const file of client.iterateFiles()) seen.push(file.file_id);

    expect(seen).toEqual([UPLOADED.file_id]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stops requesting when the caller breaks", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [UPLOADED], next_cursor: "more" })),
      );

    for await (const file of client.iterateFiles()) {
      expect(file.name).toBe("March invoice.pdf");
      break;
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
