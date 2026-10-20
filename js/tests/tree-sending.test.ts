/**
 * How the client sends a method's tree beyond choosing inline or by hash (`run-trees.test.ts`):
 * the caller's signal reaching every step before a run is created, the tree prepared once for a
 * start and its blocking fallback, the budgets a request carrying a tree gets, the inline limit
 * checked before a file is read, the version handshake kept for `HANDSHAKE_TTL_MS` and forgotten
 * when a refusal shows it stale, the two refusals answered by sending the request once more as
 * `mthds`'s `MthdsApiClient` answers them, and the refusal of a tree or a directory that is not
 * one — against a fetch scripted per test that plays the API and its storage.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProblem } from "mthds/protocol";
import type { MethodTreeSource } from "mthds/protocol";

import { PipelexApiClient } from "../src/client.js";
import { RequestArgumentError } from "../src/errors.js";
import { HANDSHAKE_TTL_MS } from "../src/method-trees.js";

const BASE_URL = "http://localhost:8081";
const STORAGE = "https://app-bucket.s3.amazonaws.com";
const MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n';
/** A file past the inline threshold on its own, so a tree holding it travels by hash. */
const LARGE = new Uint8Array(300 * 1024).fill(0x78);
const ENCODER = new TextEncoder();
const BLOCKING_CEILING_MS = 1_200_000;
const POLL_BUDGET_MS = 30_000;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  "/v1/pipe-io": [200, { is_valid: false, validation_errors: [], message: "not loaded" }],
  "/v1/runs/run-1/status": [200, { pipeline_run_id: "run-1", status: "COMPLETED" }],
};

/** A request to wait on until its signal aborts, then fail as fetch fails on an abort. */
function untilAborted(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init.signal!;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

interface Script {
  /** What the `n`th handshake adds to its answer (`blob_store` defaults to `true`). */
  version?: (n: number) => Record<string, unknown>;
  /** The answer to the `n`th request on `path`, or `undefined` for the default one. */
  route?: (
    path: string,
    body: unknown,
    n: number,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined;
  /** The answer to an upload, by default a `200`. */
  storage?: (url: string, init: RequestInit) => Promise<Response>;
}

interface Exchange {
  readonly paths: string[];
  readonly signals: Map<string, AbortSignal | undefined>;
  readonly uploads: string[];
  body(path: string, nth?: number): unknown;
}

/** Play the API and its storage for one test, by `script`, and record what was asked. */
function playApi(script: Script = {}): Exchange {
  const paths: string[] = [];
  const bodies: { path: string; body: unknown }[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const uploads: string[] = [];
  const counts = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (!url.startsWith(BASE_URL)) {
        uploads.push(url);
        return script.storage ? script.storage(url, init) : new Response(null, { status: 200 });
      }
      const path = new URL(url).pathname;
      paths.push(path);
      signals.set(path, init.signal ?? undefined);
      const n = (counts.get(path) ?? 0) + 1;
      counts.set(path, n);
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      bodies.push({ path, body });
      const scripted = script.route?.(path, body, n, init);
      if (scripted !== undefined) return scripted;
      if (path === "/v1/version") {
        return jsonResponse(200, {
          protocol_version: "1",
          runner_version: "0.90.0",
          blob_store: true,
          ...script.version?.(n),
        });
      }
      if (path === "/v1/blobs/missing") {
        const { blobs } = body as { blobs: { sha256: string; size: number }[] };
        const missing = blobs.map((blob) => ({
          ...blob,
          upload: { method: "PUT", url: `${STORAGE}/blobs/${blob.sha256}`, headers: {} },
        }));
        return jsonResponse(200, { missing });
      }
      const [status, answer] = ROUTE_ANSWERS[path] ?? [404, { detail: "Not Found" }];
      return jsonResponse(status, answer);
    },
  );
  return {
    paths,
    signals,
    uploads,
    body: (path, nth = 1) => bodies.filter((entry) => entry.path === path)[nth - 1]?.body,
  };
}

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

/**
 * A tree held in memory, its files read through `readFile`, which calls `onRead` first: what a
 * caller's own `MethodTreeSource` looks like to the client.
 */
function treeOf(
  files: Record<string, Uint8Array | string>,
  onRead: (path: string) => void = () => undefined,
): MethodTreeSource & { reads: string[] } {
  const entries = Object.entries(files)
    .map(([path, content]) => {
      const bytes = typeof content === "string" ? ENCODER.encode(content) : content;
      return { path, bytes, size: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const reads: string[] = [];
  return {
    files: entries.map(({ path, size, sha256: hash }) => ({ path, size, sha256: hash })),
    digest: `sha256:${"0".repeat(64)}`,
    reads,
    readFile: (path: string) => {
      reads.push(path);
      onRead(path);
      return Promise.resolve(entries.find((entry) => entry.path === path)!.bytes);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an abort before the run is created", () => {
  it("stops startAndWaitForResult inside a file's read, and no run is started", async () => {
    const api = playApi();
    const controller = new AbortController();
    const tree = treeOf({ "main.mthds": MAIN, "data/big.bin": LARGE }, () => controller.abort());

    const err = await makeClient()
      .startAndWaitForResult({ tree }, { signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    expect(err).toBe(controller.signal.reason);
    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing"]);
    expect(api.uploads).toEqual([]);
  });

  it("stops an upload in flight, and neither the start nor the blocking execute is sent", async () => {
    const controller = new AbortController();
    let uploadSignal: AbortSignal | undefined;
    const api = playApi({
      storage: (_url, init) => {
        uploadSignal = init.signal ?? undefined;
        controller.abort();
        return untilAborted(init);
      },
    });
    const tree = treeOf({ "data/big.bin": LARGE });

    const err = await makeClient()
      .startAndWaitForResult({ tree }, { signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    expect(err).toBe(controller.signal.reason);
    expect(uploadSignal?.aborted).toBe(true);
    expect(api.paths).not.toContain("/v1/start");
    expect(api.paths).not.toContain("/v1/execute");
  });

  it("stops the blocking execute's preparation against a bare runner, and no run is started", async () => {
    const controller = new AbortController();
    const api = playApi({
      version: () => ({ implementation: "pipelex-api" }),
      storage: (_url, init) => {
        controller.abort();
        return untilAborted(init);
      },
    });

    const err = await makeClient()
      .startAndWaitForResult(
        { tree: treeOf({ "data/big.bin": LARGE }) },
        { signal: controller.signal },
      )
      .catch((thrown: unknown) => thrown);

    expect(err).toBe(controller.signal.reason);
    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing"]);
  });

  it("stops the handshake in flight on validate", async () => {
    const controller = new AbortController();
    const api = playApi({
      route: (path, _body, _n, init) => {
        if (path !== "/v1/version") return undefined;
        controller.abort();
        return untilAborted(init);
      },
    });

    const err = await makeClient()
      .validate({ contents: { "main.mthds": MAIN } }, false, { signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    expect(err).toBe(controller.signal.reason);
    expect(api.signals.get("/v1/version")?.aborted).toBe(true);
    expect(api.paths).toEqual(["/v1/version"]);
  });

  it("stops the blob route in flight on validate", async () => {
    const controller = new AbortController();
    const api = playApi({
      route: (path, _body, _n, init) => {
        if (path !== "/v1/blobs/missing") return undefined;
        controller.abort();
        return untilAborted(init);
      },
    });

    const err = await makeClient()
      .validate({ tree: treeOf({ "data/big.bin": LARGE }) }, false, { signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    expect(err).toBe(controller.signal.reason);
    expect(api.signals.get("/v1/blobs/missing")?.aborted).toBe(true);
    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing"]);
  });
});

describe("startAndWaitForResult prepares the tree once", () => {
  it("sends the blocking execute the map the start sent when the durable routes are missing", async () => {
    // A runner that looks hosted but answers the start as a route it does not serve.
    const api = playApi({
      route: (path) =>
        path === "/v1/start" ? jsonResponse(404, { detail: "Not Found" }) : undefined,
    });
    const tree = treeOf({ "main.mthds": MAIN, "data/big.bin": LARGE });

    const results = await makeClient().startAndWaitForResult({ tree });

    expect(results.main_stuff).toEqual({ text: "ok" });
    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/start", "/v1/execute"]);
    expect(api.uploads).toHaveLength(2);
    expect([...tree.reads].sort()).toEqual(["data/big.bin", "main.mthds"]);
    const startFiles = (api.body("/v1/start") as { files: unknown }).files;
    expect(startFiles).toEqual({
      "data/big.bin": { sha256: sha256(LARGE), size: LARGE.length },
      "main.mthds": { sha256: sha256(MAIN), size: ENCODER.encode(MAIN).length },
    });
    expect((api.body("/v1/execute") as { files: unknown }).files).toEqual(startFiles);
  });
});

describe("the budget of a request carrying a tree", () => {
  /** The delay of the last timer armed, the one of the request the call ends with. */
  function lastTimer(timer: { mock: { calls: unknown[][] } }): number {
    const delays = timer.mock.calls.map((call) => Number(call[1]));
    return delays[delays.length - 1]!;
  }

  it.each([
    ["a bundle riding extra as mthds_contents", { extra: { mthds_contents: [MAIN] } }],
    ["a bundle riding extra as bundle_b64", { extra: { bundle_b64: "UEsDBA==" } }],
  ])("gives the blocking ceiling to a start carrying %s", async (_, options) => {
    playApi();
    const timer = vi.spyOn(globalThis, "setTimeout");
    await makeClient().start(options);
    expect(lastTimer(timer)).toBe(BLOCKING_CEILING_MS);
  });

  it("gives the poll budget to a start whose extra carries an empty bundle", async () => {
    playApi();
    const timer = vi.spyOn(globalThis, "setTimeout");
    await makeClient().start({ pipe_code: "p", extra: { mthds_contents: [] } });
    expect(lastTimer(timer)).toBe(POLL_BUDGET_MS);
  });

  it("gives the blocking ceiling to a crate request sending a large tree inline", async () => {
    playApi({ version: () => ({ blob_store: false }) });
    const timer = vi.spyOn(globalThis, "setTimeout");
    await makeClient().pipeIo({ contents: { "main.mthds": MAIN, "data/big.bin": LARGE } });
    expect(lastTimer(timer)).toBe(BLOCKING_CEILING_MS);
  });

  it("gives the blocking ceiling to a crate request given a large files map as is", async () => {
    playApi();
    const timer = vi.spyOn(globalThis, "setTimeout");
    await makeClient().pipeIo({ files: { "data/big.txt": "x".repeat(LARGE.length) } });
    expect(lastTimer(timer)).toBe(BLOCKING_CEILING_MS);
  });

  it("keeps the static-route budget for a crate request whose tree went by hash", async () => {
    playApi();
    const timer = vi.spyOn(globalThis, "setTimeout");
    await makeClient().pipeIo({ contents: { "main.mthds": MAIN, "data/big.bin": LARGE } });
    expect(lastTimer(timer)).toBe(POLL_BUDGET_MS);
  });
});

describe("the inline limit of an API keeping no blob store", () => {
  it("refuses a tree whose files alone pass the limit before reading any of them", async () => {
    const api = playApi({
      version: () => ({ blob_store: false, limits: { method_tree: { max_inline_bytes: 1024 } } }),
    });
    const tree = treeOf({ "data/big.bin": new Uint8Array(2048) }, () => {
      throw new Error("the tree was read");
    });

    const err = await makeClient()
      .execute({ tree })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "execute() cannot send the method's tree: the API keeps no blob store, so the tree travels " +
        "inline, and its files alone weigh 2048 bytes, past the 1024 bytes it takes inline (its " +
        "max_inline_bytes), so the request was not sent.",
    );
    expect(tree.reads).toEqual([]);
    expect(api.paths).toEqual(["/v1/version"]);
  });

  it("refuses a tree whose files fit but whose inline map passes the limit", async () => {
    const api = playApi({
      version: () => ({ blob_store: false, limits: { method_tree: { max_inline_bytes: 1024 } } }),
    });
    // Bytes that are no UTF-8 travel as Base64, a third heavier than the bytes.
    const tree = treeOf({ "data/blob.bin": new Uint8Array(900).fill(0xff) });

    const err = await makeClient()
      .execute({ tree })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toMatch(
      /and its inline map weighs \d+ bytes, past the 1024 bytes/,
    );
    expect(api.paths).toEqual(["/v1/version"]);
  });
});

describe("the version handshake", () => {
  it("is kept for HANDSHAKE_TTL_MS, then asked again", async () => {
    const api = playApi();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const client = makeClient();

    await client.validate({ contents: { "main.mthds": MAIN } });
    now.mockReturnValue(1_000_000 + HANDSHAKE_TTL_MS - 1);
    await client.validate({ contents: { "main.mthds": MAIN } });
    expect(api.paths.filter((path) => path === "/v1/version")).toHaveLength(1);

    now.mockReturnValue(1_000_000 + HANDSHAKE_TTL_MS);
    await client.validate({ contents: { "main.mthds": MAIN } });
    expect(api.paths.filter((path) => path === "/v1/version")).toHaveLength(2);
  });

  it("is forgotten when the blob route is gone, and the tree prepared again on a fresh one", async () => {
    const api = playApi({
      version: (n) => (n === 1 ? {} : { blob_store: false }),
      route: (path) =>
        path === "/v1/blobs/missing" ? jsonResponse(404, { detail: "Not Found" }) : undefined,
    });

    await makeClient().execute({ tree: treeOf({ "data/big.txt": "x".repeat(LARGE.length) }) });

    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/version", "/v1/execute"]);
    expect(api.body("/v1/execute")).toEqual({
      files: { "data/big.txt": "x".repeat(LARGE.length) },
    });
  });

  it("is forgotten when a tree is refused as too large, and the request sent once more", async () => {
    const api = playApi({
      version: (n) => (n === 1 ? {} : { limits: { method_tree: { max_inline_bytes: 16 } } }),
      route: (path, _body, n) =>
        path === "/v1/validate" && n === 1
          ? jsonResponse(422, { code: "method_tree_too_large", detail: "too large" })
          : undefined,
    });

    const verdict = await makeClient().validate({ contents: { "main.mthds": MAIN } });

    expect(verdict.is_valid).toBe(true);
    expect(api.paths).toEqual([
      "/v1/version",
      "/v1/validate",
      "/v1/version",
      "/v1/blobs/missing",
      "/v1/validate",
    ]);
    expect((api.body("/v1/validate", 1) as { files: unknown }).files).toEqual({
      "main.mthds": MAIN,
    });
    expect((api.body("/v1/validate", 2) as { files: unknown }).files).toEqual({
      "main.mthds": { sha256: sha256(MAIN), size: ENCODER.encode(MAIN).length },
    });
  });

  it.each([
    ["pipelex-api's error type", { error_type: "MethodTreeTooLarge", message: "too large" }],
    [
      "the registry's method.package_invalid naming a limit",
      { code: "method.package_invalid", params: { limit: 1024 }, detail: "too large" },
    ],
  ])("reads %s as a tree refused as too large", async (_, refusal) => {
    const api = playApi({
      route: (path, _body, n) =>
        path === "/v1/execute" && n === 1 ? jsonResponse(422, refusal) : undefined,
    });

    await makeClient().execute({ contents: { "main.mthds": MAIN } });

    expect(api.paths).toEqual(["/v1/version", "/v1/execute", "/v1/version", "/v1/execute"]);
  });

  it("sends a files map given as is only once when it is refused as too large", async () => {
    const api = playApi({
      route: (path) =>
        path === "/v1/validate"
          ? jsonResponse(422, { code: "method_tree_too_large", detail: "too large" })
          : undefined,
    });

    await expect(makeClient().validate({ files: { "main.mthds": MAIN } })).rejects.toMatchObject({
      status: 422,
    });
    expect(api.paths).toEqual(["/v1/validate"]);
  });

  it("does not send again a start under an idempotency key refused as too large", async () => {
    const api = playApi({
      route: (path) =>
        path === "/v1/start"
          ? jsonResponse(422, { code: "method_tree_too_large", detail: "too large" })
          : undefined,
    });

    await expect(
      makeClient().start({ contents: { "main.mthds": MAIN }, idempotencyKey: "key-1" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(api.paths).toEqual(["/v1/version", "/v1/start"]);
  });
});

describe("a request whose blobs went missing", () => {
  /** The problem a runner answers a request naming blobs it lacks with, coded from the registry. */
  function blobsMissing(missing: string[]): unknown {
    return buildProblem("request.blobs_missing", { missing_blobs: missing }, { status: 422 });
  }

  it("uploads the blobs a request.blobs_missing problem lists and sends the request once more", async () => {
    const api = playApi({
      route: (path, _body, n) =>
        path === "/v1/execute" && n === 1
          ? jsonResponse(422, blobsMissing([sha256(LARGE)]))
          : undefined,
    });
    const tree = treeOf({ "main.mthds": MAIN, "data/big.bin": LARGE });

    await makeClient().execute({ tree });

    expect(api.paths).toEqual([
      "/v1/version",
      "/v1/blobs/missing",
      "/v1/execute",
      "/v1/blobs/missing",
      "/v1/execute",
    ]);
    expect(api.body("/v1/blobs/missing", 2)).toEqual({
      blobs: [{ sha256: sha256(LARGE), size: LARGE.length }],
    });
    expect(api.uploads).toHaveLength(3);
    expect(api.body("/v1/execute", 2)).toEqual(api.body("/v1/execute", 1));
  });

  it("answers a list naming a blob the tree does not hold as it came", async () => {
    const api = playApi({
      route: (path) =>
        path === "/v1/execute" ? jsonResponse(422, blobsMissing(["f".repeat(64)])) : undefined,
    });

    await expect(
      makeClient().execute({ tree: treeOf({ "data/big.bin": LARGE }) }),
    ).rejects.toMatchObject({ status: 422 });
    expect(api.paths).toEqual(["/v1/version", "/v1/blobs/missing", "/v1/execute"]);
  });
});

describe("a tree or a directory that is not one", () => {
  it.each([
    ["a path", "a/path", "string"],
    ["an empty object", {}, "an object without them"],
  ])(
    "refuses a tree given as %s with RequestArgumentError, before any request",
    async (_, tree, fault) => {
      const api = playApi();
      const client = makeClient();
      for (const call of [
        () => client.validate({ tree } as never),
        () => client.execute({ tree } as never),
        () => client.pipeIo({ tree } as never),
      ]) {
        const err = await call().catch((thrown: unknown) => thrown);
        expect(err).toBeInstanceOf(RequestArgumentError);
        expect((err as Error).message).toContain(`not a listed method tree`);
        expect((err as Error).message).toContain(`got ${fault}.`);
      }
      expect(api.paths).toEqual([]);
    },
  );

  it("refuses a crate request's directory that is not a string, as a run does", async () => {
    const api = playApi();
    const client = makeClient();
    for (const call of [
      () => client.pipeIo({ directory: 42 } as never),
      () => client.execute({ directory: 42 } as never),
    ]) {
      const err = await call().catch((thrown: unknown) => thrown);
      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as Error).message).toMatch(
        /^(pipeIo|execute)\(\) got a directory that is not a path: give the method's directory as a string\.$/,
      );
    }
    expect(api.paths).toEqual([]);
  });

  it("makes two of validate's selectors a compile error", () => {
    const client = makeClient();
    const typeOnly = (): void => {
      // @ts-expect-error — the tree and a selector exclude each other.
      void client.validate({ directory: "methods/x", method_id: "mt_1" });
      // @ts-expect-error — two forms of the tree exclude each other.
      void client.validate({ contents: {}, files: {} });
      // @ts-expect-error — the two selectors exclude each other.
      void client.validate({ method_ref: "github.com/a/b", method_id: "mt_1" });
    };
    expect(typeOnly).toBeTypeOf("function");
  });
});
