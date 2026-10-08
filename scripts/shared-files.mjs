#!/usr/bin/env node
/**
 * Keep the case files the two SDKs share identical in both.
 *
 * Some behaviour is a contract the JavaScript and Python SDKs must both honour, and each holds
 * it as a file of recorded cases its own suite runs: the `pipelex-sdk` command's case table is
 * one. Each package directory stands on its own, its tests reaching nothing above it, so each
 * holds its own copy of such a file. One copy is the source, written and reviewed where the
 * behaviour is changed; the others are copies, written by this script and never edited.
 *
 *   node scripts/shared-files.mjs           copy every source over its copies
 *   node scripts/shared-files.mjs --check   exit 1 when a copy is missing or differs
 *
 * `SETS` below declares each source and its copies, as paths from the repository root. A new
 * shared file is one more entry. A copy is compared byte for byte, and copying creates its
 * directory when it is missing.
 *
 * It exits 0 when every copy is current (or was just written), 1 when `--check` finds one that
 * is not, and 2 when it cannot work at all: an unknown argument, a source that is missing, or a
 * declaration that does not hold together.
 *
 * Zero dependencies; runs on the Node the templates already need.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each shared file: its source, and the copies written from it. */
export const SETS = [
  {
    // The `pipelex-sdk` command's case table (js/docs/cli.md, "The case table").
    source: "js/tests/fixtures/cli-cases.json",
    copies: ["python/tests/fixtures/cli-cases.json"],
  },
];

export class SharedFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "SharedFileError";
  }
}

/** Refuse a declaration that does not hold together, before anything is read or written. */
export function checkSets(sets) {
  const seen = new Map();
  for (const { source, copies } of sets) {
    if (copies.length === 0) throw new SharedFileError(`${source} is declared with no copy`);
    for (const file of [source, ...copies]) {
      const normalized = path.posix.normalize(file);
      if (path.isAbsolute(file) || normalized !== file || normalized.startsWith("../")) {
        throw new SharedFileError(`${file} is not a plain path from the repository root`);
      }
      if (seen.has(file)) {
        throw new SharedFileError(`${file} is declared twice, in the sets of ${seen.get(file)} and ${source}`);
      }
      seen.set(file, source);
    }
  }
}

/** Every copy that is missing or differs from its source, as `{ source, copy, kind }`. */
export function compareSets(root, sets) {
  checkSets(sets);
  const problems = [];
  for (const { source, copies } of sets) {
    const sourcePath = path.join(root, source);
    if (!fs.existsSync(sourcePath)) throw new SharedFileError(`the source ${source} does not exist`);
    const expected = fs.readFileSync(sourcePath);
    for (const copy of copies) {
      const copyPath = path.join(root, copy);
      if (!fs.existsSync(copyPath)) problems.push({ source, copy, kind: "missing" });
      else if (!fs.readFileSync(copyPath).equals(expected)) problems.push({ source, copy, kind: "differs" });
    }
  }
  return problems;
}

/** Write every copy that is missing or differs, and return what was written. */
export function writeSets(root, sets) {
  const problems = compareSets(root, sets);
  for (const { source, copy } of problems) {
    const copyPath = path.join(root, copy);
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.copyFileSync(path.join(root, source), copyPath);
  }
  return problems;
}

export function main(argv, { root = ROOT, sets = SETS } = {}) {
  const check = argv.includes("--check");
  if (argv.some((arg) => arg !== "--check")) {
    console.error("usage: node scripts/shared-files.mjs [--check]");
    return 2;
  }
  try {
    if (check) {
      const problems = compareSets(root, sets);
      if (problems.length === 0) {
        console.log("Shared files are current.");
        return 0;
      }
      for (const { source, copy, kind } of problems) {
        console.error(`${kind}: ${copy}, the copy of ${source}`);
      }
      console.error("A copy is never edited: change its source, run `make shared-files`, and commit both.");
      return 1;
    }
    const written = writeSets(root, sets);
    for (const { source, copy } of written) console.log(`copied ${source} to ${copy}`);
    if (written.length === 0) console.log("Shared files are already current.");
    return 0;
  } catch (err) {
    if (err instanceof SharedFileError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
