/**
 * The Node host (`src/node-host.ts`): `loadNodeHost()` answers the host in Node and `null`
 * elsewhere, the variant every other runtime resolves holds no host, and the operations that need
 * Node refuse to run without it, before anything is downloaded. That a browser bundle resolves the
 * absent variant, and Node the host, through the package's own `imports` map is held by
 * `tests/browser-bundle.test.ts` against the built package.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestArgumentError, errorVerdictOf } from "../src/errors.js";
import { listDirectoryTree, writeMethodTreeTo } from "../src/method-trees.js";
import { loadNodeHost } from "../src/node-host.js";
import { nodeHost as absentHost } from "../src/node-host/unavailable.js";

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
    const host = await loadNodeHost();

    expect(host).not.toBeNull();
    expect(typeof host!.fs.readFile).toBe("function");
    expect(host!.path.join("a", "b")).toBe(join("a", "b"));
    const { listMethodTree, MethodTreeError } = await host!.loadTreeLister();
    expect(typeof listMethodTree).toBe("function");
    expect(typeof MethodTreeError).toBe("function");
    expect(typeof (await host!.loadAgent())).toBe("function");
  });

  it("answers null outside Node", async () => {
    expect(await outsideNode(() => loadNodeHost())).toBeNull();
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
    expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "input", retryable: false });
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
      expect(errorVerdictOf(refusal)).toEqual({ errorDomain: "config", retryable: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
