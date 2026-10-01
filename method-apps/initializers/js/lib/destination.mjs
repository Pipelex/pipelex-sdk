/**
 * The destination rule, which is the scaffold skill's: a directory that is
 * missing, empty, or holds only `.git` is accepted, and anything else is
 * refused. The lone `.git` is a ruling about `.git` and nothing else, so
 * `.DS_Store`, an editor's settings and every other entry refuse, because
 * judging which of a user's files matter is exactly what the rule forbids.
 *
 * The destination is resolved to an absolute path first, so `.` works, and it
 * is read twice: in the preflight, and again immediately before the first
 * write.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * What stands at the destination: `missing`, `empty`, `lone-git`, a
 * `not-empty` directory with some of what it holds, or a `not-directory`.
 */
export function readDestination(dir) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!stat.isDirectory()) return { kind: "not-directory" };
  const entries = fs.readdirSync(dir).sort();
  if (entries.length === 0) return { kind: "empty" };
  if (entries.length === 1 && entries[0] === ".git") return { kind: "lone-git" };
  return { kind: "not-empty", entries: entries.filter((entry) => entry !== ".git") };
}

/** The refusal's explanation of what stands there, or null when the rule accepts it. */
export function destinationProblem(dir, found) {
  if (found.kind === "not-directory") return `${dir} exists and is not a directory`;
  if (found.kind !== "not-empty") return null;
  const shown = found.entries.slice(0, 3).join(", ");
  const more = found.entries.length > 3 ? ` and ${found.entries.length - 3} more` : "";
  return `${dir} already holds ${shown}${more}; the template is written only into a directory that is missing, empty or holds nothing but .git`;
}

/** The nearest ancestor of `dir`, itself included, that exists. */
export function nearestExisting(dir) {
  let at = dir;
  while (!fs.existsSync(at)) {
    const parent = path.dirname(at);
    if (parent === at) return at;
    at = parent;
  }
  return at;
}
