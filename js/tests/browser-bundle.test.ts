/**
 * The package as a bundler sees it. Every entry of the `exports` map, bundled for the browser,
 * reaches no Node built-in, no `undici` and not the `mthds` root entry, statically or dynamically,
 * because the Node host (`src/node-host.ts`) resolves to its absent variant under the browser's
 * conditions; and under Node's, the same package resolves `#node-host` to the host, so a method
 * directory is still listed.
 *
 * A Next.js app's `next build` passes either way: in 0.48.0 the barrel's dynamic `import("mthds")`
 * reached `node:fs`, which only `next dev` refused, with a Turbopack panic and a `500` for any page
 * whose client code imported the barrel. This suite is the gate the templates' builds are not.
 *
 * It builds the package with `tsc` into a scratch directory laid out as the published package, its
 * `package.json` beside its `dist/`, with this checkout's `node_modules`, so the bundler and Node
 * resolve exactly what ships: the `exports` and `imports` maps and the compiled modules, never the
 * test aliases of `vitest.config.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Metafile } from "esbuild";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const NODE_BUILTINS = new Set(builtinModules);

interface Manifest {
  exports: Record<string, { import: string }>;
}

/** The subpaths of the `exports` map, read once so that each is a case of its own. */
const SUBPATHS = Object.keys(
  (JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest).exports,
);

/** Whether a specifier names a Node built-in, with or without the `node:` scheme. */
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]!);
}

/** One import of a Node built-in esbuild met while bundling, and the module that made it. */
interface BuiltinImport {
  specifier: string;
  kind: string;
  importer: string;
}

/** A module's path as a failure shows it: from `node_modules/` for a dependency's, else from the package. */
function shownPath(packageDir: string, path: string): string {
  const dependency = path.lastIndexOf("node_modules/");
  return dependency >= 0 ? path.slice(dependency) : relative(packageDir, path);
}

/**
 * Bundle the package's `entry` for the browser with nothing marked external; esbuild rejects
 * whatever it cannot resolve. Every import of a Node built-in is recorded rather than failed on,
 * so a failure names each one and the module asking for it, then left external so the rest of the
 * graph is still walked. The inputs are every module the bundle holds.
 */
async function bundleForTheBrowser(
  packageDir: string,
  entry: string,
): Promise<{ builtins: BuiltinImport[]; inputs: string[] }> {
  const builtins: BuiltinImport[] = [];
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "record-node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!isNodeBuiltin(args.path)) return undefined;
            builtins.push({
              specifier: args.path,
              kind: args.kind,
              importer: shownPath(packageDir, args.importer),
            });
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  const metafile: Metafile = result.metafile;
  return { builtins, inputs: Object.keys(metafile.inputs) };
}

describe("the package bundled for the browser", () => {
  let packageDir: string;
  let manifest: Manifest;

  beforeAll(() => {
    // Real, as esbuild reports its importers: the temporary directory is a symbolic link on macOS.
    packageDir = realpathSync(mkdtempSync(join(tmpdir(), "pipelex-sdk-package-")));
    copyFileSync(join(PACKAGE_DIR, "package.json"), join(packageDir, "package.json"));
    symlinkSync(join(PACKAGE_DIR, "node_modules"), join(packageDir, "node_modules"), "dir");
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(
      process.execPath,
      [
        tsc,
        "-p",
        join(PACKAGE_DIR, "tsconfig.json"),
        "--outDir",
        join(packageDir, "dist"),
        "--declaration",
        "false",
        "--sourceMap",
        "false",
      ],
      { stdio: "pipe" },
    );
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Manifest;
  }, 120_000);

  afterAll(() => {
    if (packageDir) rmSync(packageDir, { recursive: true, force: true });
  });

  it.each(SUBPATHS)(
    "reaches no Node built-in, no undici and not the mthds root from %s",
    async (subpath) => {
      const entry = join(packageDir, manifest.exports[subpath]!.import);
      const { builtins, inputs } = await bundleForTheBrowser(packageDir, entry);

      expect(builtins).toEqual([]);
      expect(inputs.filter((input) => input.includes("node_modules/undici/"))).toEqual([]);
      expect(inputs.filter((input) => input.endsWith("node_modules/mthds/dist/index.js"))).toEqual(
        [],
      );
      expect(inputs.filter((input) => input.endsWith("dist/node-host/node.js"))).toEqual([]);
    },
    60_000,
  );

  it("resolves the main entry's Node host to its absent variant", async () => {
    const entry = join(packageDir, manifest.exports["."]!.import);
    const { inputs } = await bundleForTheBrowser(packageDir, entry);

    expect(inputs.some((input) => input.endsWith("dist/node-host/unavailable.js"))).toBe(true);
  }, 60_000);

  it("is typed against the Node host's source, the target Node resolves", () => {
    // `tsconfig.json` cannot read the `imports` map from `dist/` while it builds `dist/`, so its
    // `paths` name each of the package's own imports again, as the source of its Node target.
    const tsconfig = JSON.parse(readFileSync(join(PACKAGE_DIR, "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const imports = (
      JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
        imports: Record<string, { node: string }>;
      }
    ).imports;

    expect(tsconfig.compilerOptions.paths).toEqual(
      Object.fromEntries(
        Object.entries(imports).map(([name, targets]) => [
          name,
          [targets.node.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts")],
        ]),
      ),
    );
  });

  it("resolves the Node host under Node, and lists a method directory with it", () => {
    const methodDir = join(packageDir, "method");
    mkdirSync(join(methodDir, "assets"), { recursive: true });
    writeFileSync(join(methodDir, "main.mthds"), 'domain = "probe"\n');
    writeFileSync(join(methodDir, "assets", "logo.png"), new Uint8Array([137, 80, 78, 71]));
    writeFileSync(join(methodDir, "inputs.json"), "{}\n");
    const script = `
      const { loadNodeHost } = await import(${JSON.stringify(pathToFileURL(join(packageDir, "dist/node-host.js")).href)});
      const { listDirectoryTree } = await import(${JSON.stringify(pathToFileURL(join(packageDir, "dist/method-trees.js")).href)});
      const host = await loadNodeHost();
      const tree = await listDirectoryTree(${JSON.stringify(methodDir)}, {}, "probe");
      console.log(JSON.stringify({ host: host !== null, files: tree.files.map((file) => file.path) }));
    `;

    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DO_NOT_TRACK: "1" },
    });

    expect(JSON.parse(output)).toEqual({ host: true, files: ["assets/logo.png", "main.mthds"] });
  }, 60_000);
});
