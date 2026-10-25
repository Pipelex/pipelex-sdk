/**
 * The method's tree on the crate routes: a `directory`, `tree` or `contents` given to `resolve`,
 * `codegen` or `pipeIo` travels as a save sends it, inline when small and by hash otherwise, after
 * uploading the blobs the API lacks — against a fetch that plays the API and its storage, as in
 * `method-trees.test.ts`. The route-level body, the `files` map sent as given and the budgets are
 * pinned in `crate-routes.test.ts` and `pipe-io.test.ts`; the run routes and `validate` in
 * `run-trees.test.ts`.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { listMethodTree } from "mthds";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";

import { PipelexApiClient } from "../src/client.js";
import { MethodFileTransferError, RequestArgumentError } from "../src/errors.js";
import type { MethodTreeSource } from "mthds/protocol";
import { prepareInputs } from "../src/prepare-inputs.js";

const BASE_URL = "http://localhost:8081";
const STORAGE = "https://app-bucket.s3.amazonaws.com";
/** The signature a link carries, which no message may repeat. */
const SIGNATURE = "X-Amz-Signature=fixture-signature";
const MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n';
/** A file past the inline threshold on its own, so a tree holding it travels by hash. */
const LARGE = new Uint8Array(300 * 1024).fill(0x78);

const ROUTE_ANSWERS: Record<string, unknown> = {
  "/v1/resolve": { is_valid: true, crate: { fingerprint: "abc" }, message: "ok" },
  "/v1/codegen": {
    is_valid: true,
    kind: "types",
    target: "ts-zod",
    crate_fingerprint: "abc",
    engine_version: "0.89.0",
    artifacts: [],
    lock: "",
    lock_filename: "codegen.lock",
    message: "ok",
  },
  "/v1/pipe-io": { is_valid: false, validation_errors: [], message: "not loaded" },
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function link(blob: string): string {
  return `${STORAGE}/org_1/blobs/${blob}?${SIGNATURE}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ApiOptions {
  blobStore?: boolean;
  /** The blobs the organization already holds, which `POST /v1/blobs/missing` leaves out. */
  held?: readonly string[];
  /** What storage answers an upload with. */
  storageStatus?: number;
  /** Run while the version handshake is in flight, before it answers. */
  duringVersion?: () => void;
}

/** The API and its storage, routed by URL: the handshake, the blob route, the crate routes, the uploads. */
class Api {
  readonly paths: string[] = [];
  /** Each API request's whole URL, its query included. */
  readonly urls: string[] = [];
  readonly bodies = new Map<string, unknown>();
  readonly uploads: { url: string; body: Uint8Array }[] = [];

  constructor(private readonly options: ApiOptions = {}) {}

  readonly fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(BASE_URL)) {
      this.uploads.push({ url, body: new Uint8Array(init.body as Uint8Array) });
      const status = this.options.storageStatus ?? 200;
      return Promise.resolve(
        status >= 300
          ? new Response(`<Error><CanonicalRequest>${url}</CanonicalRequest></Error>`, { status })
          : new Response(null, { status }),
      );
    }
    const path = new URL(url).pathname;
    this.paths.push(path);
    this.urls.push(url);
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.bodies.set(path, body);
    if (path === "/v1/version") {
      this.options.duringVersion?.();
      return Promise.resolve(
        jsonResponse(200, {
          protocol_version: "1",
          runner_version: "0.89.0",
          blob_store: this.options.blobStore ?? true,
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
    return Promise.resolve(jsonResponse(200, ROUTE_ANSWERS[path]));
  };
}

function makeClient(api: Api): PipelexApiClient {
  vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

/** A listed tree holding no file. */
const EMPTY_TREE: MethodTreeSource = {
  files: [],
  digest: `sha256:${"0".repeat(64)}`,
  readFile: () => Promise.reject(new Error("an empty tree has no file to read")),
};

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pipelex-sdk-crate-trees-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe("the method's tree on the crate routes", () => {
  it("sends a small tree listed from a directory inline, after the one handshake", async () => {
    for (const [treePath, text] of [
      ["main.mthds", MAIN],
      ["templates/invoice.html", "<p>{{ total }}</p>"],
    ] as const) {
      await mkdir(dirname(join(scratch, treePath)), { recursive: true });
      await writeFile(join(scratch, treePath), text);
    }
    const tree = await listMethodTree(scratch, { discover: false });
    const api = new Api();
    const client = makeClient(api);

    await client.resolve({ tree });
    await client.codegen({ directory: scratch, kind: "types", target: "ts-zod" });

    // The handshake is asked once per client, and its answer kept for every later tree.
    expect(api.paths).toEqual(["/v1/version", "/v1/resolve", "/v1/codegen"]);
    const files = { "main.mthds": MAIN, "templates/invoice.html": "<p>{{ total }}</p>" };
    expect(api.bodies.get("/v1/resolve")).toEqual({ files });
    expect(api.bodies.get("/v1/codegen")).toEqual({ files, kind: "types", target: "ts-zod" });
  });

  it("sends large contents by hash, after uploading the blobs the API lacks", async () => {
    const api = new Api({ held: [sha256(MAIN)] });
    const client = makeClient(api);

    await client.codegen({
      contents: { "main.mthds": MAIN, "data/big.txt": LARGE },
      kind: "types",
      target: "ts-zod",
    });

    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/codegen"]);
    expect(api.uploads.map((upload) => upload.url)).toEqual([link(sha256(LARGE))]);
    expect(api.uploads[0]!.body).toEqual(LARGE);
    expect(api.bodies.get("/v1/codegen")).toEqual({
      files: {
        "data/big.txt": { sha256: sha256(LARGE), size: LARGE.length },
        "main.mthds": { sha256: sha256(MAIN), size: Buffer.byteLength(MAIN) },
      },
      kind: "types",
      target: "ts-zod",
    });
  });

  it("sends large contents inline to an API that keeps no blob store, beside the other fields", async () => {
    const api = new Api({ blobStore: false });
    const client = makeClient(api);
    const dependencies = { "github.com/acme/scoring": { "scoring.mthds": 'domain = "s"' } };

    await client.pipeIo({
      contents: { "main.mthds": MAIN, "data/big.txt": LARGE },
      dependencies,
      include_files: true,
    });

    expect(api.paths).toEqual(["/v1/version", "/v1/pipe-io"]);
    expect(api.bodies.get("/v1/pipe-io")).toEqual({
      files: { "data/big.txt": "x".repeat(LARGE.length), "main.mthds": MAIN },
      dependencies,
      include_files: true,
    });
  });

  it("fails on an upload storage refuses, saying the request was not sent, without the link", async () => {
    const api = new Api({ storageStatus: 403 });
    const client = makeClient(api);

    const err = await client
      .resolve({ contents: { "data/big.txt": LARGE } })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(MethodFileTransferError);
    const transfer = err as MethodFileTransferError;
    expect([transfer.operation, transfer.reason, transfer.sha256, transfer.status]).toEqual([
      "upload",
      "refused",
      sha256(LARGE),
      403,
    ]);
    expect(transfer.message).toMatch(/so the request was not sent\.$/);
    expect(transfer.message).not.toContain(SIGNATURE);
    expect(api.paths).not.toContain("/v1/resolve");
  });

  it.each([
    [
      "two forms",
      { files: { "main.mthds": MAIN }, contents: { "main.mthds": MAIN } },
      "resolve() takes the method's tree in one form, directory, contents, tree or files; got contents and files.",
    ],
    [
      "no file",
      { tree: EMPTY_TREE },
      "resolve() got a tree holding no file, and a method tree holds at least one.",
    ],
  ])("refuses a tree given in %s before any request", async (_, request, message) => {
    const api = new Api();
    const client = makeClient(api);

    const err = await client.resolve(request).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(message);
    expect((err as ProblemError).problem).toMatchObject({ domain: "input", retry: "no" });
    expect(api.paths).toEqual([]);
  });

  it("asks the blob route under the request's read_scope, and sends the scope on", async () => {
    const api = new Api();
    const client = makeClient(api);

    await client.resolve({ contents: { "data/big.txt": LARGE }, read_scope: "org_acme" });

    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/resolve"]);
    expect(api.urls[1]).toBe(`${BASE_URL}/v1/blobs/missing?read_scope=org_acme`);
    expect(api.bodies.get("/v1/resolve")).toEqual({
      files: { "data/big.txt": { sha256: sha256(LARGE), size: LARGE.length } },
      read_scope: "org_acme",
    });
  });

  it("asks the blob route with no query when the request names no read_scope", async () => {
    const api = new Api();
    const client = makeClient(api);

    await client.resolve({ contents: { "data/big.txt": LARGE }, read_scope: "" });

    expect(api.urls[1]).toBe(`${BASE_URL}/v1/blobs/missing`);
  });

  it.each([
    ["files: {}", { files: {}, method_id: "mt_1" }, { method_id: "mt_1" }],
    [
      "files: null",
      { files: null, method_ref: "github.com/acme/methods" },
      { method_ref: "github.com/acme/methods" },
    ],
    [
      "contents: {} and dependencies: {}",
      { contents: {}, dependencies: {}, method_ref: "github.com/acme/methods" },
      { method_ref: "github.com/acme/methods" },
    ],
    ['directory: ""', { directory: "", method_id: "mt_1" }, { method_id: "mt_1" }],
  ])("reads %s as absent and posts the other selector alone", async (_, request, posted) => {
    const api = new Api();
    const client = makeClient(api);

    await client.resolve(request as Parameters<PipelexApiClient["resolve"]>[0]);

    expect(api.paths).toEqual(["/v1/resolve"]);
    expect(api.bodies.get("/v1/resolve")).toEqual(posted);
  });

  it("starts nothing after an abort during the version handshake", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const api = new Api({ duringVersion: () => controller.abort(reason) });
    const client = makeClient(api);

    const err = await client
      .pipeIo(
        { contents: { "main.mthds": MAIN, "data/big.txt": LARGE } },
        { signal: controller.signal },
      )
      .catch((thrown: unknown) => thrown);

    expect(err).toBe(reason);
    expect(api.paths).toEqual(["/v1/version"]);
    expect(api.uploads).toEqual([]);
  });

  it("stops prepareInputs after an abort during the handshake, before the blob route and pipe I/O", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const api = new Api({ duringVersion: () => controller.abort(reason) });
    const client = makeClient(api);

    const err = await prepareInputs(client, {
      contents: { "main.mthds": MAIN, "data/big.txt": LARGE },
      inputs: {},
      signal: controller.signal,
    }).catch((thrown: unknown) => thrown);

    expect(err).toBe(reason);
    expect(api.paths).toEqual(["/v1/version"]);
    expect(api.uploads).toEqual([]);
  });

  it("sends no further blob once the signal aborts between uploads", async () => {
    const controller = new AbortController();
    const second = new Uint8Array(300 * 1024).fill(0x79);
    const api = new Api();
    const client = makeClient(api);
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockImplementation((input, init) => {
      const answer = api.fetch(input as string, init);
      if (!String(input).startsWith(BASE_URL)) controller.abort(new Error("enough"));
      return answer;
    });

    const err = await client
      .codegen(
        {
          contents: { "data/a.txt": LARGE, "data/b.txt": second },
          kind: "types",
          target: "ts-zod",
        },
        { signal: controller.signal },
      )
      .catch((thrown: unknown) => thrown);

    expect((err as Error).message).toBe("enough");
    expect(api.uploads).toHaveLength(1);
    expect(api.paths).not.toContain("/v1/codegen");
  });

  it("starts no request under a signal aborted before the call", async () => {
    const api = new Api();
    const client = makeClient(api);

    const err = await client
      .resolve({ files: { "main.mthds": MAIN } }, { signal: AbortSignal.abort() })
      .catch((thrown: unknown) => thrown);

    expect((err as Error).name).toBe("AbortError");
    expect(api.paths).toEqual([]);
  });
});
