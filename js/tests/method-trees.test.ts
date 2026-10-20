/**
 * A saved method's tree on the client side: a save's three forms of the tree and how each travels,
 * inline or by hash after uploading the blobs the platform lacks, the refusals before anything is
 * sent, an upload storage fails, the limits a deployment announces, and the writing of a saved
 * listing to disk — all against a fetch that plays the API and its storage.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { listMethodTree, TreeLimitExceededError } from "mthds";
import type { MethodFiles } from "mthds/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelexApiClient } from "../src/client.js";
import {
  ApiResponseError,
  errorVerdictOf,
  MethodFileTransferError,
  RequestArgumentError,
} from "../src/errors.js";
import { writeMethodTreeTo } from "../src/method-trees.js";
import type { SavedMethodFile } from "../src/product-models.js";

const BASE_URL = "http://localhost:8081";
const STORAGE = "https://app-bucket.s3.amazonaws.com";
/** The signature a link carries, which no message, member or cause may repeat. */
const SIGNATURE = "X-Amz-Signature=fixture-signature";
const TARGET_HEADERS = { "Content-Type": "application/octet-stream", "If-None-Match": "*" };

const MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n';
/** A file whose inline map alone passes the inline threshold. */
const LARGE = new Uint8Array(300 * 1024).fill(0x78);
/** Bytes that are not UTF-8, which travel inline as Base64. */
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

const ENCODER = new TextEncoder();

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? ENCODER.encode(bytes) : bytes)
    .digest("hex");
}

/** The tree digest of `files`, path to bytes, computed here from the standard's definition. */
function treeDigest(files: Record<string, Uint8Array | string>): string {
  const paths = Object.keys(files).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return `sha256:${sha256(paths.map((path) => `${sha256(files[path]!)}  ${path}\n`).join(""))}`;
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

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

interface PlatformOptions {
  blobStore?: boolean;
  limits?: unknown;
  /** The blobs the organization already holds, which `POST /v1/blobs/missing` leaves out. */
  held?: readonly string[];
  /** Blobs `POST /v1/blobs/missing` asks for beyond the ones sent. */
  extraMissing?: readonly string[];
  /** The bytes storage serves, by SHA-256. */
  blobs?: Record<string, Uint8Array>;
  /** What storage answers every request with, when not a 2xx. */
  storageStatus?: number;
  /** Storage gives no answer: the fetch fails as undici's does, its message quoting the link. */
  storageUnreachable?: boolean;
  /** What `POST /v1/blobs/missing` answers instead of the blobs it lacks. */
  missingAnswer?: unknown;
}

/** The API and its storage, routed by URL. */
class Platform {
  readonly api: Sent[] = [];
  readonly storage: Sent[] = [];
  readonly blobs: Map<string, Uint8Array>;
  /** The files of the last save, which `GET /v1/methods/m1` lists back. */
  saved: MethodFiles | null = null;

  constructor(private readonly options: PlatformOptions = {}) {
    this.blobs = new Map(Object.entries(options.blobs ?? {}));
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input);
    const sent: Sent = {
      url,
      method: String(init.method ?? "GET"),
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: init.body,
      init,
    };
    if (url.startsWith(BASE_URL)) {
      sent.body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      this.api.push(sent);
      return this.answerApi(sent);
    }
    this.storage.push(sent);
    return this.answerStorage(sent);
  };

  sent(method: string, path: string): Sent[] {
    return this.api.filter((call) => call.method === method && new URL(call.url).pathname === path);
  }

  savedFiles(method: string, path: string): unknown {
    const saves = this.sent(method, path);
    expect(saves).toHaveLength(1);
    return (saves[0]!.body as { files?: unknown }).files;
  }

  private answerApi(sent: Sent): Response {
    const path = new URL(sent.url).pathname;
    if (path === "/v1/version") {
      const version: Record<string, unknown> = {
        protocol_version: "1",
        runner_version: "0.80.0",
        blob_store: this.options.blobStore ?? true,
      };
      if (this.options.limits !== undefined) version.limits = this.options.limits;
      return jsonResponse(200, version);
    }
    if (path === "/v1/blobs/missing" && this.options.missingAnswer !== undefined) {
      return jsonResponse(200, this.options.missingAnswer);
    }
    if (path === "/v1/blobs/missing") {
      const { blobs } = sent.body as { blobs: { sha256: string; size: number }[] };
      const held = new Set(this.options.held ?? []);
      const missing = blobs
        .filter((blob) => !held.has(blob.sha256))
        .map((blob) => ({
          sha256: blob.sha256,
          size: blob.size,
          upload: { method: "PUT", url: link(blob.sha256), headers: TARGET_HEADERS },
        }));
      for (const blob of this.options.extraMissing ?? []) {
        missing.push({
          sha256: blob,
          size: 1,
          upload: { method: "PUT", url: link(blob), headers: TARGET_HEADERS },
        });
      }
      return jsonResponse(200, { missing });
    }
    if (sent.method === "GET" && path === "/v1/methods/m1") {
      return jsonResponse(200, { ...METHOD, files: this.listing() });
    }
    this.saved = ((sent.body as { files?: MethodFiles | null }).files ??
      null) as MethodFiles | null;
    return jsonResponse(200, METHOD);
  }

  /** The saved tree as the platform lists it: hash entries only, in tree path order. */
  private listing(): SavedMethodFile[] {
    return Object.entries(this.saved ?? {})
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([path, entry]) => {
        const { sha256: blob, size } = entry as { sha256: string; size: number };
        return { path, sha256: blob, size, url: link(blob), expires_at: "2026-10-17T10:15:00Z" };
      });
  }

  private answerStorage(sent: Sent): Response {
    if (this.options.storageUnreachable === true) {
      throw new TypeError(`fetch failed: ${sent.url}`, {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${sent.url}`), {
          code: "ECONNREFUSED",
        }),
      });
    }
    const status = this.options.storageStatus ?? 200;
    if (status >= 300) {
      // Storage's error body can echo the signed request, which no message may repeat.
      const refusal = `<Error><Code>AccessDenied</Code><CanonicalRequest>${sent.url}</CanonicalRequest></Error>`;
      return new Response(refusal, { status, statusText: "Refused" });
    }
    const blob = new URL(sent.url).pathname.split("/").at(-1)!;
    if (sent.method === "PUT") {
      this.blobs.set(blob, new Uint8Array(sent.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    return new Response((this.blobs.get(blob) ?? new Uint8Array(0)) as Uint8Array<ArrayBuffer>, {
      status: 200,
    });
  }
}

const METHOD = {
  method_id: "m1",
  org_id: "org_1",
  created_by_user_id: "user_1",
  name: "Receipts",
  description: null,
  input_data: null,
  created_at: "2026-10-17T10:00:00Z",
  updated_at: "2026-10-17T10:00:00Z",
  draft_digest: null,
  latest_version: null,
  latest_published: null,
};

function makeClient(platform: Platform): PipelexApiClient {
  vi.spyOn(globalThis, "fetch").mockImplementation(platform.fetch);
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

/** Asserts that no link's signature reaches the error, however it is shown, and that it keeps no cause. */
function expectNoLink(err: Error): void {
  expect(err.message).not.toContain(SIGNATURE);
  expect(String(err.stack)).not.toContain(SIGNATURE);
  expect(inspect(err, { depth: Infinity })).not.toContain(SIGNATURE);
  expect(JSON.stringify({ ...err })).not.toContain(SIGNATURE);
  expect(err.cause).toBeUndefined();
}

/** The error a call threw, asserting it is a `MethodFileTransferError` that holds no link. */
async function transferError(call: Promise<unknown>): Promise<MethodFileTransferError> {
  const thrown = await call.then(
    () => expect.fail("expected the transfer to fail"),
    (err: unknown) => err,
  );
  expect(thrown).toBeInstanceOf(MethodFileTransferError);
  const err = thrown as MethodFileTransferError;
  expect(err.message).not.toContain("AccessDenied");
  expectNoLink(err);
  return err;
}

/**
 * A fetch whose storage sends its headers, then a body that never ends, which errors when the
 * request is aborted with the error undici raises for a body cut short, not the abort's reason.
 */
function stallingStorage(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new TypeError("terminated")), {
          once: true,
        });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pipelex-sdk-method-trees-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe("saving a method's tree", () => {
  /** The delays of the timers a save arms for its requests. */
  async function saveTimeLimits(
    save: (client: PipelexApiClient) => Promise<unknown>,
  ): Promise<unknown[]> {
    const client = makeClient(new Platform());
    const timer = vi.spyOn(globalThis, "setTimeout");
    await save(client);
    return timer.mock.calls.map(([, delay]) => delay);
  }

  it.each([
    [
      "createMethod",
      (client: PipelexApiClient) =>
        client.createMethod({ name: "Receipts", files: { "main.mthds": MAIN } }),
    ],
    [
      "writeDraft",
      (client: PipelexApiClient) => client.writeDraft("m1", { files: { "main.mthds": MAIN } }),
    ],
  ])("gives %s carrying a tree the client's request ceiling", async (_, save) => {
    // A tree sent inline to a platform with no blob store has no size bound, and its whole upload is charged.
    expect(await saveTimeLimits(save)).toEqual([1_200_000]);
  });

  it("gives a save sending no tree the poll timeout", async () => {
    expect(await saveTimeLimits((client) => client.createMethod({ name: "Receipts" }))).toEqual([
      30_000,
    ]);
    vi.restoreAllMocks();
    expect(await saveTimeLimits((client) => client.writeDraft("m1", { files: null }))).toEqual([
      30_000,
    ]);
  });

  it("sends files as given, with no round trip", async () => {
    const platform = new Platform();
    const client = makeClient(platform);
    const files: MethodFiles = {
      "main.mthds": MAIN,
      "helper.py": { sha256: "8f".repeat(32), size: 5 },
    };

    await client.createMethod({ name: "Receipts", files });

    expect(platform.api.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /v1/methods",
    ]);
    expect(platform.savedFiles("POST", "/v1/methods")).toEqual(files);
  });

  it("sends a small tree listed from a directory inline, Base64 for bytes that are not text", async () => {
    await writeFile(join(scratch, "main.mthds"), MAIN);
    await writeFile(join(scratch, "logo.png"), BINARY);
    const tree = await listMethodTree(scratch, { discover: false });
    const platform = new Platform();
    const client = makeClient(platform);

    await client.createMethod({ name: "Receipts", tree });

    expect(platform.savedFiles("POST", "/v1/methods")).toEqual({
      "logo.png": { base64: Buffer.from(BINARY).toString("base64") },
      "main.mthds": MAIN,
    });
    // Inline below the threshold: neither the handshake nor the blob route is asked.
    expect(platform.api).toHaveLength(1);
    expect(platform.storage).toEqual([]);
  });

  it("sends small contents inline, each file as an own property", async () => {
    const platform = new Platform();
    const client = makeClient(platform);

    await client.writeDraft("m1", {
      contents: { "main.mthds": MAIN, "assets/logo.png": BINARY, ["__proto__"]: "x = 1\n" },
    });

    const files = platform.savedFiles("PUT", "/v1/methods/m1/draft") as Record<string, unknown>;
    expect(Object.keys(files).sort()).toEqual(["__proto__", "assets/logo.png", "main.mthds"]);
    expect(files["main.mthds"]).toBe(MAIN);
    expect(files["assets/logo.png"]).toEqual({ base64: Buffer.from(BINARY).toString("base64") });
  });

  it("sends a large tree by hash, after uploading once each blob the platform lacks", async () => {
    const platform = new Platform({ held: [sha256(MAIN)] });
    const client = makeClient(platform);
    const contents = { "main.mthds": MAIN, "data/big.txt": LARGE, "data/copy.txt": LARGE };

    await client.createMethod({ name: "Receipts", contents });

    const [ask] = platform.sent("POST", "/v1/blobs/missing");
    // Each blob once, in tree path order, with the tree's digest.
    expect(ask!.body).toEqual({
      blobs: [
        { sha256: sha256(LARGE), size: LARGE.length },
        { sha256: sha256(MAIN), size: ENCODER.encode(MAIN).length },
      ],
      digest: treeDigest(contents),
    });
    expect(platform.storage).toHaveLength(1);
    const [upload] = platform.storage;
    expect(upload!.url).toBe(link(sha256(LARGE)));
    expect(upload!.method).toBe("PUT");
    // Exactly the target's headers: no credential of the client reaches storage.
    expect(upload!.headers).toEqual(TARGET_HEADERS);
    expect(upload!.init.credentials).toBe("omit");
    expect(upload!.init.redirect).toBe("manual");
    expect(platform.blobs.get(sha256(LARGE))).toEqual(LARGE);
    expect(platform.savedFiles("POST", "/v1/methods")).toEqual({
      "data/big.txt": { sha256: sha256(LARGE), size: LARGE.length },
      "data/copy.txt": { sha256: sha256(LARGE), size: LARGE.length },
      "main.mthds": { sha256: sha256(MAIN), size: ENCODER.encode(MAIN).length },
    });
  });

  it("sends a large tree inline to a platform that keeps no blob store", async () => {
    const platform = new Platform({ blobStore: false });
    const client = makeClient(platform);

    await client.writeDraft("m1", { contents: { "data/big.txt": LARGE } });

    expect(platform.sent("POST", "/v1/blobs/missing")).toEqual([]);
    expect(platform.storage).toEqual([]);
    expect(platform.savedFiles("PUT", "/v1/methods/m1/draft")).toEqual({
      "data/big.txt": "x".repeat(LARGE.length),
    });
  });

  it.each([
    [
      "createMethod",
      (client: PipelexApiClient) =>
        client.createMethod({
          name: "M",
          files: { "main.mthds": MAIN },
          contents: { "main.mthds": MAIN },
        }),
      "createMethod() takes the method's tree in one form, files, tree or contents; got files and contents.",
    ],
    [
      "writeDraft",
      (client: PipelexApiClient) =>
        client.writeDraft("m1", { files: null, contents: { "main.mthds": MAIN } }),
      "writeDraft() takes the method's tree in one form, files, tree or contents; got files and contents.",
    ],
  ])("%s refuses two forms of the tree before sending", async (_, call, message) => {
    const platform = new Platform();
    const client = makeClient(platform);

    const err = await call(client).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(message);
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
    expect(platform.api).toEqual([]);
  });

  it.each([
    ["no file", {}, "createMethod() got contents holding no file"],
    ["a lone surrogate", { "main.mthds": "\uD800" }, "holding a lone surrogate"],
    ["a value that is no file", { "main.mthds": 42 }, "neither a string nor a Uint8Array"],
  ])("refuses contents holding %s before sending", async (_, contents, refusal) => {
    const platform = new Platform();
    const client = makeClient(platform);

    const err = await client
      .createMethod({ name: "M", contents: contents as Record<string, string> })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain(refusal);
    expect(platform.api).toEqual([]);
  });

  it("reports a blob the platform asks for that the tree does not hold as its unreadable answer", async () => {
    const stranger = "f".repeat(64);
    const platform = new Platform({ extraMissing: [stranger] });
    const client = makeClient(platform);

    const err = await client
      .createMethod({ name: "M", contents: { "data/big.txt": LARGE } })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    const unreadable = err as ApiResponseError;
    expect(unreadable.message).toBe(
      "API POST /v1/blobs/missing answered 200 with a body asking for blobs this tree does not " +
        `hold: ${stranger}`,
    );
    expect(unreadable.status).toBe(200);
    // The platform's fault, which no change to the call fixes.
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: false });
    expectNoLink(unreadable);
    expect(platform.storage).toEqual([]);
    expect(platform.sent("POST", "/v1/methods")).toEqual([]);
  });

  it("refuses a tree holding no file before any request", async () => {
    const platform = new Platform();
    const client = makeClient(platform);
    const empty = { files: [], digest: treeDigest({}), readFile: () => Promise.resolve(BINARY) };

    const err = await client
      .createMethod({ name: "M", tree: empty })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "createMethod() got a tree holding no file, and a method tree holds at least one; give " +
        "files: null for an empty draft.",
    );
    expect(platform.api).toEqual([]);
  });

  it("refuses to upload bytes that are not the blob the tree's listing names", async () => {
    const platform = new Platform();
    const client = makeClient(platform);
    const other = new Uint8Array(LARGE.length).fill(0x79);
    // A hand-built tree whose listing names LARGE but whose reads give other bytes of its size.
    const lying = {
      files: [{ path: "data/big.txt", size: LARGE.length, sha256: sha256(LARGE) }],
      digest: treeDigest({ "data/big.txt": LARGE }),
      readFile: () => Promise.resolve(other),
    };

    const err = await client
      .createMethod({ name: "M", tree: lying })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      `The tree read ${other.length} bytes hashing to ${sha256(other)} for 'data/big.txt', which ` +
        `its listing names as ${LARGE.length} bytes hashing to ${sha256(LARGE)}, so they were not ` +
        "uploaded and the method was not saved.",
    );
    expect(platform.storage).toEqual([]);
    expect(platform.sent("POST", "/v1/methods")).toEqual([]);
  });

  it("asks the version handshake once per client", async () => {
    const platform = new Platform({ limits: { method_tree: { max_files: 10 } } });
    const client = makeClient(platform);

    await client.methodTreeLimits();
    await client.createMethod({ name: "M", contents: { "data/big.txt": LARGE } });
    await client.writeDraft("m1", { contents: { "data/big.txt": LARGE, "main.mthds": MAIN } });

    expect(platform.sent("GET", "/v1/version")).toHaveLength(1);
  });

  it("asks the version handshake again after one that failed", async () => {
    const platform = new Platform();
    const client = makeClient(platform);
    const spy = vi.mocked(globalThis.fetch);
    spy.mockImplementationOnce(() => Promise.resolve(jsonResponse(503, { code: "unavailable" })));

    await expect(client.methodTreeLimits()).rejects.toBeInstanceOf(ApiResponseError);
    await expect(client.methodTreeLimits()).resolves.toEqual({});
    await expect(client.methodTreeLimits()).resolves.toEqual({});

    expect(platform.sent("GET", "/v1/version")).toHaveLength(1);
  });

  it.each([
    [403, "refused", false],
    [429, "storage_error", true],
    [503, "storage_error", true],
  ] as const)(
    "fails the save on an upload storage answers %i, without the link",
    async (status, code, retryable) => {
      const platform = new Platform({ storageStatus: status });
      const client = makeClient(platform);

      const err = await transferError(
        client.createMethod({ name: "M", contents: { "data/big.txt": LARGE } }),
      );

      expect(err.operation).toBe("upload");
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.sha256).toBe(sha256(LARGE));
      expect(err.message).toContain("app-bucket.s3.amazonaws.com");
      expect(err.message).toContain("the method was not saved");
      expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable });
      expect(platform.sent("POST", "/v1/methods")).toEqual([]);
    },
  );

  it("fails the save on an upload that gets no answer, keeping no cause", async () => {
    const platform = new Platform({ storageUnreachable: true });
    const client = makeClient(platform);

    const err = await transferError(
      client.createMethod({ name: "M", contents: { "data/big.txt": LARGE } }),
    );

    expect(err.operation).toBe("upload");
    expect(err.code).toBe("unreachable");
    expect(err.status).toBeUndefined();
    expect(err.message).toContain("(ECONNREFUSED)");
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: true });
    expect(platform.sent("POST", "/v1/methods")).toEqual([]);
  });

  it("counts a create-only upload storage answers 412 as uploaded", async () => {
    const platform = new Platform({ storageStatus: 412 });
    const client = makeClient(platform);

    await client.createMethod({ name: "M", contents: { "data/big.txt": LARGE } });

    expect(platform.storage).toHaveLength(1);
    expect(platform.savedFiles("POST", "/v1/methods")).toEqual({
      "data/big.txt": { sha256: sha256(LARGE), size: LARGE.length },
    });
  });
});

describe("methodTreeLimits", () => {
  it.each([
    [
      "every limit",
      { method_tree: { max_files: 3, max_file_bytes: 10, max_total_bytes: 20 } },
      { maxFileCount: 3, maxFileSize: 10, maxTotalSize: 20 },
    ],
    ["one limit", { method_tree: { max_files: 500 } }, { maxFileCount: 500 }],
    ["no limits member", undefined, {}],
    ["no method_tree member", { runs: {} }, {}],
    [
      "values that are no positive integer",
      { method_tree: { max_files: 0, max_file_bytes: -1, max_total_bytes: "20" } },
      {},
    ],
    ["a fraction", { method_tree: { max_files: 1.5 } }, {}],
  ])("reads %s from the version handshake", async (_, limits, expected) => {
    const client = makeClient(new Platform({ limits }));

    await expect(client.methodTreeLimits()).resolves.toEqual(expected);
  });

  it("refuses a tree past an announced limit while it is listed", async () => {
    await writeFile(join(scratch, "main.mthds"), MAIN);
    await writeFile(join(scratch, "helper.py"), "x = 1\n");
    const client = makeClient(new Platform({ limits: { method_tree: { max_files: 1 } } }));

    const limits = await client.methodTreeLimits();
    const err = await listMethodTree(scratch, { discover: false, limits }).catch(
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(TreeLimitExceededError);
    expect((err as TreeLimitExceededError).limit).toBe("maxFileCount");
  });
});

describe("writeMethodTree", () => {
  /** A listing of `files`, path to bytes, each served by storage under its SHA-256. */
  function served(files: Record<string, Uint8Array | string>): {
    listing: SavedMethodFile[];
    blobs: Record<string, Uint8Array>;
  } {
    const blobs: Record<string, Uint8Array> = {};
    const listing = Object.entries(files).map(([path, content]) => {
      const bytes = typeof content === "string" ? ENCODER.encode(content) : content;
      blobs[sha256(bytes)] = bytes;
      return {
        path,
        sha256: sha256(bytes),
        size: bytes.length,
        url: link(sha256(bytes)),
        expires_at: "2026-10-17T10:15:00Z",
      };
    });
    return { listing, blobs };
  }

  it("writes each file at its tree path, downloading with no credential", async () => {
    const { listing, blobs } = served({ "main.mthds": MAIN, "assets/logo.png": BINARY });
    const platform = new Platform({ blobs });
    const client = makeClient(platform);
    const destination = join(scratch, "receipts");

    await client.writeMethodTree(listing, { destination });

    expect(await readFile(join(destination, "main.mthds"), "utf8")).toBe(MAIN);
    expect(new Uint8Array(await readFile(join(destination, "assets", "logo.png")))).toEqual(BINARY);
    expect(platform.api).toEqual([]);
    for (const download of platform.storage) {
      expect(download.headers).toEqual({});
      expect(download.init.credentials).toBe("omit");
    }
    // The staging directory took the destination's name: nothing else is left beside it.
    expect(await readdir(scratch)).toEqual(["receipts"]);
  });

  it("writes an empty listing as an empty directory", async () => {
    const destination = join(scratch, "empty");

    await makeClient(new Platform()).writeMethodTree([], { destination });

    expect(await readdir(destination)).toEqual([]);
  });

  it("writes into an empty directory", async () => {
    const { listing, blobs } = served({ "main.mthds": MAIN });
    const destination = join(scratch, "receipts");
    await mkdir(destination);

    await makeClient(new Platform({ blobs })).writeMethodTree(listing, { destination });

    expect(await readdir(destination)).toEqual(["main.mthds"]);
  });

  it.each(["a file", "a directory holding a file"])(
    "refuses a destination that is %s, before downloading",
    async (occupant) => {
      const { listing, blobs } = served({ "main.mthds": MAIN });
      const platform = new Platform({ blobs });
      const destination = join(scratch, "receipts");
      if (occupant === "a file") {
        await writeFile(destination, "mine");
      } else {
        await mkdir(destination);
        await writeFile(join(destination, "notes.txt"), "mine");
      }

      const err = await makeClient(platform)
        .writeMethodTree(listing, { destination })
        .catch((thrown: unknown) => thrown);

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as Error).message).toContain("already exists and is not an empty directory");
      expect(platform.storage).toEqual([]);
      const kept =
        occupant === "a file"
          ? await readFile(destination, "utf8")
          : await readFile(join(destination, "notes.txt"), "utf8");
      expect(kept).toBe("mine");
    },
  );

  it.each([
    [
      "a path climbing out",
      ["../escape.py"],
      "is not a tree path (the path holds the segment '..')",
    ],
    ["an empty segment", ["lib//x.py"], "is not a tree path (the path holds an empty segment)"],
    ["an absolute path", ["/etc/x"], "is not a tree path (the path starts or ends with '/')"],
    ["a path twice", ["main.mthds", "main.mthds"], "holds 'main.mthds' twice"],
    ["paths equal once case-folded", ["Main.mthds", "main.mthds"], "Main.mthds, main.mthds"],
    ["a file naming a directory of another", ["lib", "lib/x.py"], "lib, lib/x.py"],
  ])("refuses a listing holding %s, before downloading", async (_, paths, refusal) => {
    const platform = new Platform();
    const destination = join(scratch, "receipts");
    const listing = paths.map((path) => ({
      path,
      sha256: sha256(MAIN),
      size: ENCODER.encode(MAIN).length,
      url: link(sha256(MAIN)),
      expires_at: "2026-10-17T10:15:00Z",
    }));

    const err = await makeClient(platform)
      .writeMethodTree(listing, { destination })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain(refusal);
    expect(platform.storage).toEqual([]);
    expect(await readdir(scratch)).toEqual([]);
  });

  it.each([
    ["other bytes of the same size", ENCODER.encode(MAIN.toUpperCase()), "hashing to"],
    ["fewer bytes", ENCODER.encode("domain"), "6 bytes came back"],
    ["more bytes", ENCODER.encode(`${MAIN}# more\n`), "more than that came back"],
  ])(
    "fails the write when storage serves %s, leaving nothing",
    async (_, servedBytes, cameBack) => {
      const { listing } = served({ "main.mthds": MAIN, "helper.py": "x = 1\n" });
      const blobs = { [sha256(MAIN)]: servedBytes, [sha256("x = 1\n")]: ENCODER.encode("x = 1\n") };
      const destination = join(scratch, "receipts");

      const err = await transferError(
        makeClient(new Platform({ blobs })).writeMethodTree(listing, { destination }),
      );

      expect(err.operation).toBe("download");
      expect(err.code).toBe("mismatch");
      expect(err.path).toBe("main.mthds");
      expect(err.sha256).toBe(sha256(MAIN));
      expect(err.message).toContain(cameBack);
      expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: true });
      expect(await readdir(scratch)).toEqual([]);
    },
  );

  it.each([
    [403, "refused", false],
    [500, "storage_error", true],
  ] as const)(
    "fails the write on a download storage answers %i, without the link",
    async (status, code, retryable) => {
      const { listing } = served({ "main.mthds": MAIN });
      const destination = join(scratch, "receipts");

      const err = await transferError(
        makeClient(new Platform({ storageStatus: status })).writeMethodTree(listing, {
          destination,
        }),
      );

      expect(err.operation).toBe("download");
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.path).toBe("main.mthds");
      expect(err.message).toContain("read the method again for fresh links");
      expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable });
      expect(await readdir(scratch)).toEqual([]);
    },
  );

  it("fails the write on a download that gets no answer, keeping no cause", async () => {
    const { listing } = served({ "main.mthds": MAIN });
    const destination = join(scratch, "receipts");

    const err = await transferError(
      makeClient(new Platform({ storageUnreachable: true })).writeMethodTree(listing, {
        destination,
      }),
    );

    expect(err.operation).toBe("download");
    expect(err.code).toBe("unreachable");
    expect(err.message).toContain("(ECONNREFUSED)");
    expect(await readdir(scratch)).toEqual([]);
  });

  it("times out a download whose body stalls, as one with no answer", async () => {
    const { listing } = served({ "main.mthds": MAIN });
    stallingStorage();
    const destination = join(scratch, "receipts");

    const err = await transferError(writeMethodTreeTo(listing, destination, { timeoutMs: 20 }));

    // The transfer's own time limit names the failure, whatever error the aborted read raised.
    expect(err.code).toBe("unreachable");
    expect(err.message).toContain("(ABORT_TIMEOUT)");
    expect(await readdir(scratch)).toEqual([]);
  });

  it("bounds each download by the client's request ceiling", async () => {
    const { listing } = served({ "main.mthds": MAIN });
    stallingStorage();
    const client = new PipelexApiClient({
      baseUrl: BASE_URL,
      apiKey: "test-token",
      requestTimeoutMs: 20,
    });

    const err = await transferError(
      client.writeMethodTree(listing, { destination: join(scratch, "receipts") }),
    );

    expect(err.message).toContain("(ABORT_TIMEOUT)");
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, 2 ** 31])(
    "refuses a request ceiling of %d at construction",
    (requestTimeoutMs) => {
      expect(() => new PipelexApiClient({ baseUrl: BASE_URL, requestTimeoutMs })).toThrow(
        RangeError,
      );
    },
  );

  it("writes back the tree a save sent by hash", async () => {
    const platform = new Platform();
    const client = makeClient(platform);
    const contents = { "main.mthds": MAIN, "data/big.txt": LARGE, "assets/logo.png": BINARY };

    await client.writeDraft("m1", { contents });
    const detail = await client.getMethod("m1");
    const destination = join(scratch, "receipts");
    await client.writeMethodTree(detail.files, { destination });

    expect(detail.files.map((file) => file.path)).toEqual([
      "assets/logo.png",
      "data/big.txt",
      "main.mthds",
    ]);
    expect(await readFile(join(destination, "main.mthds"), "utf8")).toBe(MAIN);
    expect(new Uint8Array(await readFile(join(destination, "data", "big.txt")))).toEqual(LARGE);
    expect(new Uint8Array(await readFile(join(destination, "assets", "logo.png")))).toEqual(BINARY);
  });
});

describe("answers that carry links", () => {
  const signedFile = {
    path: "main.mthds",
    sha256: sha256(MAIN),
    size: ENCODER.encode(MAIN).length,
    url: link(sha256(MAIN)),
    expires_at: "2026-10-17T10:15:00Z",
  };

  function answering(text: string): void {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(text, { status: 200, headers: { "X-Request-ID": "req-1" } }),
    );
  }

  it.each([
    [
      "getMethod",
      (client: PipelexApiClient) => client.getMethod("m1"),
      "GET /v1/methods/m1",
      "a stored method",
      { ...METHOD },
    ],
    [
      "getMethodVersion",
      (client: PipelexApiClient) => client.getMethodVersion("m1", 3),
      "GET /v1/methods/m1/versions/3",
      "a published version",
      { version: 3, method_id: "m1", tree_digest: null },
    ],
  ])(
    "%s holds a listing it cannot read with every link hidden",
    async (_, call, route, subject, record) => {
      const files = [signedFile, { ...signedFile, path: "helper.py", sha256: "A".repeat(64) }];
      answering(JSON.stringify({ ...record, files }));

      const err = await call(new PipelexApiClient({ baseUrl: BASE_URL })).catch(
        (thrown: unknown) => thrown,
      );

      expect(err).toBeInstanceOf(ApiResponseError);
      const unreadable = err as ApiResponseError;
      expect(unreadable.message).toBe(
        `API ${route} answered 200 with ${subject} whose \`files\` holds an entry whose ` +
          "`sha256` is not 64 lowercase hex digits, at [1]",
      );
      expect(unreadable.responseBody).toContain('"url":"[redacted]"');
      expect(unreadable.requestId).toBe("req-1");
      expectNoLink(unreadable);
    },
  );

  it("holds an answer cut short with every link's query hidden, and no parse failure", async () => {
    const whole = JSON.stringify({ ...METHOD, files: [signedFile] });
    answering(whole.slice(0, whole.indexOf(SIGNATURE) + SIGNATURE.length));

    const err = await new PipelexApiClient({ baseUrl: BASE_URL })
      .getMethod("m1")
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as Error).message).toBe(
      "API GET /v1/methods/m1 answered 200 with a body that is not JSON",
    );
    expect((err as ApiResponseError).responseBody).toContain("?[redacted]");
    // The parse failure is not kept: V8's message quotes the text around the failure.
    expectNoLink(err as Error);
  });

  it("holds a blob answer it cannot read with every upload link hidden", async () => {
    const blob = sha256(LARGE);
    const platform = new Platform({
      missingAnswer: {
        missing: [{ sha256: blob, size: LARGE.length, upload: { method: "PUT", url: link(blob) } }],
      },
    });
    const client = makeClient(platform);

    const err = await client
      .createMethod({ name: "M", contents: { "data/big.txt": LARGE } })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as Error).message).toBe(
      "API POST /v1/blobs/missing answered 200 with a body whose `missing` is not a list of " +
        "blobs, each with its upload target",
    );
    expect((err as ApiResponseError).responseBody).toContain('"url":"[redacted]"');
    expectNoLink(err as Error);
    expect(platform.storage).toEqual([]);
  });
});
