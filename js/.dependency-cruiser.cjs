/**
 * dependency-cruiser config — enforces the one-way boundary this SDK rests on:
 *
 *   `@pipelex/sdk` depends on `mthds` for the pure MTHDS Protocol wire types,
 *   and ONLY through the published `mthds/protocol` subpath. It must never import
 *   bare `mthds` (whose top-level barrel re-exports the runner-side surface —
 *   `MthdsApiClient`, the `Dict*` concretes, run-lifecycle types) nor deep-import
 *   `mthds` internals. Pinning to the subpath keeps the product client tied to the
 *   standard's public surface, so it can't silently diverge from the protocol.
 *
 * Why the rule matches `node_modules/mthds/` (the resolved path) rather than the
 * `mthds` specifier: dependency-cruiser leaves the `mthds/protocol` subpath import
 * unresolved as the bare specifier `mthds/protocol` (it doesn't follow the exports
 * map), while a bare `mthds` import resolves to `node_modules/mthds/dist/index.js`
 * and a deep import resolves under `node_modules/mthds/…`. So forbidding resolved
 * paths under `node_modules/mthds/` catches the bare + deep imports while letting
 * the legitimate subpath through. The `pathNot` protocol exclusion future-proofs
 * the rule against a depcruise version that DOES resolve the subpath to a file.
 *
 * The `pipelex-sdk` command (`src/cli.ts`, the executable, and `src/cli/`) sits at the
 * TOP of the graph, the other way round: nothing in the SDK imports it, so a library user
 * never loads it, and it reaches the SDK only through the public barrel `src/index.ts`,
 * as any other caller would, so it can use nothing a caller could not.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-mthds-internals",
      severity: "error",
      comment:
        "Import the MTHDS standard's types only via the published `mthds/protocol` subpath — never bare `mthds` (pulls the runner-side surface) or a deep import into `mthds` internals.",
      from: { path: "^src/" },
      to: { path: "node_modules/mthds/", pathNot: "node_modules/mthds/(dist/)?protocol/" },
    },
    {
      name: "no-import-of-the-command",
      severity: "error",
      comment:
        "The `pipelex-sdk` command sits at the top of the graph: no module of the SDK imports `src/cli.ts` or `src/cli/`.",
      from: { path: "^src/", pathNot: "^src/cli(\\.ts$|/)" },
      to: { path: "^src/cli(\\.ts$|/)" },
    },
    {
      name: "command-uses-the-public-surface",
      severity: "error",
      comment:
        "The `pipelex-sdk` command reaches the SDK only through its public barrel, `src/index.ts`, as any caller would.",
      from: { path: "^src/cli(\\.ts$|/)" },
      to: { path: "^src/", pathNot: "^src/(cli(\\.ts$|/)|index\\.ts$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // With tsConfig + tsPreCompilationDeps, dependency-cruiser drives the
    // TypeScript resolver, which natively maps ESM `.js` import specifiers to
    // their `.ts` source — so the `to.path` matches real on-disk modules.
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
