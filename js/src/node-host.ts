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
 * the Node-only operations work there as they always did.
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
 * The Node host, or `null` in two cases: in a runtime that is not Node, or in Node itself where
 * the package was resolved without the `node` export condition, as a bundle built for the browser
 * or for esbuild's `neutral` platform resolves it. A refusal tells them apart with
 * `nodeConditionMissing()`. The runtime is checked first, so nothing is loaded where it is not
 * Node.
 */
export async function loadNodeHost(): Promise<NodeHost | null> {
  if (!isNodeRuntime()) return null;
  const loaded: { readonly nodeHost: NodeHost | null } = await import("#node-host");
  return loaded.nodeHost;
}

/**
 * What a refusal says once `loadNodeHost()` has answered `null`: inside Node, that the package was
 * resolved without the `node` export condition, and how to resolve it with it; `null` outside
 * Node, where the operation's own "Node only" refusal is the right one.
 */
export function nodeConditionMissing(): string | null {
  if (!isNodeRuntime()) return null;
  return (
    'this copy of @pipelex/sdk runs in Node but was resolved without the "node" export ' +
    "condition, which selects the part of the package that reaches Node's file system. Bundle " +
    'it for Node (esbuild platform "node", webpack target "node"), add "node" to the bundler\'s ' +
    "conditions (esbuild conditions, webpack resolve.conditionNames, Vite resolve.conditions), " +
    "or leave @pipelex/sdk out of the bundle."
  );
}
