/**
 * The format stage's write-back: the formatted `.mthds` replaces the user's file atomically.
 *
 * The formatted text is written to a temporary file in the target's own directory, flushed to
 * disk, given the target's permission bits, then renamed over the target. A rename within one
 * directory is atomic, so a hook killed at any moment (Claude Code's hook timeout, the plugin
 * wrapper's SIGKILL) leaves either the original file or the formatted one, never a truncated
 * one. The temporary file's name starts with a dot, so the tree lister, which keeps out hidden
 * entries, never sends it, and every failure path removes it.
 *
 * On Windows a rename over an existing file fails while another process holds the target open
 * without delete sharing, as an antivirus scanner, a search indexer or an editor briefly does
 * after a save, with `EPERM`, `EACCES` or `EBUSY`. Those codes are retried a few times over
 * well under a second, which outlasts such a hold; when they persist, the temporary file is
 * removed and the error is raised, so the caller reports that the format could not be written
 * and the user's file stays exactly as it was.
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
  | "fsyncSync"
  | "openSync"
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

export type FormatWriteOutcome = "unchanged" | "written";

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
 * Write the formatter's result back to `filePath` when it changed anything, atomically.
 * Throws when the file cannot be replaced; the original is then left untouched and no
 * temporary file remains.
 */
export function writeBackFormatted(
  filePath: string,
  result: FormatResult,
  options: FormatWriteOptions = {},
): FormatWriteOutcome {
  if (!result.changed) {
    return "unchanged";
  }
  writeFileAtomically(filePath, result.formatted, options);
  return "written";
}

/**
 * Replace the file at `filePath` with `content` through a temporary file and a rename.
 * A symbolic link is followed, so the file it points to is replaced and the link kept.
 */
export function writeFileAtomically(
  filePath: string,
  content: string,
  options: FormatWriteOptions = {},
): void {
  const fs = options.fs ?? nodeFs;
  const platform = options.platform ?? process.platform;
  const sleep = options.sleep ?? sleepSync;
  const retryDelays =
    platform === "win32" ? (options.renameRetryDelaysMs ?? WINDOWS_RENAME_RETRY_DELAYS_MS) : [];

  const target = fs.realpathSync(filePath);
  // An in-place write refused a file the user cannot write; a rename would not, so ask first.
  fs.accessSync(target, nodeFs.constants.W_OK);
  const mode = fs.statSync(target).mode & 0o7777;

  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let created = false;
  try {
    // `wx`: never reuse a path someone else holds.
    const fd = fs.openSync(temporary, "wx", mode);
    created = true;
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // The mode given to `open` went through the umask; set the original's bits exactly.
    fs.chmodSync(temporary, mode);
    renameWithRetries(fs, temporary, target, retryDelays, sleep);
    created = false;
  } finally {
    if (created) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Nothing more can be done; the original is intact either way.
      }
    }
  }
}

function renameWithRetries(
  fs: FormatWriteFs,
  from: string,
  to: string,
  retryDelays: readonly number[],
  sleep: (ms: number) => void,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = errorCode(err);
      const delay = retryDelays[attempt];
      if (delay === undefined || code === undefined || !WINDOWS_TRANSIENT_RENAME_CODES.has(code)) {
        if (attempt > 0 && err instanceof Error) {
          err.message = `${err.message} (still held after ${attempt + 1} attempts; the file was left as it was)`;
        }
        throw err;
      }
      sleep(delay);
    }
  }
}
