/**
 * The method tree the validate stage sends to `POST /v1/validate` around an edited `.mthds` file.
 *
 * It is the tree a run of the method would send: the edited file's directory listed by the `mthds`
 * package's lister, under the MTHDS standard's membership rule and Manifest Discovery, so it is
 * rooted at the nearest `METHODS.toml` at or above that directory, else at the directory itself,
 * and holds every file the rule keeps — every bundle of the method, and every file a step reads,
 * such as a `PipeDocGen` step's `template_file`, under its tree path. The client sends it inline
 * when small and by hash otherwise, uploading the files the API lacks.
 *
 * Capped, because the hook should not send a large tree on every edit, and because a tree it
 * cannot list whole would risk a wrong verdict: on any of the caps, on a tree the standard refuses
 * (a symbolic link or a special file in it, an unreadable directory), and on an edited file the
 * tree does not hold (one the membership rule keeps out), the caller treats validate as
 * unavailable rather than risk a wrong block.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { listDirectoryTree } from "../method-trees.js";
import type { MethodTreeSource } from "mthds/protocol";

/** The hook's own bounds on the tree it sends, whatever the deployment would take. */
export interface GatherCaps {
  /** How many files the tree may hold. */
  maxFiles: number;
  /** How large one file of it may be, in bytes. */
  maxFileBytes: number;
  /** How large all its files together may be, in bytes. */
  maxTotalBytes: number;
}

export const DEFAULT_GATHER_CAPS: GatherCaps = {
  maxFiles: 100,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
};

/**
 * The gathered tree, or why there is none to send: `overflow` for a tree past one of the caps,
 * `unreadable` for a directory the standard's lister refuses to list, and `outside` for an edited
 * file the tree does not hold.
 */
export type GatherResult =
  | { ok: true; tree: MethodTreeSource }
  | { ok: false; reason: "overflow" | "unreadable" | "outside" };

/**
 * List the method tree around the edited file: its directory, listed under the standard's
 * membership rule and the hook's caps. The files are read when the client sends them, so a format
 * write-back made before this call is reflected, and a file changed after it is refused by the
 * tree's own check of its hash rather than sent stale.
 */
export async function gatherMethodTree(
  editedFilePath: string,
  caps: GatherCaps = DEFAULT_GATHER_CAPS,
): Promise<GatherResult> {
  const editedAbs = resolve(editedFilePath);
  let tree: Awaited<ReturnType<typeof listDirectoryTree>>;
  try {
    tree = await listDirectoryTree(
      dirname(editedAbs),
      {
        maxFileCount: caps.maxFiles,
        maxFileSize: caps.maxFileBytes,
        maxTotalSize: caps.maxTotalBytes,
      },
      "validate",
    );
  } catch (err) {
    return { ok: false, reason: isLimitExceeded(err) ? "overflow" : "unreadable" };
  }
  const treePath = treePathOf(editedAbs, tree.root);
  if (treePath === undefined || !tree.files.some((file) => file.path === treePath)) {
    return { ok: false, reason: "outside" };
  }
  return { ok: true, tree };
}

/** The edited file's tree path under `root`, or `undefined` when it lies outside it. */
function treePathOf(editedAbs: string, root: string | null): string | undefined {
  if (root === null) return undefined;
  let real: string;
  try {
    real = realpathSync(editedAbs);
  } catch {
    return undefined;
  }
  const relativePath = relative(root, real);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(sep).join("/").normalize("NFC");
}

/** Whether a listing failed on one of the caps: the lister's `limit_exceeded`. */
function isLimitExceeded(err: unknown): boolean {
  const cause = err instanceof Error ? err.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "limit_exceeded"
  );
}
