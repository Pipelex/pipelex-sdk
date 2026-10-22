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
 * One module is let through, and only by a dynamic import: `src/node-host/node.ts`, the Node
 * host as Node resolves it, loads `mthds`'s `listMethodTree`, the MTHDS standard's lister and its
 * membership rule, which only the root entry exports. The root entry loads Node built-ins and
 * the runner-side surface, so the host loads it by `await import("mthds")` when a caller lists a
 * `directory`, and never by a static import.
 *
 * The Node host is the one module of the barrel's graph that may load what only Node has: a Node
 * built-in, `undici` or that root entry. The rest of the SDK gets them from `loadNodeHost()`
 * (`src/node-host.ts`), which imports `#node-host`, the package's own subpath import, resolved by
 * condition to the host under `node` and to `src/node-host/unavailable.ts` everywhere else, so a
 * bundler building for the browser follows none of them. dependency-cruiser reads that import
 * through `tsconfig.json`'s `paths`, which map it to the Node variant as the type checker sees it,
 * not through the conditions; so the rules below hold the source to the shape, and
 * `tests/browser-bundle.test.ts` bundles the built package for the browser to hold the result to
 * it. Type-only imports are erased from the build, so they are let through.
 *
 * The command (`src/cli.ts`, `src/cli/`) and the hook (`src/hooks/`) are Node programs that no
 * module of the barrel imports, so they use Node directly.
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
      from: { path: "^src/", pathNot: "^src/node-host/node\\.ts$" },
      to: { path: "node_modules/mthds/", pathNot: "node_modules/mthds/(dist/)?protocol/" },
    },
    {
      name: "mthds-lister-only-by-the-node-host",
      severity: "error",
      comment:
        "`src/node-host/node.ts` may load `mthds`'s root entry for its directory lister, never a deep import.",
      from: { path: "^src/node-host/node\\.ts$" },
      to: {
        path: "node_modules/mthds/",
        pathNot: "node_modules/mthds/((dist/)?protocol/|dist/index\\.js$)",
      },
    },
    {
      name: "mthds-root-entry-never-static",
      severity: "error",
      comment:
        "The Node host loads `mthds`'s root entry by a dynamic `import()` alone, when a directory is listed: a static import would load the runner-side surface with every use of the host.",
      from: { path: "^src/node-host/node\\.ts$" },
      to: {
        path: "node_modules/mthds/dist/index\\.js$",
        dependencyTypesNot: ["dynamic-import", "type-only"],
      },
    },
    {
      name: "node-builtins-only-in-the-node-host",
      severity: "error",
      comment:
        "Only the Node host (`src/node-host/node.ts`) imports a Node built-in, statically or dynamically; the rest of the barrel's graph gets it from `loadNodeHost()`, so a browser bundle follows none.",
      from: { path: "^src/", pathNot: "^src/(node-host/node\\.ts$|cli(\\.ts$|/)|hooks/)" },
      to: { dependencyTypes: ["core"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "undici-only-in-the-node-host",
      severity: "error",
      comment:
        "Only the Node host (`src/node-host/node.ts`) loads `undici`, which requires Node built-ins; the rest of the barrel's graph gets its `Agent` from `loadNodeHost()`.",
      from: { path: "^src/", pathNot: "^src/(node-host/node\\.ts$|cli(\\.ts$|/)|hooks/)" },
      to: { path: "node_modules/undici/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "node-host-only-through-its-condition",
      severity: "error",
      comment:
        "The Node host's two variants are reached only through `#node-host`, which `package.json` resolves by condition (`tsconfig.json` maps it to the Node variant for the type checker, as an alias); importing one by its path would put the Node variant in a browser bundle.",
      from: { path: "^src/", pathNot: "^src/node-host/" },
      to: { path: "^src/node-host/", dependencyTypesNot: ["type-only", "aliased-tsconfig-paths"] },
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
