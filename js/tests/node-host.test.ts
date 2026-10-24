/**
 * The Node host (`src/node-host.ts`): `loadNodeHost()` answers the host in Node and `null`
 * elsewhere, the variant every other runtime resolves holds no host, and the operations that need
 * Node refuse to run without it, before anything is downloaded. That a browser bundle resolves the
 * absent variant, and Node the host, through the package's own `imports` map is held by
 * `tests/browser-bundle.test.ts` against the built package.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadArtifacts } from "../src/artifacts.js";
import type { ArtifactCapableClient } from "../src/artifacts.js";
import {
  ArtifactOperationError,
  InvalidLocalSourceError,
  RequestArgumentError,
} from "../src/errors.js";
import { listDirectoryTree, writeMethodTreeTo } from "../src/method-trees.js";
import { PipelexApiClient } from "../src/client.js";
import { loadNodeHost } from "../src/node-host.js";
import { nodeHost as absentHost } from "../src/node-host/unavailable.js";
import { readLocalPath } from "../src/upload.js";

/** A client the refusals must never reach. */
const UNREACHED: ArtifactCapableClient = {
  resolveStorageUrls: () => Promise.reject(new Error("the client was reached")),
  getRunResult: () => Promise.reject(new Error("the client was reached")),
};

/** Run `body` as a runtime without `process.versions.node` would. */
async function outsideNode<T>(body: () => Promise<T>): Promise<T> {
  const versions = Object.getOwnPropertyDescriptor(process, "versions")!;
  Object.defineProperty(process, "versions", { value: {}, configurable: true });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "versions", versions);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadNodeHost", () => {
  it("answers the host in Node, with the file system and the loaders", async () => {
    const { host } = await loadNodeHost();

    expect(host).not.toBeNull();
    expect(typeof host!.fs.readFile).toBe("function");
    expect(host!.path.join("a", "b")).toBe(join("a", "b"));
    const { listMethodTree, MethodTreeError } = await host!.loadTreeLister();
    expect(typeof listMethodTree).toBe("function");
    expect(typeof MethodTreeError).toBe("function");
    expect(typeof (await host!.loadAgent())).toBe("function");
  });

  it("answers no host outside Node, with no reason, the operation's own refusal applying", async () => {
    expect(await outsideNode(() => loadNodeHost())).toEqual({ host: null, reason: null });
  });

  it("is absent from the variant every other runtime resolves", () => {
    expect(absentHost).toBeNull();
  });
});

describe("the operations that need Node, outside it", () => {
  it("refuse a directory, naming the call", async () => {
    const refusal = await outsideNode(() =>
      listDirectoryTree("/anywhere", {}, "validate").catch((e: unknown) => e),
    );

    expect(refusal).toBeInstanceOf(RequestArgumentError);
    expect((refusal as Error).message).toBe(
      "validate() got a directory, which only Node can list. In the browser or an edge runtime, " +
        "give the method's tree as contents, tree or files instead.",
    );
    expect((refusal as ProblemError).problem).toMatchObject({
      code: "runtime.unsupported",
      retry: "no",
    });
  });

  it("refuse a directory given to the client before any request, the handshake included", async () => {
    const client = new PipelexApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
    // Answered here, so a regression fails the test rather than reaching a local server.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("the handshake was sent"));

    const refusal = await outsideNode(() =>
      client.validate({ directory: "/a/method" }).catch((e: unknown) => e),
    );

    expect(refusal).toBeInstanceOf(RequestArgumentError);
    expect((refusal as Error).message).toMatch(/^validate\(\) got a directory, which only Node/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reject an aborted directory request with the abort reason, not the Node-only refusal", async () => {
    const client = new PipelexApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("the handshake was sent"));
    const reason = new Error("the caller gave up");

    const refusal = await outsideNode(() =>
      client
        .validate({ directory: "/a/method" }, false, { signal: AbortSignal.abort(reason) })
        .catch((e: unknown) => e),
    );

    expect(refusal).toBe(reason);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuse to write a tree to disk, before any download", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const destination = await mkdtemp(join(tmpdir(), "pipelex-sdk-node-host-"));
    try {
      const files = [
        {
          path: "main.mthds",
          sha256: "0".repeat(64),
          size: 1,
          url: "https://storage.example/main.mthds",
          expires_at: "2026-10-22T12:00:00Z",
        },
      ];
      const refusal = await outsideNode(() =>
        writeMethodTreeTo(files, join(destination, "tree"), { timeoutMs: 1_000 }).catch(
          (e: unknown) => e,
        ),
      );

      expect(refusal).toBeInstanceOf(RequestArgumentError);
      expect((refusal as Error).message).toMatch(/^writeMethodTree\(\) writes to a file system/);
      expect((refusal as ProblemError).code).toBe("runtime.unsupported");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it("refuse a path string, as Node-only", async () => {
    const refusal = await outsideNode(() =>
      readLocalPath("/a/report.pdf").catch((e: unknown) => e),
    );

    expect(refusal).toBeInstanceOf(InvalidLocalSourceError);
    expect((refusal as Error).message).toBe(
      'Cannot read the local path "/a/report.pdf" outside Node — path strings are Node-only. ' +
        "In the browser or an edge runtime, pass the file as bytes (Blob/File/ArrayBuffer/Uint8Array).",
    );
  });

  it("refuse to download artifacts, as Node-only", async () => {
    const refusal = await outsideNode(() =>
      downloadArtifacts(UNREACHED, { run_id: "run_1", dir: "/a/out" }).catch((e: unknown) => e),
    );

    expect(refusal).toBeInstanceOf(ArtifactOperationError);
    expect((refusal as Error).message).toBe(
      "downloadArtifacts writes to a filesystem and is Node-only. In another runtime, resolve " +
        "with resolveArtifacts or stream with fetchArtifact instead.",
    );
    expect((refusal as ProblemError).code).toBe("runtime.unsupported");
  });
});
