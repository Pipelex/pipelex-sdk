/**
 * The Node host as Node resolves it: the one module of the SDK that loads what only Node has,
 * `node:fs/promises`, `node:path`, the `mthds` package's tree lister and `undici`'s `Agent`.
 *
 * Nothing imports this file by its path. `src/node-host.ts` reaches it through `#node-host`, the
 * package's own subpath import, which `package.json` maps to this file under the `node` condition
 * and to `./unavailable.ts` under every other condition set, so a bundler building for a browser
 * or an edge runtime never follows it (see `src/node-host.ts`).
 *
 * The two built-ins load with the host. The `mthds` root entry and `undici` are heavier, and only
 * listing a directory or fetching an artifact needs one of them, so each loads on its first use.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MethodTreeError, listMethodTree } from "mthds";
import type { Agent } from "undici";

/** The `mthds` package's lister of a method directory, and the error it refuses a tree with. */
export interface TreeLister {
  readonly listMethodTree: typeof listMethodTree;
  readonly MethodTreeError: typeof MethodTreeError;
}

/** What only Node has, as the SDK uses it. */
export interface NodeHost {
  /** `node:fs/promises`. */
  readonly fs: typeof fs;
  /** `node:path`. */
  readonly path: typeof path;
  /** The `mthds` root entry's tree lister, loading that entry on the first call. */
  loadTreeLister(): Promise<TreeLister>;
  /** `undici`'s `Agent`, loading `undici` on the first call. */
  loadAgent(): Promise<typeof Agent>;
}

export const nodeHost: NodeHost = {
  fs,
  path,
  async loadTreeLister() {
    const { listMethodTree, MethodTreeError } = await import("mthds");
    return { listMethodTree, MethodTreeError };
  },
  async loadAgent() {
    const { Agent } = await import("undici");
    return Agent;
  },
};
