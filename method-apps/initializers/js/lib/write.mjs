/**
 * The write, which removes exactly what it created when it cannot finish.
 *
 * Every directory is made without `recursive` and every file is opened with
 * `wx`, so something that appears between the reading of the destination and
 * the write makes the write fail rather than be written over or into. Each
 * directory and file is recorded the moment it exists, and on a failure or an
 * interruption the files go first, then the directories, deepest first and
 * only when empty, the destination itself among them only when this write
 * made it. Nothing the write did not create is ever removed.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { MODES } from "./pack.mjs";
import { readDestination } from "./destination.mjs";

/** The write stopped because the run was interrupted. */
export class Interrupted extends Error {
  constructor(signal) {
    super(`${signal ?? "a signal"} interrupted the write`);
    this.name = "Interrupted";
  }
}

/** The destination changed between the preflight's reading and the write. */
export class DestinationChanged extends Error {
  constructor(found) {
    super("the destination changed after it was checked");
    this.name = "DestinationChanged";
    this.found = found;
  }
}

/** What the write created, in the order it created it. */
export class Created {
  dirs = [];
  files = [];
}

/** Make `dest` and each missing ancestor, recording each one made. */
async function makeDest(dest, created) {
  const missing = [];
  for (let at = dest; ; at = path.dirname(at)) {
    try {
      await fs.stat(at);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    missing.push(at);
    if (path.dirname(at) === at) break;
  }
  for (const dir of missing.reverse()) {
    await fs.mkdir(dir);
    created.dirs.push(dir);
  }
}

/**
 * Make a directory under the destination with each parent it needs there,
 * never reusing one this write did not make: a directory that appeared after
 * the destination was read fails the `mkdir`.
 */
async function makeUnder(dir, dest, created, made) {
  if (dir === dest || made.has(dir)) return;
  await makeUnder(path.dirname(dir), dest, created, made);
  await fs.mkdir(dir);
  created.dirs.push(dir);
  made.add(dir);
}

/**
 * Remove what was created: files, then directories deepest first, each only
 * while empty. Returns the paths it could not remove, which a report names.
 */
export async function removeCreated(created) {
  const left = [];
  for (const file of [...created.files].reverse()) {
    try {
      await fs.unlink(file);
    } catch (error) {
      if (error.code !== "ENOENT") left.push(file);
    }
  }
  const depth = (dir) => dir.split(path.sep).length;
  for (const dir of [...created.dirs].sort((a, b) => depth(b) - depth(a))) {
    try {
      await fs.rmdir(dir);
    } catch (error) {
      if (error.code !== "ENOENT") left.push(dir);
    }
  }
  return left;
}

/**
 * Write `files` (`[{ path, mode, data }]`, paths relative) under `dest`. The
 * destination is made when missing, then read again; `signal` is checked
 * before each file. On any failure what was created is removed, and the error
 * is rethrown with `created` and `left` attached.
 */
export async function writeTree(dest, files, { signal, onFile } = {}) {
  const created = new Created();
  const made = new Set();
  try {
    await makeDest(dest, created);
    const found = readDestination(dest);
    if (found.kind !== "missing" && found.kind !== "empty" && found.kind !== "lone-git") {
      throw new DestinationChanged(found);
    }

    for (const [index, file] of files.entries()) {
      if (signal?.aborted) throw new Interrupted(signal.reason);
      const full = path.join(dest, ...file.path.split("/"));
      await makeUnder(path.dirname(full), dest, created, made);
      const handle = await fs.open(full, "wx", MODES[file.mode]);
      created.files.push(full);
      try {
        await handle.writeFile(file.data);
      } finally {
        await handle.close();
      }
      await onFile?.(index, full);
    }
    if (signal?.aborted) throw new Interrupted(signal.reason);
    return created;
  } catch (error) {
    error.created = created;
    error.left = await removeCreated(created);
    throw error;
  }
}
