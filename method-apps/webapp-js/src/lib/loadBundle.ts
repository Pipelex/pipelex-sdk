import { readdir, readFile } from "node:fs/promises";
import path, { type PlatformPath } from "node:path";

const METHODS_DIR = path.join(process.cwd(), "methods");

/** A method directory name, exactly as `make add-method` derives one: kebab-case, a letter first. */
const METHOD_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Read every `.mthds` file of one method directory, for a run's
 * `mthds_contents`.
 *
 * The Pipelex API takes a bundle's TOML directly, so a method authored in this
 * repo is read from disk at request time rather than inlined as a string. The
 * files are the ones `npm run codegen` projected the method from — every
 * `.mthds` file under `methods/<name>/`, at any depth, in the order of
 * `bundleOrder` — so a run and its generated types always describe the same
 * bundle.
 *
 * A missing directory, or one holding no `.mthds` file, rejects with an
 * `ENOENT` error, which `classifyPipelineError` reports as `bundle_load_failed`.
 */
export async function loadMethodBundles(
  name: string,
  methodsDir: string = METHODS_DIR,
): Promise<string[]> {
  // The name comes from a scaffolded constant, never from a request, but it is
  // joined into a filesystem path, so it is held to the one shape it can have.
  if (!METHOD_NAME.test(name)) {
    throw new Error(`"${name}" is not a method directory name (kebab-case).`);
  }
  const dir = path.join(methodsDir, name);
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const bundlePaths = bundleOrder(
    dir,
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mthds"))
      .map((entry) => path.join(entry.parentPath, entry.name)),
  );
  if (bundlePaths.length === 0) {
    throw Object.assign(new Error(`ENOENT: no .mthds file under ${dir}`), { code: "ENOENT" });
  }
  return Promise.all(bundlePaths.map((relative) => readFile(path.join(dir, relative), "utf-8")));
}

/**
 * The bundle's files as paths relative to `dir`, joined with `/`, and sorted:
 * the order codegen's `walk` (`scripts/lib/shared.mts`) reads them in, on every
 * platform. Sorting the absolute paths would compare the platform separator
 * instead, and on Windows `\` sorts after `2`, putting `steps2.mthds` before
 * `steps/score.mthds`. The order reaches the API as `mthds_contents`, where the
 * first of two same-domain files to declare a metadata value is the one kept.
 */
export function bundleOrder(
  dir: string,
  filePaths: readonly string[],
  paths: PlatformPath = path,
): string[] {
  return filePaths
    .map((filePath) => paths.relative(dir, filePath).split(paths.sep).join("/"))
    .sort();
}
