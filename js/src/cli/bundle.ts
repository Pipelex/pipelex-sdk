/**
 * The bundle reader: a `--method` path read from disk into the files `run` sends inline.
 *
 * The rules are the command's contract, recorded as cases in `tests/fixtures/cli-cases.json` so
 * that the Python twin reads a bundle the same way (`docs/cli.md`, "Reading a bundle"):
 *
 * - **A `.mthds` file** is a one-file bundle, sent under its own file name. A file of any other
 *   name is refused.
 * - **A directory** is every `.mthds` file under it, at any depth, each sent under its path
 *   relative to the directory, with `/` between segments.
 * - **The order** is the order of those names compared code point by code point, which is the
 *   order of their UTF-8 bytes: `Zeta.mthds` before `main.mthds`, and `steps/score.mthds` before
 *   `steps2.mthds`. A run sends the contents in this order, and the first of two files to declare
 *   the same metadata is the one kept.
 * - **A hidden entry**, a file or a directory whose name starts with `.`, is skipped, so a
 *   `.venv/` or a `.git/` inside a bundle is never read.
 * - **Any file not named `.mthds`** is ignored, Python files included: the command sends only
 *   the MTHDS sources.
 * - **A symbolic link** is judged by its own name: one named `.mthds` that leads to a file is read
 *   through, under the link's name; one that leads to a directory is not descended into, which
 *   keeps a link cycle from looping; and one that leads nowhere is refused. The `--method` path
 *   itself may be a link, and is followed.
 * - **A directory with no `.mthds` file** under it is refused, as is a file that is not UTF-8
 *   text and a directory that cannot be listed. A byte-order mark is kept as the file's first
 *   character, as it is on disk.
 *
 * Every refusal is a usage error, raised before any request.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { usageError } from "./io.js";

/** The extension of a bundle's files. */
export const BUNDLE_SUFFIX = ".mthds";

/** One file of a bundle: the name it is sent under, and its text. */
export interface BundleFile {
  readonly name: string;
  readonly content: string;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Read the bundle a `--method` path names, in the order the rules above give.
 *
 * @throws {CommandError} A usage error for a path that names no bundle.
 */
export async function readBundle(given: string): Promise<BundleFile[]> {
  const absolute = resolve(given);
  let found: Awaited<ReturnType<typeof stat>>;
  try {
    found = await stat(absolute);
  } catch (error) {
    throw usageError(
      `--method "${given}" is not a catalog id (mt_...), not an address (github.com/...), and no file or directory of that name exists.`,
      [`Reason: ${systemReason(error)}`],
    );
  }
  if (found.isDirectory()) {
    const shown = given.replace(/\/+$/, "") || "/";
    const entries: Array<{ name: string; path: string }> = [];
    await collect(absolute, "", shown, entries);
    if (entries.length === 0) {
      throw usageError(`--method "${given}" is a directory with no .mthds file under it.`);
    }
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    const files: BundleFile[] = [];
    for (const entry of entries) {
      files.push({
        name: entry.name,
        content: await readText(entry.path, under(shown, entry.name)),
      });
    }
    return files;
  }
  if (!found.isFile()) {
    throw usageError(`--method "${given}" is neither a file nor a directory.`);
  }
  if (!basename(absolute).endsWith(BUNDLE_SUFFIX)) {
    throw usageError(`--method "${given}" is not a .mthds file.`, [
      "Name a .mthds file, a directory of them, an address (github.com/...) or a catalog id (mt_...).",
    ]);
  }
  return [{ name: basename(absolute), content: await readText(absolute, given) }];
}

/** Gather the `.mthds` files under `directory`, each with its name relative to the bundle's root. */
async function collect(
  directory: string,
  prefix: string,
  shownRoot: string,
  into: Array<{ name: string; path: string }>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw usageError(
      `cannot list "${prefix === "" ? shownRoot : under(shownRoot, prefix.slice(0, -1))}".`,
      [`Reason: ${systemReason(error)}`],
    );
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const name = `${prefix}${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path, `${name}/`, shownRoot, into);
    } else if (entry.isSymbolicLink()) {
      if (!entry.name.endsWith(BUNDLE_SUFFIX)) continue;
      let target: Awaited<ReturnType<typeof stat>>;
      try {
        target = await stat(path);
      } catch (error) {
        throw usageError(`"${under(shownRoot, name)}" is a symbolic link that leads to no file.`, [
          `Reason: ${systemReason(error)}`,
        ]);
      }
      if (target.isFile()) into.push({ name, path });
    } else if (entry.isFile() && entry.name.endsWith(BUNDLE_SUFFIX)) {
      into.push({ name, path });
    }
  }
}

/**
 * A path inside the bundle as the person would type it: the `--method` path as given, without
 * its trailing `/`, then `/`, then the file's name in the bundle.
 */
function under(root: string, name: string): string {
  return `${root === "/" ? "" : root}/${name}`;
}

/** A bundle file's text, which must be UTF-8. */
async function readText(path: string, shown: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw usageError(`cannot read "${shown}".`, [`Reason: ${systemReason(error)}`]);
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw usageError(`"${shown}" is not UTF-8 text.`);
  }
}

/** Compare two strings code point by code point, which is comparing their UTF-8 bytes. */
export function compareCodePoints(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** The system's reason for a failed file operation: its code, else its message. */
export function systemReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ?? error.message;
  }
  return String(error);
}
