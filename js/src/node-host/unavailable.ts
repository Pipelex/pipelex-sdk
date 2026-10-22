/**
 * The Node host as every runtime other than Node resolves it: absent. `package.json` maps
 * `#node-host` to this file under every condition set without `node`, a browser's or an edge
 * runtime's, so the graph a bundler follows there holds no Node built-in, no `undici` and not the
 * `mthds` root entry (see `src/node-host.ts`). It imports nothing at run time.
 */

import type { NodeHost } from "./node.js";

export const nodeHost: NodeHost | null = null;
