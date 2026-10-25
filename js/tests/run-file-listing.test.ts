/**
 * A run's files, `GET /v1/runs/{run_id}/files`: what went in, what came out, what was made along
 * the way and the web links, each entry with its mark and its record. Pins the request
 * `listRunFiles` sends, the page it returns with `next_cursor` read as `nextCursor`, and the pages
 * it refuses. The fetch boundary is mocked, so the client's real request pipeline runs.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import type { FileRecord, RunFilesPage } from "../src/index.js";
import { problemResponse } from "./helpers/problems.js";

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

/** A run's final output's record, made up. */
const OUTPUT: FileRecord = {
  file_id: "fl_out",
  uri: "pipelex-storage://org_1/mt_abc/run_7/outputs/summary.docx",
  source_uri: null,
  name: "summary.docx",
  original_name: "summary.docx",
  media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  format: "docx",
  size: 9120,
  sha256: null,
  kind: "generated",
  role: "final",
  origin: { surface: null, run_id: "run_7", method_id: "mt_abc", method_version: 3 },
  created_at: "2026-10-22T09:10:00+00:00",
  created_by: "user_1",
  state: "stored",
};

/** The first page of a run's files as the platform serializes it. */
const PAGE = {
  pipeline_run_id: "run_7",
  state: "listed",
  inputs: [
    {
      mark: "input",
      input_name: "invoice",
      uri: "pipelex-storage://org_1/assets/5f0c.pdf",
      file: null,
    },
  ],
  outputs: [{ mark: "final", input_name: null, uri: OUTPUT.uri, file: OUTPUT }],
  intermediates: [],
  links: [
    {
      input_name: "logo",
      url: "https://example.com/logo.png",
      warning: "Replaying this run needs this link to still serve the same file.",
    },
  ],
  next_cursor: "c2",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listRunFiles", () => {
  it("GETs /v1/runs/{run_id}/files and returns the page, next_cursor read as nextCursor", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, PAGE));

    const page = await makeClient().listRunFiles("run_7");

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/runs/run_7/files`);
    expect(init.method).toBe("GET");
    const { next_cursor: _cursor, ...rest } = PAGE;
    expect(page).toEqual({ ...rest, nextCursor: "c2" });
    expect(page).not.toHaveProperty("next_cursor");
    expectTypeOf(page).toEqualTypeOf<RunFilesPage>();
  });

  it("pages the run's own records with limit and cursor", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ...PAGE, inputs: [], links: [], next_cursor: null }));

    const page = await makeClient().listRunFiles("run_7", { limit: 20, cursor: "c2" });

    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/runs/run_7/files?limit=20&cursor=c2`);
    expect(page.nextCursor).toBeNull();
  });

  it("reads a run still being recorded as listing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...PAGE, state: "listing", outputs: [], next_cursor: null }),
    );

    const page = await makeClient().listRunFiles("run_7");

    expect(page.state).toBe("listing");
  });

  it("refuses an empty run id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .listRunFiles("")
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "listRunFiles() takes a run id, the run's non-empty `pipeline_run_id`; got an empty string.",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a state it does not know",
      { ...PAGE, state: "done" },
      "whose `state` is not `listing` or `listed`",
    ],
    ["no outputs", { ...PAGE, outputs: undefined }, "whose `outputs` is not an array"],
    ["links that are not an array", { ...PAGE, links: {} }, "whose `links` is not an array"],
    [
      "a numeric cursor",
      { ...PAGE, next_cursor: 2 },
      "whose `next_cursor` is neither a string nor null",
    ],
  ])("throws a typed ApiResponseError for a page with %s", async (_label, body, what) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await makeClient()
      .listRunFiles("run_7")
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API GET /v1/runs/run_7/files answered 200 with a page of a run's files ${what}`,
    );
  });

  it("surfaces another organization's run as a 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("run.not_found", 404, { detail: "Run not found." }),
    );

    const err = await makeClient()
      .listRunFiles("run_7")
      .catch((thrown: unknown) => thrown);

    expect((err as ApiResponseError).code).toBe("run.not_found");
  });
});
