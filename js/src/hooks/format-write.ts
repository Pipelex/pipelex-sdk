/**
 * The format stage's write-back: the formatted `.mthds` replaces the user's file atomically,
 * unless a replacement would lose something the file carries, in which case it is written in
 * place as before.
 *
 * The formatted text is written to a temporary file in the target's own directory, given the
 * target's owner and group, flushed to disk, given the target's permission bits, then renamed
 * over the target. A rename within one directory is atomic, so a hook killed at any moment
 * (Claude Code's hook timeout, the plugin wrapper's SIGKILL) leaves either the original file or
 * the formatted one, never a truncated one. The temporary file's name starts with a dot, so the
 * tree lister, which keeps out hidden entries, never sends it, and every failure path removes it.
 *
 * A rename puts a new file at the target's name, so the write-back falls back to writing into
 * the file in place, the hook's behaviour before the rename, where the new file could not be the
 * same as the old one in what matters to the user: when the file has several hard links, whose
 * other names would keep the old content, and on POSIX when the process cannot give the new
 * file the original's owner and group (a file owned by another user, or by a group the user is
 * not in). Extended attributes and access control lists are not carried over and not detected:
 * Node has no API to read them, macOS puts an attribute on nearly every file, and an
 * inheritable ACL on the directory reaches the new file as it reached the old one
 * (`docs/hook-bundle.md`, "How the format is written").
 *
 * On Windows a rename over an existing file fails while another process holds the target open
 * without delete sharing, as an antivirus scanner, a search indexer or an editor briefly does
 * after a save, with `EPERM`, `EACCES` or `EBUSY`. Those codes are retried a few times over
 * well under a second, which outlasts such a hold. Before each retry the target is read again,
 * and when it no longer holds the text that was formatted, a newer save landed meanwhile: the
 * write-back gives up and keeps it. When the hold persists, the temporary file is removed and
 * the error is raised, so the caller reports that the format could not be written and the
 * user's file stays exactly as it was.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";

/** The `node:fs` calls the write-back makes, injectable so a test can fail any of them. */
export type FormatWriteFs = Pick<
  typeof nodeFs,
  | "accessSync"
  | "chmodSync"
  | "closeSync"
  | "fchownSync"
  | "fstatSync"
  | "fsyncSync"
  | "openSync"
  | "readFileSync"
  | "realpathSync"
  | "renameSync"
  | "statSync"
  | "unlinkSync"
  | "writeFileSync"
>;

export interface FormatWriteOptions {
  fs?: FormatWriteFs;
  /** `process.platform` by default; the Windows rename retries apply on `win32` only. */
  platform?: NodeJS.Platform;
  /** The pauses between rename attempts on Windows, in milliseconds. */
  renameRetryDelaysMs?: readonly number[];
  /** A synchronous pause, `Atomics.wait` by default. */
  sleep?: (ms: number) => void;
}

/** What the format engine answers for one file. */
export interface FormatResult {
  changed: boolean;
  formatted: string;
}

/** How the file was written: replaced by a rename, or written into in place. */
export type FileWriteMethod = "replaced" | "written-in-place";

export type FormatWriteOutcome = "unchanged" | FileWriteMethod;

/** About 0.6 seconds in all, far below the hook's own deadline. */
export const WINDOWS_RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 300];

const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Write the formatter's result back to `filePath` when it changed anything. `original` is the
 * text the formatter was given, which the file must still hold for a Windows retry to replace it.
 * Throws when the file cannot be written; the original is then left untouched and no temporary
 * file remains.
 */
export function writeBackFormatted(
  filePath: string,
  original: string,
  result: FormatResult,
  options: FormatWriteOptions = {},
): FormatWriteOutcome {
  if (!result.changed) {
    return "unchanged";
  }
  return replaceFileContent(filePath, original, result.formatted, options);
}

/**
 * Replace the content of the file at `filePath`, which held `original`, with `content`: through
 * a temporary file and a rename, or in place when a rename would lose the file's other hard links
 * or its owner and group. A symbolic link is followed, so the file it points to is written and
 * the link kept.
 */
export function replaceFileContent(
  filePath: string,
  original: string,
  content: string,
  options: FormatWriteOptions = {},
): FileWriteMethod {
  const fs = options.fs ?? nodeFs;
  const platform = options.platform ?? process.platform;
  const sleep = options.sleep ?? sleepSync;
  const retryDelays =
    platform === "win32" ? (options.renameRetryDelaysMs ?? WINDOWS_RENAME_RETRY_DELAYS_MS) : [];

  // The native realpath answers the name as the directory stores it, so the rename keeps its
  // case on a case-insensitive filesystem whatever case the agent wrote the path in.
  const target = fs.realpathSync.native(filePath);
  // An in-place write refused a file the user cannot write; a rename would not, so ask first.
  fs.accessSync(target, nodeFs.constants.W_OK);
  const stats = fs.statSync(target);
  if (stats.nlink > 1) {
    // A rename would leave the file's other names holding the old content.
    fs.writeFileSync(target, content);
    return "written-in-place";
  }
  const mode = stats.mode & 0o7777;

  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let created = false;
  let ownershipKept = false;
  try {
    // `wx`: never reuse a path someone else holds.
    const fd = fs.openSync(temporary, "wx", mode);
    created = true;
    try {
      ownershipKept = platform === "win32" || giveOwnership(fs, fd, stats);
      if (ownershipKept) {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (ownershipKept) {
      // The mode given to `open` went through the umask, and a `chown` may clear the set-id
      // bits; set the original's bits exactly.
      fs.chmodSync(temporary, mode);
      renameWithRetries(fs, temporary, target, original, retryDelays, sleep);
      created = false;
      return "replaced";
    }
  } finally {
    if (created) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Nothing more can be done; the original is intact either way.
      }
    }
  }
  // The new file could not take the original's owner and group, so write into the original.
  fs.writeFileSync(target, content);
  return "written-in-place";
}

/**
 * Give the open temporary file the original's owner and group, which it gets from the process
 * (and on BSD and macOS its group from the directory). True when the two now match.
 */
function giveOwnership(fs: FormatWriteFs, fd: number, original: nodeFs.Stats): boolean {
  const created = fs.fstatSync(fd);
  if (created.uid === original.uid && created.gid === original.gid) {
    return true;
  }
  try {
    fs.fchownSync(fd, original.uid, original.gid);
    return true;
  } catch {
    // Only root gives a file away, and a user can only choose a group they are in.
    return false;
  }
}

function annotateStillHeld(err: unknown, attempts: number): unknown {
  if (err instanceof Error) {
    err.message = `${err.message} (still held after ${attempts} attempts; the file was left as it was)`;
  }
  return err;
}

function renameWithRetries(
  fs: FormatWriteFs,
  from: string,
  to: string,
  original: string,
  retryDelays: readonly number[],
  sleep: (ms: number) => void,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = errorCode(err);
      const retried = code !== undefined && WINDOWS_TRANSIENT_RENAME_CODES.has(code);
      const delay = retryDelays[attempt];
      if (!retried || delay === undefined) {
        throw retried && attempt > 0 ? annotateStillHeld(err, attempt + 1) : err;
      }
      sleep(delay);
      // A newer save made while the file was held must not be overwritten with older content.
      let current: string;
      try {
        current = fs.readFileSync(to, "utf-8");
      } catch {
        throw annotateStillHeld(err, attempt + 1);
      }
      if (current !== original) {
        throw new Error(
          `${to} changed while its formatted copy waited to replace it; the newer content was kept`,
        );
      }
    }
  }
}
