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
 * Screened, because the listing reads no `.gitignore` above the tree's root, so a repository's
 * own ignore lines protect nothing in it: every file is read once, before any request, and one
 * that looks like a secret by the workshop's rule, as `secret-guard.ts` refines it, stays home.
 * The tree sent is the rest, over the bytes screened, never read again. A bundle or the manifest
 * is read by every validation, so a tree without one is not the method: one that looks like a
 * secret refuses the whole tree, and nothing is sent. Any other file is left out and the method
 * validated without it, which only a step reading that file can notice, as a missing file the
 * caller is told about.
 *
 * Capped, because the hook should not send a large tree on every edit, and because a tree it
 * cannot list whole would risk a wrong verdict: on any of the caps, on a tree the standard refuses
 * (a symbolic link or a special file in it, an unreadable directory), on a file that changed since
 * it was listed, and on an edited file the tree does not hold (one the membership rule keeps out),
 * the caller treats validate as unavailable rather than risk a wrong block.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MethodTreeSource, MethodTreeSourceFile } from "mthds/protocol";
import { listDirectoryTree, treeDigestOf, type ListedMethodTree } from "../method-trees.js";
import type { WithheldFile } from "./check-core.js";
import { secretFindings } from "./secret-guard.js";

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
 * The gathered tree and the files it leaves home, or why there is none to send: `secret` for a
 * bundle or the manifest that looks like a secret, with the tree's root and every file of the
 * tree that does, `overflow` for a tree past one of the caps, `unreadable` for a directory the
 * standard's lister refuses to list or a file that changed since it was listed, and `outside` for
 * an edited file the tree does not hold. A withheld file's path, and the root, are spelled as the
 * caller spelled the edited file's directory whenever that spelling reaches the same root.
 */
export type GatherResult =
  | { ok: true; tree: MethodTreeSource; withheld: WithheldFile[] }
  | { ok: false; reason: "secret"; root: string; withheld: WithheldFile[] }
  | { ok: false; reason: "overflow" | "unreadable" | "outside" };

/**
 * List the method tree around the edited file, its directory under the standard's membership
 * rule and the hook's caps, then read and screen every file of it. The files are read here, after
 * the format write-back the hook made before this call, and the tree returned serves the bytes
 * read, so what was screened is what is sent.
 */
export async function gatherMethodTree(
  editedFilePath: string,
  caps: GatherCaps = DEFAULT_GATHER_CAPS,
): Promise<GatherResult> {
  const editedAbs = resolve(editedFilePath);
  let tree: ListedMethodTree;
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
  const root = tree.root;
  const treePath = root === null ? undefined : treePathOf(editedAbs, root);
  if (root === null || treePath === undefined || !tree.files.some((f) => f.path === treePath)) {
    return { ok: false, reason: "outside" };
  }

  // The tree's reader checks each file against the hash it was listed with.
  const bytesByPath = new Map<string, Uint8Array>();
  try {
    for (const file of tree.files) {
      bytesByPath.set(file.path, await tree.readFile(file.path));
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const findings = secretFindings(
    tree.files.map((file) => ({ path: file.path, bytes: bytesByPath.get(file.path)! })),
  );
  const shownRoot = shownRootOf(editedAbs, root);
  const withheld = findings.map((finding) => ({
    path: join(shownRoot, ...finding.path.split("/")),
    reason: finding.reason,
  }));
  if (findings.some((finding) => isReadByEveryValidation(finding.path))) {
    // The files to fix first lead, so a note naming only the first few still names them.
    const firsts = findings.map((finding) => isReadByEveryValidation(finding.path));
    const ordered = [
      ...withheld.filter((_, index) => firsts[index]),
      ...withheld.filter((_, index) => !firsts[index]),
    ];
    return { ok: false, reason: "secret", root: shownRoot, withheld: ordered };
  }
  // A withheld file's bytes leave the map, so the tree sent cannot serve them.
  for (const finding of findings) bytesByPath.delete(finding.path);
  const files = tree.files.filter((file) => bytesByPath.has(file.path));
  return { ok: true, tree: await treeOver(files, bytesByPath), withheld };
}

/**
 * The tree's root as the caller spells it, the way the hook's output names the files of the
 * tree: the root reached from the edited file's directory as the caller wrote it, by the same
 * steps that lead from that directory's real path to the root, when it is the same directory,
 * and the root's real path, the lister's, otherwise. A directory reached through a link above
 * the root is so named through the link, while a link pointing into the tree, whose steps up
 * leave the tree, falls back to the real path.
 */
function shownRootOf(editedAbs: string, root: string): string {
  const editedDir = dirname(editedAbs);
  try {
    const candidate = resolve(editedDir, relative(realpathSync(editedDir), root));
    return realpathSync(candidate) === root ? candidate : root;
  } catch {
    return root;
  }
}

/** Whether every validation reads the file whole: a bundle, or the manifest at the root. */
function isReadByEveryValidation(treePath: string): boolean {
  return treePath.endsWith(".mthds") || treePath === "METHODS.toml";
}

/**
 * The tree of `files`, the listing's own entries, serving the bytes already read, which hold
 * those files' bytes alone, with the digest of that listing: the listed tree's digest when
 * nothing was left out.
 */
async function treeOver(
  files: readonly MethodTreeSourceFile[],
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): Promise<MethodTreeSource> {
  return {
    files,
    digest: await treeDigestOf(files),
    readFile: async (treePath) => {
      const bytes = bytesByPath.get(treePath);
      if (bytes === undefined) throw new Error(`The tree holds no file '${treePath}'.`);
      return bytes;
    },
  };
}

/** The edited file's tree path under `root`, or `undefined` when it lies outside it. */
function treePathOf(editedAbs: string, root: string): string | undefined {
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
