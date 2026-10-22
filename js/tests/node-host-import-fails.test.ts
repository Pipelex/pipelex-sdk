/**
 * The Node host's import failing inside Node, as in a toolchain that does not resolve the
 * `imports` map of `package.json` (Jest before 29.4) or a package installed in part. Every
 * operation that needs Node refuses with its own class and verdict, saying the host could not be
 * loaded and why, with the import's own error as the `cause`, never that the `node` condition was
 * missing; a directory given to the client is refused before any request; and `fetchArtifact`
 * falls back to the platform's default dispatcher, the undici dispatcher being a Node refinement
 * (`docs/artifact-download.md`). The host is mocked to fail here, in a file of its own, so the
 * mock touches no other suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadArtifacts, fetchArtifact } from "../src/artifacts.js";
import type { ArtifactCapableClient, ResolvedArtifact } from "../src/artifacts.js";
import { PipelexApiClient } from "../src/client.js";
import {
  ArtifactOperationError,
  InvalidLocalSourceError,
  RequestArgumentError,
  errorVerdictOf,
} from "../src/errors.js";
import { listDirectoryTree, writeMethodTreeTo } from "../src/method-trees.js";
import { loadNodeHost } from "../src/node-host.js";
import { readLocalPath } from "../src/upload.js";

vi.mock("#node-host", () => {
  // What Node throws for a package import its toolchain cannot resolve.
  throw Object.assign(
    new Error('Package import specifier "#node-host" is not defined in package.json'),
    { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED" },
  );
});

const URI = "pipelex-storage://org/runs/01JRUN/outputs/illustration.png";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A client resolving `URI` to a fresh link; nothing else is called. */
function resolvingClient(): ArtifactCapableClient {
  return {
    async resolveStorageUrls(input) {
      const items: ResolvedArtifact[] = input.uris.map((uri) => ({
        uri,
        url: `https://store.example/${encodeURIComponent(uri)}?sig=abc`,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        content_type: "image/png",
        error: null,
      }));
      return { items };
    },
    getRunResult: () => Promise.reject(new Error("the client was reached")),
  };
}

/**
 * Hold a refusal to the import failure: its message names the host that could not be loaded, the
 * toolchain at fault and the import's own error, which is its `cause`, and never the `node`
 * condition.
 */
function expectImportFailure(refusal: unknown, subject: string): void {
  const message = (refusal as Error).message;
  const cause = (refusal as Error).cause;
  expect(cause).toBeInstanceOf(Error);
  expect(message.startsWith(`${subject}: the Node host of @pipelex/sdk`)).toBe(true);
  expect(message).toContain(`could not be loaded (${(cause as Error).message})`);
  expect(message).toContain('"imports"');
  expect(message).toContain("Jest 29.4 or later");
  expect(message).not.toContain('"node" export condition');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Node host's import failing", () => {
  it("is an absence with a reason and the import's error, never a rejection", async () => {
    const loaded = await loadNodeHost();

    expect(loaded.host).toBeNull();
    expect(loaded.host === null && loaded.reason).toMatch(/could not be loaded/);
    expect(loaded.host === null && loaded.cause).toBeInstanceOf(Error);
  });

  it("refuses a directory as an input error", async () => {
    const refusal = await listDirectoryTree("/a/method", {}, "validate").catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RequestArgumentError);
    expectImportFailure(refusal, "validate() cannot list the directory '/a/method'");
    expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "input", retryable: false });
  });

  it("refuses a directory given to the client before any request", async () => {
    const client = new PipelexApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
    // Answered here, so a regression fails the test rather than reaching a local server.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("the handshake was sent"));

    const refusal = await client.validate({ directory: "/a/method" }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RequestArgumentError);
    expectImportFailure(refusal, "validate() cannot list the directory '/a/method'");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to write a tree to disk as a config error, before any download", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const files = [
      {
        path: "main.mthds",
        sha256: "0".repeat(64),
        size: 1,
        url: "https://storage.example/main.mthds",
        expires_at: "2026-10-22T12:00:00Z",
      },
    ];

    const refusal = await writeMethodTreeTo(files, "/a/tree", { timeoutMs: 1_000 }).catch(
      (e: unknown) => e,
    );

    expect(refusal).toBeInstanceOf(RequestArgumentError);
    expectImportFailure(refusal, "writeMethodTree() cannot write to the file system");
    expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "config", retryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to read a path string", async () => {
    const refusal = await readLocalPath("/a/report.pdf").catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(InvalidLocalSourceError);
    expect((refusal as InvalidLocalSourceError).source).toBe("/a/report.pdf");
    expectImportFailure(refusal, 'Cannot read the local path "/a/report.pdf"');
  });

  it("refuses to download artifacts as a config error, before reaching the client", async () => {
    const refusal = await downloadArtifacts(resolvingClient(), {
      run_id: "run_1",
      dir: "/a/out",
    }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ArtifactOperationError);
    expectImportFailure(refusal, "downloadArtifacts cannot write to the filesystem");
    expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "config", retryable: false });
  });

  it("fetches an artifact on the platform's default dispatcher", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response(BYTES, { status: 200 })));

    const response = await fetchArtifact(resolvingClient(), URI);

    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0] as [URL, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeUndefined();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });
});
