/**
 * The Node host absent inside Node: a Node process running a copy of the package resolved without
 * the `node` export condition, as a bundle built for esbuild's `neutral` platform resolves it. The
 * operations that need Node refuse with their verdicts unchanged, but say what happened, the
 * condition missing and how to bundle with it, rather than blaming the runtime. `#node-host` is
 * mocked to the variant such a bundle resolves, in a file of its own, so the mock touches no other
 * suite; `tests/node-host.test.ts` covers the refusals outside Node.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadArtifacts } from "../src/artifacts.js";
import type { ArtifactCapableClient } from "../src/artifacts.js";
import {
  ArtifactOperationError,
  InvalidLocalSourceError,
  RequestArgumentError,
  errorVerdictOf,
} from "../src/errors.js";
import { listDirectoryTree, writeMethodTreeTo } from "../src/method-trees.js";
import { PipelexApiClient } from "../src/client.js";
import { isNodeRuntime, loadNodeHost } from "../src/node-host.js";
import { readLocalPath } from "../src/upload.js";

vi.mock("#node-host", async () => await import("../src/node-host/unavailable.js"));

const CONDITION_MISSING =
  'this copy of @pipelex/sdk runs in Node but was resolved without the "node" export condition';

/** Why the host is absent, as the refusals say it. */
async function reason(): Promise<string | null> {
  const loaded = await loadNodeHost();
  return loaded.host === null ? loaded.reason : null;
}

/** A client the refusals must never reach. */
const UNREACHED: ArtifactCapableClient = {
  resolveStorageUrls: () => Promise.reject(new Error("the client was reached")),
  getRunResult: () => Promise.reject(new Error("the client was reached")),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Node host resolved without the node condition", () => {
  it("is absent although the runtime is Node, and the refusal says why", async () => {
    const loaded = await loadNodeHost();

    expect(isNodeRuntime()).toBe(true);
    expect(loaded.host).toBeNull();
    expect(await reason()).toMatch(new RegExp(`^${CONDITION_MISSING}`));
    expect(await reason()).toContain('esbuild platform "node"');
    expect("cause" in loaded).toBe(false);
  });

  it("refuses a directory given to the client before any request", async () => {
    const client = new PipelexApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
    // Answered here, so a regression fails the test rather than reaching a local server.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("the handshake was sent"));

    const refusal = await client.validate({ directory: "/a/method" }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RequestArgumentError);
    expect((refusal as Error).message).toBe(
      `validate() cannot list the directory '/a/method': ${await reason()}`,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a directory as an input error, naming the call and the condition", async () => {
    const refusal = await listDirectoryTree("/a/method", {}, "validate").catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RequestArgumentError);
    expect((refusal as Error).message).toBe(
      `validate() cannot list the directory '/a/method': ${await reason()}`,
    );
    expect((refusal as Error).message).not.toContain("only Node");
    expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "input", retryable: false });
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
    expect((refusal as Error).message).toBe(
      `writeMethodTree() cannot write to the file system: ${await reason()}`,
    );
    expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "config", retryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to read a path string, naming the path and the condition", async () => {
    const refusal = await readLocalPath("/a/report.pdf").catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(InvalidLocalSourceError);
    expect((refusal as InvalidLocalSourceError).source).toBe("/a/report.pdf");
    expect((refusal as Error).message).toBe(
      `Cannot read the local path "/a/report.pdf": ${await reason()}`,
    );
  });

  it("refuses to download artifacts as a config error, before reaching the client", async () => {
    const refusal = await downloadArtifacts(UNREACHED, { run_id: "run_1", dir: "/a/out" }).catch(
      (e: unknown) => e,
    );

    expect(refusal).toBeInstanceOf(ArtifactOperationError);
    expect((refusal as Error).message).toBe(
      `downloadArtifacts cannot write to the filesystem: ${await reason()}`,
    );
    expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "config", retryable: false });
  });
});
