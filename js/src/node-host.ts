/**
 * The Node host: what the SDK uses that only Node has, behind one import that a bundler building
 * for any other runtime never follows. See `docs/architecture.md`, "The Node host".
 *
 * The operations that need Node, reading a local path (`upload.ts`), downloading a run's files and
 * the undici dispatcher of an artifact fetch (`artifacts.ts`), listing a method directory and
 * writing a saved tree to disk (`method-trees.ts`), get it from `loadNodeHost()`, and never import
 * a Node built-in, `undici` or the `mthds` root entry themselves. `loadNodeHost()` imports
 * `#node-host`, the package's own subpath import, which the `imports` map of `package.json`
 * resolves by condition: under `node` to `node-host/node.ts`, which holds those modules, and under
 * every other condition set, a browser's or an edge runtime's, to `node-host/unavailable.ts`,
 * which holds none. A bundler building for the browser therefore follows no Node built-in from the
 * barrel, statically or dynamically, and `tests/browser-bundle.test.ts` bundles the built package
 * for the browser to hold it to that. Node resolves the same import under its own condition, so
 * the Node-only operations work there as they always did. Where the host cannot be had, outside
 * Node, inside it without the `node` condition, or where the import itself fails, `loadNodeHost()`
 * answers why rather than throwing, so each operation refuses with its own class and verdict.
 */

import type { NodeHost } from "./node-host/node.js";

export type { NodeHost, TreeLister } from "./node-host/node.js";

/** True when running under Node (has `process.versions.node`). */
export function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" && process.versions != null && process.versions.node != null
  );
}

/**
 * The Node host could not be had: why, for a refusal to say, and the error behind it when the
 * host's import failed.
 */
export interface NodeHostAbsence {
  readonly host: null;
  /**
   * Why, as a clause a refusal puts after its own subject; `null` outside Node, where the
   * operation's own "Node only" refusal is the right one.
   */
  readonly reason: string | null;
  /** The import's own error, when the host's import failed rather than resolving to nothing. */
  readonly cause?: unknown;
}

/** The Node host, or why it could not be had. */
export type NodeHostLoad = { readonly host: NodeHost } | NodeHostAbsence;

/**
 * Inside Node, the package was resolved without the `node` export condition, as a bundle built
 * for the browser or for esbuild's `neutral` platform resolves it, so `#node-host` resolved to the
 * variant holding nothing.
 */
const NODE_CONDITION_MISSING =
  'this copy of @pipelex/sdk runs in Node but was resolved without the "node" export ' +
  "condition, which selects the part of the package that reaches Node's file system. Bundle " +
  'it for Node (esbuild platform "node", webpack target "node"), add "node" to the bundler\'s ' +
  "conditions (esbuild conditions, webpack resolve.conditionNames, Vite resolve.conditions), " +
  "or leave @pipelex/sdk out of the bundle.";

/**
 * Inside Node, the import of `#node-host` itself failed: the toolchain loading the package does
 * not resolve the `imports` map of `package.json`, as Jest before 29.4 does not, or the package is
 * installed in part. `detail` is the import's own error message.
 */
function hostImportFailed(detail: string): string {
  return (
    `the Node host of @pipelex/sdk could not be loaded (${detail}). The SDK reaches Node's file ` +
    'system through "#node-host", an entry of the "imports" map of its package.json, and a ' +
    'toolchain that does not resolve package "imports", such as Jest before 29.4, cannot load ' +
    "it: run under one that does, such as Node's own loader, Jest 29.4 or later or a current " +
    "bundler, or reinstall @pipelex/sdk if it is installed in part."
  );
}

/**
 * The Node host, or its absence and why, in three cases: a runtime that is not Node; Node itself
 * where the package was resolved without the `node` export condition, so `#node-host` resolved to
 * the variant holding nothing; and Node where the import of `#node-host` failed, as in a
 * toolchain that does not resolve the `imports` map of `package.json`, whose error is the
 * absence's `cause`. It never throws, so every operation needing Node refuses with its own class
 * and verdict. The runtime is checked first, so nothing is loaded where it is not Node.
 */
export async function loadNodeHost(): Promise<NodeHostLoad> {
  if (!isNodeRuntime()) return { host: null, reason: null };
  let loaded: { readonly nodeHost: NodeHost | null };
  try {
    loaded = await import("#node-host");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { host: null, reason: hostImportFailed(detail), cause };
  }
  return loaded.nodeHost === null
    ? { host: null, reason: NODE_CONDITION_MISSING }
    : { host: loaded.nodeHost };
}

/** The `cause` option of a refusal made for `absence`: the import's own error, when there is one. */
export function absenceCause(absence: NodeHostAbsence): { cause?: unknown } {
  return absence.cause === undefined ? {} : { cause: absence.cause };
}
