/**
 * Result artifacts handed back by reference — `RunResults.artifact_links`. When inline they would
 * take the results body past the API Gateway's limit, the platform answers each of the largest
 * artifacts as `null` beside a signed link to its stored file. The result readers follow those
 * links by default, before the main-stuff check and the stored-text load; `followArtifactLinks:
 * false` hands them back untouched, for a caller that passes the link on. The fetch boundary is
 * mocked per URL: the results route, the bulk resolve route and the object store.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ArtifactFetchError, MissingMainStuffError } from "../src/errors.js";
import {
  RUN_ARTIFACT_UNREADABLE,
  followArtifactLinks,
  parseRunArtifact,
} from "../src/run-artifact-links.js";
import type { RunResults, RunResultState } from "../src/runs.js";
import * as sdk from "../src/index.js";

const BASE_URL = "http://localhost:8081";
const RUN_ID = "run-referenced";
const STORE = "https://store.example";
const SIGNATURE = "X-Amz-Signature=deadbeef";
const STORED_TEXT = "pipelex-storage://org/method/run-referenced/generated/a/value.txt";

/** The signed link the platform hands back for one artifact's stored file. */
function linkTo(file: string): { url: string; expires_at: string } {
  return {
    url: `${STORE}/results/${file}?${SIGNATURE}`,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
  };
}

const MEMORY = {
  root: { summary: { concept: "native.Text", content: { text: "Short." } } },
  aliases: { main_stuff: "summary" },
};

const GRAPH = { meta: { mode: "live" } };

const USAGE_ENVELOPE = {
  tokens_usages: [{ model: "m", cost: 0.25 }],
  usage_assembly_error: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Boundary {
  /** The `?artifacts=` of each results read, `null` for a read of every artifact. */
  reads: (string | null)[];
  /** The paths fetched from the object store. */
  fetched: string[];
}

/**
 * The results route answers `body`, the object store answers each stored file `files` holds by
 * its name (a 403 for one it does not), and the bulk route resolves a stored text to the store.
 */
function mockBoundary(options: {
  body: Record<string, unknown>;
  files?: Record<string, string>;
  texts?: Record<string, string>;
}): Boundary {
  const boundary: Boundary = { reads: [], fetched: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === `/v1/runs/${RUN_ID}/results`) {
      boundary.reads.push(url.searchParams.get("artifacts"));
      return jsonResponse(200, options.body);
    }
    if (url.pathname === "/v1/resolve-storage-url/bulk") {
      const { uris } = JSON.parse(String(init?.body)) as { uris: string[] };
      const items = uris.map((uri) => ({
        uri,
        url: `${STORE}/texts/${encodeURIComponent(uri)}`,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        content_type: "text/plain",
        error: null,
      }));
      return jsonResponse(200, { items });
    }
    if (url.origin === STORE) {
      boundary.fetched.push(url.pathname);
      if (url.pathname.startsWith("/texts/")) {
        const text = options.texts?.[decodeURIComponent(url.pathname.slice("/texts/".length))];
        return text === undefined ? new Response(null, { status: 404 }) : new Response(text);
      }
      const file = options.files?.[url.pathname.slice("/results/".length)];
      return file === undefined ? new Response(null, { status: 403 }) : new Response(file);
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

/** A body that handed `main_stuff`, `graph_spec` and the usage envelope back by reference. */
function referencedBody(): Record<string, unknown> {
  return {
    pipeline_run_id: RUN_ID,
    main_stuff: null,
    working_memory: MEMORY,
    graph_spec: null,
    pipe_io_contracts: null,
    input_form: null,
    output_form: null,
    tokens_usages: null,
    usage_assembly_error: null,
    artifact_links: {
      main_stuff: linkTo("main_stuff.json"),
      graph_spec: linkTo("graphspec.json"),
      tokens_usages: linkTo("tokens_usages.json"),
    },
  };
}

/** The stored files of {@link referencedBody}, written as the runner writes them. */
const REFERENCED_FILES = {
  "main_stuff.json": JSON.stringify({ text: "Short." }),
  // An integer past 2^53, written with its exact digits.
  "graphspec.json": '{"meta":{"mode":"live"},"nodes":[{"id":"n1","cost":12345678901234567890}]}',
  "tokens_usages.json": JSON.stringify(USAGE_ENVELOPE),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRunArtifact", () => {
  it("reads an artifact exactly into its own field", () => {
    expect(parseRunArtifact("graph_spec", REFERENCED_FILES["graphspec.json"])).toEqual({
      graph_spec: { ...GRAPH, nodes: [{ id: "n1", cost: 12345678901234567890n }] },
    });
  });

  it("unpacks the usage envelope onto both usage fields", () => {
    expect(
      parseRunArtifact(
        "tokens_usages",
        JSON.stringify({ tokens_usages: [], usage_assembly_error: "boom" }),
      ),
    ).toEqual({ tokens_usages: [], usage_assembly_error: "boom" });
    expect(parseRunArtifact("tokens_usages", "{}")).toEqual({
      tokens_usages: null,
      usage_assembly_error: null,
    });
  });

  it("refuses a file that is not JSON, or a usage file that is no envelope", () => {
    const notJson = (): unknown => parseRunArtifact("main_stuff", "<html>");
    expect(notJson).toThrow(ArtifactFetchError);
    expect(notJson).toThrow(/main_stuff artifact handed back by reference could not be read/);
    try {
      parseRunArtifact("tokens_usages", "[]");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactFetchError);
      expect((error as ArtifactFetchError).reason).toBe(RUN_ARTIFACT_UNREADABLE);
      expect((error as ArtifactFetchError).uri).toBe("artifact_links.tokens_usages");
      expect((error as ArtifactFetchError).problem.code).toBe("client.response_unreadable");
    }
  });

  it("travels with the barrel", () => {
    expect(sdk.parseRunArtifact).toBe(parseRunArtifact);
    expect(sdk.followArtifactLinks).toBe(followArtifactLinks);
    expect(sdk.RUN_ARTIFACT_UNREADABLE).toBe("unreadable");
  });
});

describe("the result readers follow artifact_links by default", () => {
  it("fills every referenced field from its stored file and drops the links", async () => {
    const boundary = mockBoundary({ body: referencedBody(), files: REFERENCED_FILES });

    const result = await completedResult(makeClient().getRunResult(RUN_ID));

    expect(result.main_stuff).toEqual({ text: "Short." });
    expect(result.graph_spec).toEqual({
      ...GRAPH,
      nodes: [{ id: "n1", cost: 12345678901234567890n }],
    });
    expect(result.tokens_usages).toEqual(USAGE_ENVELOPE.tokens_usages);
    expect(result.usage_assembly_error).toBeNull();
    expect(result).not.toHaveProperty("artifact_links");
    expect([...boundary.fetched].sort()).toEqual([
      "/results/graphspec.json",
      "/results/main_stuff.json",
      "/results/tokens_usages.json",
    ]);
  });

  it("follows through waitForResult, a referenced working memory telling the load what is a text", async () => {
    const memory = {
      root: { summary: { concept: "native.Text", content: { url: STORED_TEXT } } },
      aliases: { main_stuff: "summary" },
    };
    const boundary = mockBoundary({
      body: {
        pipeline_run_id: RUN_ID,
        main_stuff: { url: STORED_TEXT, size: 12, mime_type: "text/plain", preview: "A long" },
        working_memory: null,
        output_form: {},
        input_form: {},
        artifact_links: { working_memory: linkTo("working_memory.json") },
      },
      files: { "working_memory.json": JSON.stringify(memory) },
      texts: { [STORED_TEXT]: "A long text." },
    });

    const result = await makeClient().waitForResult(RUN_ID, { intervalMs: 1 });

    expect(result.main_stuff).toEqual({ text: "A long text." });
    expect(result.working_memory).toEqual(memory);
    expect(result).not.toHaveProperty("artifact_links");
    // One results read: no `concepts_missing` re-poll.
    expect(boundary.reads).toEqual([null]);
  });

  it("names the link, never the signed URL, when the store refuses it", async () => {
    mockBoundary({ body: referencedBody(), files: {} });

    const failure = await makeClient()
      .getRunResult(RUN_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArtifactFetchError);
    const error = failure as ArtifactFetchError;
    expect(error.uri).toMatch(/^artifact_links\./);
    expect(error.status).toBe(403);
    expect(error.message).not.toContain(SIGNATURE);
  });
});

describe("followArtifactLinks: false hands the links back", () => {
  it("does not fetch, and a referenced main_stuff is no MissingMainStuffError", async () => {
    const boundary = mockBoundary({ body: referencedBody(), files: REFERENCED_FILES });

    const result = await completedResult(
      makeClient().getRunResult(RUN_ID, { followArtifactLinks: false }),
    );

    expect(result.main_stuff).toBeNull();
    expect(result.graph_spec).toBeNull();
    expect(result.artifact_links?.main_stuff?.url).toBe(linkTo("main_stuff.json").url);
    expect(Object.keys(result.artifact_links ?? {}).sort()).toEqual([
      "graph_spec",
      "main_stuff",
      "tokens_usages",
    ]);
    expect(boundary.fetched).toEqual([]);
  });

  it("still throws MissingMainStuffError for a null main_stuff with no link", async () => {
    mockBoundary({
      body: { ...referencedBody(), artifact_links: { graph_spec: linkTo("graphspec.json") } },
    });

    await expect(
      makeClient().getRunResult(RUN_ID, { followArtifactLinks: false }),
    ).rejects.toBeInstanceOf(MissingMainStuffError);
  });

  it("returns the links from waitForResult too", async () => {
    const boundary = mockBoundary({ body: referencedBody(), files: REFERENCED_FILES });

    const result = await makeClient().waitForResult(RUN_ID, {
      intervalMs: 1,
      followArtifactLinks: false,
    });

    expect(result.main_stuff).toBeNull();
    expect(result.artifact_links?.tokens_usages).toBeDefined();
    expect(boundary.fetched).toEqual([]);
  });

  it("reads a referenced working memory for the stored-text load alone, keeping its link", async () => {
    const memory = {
      root: { summary: { concept: "native.Text", content: { url: STORED_TEXT } } },
      aliases: { main_stuff: "summary" },
    };
    const boundary = mockBoundary({
      body: {
        pipeline_run_id: RUN_ID,
        main_stuff: { url: STORED_TEXT, size: 12, mime_type: "text/plain", preview: "A long" },
        working_memory: null,
        output_form: {},
        input_form: {},
        artifact_links: { working_memory: linkTo("working_memory.json") },
      },
      files: { "working_memory.json": JSON.stringify(memory) },
      texts: { [STORED_TEXT]: "A long text." },
    });

    const result = await completedResult(
      makeClient().getRunResult(RUN_ID, { followArtifactLinks: false }),
    );

    expect(result.main_stuff).toEqual({ text: "A long text." });
    expect(result.working_memory).toBeNull();
    expect(result.artifact_links?.working_memory).toBeDefined();
    expect(boundary.fetched).toContain("/results/working_memory.json");
  });

  it("follows later with followArtifactLinks, only the named links when asked", async () => {
    const boundary = mockBoundary({ body: referencedBody(), files: REFERENCED_FILES });
    const client = makeClient();
    const read = await completedResult(client.getRunResult(RUN_ID, { followArtifactLinks: false }));

    const partly = await client.followArtifactLinks(read, { artifacts: ["graph_spec"] });

    expect(partly).not.toBe(read);
    expect(read.graph_spec).toBeNull();
    expect(partly.graph_spec).toMatchObject({ meta: { mode: "live" } });
    expect(Object.keys(partly.artifact_links ?? {}).sort()).toEqual([
      "main_stuff",
      "tokens_usages",
    ]);
    expect(boundary.fetched).toEqual(["/results/graphspec.json"]);

    const whole = await client.followArtifactLinks(partly);
    expect(whole.main_stuff).toEqual({ text: "Short." });
    expect(whole).not.toHaveProperty("artifact_links");
    expect(await client.followArtifactLinks(whole)).toBe(whole);
  });

  it("fetches one artifact with fetchRunArtifact", async () => {
    mockBoundary({ body: referencedBody(), files: REFERENCED_FILES });

    const fields = await makeClient().fetchRunArtifact(
      "tokens_usages",
      linkTo("tokens_usages.json"),
    );

    expect(fields).toEqual(USAGE_ENVELOPE);
  });
});

describe("what the review asked of following", () => {
  const STORED_MEMORY = {
    root: { summary: { concept: "native.Text", content: { url: STORED_TEXT } } },
    aliases: { main_stuff: "summary" },
  };
  const STORED_REFERENCE = {
    url: STORED_TEXT,
    size: 12,
    mime_type: "text/plain",
    preview: "A long",
  };

  it("refuses a file holding a number JSON.parse would read as Infinity, as an inline answer is", () => {
    try {
      parseRunArtifact("graph_spec", '{"cost":1e999}');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactFetchError);
      expect((error as ArtifactFetchError).reason).toBe(RUN_ARTIFACT_UNREADABLE);
    }
  });

  it("refuses an empty selection to follow", async () => {
    mockBoundary({ body: referencedBody(), files: REFERENCED_FILES });
    const client = makeClient();
    const read = await completedResult(client.getRunResult(RUN_ID, { followArtifactLinks: false }));

    await expect(client.followArtifactLinks(read, { artifacts: [] })).rejects.toMatchObject({
      problem: { code: "client.argument_invalid" },
    });
  });

  it("waits fetching what the load reads before the other links", async () => {
    const boundary = mockBoundary({
      body: {
        pipeline_run_id: RUN_ID,
        main_stuff: STORED_REFERENCE,
        working_memory: null,
        graph_spec: null,
        output_form: {},
        input_form: {},
        artifact_links: {
          graph_spec: linkTo("graphspec.json"),
          working_memory: linkTo("working_memory.json"),
        },
      },
      files: {
        "working_memory.json": JSON.stringify(STORED_MEMORY),
        "graphspec.json": REFERENCED_FILES["graphspec.json"],
      },
      texts: { [STORED_TEXT]: "A long text." },
    });

    const result = await makeClient().waitForResult(RUN_ID, { intervalMs: 10 });

    expect(result.main_stuff).toEqual({ text: "A long text." });
    expect(result).not.toHaveProperty("artifact_links");
    const graphRead = boundary.fetched.indexOf("/results/graphspec.json");
    expect(boundary.fetched.indexOf("/results/working_memory.json")).toBeLessThan(graphRead);
    expect(boundary.fetched.findIndex((path) => path.startsWith("/texts/"))).toBeLessThan(
      graphRead,
    );
  });

  it("loads a result read without following: its main stuff followed, its memory fetched alone", async () => {
    mockBoundary({
      body: {
        pipeline_run_id: RUN_ID,
        main_stuff: null,
        working_memory: null,
        output_form: {},
        input_form: {},
        artifact_links: {
          main_stuff: linkTo("main_stuff.json"),
          working_memory: linkTo("working_memory.json"),
        },
      },
      files: {
        "main_stuff.json": JSON.stringify(STORED_REFERENCE),
        "working_memory.json": JSON.stringify(STORED_MEMORY),
      },
      texts: { [STORED_TEXT]: "A long text." },
    });
    const client = makeClient();
    const read = await completedResult(
      client.getRunResult(RUN_ID, { followArtifactLinks: false, loadStoredTexts: false }),
    );

    const loaded = await sdk.loadStoredTexts(client, read);

    expect(loaded.main_stuff).toEqual({ text: "A long text." });
    expect(loaded.working_memory).toBeNull();
    expect(Object.keys(loaded.artifact_links ?? {})).toEqual(["working_memory"]);
  });

  it("downloads a main stuff handed back by reference in a result in hand", async () => {
    const report = "pipelex-storage://org/method/run-referenced/generated/a/report.pdf";
    const boundary = mockBoundary({
      body: { ...referencedBody(), artifact_links: { main_stuff: linkTo("main_stuff.json") } },
      files: { "main_stuff.json": JSON.stringify({ url: report }) },
      texts: { [report]: "%PDF-1.7" },
    });
    const client = makeClient();
    const read = await completedResult(client.getRunResult(RUN_ID, { followArtifactLinks: false }));
    const dir = await mkdtemp(join(tmpdir(), "artifact-links-"));

    try {
      const verdict = await client.downloadArtifacts({ results: read, dir });

      expect(verdict.all_saved).toBe(true);
      expect(boundary.fetched).toContain("/results/main_stuff.json");
      const saved = await Promise.all(verdict.saved_paths.map((path) => readFile(path, "utf8")));
      expect(saved).toEqual(["%PDF-1.7"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
