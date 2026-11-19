/**
 * Stored texts — a `Text`, `Markdown`, `Html` or `JSON` value the runtime holds by reference,
 * `{ url, size, mime_type, preview }`. The result readers load them by default, through the bulk
 * resolve route and a fetch of each signed link, so `main_stuff` reaches the generated parser in
 * its loaded shape; `loadStoredTexts: false` hands the wire shape back. The file walkers skip a
 * stored text by its concept. The fetch boundary is mocked per URL: the results route, the bulk
 * resolve route and the object store.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputFormItem, InputFormTopLevelField, OutputForm } from "mthds/protocol";
import { PipelexApiClient } from "../src/client.js";
import {
  BULK_RESOLVE_MAX_URIS,
  STORED_TEXT_CONCEPTS_MISSING,
  collectArtifacts,
  downloadArtifacts,
  artifactFilename,
  lacksStoredTextConcepts,
  loadStoredTexts,
  locateArtifacts,
  locateStoredReferences,
} from "../src/artifacts.js";
import type { ResolvedArtifact } from "../src/artifacts.js";
import { RunTimeoutError, StoredTextLoadError } from "../src/errors.js";
import {
  STORED_TEXT_CONCEPT_REFS,
  isStoredTextConcept,
  mainStuffNode,
  storedTextKindOf,
  storedTextKindOfNode,
  workingMemoryNode,
} from "../src/stored-texts.js";
import { MAX_CONCEPTS_MISSING_POLLS } from "../src/runs.js";
import type { RunResults, RunResultState } from "../src/runs.js";
import * as sdk from "../src/index.js";

const BASE_URL = "http://localhost:8081";
const RUN_ID = "run-stored";
const STORE = "https://store.example";
const SCOPE = "pipelex-storage://org/method/run-stored/generated";

function storedUri(hash: string, extension = "txt"): string {
  return `${SCOPE}/${hash}/value.${extension}`;
}

function reference(uri: string, preview = "The start…"): Record<string, unknown> {
  return { url: uri, size: 4096, mime_type: "text/plain", preview };
}

/** The working memory naming the main stuff's concept, as the runtime writes it. */
function memory(concept: string, content: unknown, name = "summary"): Record<string, unknown> {
  return { root: { [name]: { concept, content } }, aliases: { main_stuff: name } };
}

/** A results body: the main stuff, its working memory, and an output form for `pipeRef`. */
function results(
  concept: string,
  mainStuff: unknown,
  outputField?: InputFormItem,
): Record<string, unknown> {
  return {
    pipeline_run_id: RUN_ID,
    main_stuff: mainStuff,
    working_memory: memory(concept, mainStuff),
    output_form:
      outputField === undefined
        ? {}
        : ({ "my_domain.summarize": { field: { ...outputField, name: "output" } } } as OutputForm),
    input_form: {},
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Boundary {
  /** The `uris` of each bulk resolve request, in order. */
  resolved: string[][];
  /** The `?artifacts=` of each results read, `null` for a read of every artifact. */
  reads: (string | null)[];
  /** The object-store links fetched. */
  fetched: string[];
}

/**
 * Mock the fetch boundary: the results route answers `body` (or `conceptsBody` for a read that
 * names no `main_stuff`), the bulk route resolves each reference to a store link (or the item
 * `refusals` names), and the store answers each link with the bytes `objects` holds for its
 * reference — or, with `stallStore`, never answers until the request is aborted.
 */
function mockBoundary(options: {
  body: Record<string, unknown>;
  /** The bodies successive reads of `main_stuff` answer, the last one answering every read past them. */
  bodies?: Record<string, unknown>[];
  conceptsBody?: Record<string, unknown>;
  objects?: Record<string, string | Uint8Array>;
  /** A store body per reference, built afresh for each fetch, in place of its `objects` bytes. */
  streams?: Record<string, () => ReadableStream<Uint8Array>>;
  refusals?: Record<string, ResolvedArtifact>;
  stallStore?: boolean;
  /** The `expires_at` of each resolved link, by reference and the resolve call it is in (from 0). */
  expiresAt?: (uri: string, call: number) => string;
}): Boundary {
  const boundary: Boundary = { resolved: [], reads: [], fetched: [] };
  let mainReads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === `/v1/runs/${RUN_ID}/results`) {
      const selection = url.searchParams.get("artifacts");
      boundary.reads.push(selection);
      if (selection !== null && !selection.split(",").includes("main_stuff")) {
        const concepts = options.conceptsBody ?? options.body;
        const picked: Record<string, unknown> = { pipeline_run_id: RUN_ID };
        for (const name of selection.split(",")) picked[name] = concepts[name] ?? null;
        return jsonResponse(200, picked);
      }
      const bodies = options.bodies ?? [options.body];
      const answered = bodies[Math.min(mainReads, bodies.length - 1)]!;
      mainReads += 1;
      return jsonResponse(200, answered);
    }
    if (url.pathname === "/v1/resolve-storage-url/bulk") {
      const { uris } = JSON.parse(String(init?.body)) as { uris: string[] };
      const call = boundary.resolved.length;
      boundary.resolved.push(uris);
      const items = uris.map(
        (uri) =>
          options.refusals?.[uri] ?? {
            uri,
            url: `${STORE}/${encodeURIComponent(uri)}?sig=1`,
            expires_at:
              options.expiresAt?.(uri, call) ?? new Date(Date.now() + 900_000).toISOString(),
            content_type: "text/plain",
            error: null,
          },
      );
      return jsonResponse(200, { items });
    }
    if (url.origin === STORE) {
      boundary.fetched.push(url.href);
      if (options.stallStore === true) {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        });
      }
      const uri = decodeURIComponent(url.pathname.slice(1));
      const stream = options.streams?.[uri];
      if (stream !== undefined) return new Response(stream(), { status: 200 });
      const object = options.objects?.[uri];
      if (object === undefined) return new Response(null, { status: 404 });
      const bytes = typeof object === "string" ? new TextEncoder().encode(object) : object;
      return new Response(new Blob([new Uint8Array(bytes)]), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
  return boundary;
}

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

async function completedResult(state: Promise<RunResultState>): Promise<RunResults> {
  const answer = await state;
  if (answer.state !== "completed") throw new Error(`run is ${answer.state}`);
  return answer.result;
}

const TEXT_NODE: InputFormItem = {
  kind: "prose",
  concept_ref: "native.Text",
  required: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stored-text concepts", () => {
  it("names the four natives and reads a refinement chain", () => {
    expect(STORED_TEXT_CONCEPT_REFS).toEqual([
      "native.Text",
      "native.Markdown",
      "native.Html",
      "native.JSON",
    ]);
    expect(storedTextKindOf("native.Markdown")).toBe("text");
    expect(storedTextKindOf("native.Html")).toBe("html");
    expect(storedTextKindOf("legal.Memo", ["legal.Note", "native.JSON"])).toBe("json");
    expect(isStoredTextConcept("native.Document")).toBe(false);
    expect(isStoredTextConcept("legal.Contract", ["native.Document"])).toBe(false);
  });

  it("finds the main output's node from the working memory and the output form", () => {
    const node = mainStuffNode(
      results("my_domain.Memo", reference(storedUri("a")), {
        kind: "prose",
        concept_ref: "my_domain.Memo",
        refines: ["native.Text"],
        required: true,
      }) as unknown as RunResults,
    );
    expect(node).toMatchObject({ concept_ref: "my_domain.Memo", refines: ["native.Text"] });
  });

  it("wraps a plural content in a list node", () => {
    const node = mainStuffNode(
      results("native.Text", { items: [reference(storedUri("a"))] }) as unknown as RunResults,
    );
    expect(node).toMatchObject({ kind: "list", item: { concept_ref: "native.Text" } });
  });

  it("describes each stuff of the working memory beside a top-level input field", () => {
    const textUri = storedUri("wm");
    const documentUri = "pipelex-storage://org/assets/brief.pdf";
    const wm = {
      root: {
        summary: { concept: "native.Text", content: reference(textUri) },
        doc: {
          concept: "native.Document",
          content: { url: documentUri, mime_type: "application/pdf", filename: "brief.pdf" },
        },
      },
      aliases: { main_stuff: "summary" },
    };
    // A top-level input field states the slot facts no nested node may carry.
    const documentInput: InputFormTopLevelField = {
      kind: "document",
      name: "doc",
      concept_ref: "native.Document",
      required: true,
      presence: "plain",
      gating: true,
    };
    const node = workingMemoryNode({
      working_memory: wm,
      output_form: {},
      input_form: { "my_domain.summarize": { fields: [documentInput] } },
    });

    expect(node).not.toBeNull();
    expect(locateStoredReferences(wm, node ?? undefined)).toEqual({
      files: [{ uri: documentUri, found_at: ["$.root.doc.content.url"] }],
      texts: [
        {
          uri: textUri,
          found_at: ["$.root.summary.content.url"],
          kind: "text",
          size: 4096,
          mime_type: "text/plain",
          preview: "The start…",
        },
      ],
    });
  });

  it("knows nothing without a working memory", () => {
    expect(mainStuffNode({ main_stuff: { text: "x" } })).toBeNull();
    expect(workingMemoryNode({})).toBeNull();
  });

  it("is exported from the package barrel", () => {
    expect(sdk.loadStoredTexts).toBe(loadStoredTexts);
    expect(sdk.mainStuffNode).toBe(mainStuffNode);
    expect(sdk.StoredTextLoadError).toBe(StoredTextLoadError);
    expect(sdk.STORED_TEXT_CONCEPT_REFS).toBe(STORED_TEXT_CONCEPT_REFS);
  });
});

describe("the result readers load stored texts", () => {
  it("returns a stored Text loaded, resolved in bulk and fetched from its signed link", async () => {
    const uri = storedUri("a");
    const boundary = mockBoundary({
      body: results("native.Text", reference(uri), TEXT_NODE),
      objects: { [uri]: "A long answer, stored by the runtime." },
    });

    const result = await completedResult(makeClient().getRunResult(RUN_ID));

    expect(result.main_stuff).toEqual({ text: "A long answer, stored by the runtime." });
    expect(boundary.resolved).toEqual([[uri]]);
    expect(boundary.fetched).toHaveLength(1);
  });

  it("hands the wire shape back with loadStoredTexts: false, and reads nothing more", async () => {
    const uri = storedUri("a");
    const boundary = mockBoundary({ body: results("native.Text", reference(uri), TEXT_NODE) });

    const result = await completedResult(
      makeClient().getRunResult(RUN_ID, { loadStoredTexts: false }),
    );

    expect(result.main_stuff).toEqual(reference(uri));
    expect(boundary.resolved).toEqual([]);
    expect(boundary.fetched).toEqual([]);
  });

  it("loads through waitForResult, and leaves an inline text and an image alone", async () => {
    const uri = storedUri("b", "md");
    const picture = "pipelex-storage://org/method/run-stored/generated/0f0f.png";
    const mainStuff = {
      title: { text: "Short title" },
      body: reference(uri),
      cover: { url: picture, mime_type: "image/png" },
    };
    const field: InputFormItem = {
      kind: "object",
      concept_ref: "my_domain.Report",
      required: true,
      fields: [
        { kind: "prose", name: "title", concept_ref: "native.Text", required: true },
        { kind: "prose", name: "body", concept_ref: "native.Markdown", required: true },
        { kind: "image", name: "cover", concept_ref: "native.Image", required: true },
      ],
    };
    const boundary = mockBoundary({
      body: results("my_domain.Report", mainStuff, field),
      objects: { [uri]: "# Heading\n\nBody." },
    });

    const result = await makeClient().waitForResult(RUN_ID, { intervalMs: 1 });

    expect(result.main_stuff).toEqual({
      title: { text: "Short title" },
      body: { text: "# Heading\n\nBody." },
      cover: { url: picture, mime_type: "image/png" },
    });
    expect(boundary.resolved).toEqual([[uri]]);
  });

  it("waitForResult's deadline covers the stored-text load", async () => {
    const uri = storedUri("w1");
    const boundary = mockBoundary({
      body: results("native.Text", reference(uri), TEXT_NODE),
      stallStore: true,
    });
    const startedAt = Date.now();

    const failure = await makeClient()
      .waitForResult(RUN_ID, { timeoutMs: 200 })
      .catch((err: unknown) => err);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(failure).toBeInstanceOf(RunTimeoutError);
    expect(failure).toMatchObject({ runId: RUN_ID, timeoutMs: 200 });
    expect((failure as RunTimeoutError).message).toContain(
      `Run ${RUN_ID} completed, but its stored texts did not load within 200ms`,
    );
    expect(boundary.fetched).toHaveLength(1);
  });

  it("startAndWaitForResult's blocking fallback keeps the wire result when a load fails", async () => {
    const uri = storedUri("b1");
    const stored = reference(uri);
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      paths.push(url.pathname);
      switch (url.pathname) {
        case "/v1/version":
          return jsonResponse(200, { protocol_version: "0.6.0", runner_version: "9.9.9" });
        case "/v1/start":
        case "/v1/resolve-storage-url/bulk":
          return jsonResponse(404, { detail: "Not Found" });
        case "/v1/execute":
          return jsonResponse(200, {
            pipeline_run_id: RUN_ID,
            created_at: "t0",
            state: "COMPLETED",
            main_stuff_name: "summary",
            pipe_output: {
              working_memory: memory("native.Text", stored),
              pipeline_run_id: RUN_ID,
            },
          });
        default:
          throw new Error(`unexpected fetch ${url.href}`);
      }
    });

    const failure = await makeClient()
      .startAndWaitForResult({ pipe_code: "p", files: { "main.mthds": "x" } })
      .catch((err: unknown) => err);

    expect(paths).toEqual([
      "/v1/version",
      "/v1/start",
      "/v1/execute",
      "/v1/resolve-storage-url/bulk",
    ]);
    expect(failure).toBeInstanceOf(StoredTextLoadError);
    expect(failure).toMatchObject({ reason: "resolve_failed", path: "$", uri });
    const { wireResults } = failure as StoredTextLoadError;
    expect(wireResults?.pipeline_run_id).toBe(RUN_ID);
    expect(wireResults?.main_stuff).toEqual(stored);
  });

  it("passes the opt-out through waitForResult", async () => {
    const uri = storedUri("a");
    const boundary = mockBoundary({ body: results("native.Text", reference(uri), TEXT_NODE) });

    const result = await makeClient().waitForResult(RUN_ID, { loadStoredTexts: false });

    expect(result.main_stuff).toEqual(reference(uri));
    expect(boundary.resolved).toEqual([]);
  });

  it("keeps an Html's css_class and parses a JSON value into its object", async () => {
    const html = storedUri("c", "html");
    const json = storedUri("d", "json");
    const mainStuff = {
      page: { ...reference(html), mime_type: "text/html", css_class: "report" },
      data: { ...reference(json), mime_type: "application/json" },
    };
    const field: InputFormItem = {
      kind: "object",
      concept_ref: "my_domain.Bundle",
      required: true,
      fields: [
        { kind: "object", name: "page", concept_ref: "native.Html", required: true, fields: [] },
        { kind: "unknown", name: "data", concept_ref: "native.JSON", required: true },
      ],
    };
    mockBoundary({
      body: results("my_domain.Bundle", mainStuff, field),
      objects: { [html]: "<p>Hello</p>", [json]: '{"total": 12345678901234567890, "ok": true}' },
    });

    const result = await completedResult(makeClient().getRunResult(RUN_ID));

    expect(result.main_stuff).toEqual({
      page: { inner_html: "<p>Hello</p>", css_class: "report" },
      data: { json_obj: { total: 12345678901234567890n, ok: true } },
    });
  });

  it("reads a concept that refines a stored native through the output form's refines", async () => {
    const uri = storedUri("e");
    mockBoundary({
      body: results("my_domain.Memo", reference(uri), {
        kind: "prose",
        concept_ref: "my_domain.Memo",
        refines: ["native.Text"],
        required: true,
      }),
      objects: { [uri]: "A memo." },
    });

    const result = await completedResult(makeClient().getRunResult(RUN_ID));

    expect(result.main_stuff).toEqual({ text: "A memo." });
  });

  it("loads a page's text by the native's shape when no form describes it", async () => {
    const uri = storedUri("f");
    const picture = "pipelex-storage://org/method/run-stored/generated/1a1a.png";
    const page = {
      text_and_images: { text: reference(uri), images: [{ url: picture }] },
      page_view: { url: picture },
    };
    mockBoundary({
      body: results("native.Page", { items: [page] }),
      objects: { [uri]: "Page 1." },
    });

    const result = await completedResult(makeClient().getRunResult(RUN_ID));

    expect(result.main_stuff).toEqual({
      items: [
        {
          text_and_images: { text: { text: "Page 1." }, images: [{ url: picture }] },
          page_view: { url: picture },
        },
      ],
    });
  });

  it(`resolves at most ${BULK_RESOLVE_MAX_URIS} references per request, batched past that`, async () => {
    const count = BULK_RESOLVE_MAX_URIS + 30;
    const uris = Array.from({ length: count }, (_unused, index) => storedUri(`p${index}`));
    const objects = Object.fromEntries(uris.map((uri, index) => [uri, `Page ${index}.`]));
    const boundary = mockBoundary({
      body: results("native.Text", { items: uris.map((uri) => reference(uri)) }),
      objects,
    });

    const result = await completedResult(makeClient().getRunResult(RUN_ID));

    expect(boundary.resolved.map((chunk) => chunk.length)).toEqual([BULK_RESOLVE_MAX_URIS, 30]);
    expect((result.main_stuff as { items: unknown[] }).items[count - 1]).toEqual({
      text: `Page ${count - 1}.`,
    });
  });

  it("reads the concepts beside a narrowed read, and returns only what it was asked for", async () => {
    const uri = storedUri("g");
    const body = results("native.Text", reference(uri), TEXT_NODE);
    const boundary = mockBoundary({
      body: { pipeline_run_id: RUN_ID, main_stuff: body["main_stuff"] },
      conceptsBody: body,
      objects: { [uri]: "Narrowed." },
    });

    const result = await completedResult(
      makeClient().getRunResult(RUN_ID, { artifacts: ["main_stuff"] }),
    );

    expect(result).toEqual({ pipeline_run_id: RUN_ID, main_stuff: { text: "Narrowed." } });
    expect(boundary.reads).toEqual(["main_stuff", "working_memory,output_form,input_form"]);
  });

  it("a narrowed read of an image output makes no concept re-read", async () => {
    const picture = "pipelex-storage://org/method/run-stored/generated/0f0f.png";
    const image = {
      url: picture,
      mime_type: "image/png",
      public_url: "https://cdn.example/0f0f.png",
    };
    const body = results("native.Image", image, {
      kind: "image",
      concept_ref: "native.Image",
      required: true,
    });
    const boundary = mockBoundary({
      body: { pipeline_run_id: RUN_ID, main_stuff: image },
      conceptsBody: body,
    });

    const result = await completedResult(
      makeClient().getRunResult(RUN_ID, { artifacts: ["main_stuff"] }),
    );

    expect(result.main_stuff).toEqual(image);
    expect(boundary.reads).toEqual(["main_stuff"]);
    expect(boundary.resolved).toEqual([]);
  });

  it("reads nothing more for a narrowed read whose output holds no reference", async () => {
    const boundary = mockBoundary({
      body: { pipeline_run_id: RUN_ID, main_stuff: { text: "Inline." } },
    });

    const result = await completedResult(
      makeClient().getRunResult(RUN_ID, { artifacts: ["main_stuff"] }),
    );

    expect(result.main_stuff).toEqual({ text: "Inline." });
    expect(boundary.reads).toEqual(["main_stuff"]);
  });

  it("refuses a stored text that is not UTF-8, naming where it sits", async () => {
    const uri = storedUri("h");
    mockBoundary({
      body: results("native.Text", reference(uri), TEXT_NODE),
      objects: { [uri]: new Uint8Array([0xff, 0xfe, 0x00]) },
    });

    const failure = await makeClient()
      .getRunResult(RUN_ID)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(StoredTextLoadError);
    expect(failure).toMatchObject({ uri, path: "$", reason: "not_utf8" });
    expect((failure as StoredTextLoadError).problem.code).toBe("client.response_unreadable");
  });

  it("refuses a reference the resolve route refuses, with the route's code", async () => {
    const uri = storedUri("i");
    mockBoundary({
      body: results("native.Text", { items: [{ text: "ok" }, reference(uri)] }),
      refusals: {
        [uri]: {
          uri,
          url: null,
          expires_at: null,
          content_type: null,
          error: { code: "pipelex.org.mismatch", detail: "Another organization's reference." },
        },
      },
    });

    const failure = await makeClient()
      .getRunResult(RUN_ID)
      .catch((err: unknown) => err);

    expect(failure).toMatchObject({
      name: "StoredTextLoadError",
      uri,
      path: "$.items[1]",
      reason: "pipelex.org.mismatch",
    });
  });

  it.each(["pipelex.org.mismatch", "pipelex.storage.uri_invalid"])(
    "reads the platform's %s as input.reference_not_found",
    async (code) => {
      const uri = storedUri("x1");
      mockBoundary({
        body: results("native.Text", reference(uri), TEXT_NODE),
        refusals: {
          [uri]: {
            uri,
            url: null,
            expires_at: null,
            content_type: null,
            error: { code, detail: "Refused." },
          },
        },
      });

      const failure = await makeClient()
        .getRunResult(RUN_ID)
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(StoredTextLoadError);
      expect(failure).toMatchObject({ reason: code, wireResults: undefined });
      expect((failure as StoredTextLoadError).problem.code).toBe("input.reference_not_found");
    },
  );

  it("refuses a stored text at a foreign URL without fetching it", async () => {
    const foreign = "https://10.0.0.5/admin";
    const boundary = mockBoundary({ body: results("native.Text", { url: foreign }, TEXT_NODE) });
    const client = makeClient();

    const failure = await client.getRunResult(RUN_ID).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(StoredTextLoadError);
    expect(failure).toMatchObject({ uri: foreign, path: "$", reason: "unsupported_url" });
    expect((failure as StoredTextLoadError).problem.code).toBe("client.link_refused");
    expect(boundary.reads).toEqual([null]);
    expect(boundary.resolved).toEqual([]);
    expect(boundary.fetched).toEqual([]);
    const calls = vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
    expect(calls.some((called) => called.includes("10.0.0.5"))).toBe(false);
    // Turned off, the reader hands the reference back as written, still without reading it.
    const wire = await completedResult(client.getRunResult(RUN_ID, { loadStoredTexts: false }));
    expect(wire.main_stuff).toEqual({ url: foreign });
    expect(boundary.fetched).toEqual([]);
  });

  it("names the first text when the resolve route fails as a whole", async () => {
    const uri = storedUri("x2");
    mockBoundary({ body: results("native.Text", reference(uri), TEXT_NODE) });
    const boundaryFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/resolve-storage-url/bulk") {
        return jsonResponse(404, { detail: "Not Found" });
      }
      return boundaryFetch(input, init);
    });

    const failure = await makeClient()
      .getRunResult(RUN_ID)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(StoredTextLoadError);
    expect(failure).toMatchObject({ uri, path: "$", reason: "resolve_failed", status: 404 });
  });

  it("refuses a stored text the store no longer holds", async () => {
    const uri = storedUri("j");
    mockBoundary({ body: results("native.Text", reference(uri), TEXT_NODE) });

    const failure = await makeClient()
      .getRunResult(RUN_ID)
      .catch((err: unknown) => err);

    expect(failure).toMatchObject({ name: "StoredTextLoadError", reason: "not_found" });
  });
});

describe("loadStoredTexts", () => {
  it("loads a result read with the loading off, and never changes the one passed in", async () => {
    const uri = storedUri("k");
    const body = results("native.Text", reference(uri), TEXT_NODE);
    mockBoundary({ body, objects: { [uri]: "Later." } });
    const client = makeClient();
    const wire = await completedResult(client.getRunResult(RUN_ID, { loadStoredTexts: false }));

    const loaded = await loadStoredTexts(client, wire);

    expect(loaded.main_stuff).toEqual({ text: "Later." });
    expect(wire.main_stuff).toEqual(reference(uri));
  });

  it("decodes a data URL without any request", async () => {
    const boundary = mockBoundary({ body: {} });
    const dataUrl = `data:text/plain;base64,${btoa("Inline bytes.")}`;
    const wire = results("native.Text", { url: dataUrl }) as unknown as RunResults;

    const loaded = await loadStoredTexts(makeClient(), wire);

    expect(loaded.main_stuff).toEqual({ text: "Inline bytes." });
    expect(boundary.resolved).toEqual([]);
  });

  it("returns a result whose concepts are unknown as it is when nothing in it looks like a stored text", async () => {
    const wire = { pipeline_run_id: RUN_ID, main_stuff: { text: "Inline." } };
    expect(await loadStoredTexts(makeClient(), wire)).toBe(wire);
  });
});

describe("a result that does not say which values are texts", () => {
  const REPORT_FIELD: InputFormItem = {
    kind: "object",
    concept_ref: "my_domain.Report",
    required: true,
    fields: [{ kind: "prose", name: "summary", concept_ref: "native.Text", required: true }],
  };

  it("fails a result without a working memory rather than handing on its reference", async () => {
    const uri = storedUri("n1");
    const boundary = mockBoundary({ body: {} });
    const wire = { pipeline_run_id: RUN_ID, main_stuff: { summary: reference(uri) } };

    const failure = await loadStoredTexts(makeClient(), wire).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(StoredTextLoadError);
    expect(failure).toMatchObject({ reason: STORED_TEXT_CONCEPTS_MISSING, path: "$.summary", uri });
    expect((failure as StoredTextLoadError).message).toContain("working_memory");
    expect(boundary.resolved).toEqual([]);
  });

  it("fails a structured output whose output form is not written rather than handing on its texts", async () => {
    const uri = storedUri("n2");
    const body = { ...results("my_domain.Report", { summary: reference(uri) }), output_form: null };
    const boundary = mockBoundary({ body });

    const failure = await makeClient()
      .getRunResult(RUN_ID)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(StoredTextLoadError);
    expect(failure).toMatchObject({ reason: "concepts_missing", path: "$.summary" });
    expect((failure as StoredTextLoadError).message).toContain("output_form");
    expect(boundary.resolved).toEqual([]);
    expect(lacksStoredTextConcepts(body as unknown as RunResults)).toBe(true);
  });

  it("needs no form for a native concept", () => {
    const body = { ...results("native.Text", reference(storedUri("n3"))), output_form: null };
    expect(lacksStoredTextConcepts(body as unknown as RunResults)).toBe(false);
  });

  it("waitForResult waits through the window where the output form is not yet written", async () => {
    const uri = storedUri("n4");
    const described = results("my_domain.Report", { summary: reference(uri) }, REPORT_FIELD);
    const boundary = mockBoundary({
      body: described,
      bodies: [{ ...described, output_form: null }, described],
      objects: { [uri]: "The summary." },
    });

    const result = await makeClient().waitForResult(RUN_ID, { intervalMs: 1 });

    expect(result.main_stuff).toEqual({ summary: { text: "The summary." } });
    expect(boundary.reads).toEqual([null, null]);
    expect(boundary.resolved).toEqual([[uri]]);
  });

  it("waitForResult fails once the output form never arrives", async () => {
    const uri = storedUri("n5");
    const body = { ...results("my_domain.Report", { summary: reference(uri) }), output_form: null };
    const boundary = mockBoundary({ body });

    const failure = await makeClient()
      .waitForResult(RUN_ID, { intervalMs: 1 })
      .catch((err: unknown) => err);

    expect(failure).toMatchObject({ name: "StoredTextLoadError", reason: "concepts_missing" });
    expect(boundary.reads).toHaveLength(MAX_CONCEPTS_MISSING_POLLS + 1);
    expect(boundary.resolved).toEqual([]);
  });
});

describe("a stored-text load is bounded", () => {
  it("refuses texts whose declared sizes together cross the total cap, before anything is sent", async () => {
    const uris = ["t1", "t2", "t3"].map((hash) => storedUri(hash));
    const boundary = mockBoundary({ body: {} });
    const wire = results("native.Text", {
      items: uris.map((uri) => reference(uri)),
    }) as unknown as RunResults;

    const failure = await loadStoredTexts(makeClient(), wire, { maxTotalBytes: 10_000 }).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(StoredTextLoadError);
    expect(failure).toMatchObject({ reason: "total_limit_exceeded", path: "$.items[2]" });
    expect((failure as StoredTextLoadError).message).toContain("total limit");
    expect(boundary.resolved).toEqual([]);
    expect(boundary.fetched).toEqual([]);
  });

  it("refuses a text whose declared size is over the cap on one text, before anything is sent", async () => {
    const uri = storedUri("t4");
    const boundary = mockBoundary({ body: {} });
    const wire = results("native.Text", reference(uri)) as unknown as RunResults;

    const failure = await loadStoredTexts(makeClient(), wire, { maxBytes: 1_000 }).catch(
      (err: unknown) => err,
    );

    expect(failure).toMatchObject({ name: "StoredTextLoadError", reason: "too_large", path: "$" });
    expect(boundary.resolved).toEqual([]);
  });

  it("fails the load once the bytes read together cross the total cap, stopping every read", async () => {
    const uris = ["u1", "u2", "u3"].map((hash) => storedUri(hash));
    const cancelled: string[] = [];
    // Sends its bytes, then nothing more, never ending on its own.
    const endless = (uri: string) => (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4_000).fill(0x61));
        },
        cancel() {
          cancelled.push(uri);
        },
      });
    mockBoundary({
      body: {},
      streams: Object.fromEntries(uris.map((uri) => [uri, endless(uri)])),
    });
    // Each reference understates its size: only the bytes read tell.
    const wire = results("native.Text", {
      items: uris.map((uri) => ({ ...reference(uri), size: 1 })),
    }) as unknown as RunResults;

    const failure = await loadStoredTexts(makeClient(), wire, { maxTotalBytes: 10_000 }).catch(
      (err: unknown) => err,
    );

    expect(failure).toMatchObject({ name: "StoredTextLoadError", reason: "total_limit_exceeded" });
    expect([...cancelled].sort()).toEqual([...uris].sort());
  });

  it("refuses a data: URL over the cap without decoding it", async () => {
    const decode = vi.spyOn(globalThis, "atob");
    const wire = results("native.Text", {
      url: `data:text/plain;base64,${"A".repeat(400)}`,
      size: 1,
    }) as unknown as RunResults;

    const failure = await loadStoredTexts(makeClient(), wire, { maxBytes: 100 }).catch(
      (err: unknown) => err,
    );

    expect(failure).toMatchObject({ name: "StoredTextLoadError", reason: "too_large" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("counts a data: URL's bytes against the total cap", async () => {
    const payload = btoa("x".repeat(600));
    const wire = results("native.Text", {
      items: [
        { url: `data:text/plain;base64,${payload}` },
        { url: `data:text/plain;base64,${payload}` + "eA==" },
      ],
    }) as unknown as RunResults;

    const failure = await loadStoredTexts(makeClient(), wire, {
      maxTotalBytes: 1_000,
      concurrency: 1,
    }).catch((err: unknown) => err);

    expect(failure).toMatchObject({ reason: "total_limit_exceeded", path: "$.items[1]" });
  });

  it("refuses malformed base64 rather than decoding it truncated, and accepts unpadded base64 as atob does", async () => {
    const malformed = results("native.Text", {
      url: "data:text/plain;base64,QUJDa",
    }) as unknown as RunResults;
    await expect(loadStoredTexts(makeClient(), malformed)).rejects.toMatchObject({
      reason: "unsupported_url",
    });

    const unpadded = results("native.Text", {
      url: "data:text/plain;base64,QUI",
    }) as unknown as RunResults;
    expect((await loadStoredTexts(makeClient(), unpadded)).main_stuff).toEqual({ text: "AB" });
  });

  it("refuses a base64 payload a backtracking pattern would stall on, at once", async () => {
    const wire = results("native.Text", {
      url: `data:text/plain;base64,A${" ".repeat(200_000)}!`,
    }) as unknown as RunResults;
    const startedAt = Date.now();

    await expect(loadStoredTexts(makeClient(), wire)).rejects.toMatchObject({
      reason: "unsupported_url",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("a stored text's link about to expire", () => {
  it("is resolved again just before its read", async () => {
    const uri = storedUri("e1");
    const boundary = mockBoundary({
      body: results("native.Text", reference(uri), TEXT_NODE),
      objects: { [uri]: "Fresh." },
      expiresAt: (_uri, call) =>
        new Date(Date.now() + (call === 0 ? -1_000 : 900_000)).toISOString(),
    });

    const result = await completedResult(makeClient().getRunResult(RUN_ID));

    expect(result.main_stuff).toEqual({ text: "Fresh." });
    expect(boundary.resolved).toEqual([[uri], [uri]]);
    expect(boundary.fetched).toHaveLength(1);
  });

  it("is read at once while it is still fresh", async () => {
    const uri = storedUri("e2");
    const boundary = mockBoundary({
      body: results("native.Text", reference(uri), TEXT_NODE),
      objects: { [uri]: "Fresh." },
    });

    await completedResult(makeClient().getRunResult(RUN_ID));

    expect(boundary.resolved).toEqual([[uri]]);
  });
});

describe("the walkers tell stored texts from files by concept", () => {
  const textUri = storedUri("m");
  const pdfUri = "pipelex-storage://org/method/run-stored/generated/notes.txt";
  const value = {
    summary: reference(textUri),
    notes: { url: pdfUri, mime_type: "text/plain", filename: "notes.txt" },
  };
  const node: InputFormItem = {
    kind: "object",
    concept_ref: "my_domain.Dossier",
    required: true,
    fields: [
      { kind: "prose", name: "summary", concept_ref: "native.Text", required: true },
      { kind: "document", name: "notes", concept_ref: "native.Document", required: true },
    ],
  };

  it("counts a Document typed text/plain as a file and a stored Text as none", () => {
    expect(collectArtifacts(value, node)).toEqual([pdfUri]);
    expect(locateArtifacts(value, node)).toEqual([{ uri: pdfUri, found_at: ["$.notes.url"] }]);
  });

  it("counts every reference when nothing says what the values are", () => {
    expect(collectArtifacts(value)).toEqual([textUri, pdfUri]);
  });

  it("tells the stored texts from the files and states what each reference says", () => {
    const html = { url: storedUri("h", "html"), size: 9, mime_type: "text/html", preview: "<p>" };
    const described: InputFormItem = {
      ...node,
      fields: [
        ...(node.kind === "object" ? node.fields : []),
        { kind: "prose", name: "page", concept_ref: "native.Html", required: true },
      ],
    } as InputFormItem;

    expect(locateStoredReferences({ ...value, page: html }, described)).toEqual({
      files: [{ uri: pdfUri, found_at: ["$.notes.url"] }],
      texts: [
        {
          uri: textUri,
          found_at: ["$.summary.url"],
          kind: "text",
          size: 4096,
          mime_type: "text/plain",
          preview: "The start…",
        },
        {
          uri: html.url,
          found_at: ["$.page.url"],
          kind: "html",
          size: 9,
          mime_type: "text/html",
          preview: "<p>",
        },
      ],
    });
    expect(locateStoredReferences(value)).toEqual({
      files: [
        { uri: textUri, found_at: ["$.summary.url"] },
        { uri: pdfUri, found_at: ["$.notes.url"] },
      ],
      texts: [],
    });
  });

  it("treats a description-only concept as a stored text, a structured one as none", () => {
    expect(
      storedTextKindOfNode({ kind: "prose", concept_ref: "legal.Clause", required: true }),
    ).toBe("text");
    expect(
      storedTextKindOfNode({
        kind: "prose",
        concept_ref: "legal.Special",
        refines: ["legal.Clause"],
        required: true,
      }),
    ).toBe("text");
    expect(
      storedTextKindOfNode({
        kind: "text",
        concept_ref: "legal.When",
        refines: ["native.Time"],
        required: true,
      }),
    ).toBeNull();
    expect(storedTextKindOfNode({ kind: "text", required: true })).toBeNull();
    expect(
      storedTextKindOfNode({
        kind: "object",
        concept_ref: "legal.Contract",
        required: true,
        fields: [],
      }),
    ).toBeNull();
  });

  it("names a saved stored text by its MIME type, never its storage key", () => {
    const markdown = {
      uri: storedUri("md", "bin"),
      found_at: ["$.summary.url"],
      kind: "text" as const,
      size: 3,
      mime_type: "text/markdown",
      preview: "# A",
    };
    expect(artifactFilename(markdown, null, "main_stuff")).toBe("summary.md");
    expect(artifactFilename({ ...markdown, mime_type: null }, null, "main_stuff")).toBe(
      "summary.txt",
    );
    expect(
      artifactFilename({ uri: markdown.uri, found_at: markdown.found_at }, null, "main_stuff"),
    ).toBe("summary.bin");
  });

  it("downloadArtifacts saves a stored text as a text file named by its MIME type", async () => {
    const markdownUri = storedUri("n", "bin");
    const mainStuff = {
      summary: { url: markdownUri, size: 9, mime_type: "text/markdown", preview: "# Title" },
      notes: { url: pdfUri, mime_type: "text/plain", filename: "notes.txt" },
    };
    const boundary = mockBoundary({
      body: {},
      objects: { [markdownUri]: "# Title\n", [pdfUri]: "plain notes" },
    });
    const run = { ...results("my_domain.Dossier", mainStuff, node) } as unknown as RunResults;
    const dir = await mkdtemp(join(tmpdir(), "stored-texts-"));
    try {
      const verdict = await downloadArtifacts(makeClient(), { results: run, dir });

      expect(boundary.resolved).toEqual([[markdownUri, pdfUri]]);
      expect(verdict.all_saved).toBe(true);
      expect(verdict.artifacts).toEqual([
        {
          uri: markdownUri,
          kind: "text",
          found_at: ["$.summary.url"],
          path: join(dir, "summary.md"),
          content_type: "text/markdown",
          size: 8,
          error: null,
        },
        {
          uri: pdfUri,
          kind: "file",
          found_at: ["$.notes.url"],
          path: join(dir, "notes.txt"),
          content_type: "text/plain",
          size: 11,
          error: null,
        },
      ]);
      expect(await readFile(join(dir, "summary.md"), "utf8")).toBe("# Title\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("downloadArtifacts by run id reads the concepts only beside a stored text", async () => {
    const markdownUri = storedUri("o", "md");
    const mainStuff = {
      summary: { url: markdownUri, size: 8, mime_type: "text/markdown", preview: "# Title" },
      notes: { url: pdfUri, mime_type: "text/plain", filename: "notes.txt" },
    };
    const body = results("my_domain.Dossier", mainStuff, node);
    const boundary = mockBoundary({
      body: { pipeline_run_id: RUN_ID, main_stuff: mainStuff },
      conceptsBody: body,
      objects: { [markdownUri]: "# Title\n", [pdfUri]: "plain notes" },
    });
    const dir = await mkdtemp(join(tmpdir(), "stored-texts-"));
    try {
      const verdict = await downloadArtifacts(makeClient(), { run_id: RUN_ID, dir });

      expect(boundary.reads).toEqual(["main_stuff", "working_memory,output_form,input_form"]);
      expect(verdict.artifacts.map((item) => [item.kind, item.found_at])).toEqual([
        ["text", ["$.summary.url"]],
        ["file", ["$.notes.url"]],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
