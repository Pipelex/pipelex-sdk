/**
 * The method's tree on the run routes and on `validate`: a `directory`, `contents` or `tree` given
 * to `execute`, `start`, `startAndWaitForResult` or `validate` travels as the protocol's `files`
 * map, inline when small and by hash otherwise, after uploading only the blobs the API lacks, by
 * `mthds`'s `MthdsApiClient` rule — against a fetch that plays the API and its storage, as in
 * `crate-route-trees.test.ts`.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";

import { PipelexApiClient } from "../src/client.js";
import { RequestArgumentError } from "../src/errors.js";

const BASE_URL = "http://localhost:8081";
const STORAGE = "https://app-bucket.s3.amazonaws.com";
const MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n';
const TEMPLATE = "<p>{{ total }}</p>";
/** A file past the inline threshold on its own, so a tree holding it travels by hash. */
const LARGE = new Uint8Array(300 * 1024).fill(0x78);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function link(blob: string): string {
  return `${STORAGE}/org_1/blobs/${blob}?X-Amz-Signature=fixture-signature`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EXECUTE_ANSWER = {
  pipeline_run_id: "run-1",
  created_at: "t0",
  state: "COMPLETED",
  main_stuff_name: "result",
  pipe_output: {
    working_memory: {
      root: { result: { concept: "native.Text", content: { text: "ok" } } },
      aliases: { main_stuff: "result" },
    },
    pipeline_run_id: "run-1",
  },
};

const ROUTE_ANSWERS: Record<string, [number, unknown]> = {
  "/v1/execute": [200, EXECUTE_ANSWER],
  "/v1/start": [202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }],
  "/v1/validate": [200, { is_valid: true, pending_signatures: [], is_runnable: true }],
};

interface ApiOptions {
  blobStore?: boolean;
  /** What the handshake announces under `limits.method_tree`. */
  limits?: Record<string, number>;
  /** The blobs the organization already holds, which `POST /v1/blobs/missing` leaves out. */
  held?: readonly string[];
}

/** The API and its storage, routed by URL: the handshake, the blob route, the run routes, the uploads. */
class Api {
  readonly paths: string[] = [];
  readonly bodies = new Map<string, unknown>();
  readonly uploads: { url: string; body: Uint8Array }[] = [];

  constructor(private readonly options: ApiOptions = {}) {}

  readonly fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(BASE_URL)) {
      this.uploads.push({ url, body: new Uint8Array(init.body as Uint8Array) });
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    const path = new URL(url).pathname;
    this.paths.push(path);
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.bodies.set(path, body);
    if (path === "/v1/version") {
      return Promise.resolve(
        jsonResponse(200, {
          protocol_version: "1",
          runner_version: "0.90.0",
          blob_store: this.options.blobStore ?? true,
          ...(this.options.limits === undefined
            ? {}
            : { limits: { method_tree: this.options.limits } }),
        }),
      );
    }
    if (path === "/v1/blobs/missing") {
      const held = new Set(this.options.held ?? []);
      const { blobs } = body as { blobs: { sha256: string; size: number }[] };
      const missing = blobs
        .filter((blob) => !held.has(blob.sha256))
        .map((blob) => ({
          ...blob,
          upload: { method: "PUT", url: link(blob.sha256), headers: {} },
        }));
      return Promise.resolve(jsonResponse(200, { missing }));
    }
    const [status, answer] = ROUTE_ANSWERS[path] ?? [404, { detail: "Not Found" }];
    return Promise.resolve(jsonResponse(status, answer));
  };
}

function makeClient(api: Api): PipelexApiClient {
  vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

let scratch: string;

/** Write a method directory under the scratch directory, each file at its tree path. */
async function methodDirectory(files: Record<string, string | Uint8Array>): Promise<string> {
  const directory = join(scratch, "method");
  for (const [treePath, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, treePath)), { recursive: true });
    await writeFile(join(directory, treePath), content);
  }
  return directory;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pipelex-sdk-run-trees-"));
  // An entry named `.git` stops Manifest Discovery here, whatever lies above the scratch directory.
  await writeFile(join(scratch, ".git"), "");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe("a run given its method as a directory", () => {
  it("lists the directory and sends its tree inline, the run's inputs file left out", async () => {
    const directory = await methodDirectory({
      "main.mthds": MAIN,
      "templates/invoice.html": TEMPLATE,
      "inputs.json": '{"receipt": "a receipt"}',
    });
    const api = new Api();
    const client = makeClient(api);

    await client.execute({ directory, inputs: { receipt: "a receipt" } });

    expect(api.paths).toEqual(["/v1/version", "/v1/execute"]);
    expect(api.bodies.get("/v1/execute")).toEqual({
      files: { "main.mthds": MAIN, "templates/invoice.html": TEMPLATE },
      inputs: { receipt: "a receipt" },
    });
    expect(api.uploads).toEqual([]);
  });

  it("starts the durable run with the directory's tree, by hash once it is large", async () => {
    const directory = await methodDirectory({ "main.mthds": MAIN, "data/big.txt": LARGE });
    const api = new Api({ held: [sha256(MAIN)] });
    const client = makeClient(api);

    const ack = await client.start({ directory, pipe_code: "receipts.review_receipt" });

    expect(ack.pipeline_run_id).toBe("run-1");
    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/start"]);
    expect(api.uploads.map((upload) => upload.url)).toEqual([link(sha256(LARGE))]);
    expect(api.bodies.get("/v1/start")).toEqual({
      pipe_code: "receipts.review_receipt",
      files: {
        "data/big.txt": { sha256: sha256(LARGE), size: LARGE.length },
        "main.mthds": { sha256: sha256(MAIN), size: Buffer.byteLength(MAIN) },
      },
    });
  });

  it("lists the directory under the limits the deployment announces", async () => {
    const directory = await methodDirectory({ "main.mthds": MAIN, "other.mthds": MAIN });
    const api = new Api({ limits: { max_files: 1 } });
    const client = makeClient(api);

    const err = await client.execute({ directory }).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toMatch(/^execute\(\) could not list the method's tree at /);
    expect(((err as Error).cause as { code?: unknown }).code).toBe("limit_exceeded");
    expect((err as ProblemError).problem).toMatchObject({ domain: "input", retry: "no" });
    expect(api.paths).toEqual(["/v1/version"]);
  });

  it("refuses a directory that names nothing, before the run is asked", async () => {
    const api = new Api();
    const client = makeClient(api);

    const err = await client
      .start({ directory: join(scratch, "missing") })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect(((err as Error).cause as { code?: unknown }).code).toBe("not_found");
    expect(api.paths).not.toContain("/v1/start");
  });

  it("keeps the directory on the blocking fallback of a bare runner", async () => {
    const directory = await methodDirectory({ "main.mthds": MAIN });
    const api = new Api({ blobStore: false });
    const bare = api.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input) === `${BASE_URL}/v1/version`) {
        api.paths.push("/v1/version");
        return Promise.resolve(jsonResponse(200, { implementation: "pipelex-api" }));
      }
      return bare(input as string, init);
    });
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });

    const results = await client.startAndWaitForResult({ directory });

    expect(results.pipeline_run_id).toBe("run-1");
    // The lifecycle handshake's answer is the one the tree's preparation reads.
    expect(api.paths).toEqual(["/v1/version", "/v1/execute"]);
    expect(api.bodies.get("/v1/execute")).toEqual({ files: { "main.mthds": MAIN } });
  });
});

describe("a run given its method as a map in memory", () => {
  it("sends small contents inline, text as text and other bytes as base64", async () => {
    const api = new Api();
    const client = makeClient(api);

    await client.execute({
      contents: { "main.mthds": MAIN, "assets/logo.png": new Uint8Array([0xff, 0x00]) },
    });

    expect(api.paths).toEqual(["/v1/version", "/v1/execute"]);
    expect(api.bodies.get("/v1/execute")).toEqual({
      files: { "assets/logo.png": { base64: "/wA=" }, "main.mthds": MAIN },
    });
  });

  it("uploads only the blobs the API lacks, then sends every file by hash", async () => {
    const second = new Uint8Array(300 * 1024).fill(0x79);
    const api = new Api({ held: [sha256(MAIN), sha256(second)] });
    const client = makeClient(api);

    await client.start({
      contents: { "main.mthds": MAIN, "data/a.txt": LARGE, "data/b.txt": second },
      method_id: "mt_receipts01",
    });

    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/start"]);
    expect(api.bodies.get("/v1/blobs/missing")).toMatchObject({
      blobs: [
        { sha256: sha256(LARGE), size: LARGE.length },
        { sha256: sha256(second), size: second.length },
        { sha256: sha256(MAIN), size: Buffer.byteLength(MAIN) },
      ],
    });
    expect(api.uploads.map((upload) => upload.url)).toEqual([link(sha256(LARGE))]);
    expect(api.uploads[0]!.body).toEqual(LARGE);
    expect(api.bodies.get("/v1/start")).toEqual({
      files: {
        "data/a.txt": { sha256: sha256(LARGE), size: LARGE.length },
        "data/b.txt": { sha256: sha256(second), size: second.length },
        "main.mthds": { sha256: sha256(MAIN), size: Buffer.byteLength(MAIN) },
      },
      method_id: "mt_receipts01",
    });
  });

  it("sends a large tree inline whole to an API that keeps no blob store", async () => {
    const api = new Api({ blobStore: false });
    const client = makeClient(api);

    await client.execute({ contents: { "main.mthds": MAIN, "data/big.txt": LARGE } });

    expect(api.paths).toEqual(["/v1/version", "/v1/execute"]);
    expect(api.bodies.get("/v1/execute")).toEqual({
      files: { "data/big.txt": "x".repeat(LARGE.length), "main.mthds": MAIN },
    });
  });

  it("refuses a tree past the inline limit of an API that keeps no blob store, before the run", async () => {
    const api = new Api({ blobStore: false, limits: { max_inline_bytes: 1024 } });
    const client = makeClient(api);

    const err = await client
      .start({ contents: { "main.mthds": MAIN, "data/big.txt": LARGE } })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toMatch(
      /^start\(\) cannot send the method's tree: the API keeps no blob store, so the tree travels inline, and its files alone weigh \d+ bytes, past the 1024 bytes it takes inline \(its max_inline_bytes\), so the request was not sent\.$/,
    );
    expect(api.paths).toEqual(["/v1/version"]);
  });

  it("sends by hash a small tree past the inline limit the API announces", async () => {
    const api = new Api({ limits: { max_inline_bytes: 16 } });
    const client = makeClient(api);

    await client.execute({ contents: { "main.mthds": MAIN } });

    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/execute"]);
    expect(api.bodies.get("/v1/execute")).toEqual({
      files: { "main.mthds": { sha256: sha256(MAIN), size: Buffer.byteLength(MAIN) } },
    });
  });

  it("asks the handshake once per client, whatever the trees that follow", async () => {
    const api = new Api();
    const client = makeClient(api);

    await client.execute({ contents: { "main.mthds": MAIN } });
    await client.start({ contents: { "main.mthds": MAIN } });

    expect(api.paths).toEqual(["/v1/version", "/v1/execute", "/v1/start"]);
  });

  it("sends a files map as given, with no handshake", async () => {
    const api = new Api();
    const client = makeClient(api);

    await client.execute({ files: { "main.mthds": MAIN } });

    expect(api.paths).toEqual(["/v1/execute"]);
    expect(api.bodies.get("/v1/execute")).toEqual({ files: { "main.mthds": MAIN } });
  });
});

describe("validate given its method as a directory or a map", () => {
  it("lists a directory and sends its tree, the inputs file left out", async () => {
    const directory = await methodDirectory({
      "main.mthds": MAIN,
      "templates/invoice.html": TEMPLATE,
      "inputs.json": "{}",
    });
    const api = new Api();
    const client = makeClient(api);

    const verdict = await client.validate({ directory }, true);

    expect(verdict.is_valid).toBe(true);
    expect(api.paths).toEqual(["/v1/version", "/v1/validate"]);
    expect(api.bodies.get("/v1/validate")).toEqual({
      allow_signatures: true,
      files: { "main.mthds": MAIN, "templates/invoice.html": TEMPLATE },
      render: ["markdown"],
    });
  });

  it("sends large contents by hash, uploading only what the API lacks", async () => {
    const api = new Api({ held: [sha256(MAIN)] });
    const client = makeClient(api);

    await client.validate({ contents: { "main.mthds": MAIN, "data/big.txt": LARGE } });

    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/validate"]);
    expect(api.uploads.map((upload) => upload.url)).toEqual([link(sha256(LARGE))]);
    expect(api.bodies.get("/v1/validate")).toEqual({
      allow_signatures: false,
      files: {
        "data/big.txt": { sha256: sha256(LARGE), size: LARGE.length },
        "main.mthds": { sha256: sha256(MAIN), size: Buffer.byteLength(MAIN) },
      },
      render: ["markdown"],
    });
  });

  it("stops before the handshake under a signal aborted before the call", async () => {
    const api = new Api();
    const client = makeClient(api);

    const err = await client
      .validate({ contents: { "main.mthds": MAIN } }, false, { signal: AbortSignal.abort() })
      .catch((thrown: unknown) => thrown);

    expect((err as Error).name).toBe("AbortError");
    expect(api.paths).toEqual([]);
  });
});
