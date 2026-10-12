/**
 * Bundle gathering for the validate stage: the multi-file set sent to
 * `POST /v1/validate` around an edited `.mthds` file.
 *
 * Mirrors what the plxt-era hook's `-L "$PARENT_DIR/"` did through the Python
 * runtime (`pipelex/libraries/library_utils.py`): a recursive `.mthds` scan of
 * the edited file's parent directory, skipping the runtime's excluded dirs.
 * Capped, because an under-supplied bundle can produce a FALSE invalid verdict
 * (missing cross-file refs) — on overflow the caller must treat validate as
 * unavailable rather than risk a wrong block.
 *
 * It also gathers the files the bundle's steps read, a `PipeDocGen` step's
 * `template_file`, read beside the `.mthds` file whose step names it and sent as
 * the request's `resources` under the path the step names, as the runtime reads
 * a bundle loaded from disk: without them the server could only answer that the
 * template file was not supplied, which would block every edit of such a bundle.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { bundleResourcePathRefusal, canonicalBundleResourcePath } from "../bundle-resources.js";
import type { MthdsFile } from "../client.js";

/** Mirror of pipelex's `scan_config.excluded_dirs` (dot-dirs are skipped wholesale). */
const EXCLUDED_DIRS = new Set([
  "venv",
  "env",
  "virtualenv",
  "__pycache__",
  "node_modules",
  "results",
]);

export interface GatherCaps {
  maxFiles: number;
  maxTotalBytes: number;
  /** How many template files the gather sends at most; the server's default limit when omitted. */
  maxResourceFiles?: number;
  /** How many bytes of template files the gather sends at most; the server's default when omitted. */
  maxResourceBytes?: number;
}

/** The server's default bounds on the files a request sends with its bundle. */
const DEFAULT_MAX_RESOURCE_FILES = 32;
const DEFAULT_MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

export const DEFAULT_GATHER_CAPS: GatherCaps = {
  maxFiles: 50,
  maxTotalBytes: 2 * 1024 * 1024,
  maxResourceFiles: DEFAULT_MAX_RESOURCE_FILES,
  maxResourceBytes: DEFAULT_MAX_RESOURCE_BYTES,
};

/**
 * The gathered bundle, or why there is none to send. `resources` maps the path a
 * step names to the template file's bytes. `conflict` is one path naming two
 * different files, beside two `.mthds` files of the bundle, which the server
 * would refuse, so validate is unavailable rather than a wrong verdict.
 */
export type GatherResult =
  | { ok: true; files: MthdsFile[]; resources: Record<string, Uint8Array> }
  | { ok: false; reason: "overflow" | "unreadable" | "conflict" };

/**
 * Recursively collect `.mthds` paths under `dir`. Throws if any directory in
 * the tree can't be read: a silently-skipped subtree would drop cross-file
 * refs and risk a FALSE invalid verdict, so the caller must treat an
 * unreadable scan as `unreadable` (validate unavailable), not as a smaller
 * bundle. The caps guard the opposite failure (over-supply), never this one.
 */
function walkMthdsFiles(dir: string, collected: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMthdsFiles(full, collected);
    } else if (entry.isFile() && entry.name.endsWith(".mthds")) {
      collected.push(full);
    }
  }
}

/**
 * Gather the `.mthds` files under the edited file's parent directory, the
 * edited file first (absent any `main_pipe`, the server's primary blueprint is
 * the first content — make that the file being edited). Contents are read
 * fresh from disk, so a format write-back is already reflected.
 */
export function gatherBundle(
  editedFilePath: string,
  caps: GatherCaps = DEFAULT_GATHER_CAPS,
): GatherResult {
  const editedAbs = resolve(editedFilePath);
  const parentDir = dirname(editedAbs);

  const paths: string[] = [];
  try {
    walkMthdsFiles(parentDir, paths);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const ordered = [editedAbs, ...paths.filter((path) => resolve(path) !== editedAbs)];
  if (ordered.length > caps.maxFiles) {
    return { ok: false, reason: "overflow" };
  }

  let totalBytes = 0;
  for (const path of ordered) {
    try {
      totalBytes += statSync(path).size;
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  if (totalBytes > caps.maxTotalBytes) {
    return { ok: false, reason: "overflow" };
  }

  const files: MthdsFile[] = [];
  for (const path of ordered) {
    try {
      files.push({ content: readFileSync(path, "utf-8"), uri: relative(parentDir, path) });
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  const gathered = gatherTemplateFiles(parentDir, ordered, files, caps);
  if (!gathered.ok) return gathered;
  return { ok: true, files, resources: gathered.resources };
}

/**
 * The paths of the template files the steps of one `.mthds` file name: each
 * `PipeDocGen` pipe's `template_file`. A file that does not parse names none, the
 * server giving its verdict on it.
 */
export function templateFilesNamedBy(mthdsContent: string): string[] {
  let document: unknown;
  try {
    document = parseToml(mthdsContent);
  } catch {
    return [];
  }
  const pipes = isRecord(document) ? document["pipe"] : undefined;
  if (!isRecord(pipes)) return [];
  const named: string[] = [];
  for (const pipe of Object.values(pipes)) {
    if (
      isRecord(pipe) &&
      pipe["type"] === "PipeDocGen" &&
      typeof pipe["template_file"] === "string"
    ) {
      named.push(pipe["template_file"]);
    }
  }
  return named;
}

/** Why the template files could not be gathered, read as validate being unavailable. */
type TemplateGatherFailure = { ok: false; reason: "overflow" | "unreadable" | "conflict" };

/**
 * Read the template files the gathered `.mthds` files name, each beside the file
 * whose step names it, keyed by the path the step names, as the runtime reads a
 * bundle loaded from disk. A path the server would refuse, and a file that is not
 * there, are left out, for the server to say the step's file was not supplied. A
 * file that leads out of the bundle's directory through a link is never read, and
 * makes validate unavailable, as an unreadable scan does; so does one path naming
 * two different files, and template files past the caps.
 */
function gatherTemplateFiles(
  parentDir: string,
  paths: string[],
  files: MthdsFile[],
  caps: GatherCaps,
): { ok: true; resources: Record<string, Uint8Array> } | TemplateGatherFailure {
  const maxFiles = caps.maxResourceFiles ?? DEFAULT_MAX_RESOURCE_FILES;
  const maxBytes = caps.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  let root: string;
  try {
    root = realpathSync(parentDir);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // Each path a step names, once, with the real file it names on disk.
  const located = new Map<string, string>();
  for (const [index, mthdsPath] of paths.entries()) {
    for (const named of templateFilesNamedBy(files[index]!.content)) {
      if (bundleResourcePathRefusal(named) !== undefined) continue;
      const key = canonicalBundleResourcePath(named);
      const real = realFileOrUndefined(join(dirname(mthdsPath), key));
      if (real === undefined) continue;
      if (!real.startsWith(root + sep)) return { ok: false, reason: "unreadable" };
      const known = located.get(key);
      if (known === undefined) {
        located.set(key, real);
      } else if (known !== real && !sameBytes(known, real)) {
        return { ok: false, reason: "conflict" };
      }
    }
  }
  if (located.size > maxFiles) return { ok: false, reason: "overflow" };

  const resources = Object.create(null) as Record<string, Uint8Array>;
  let totalBytes = 0;
  for (const [key, real] of located) {
    try {
      totalBytes += statSync(real).size;
      if (totalBytes > maxBytes) return { ok: false, reason: "overflow" };
      resources[key] = readFileSync(real);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  return { ok: true, resources };
}

/** The real path of a regular file, or `undefined` when there is none at `path`. */
function realFileOrUndefined(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Whether two files hold the same bytes; an unreadable one holds none. */
function sameBytes(left: string, right: string): boolean {
  try {
    if (statSync(left).size !== statSync(right).size) return false;
    return Buffer.compare(readFileSync(left), readFileSync(right)) === 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
