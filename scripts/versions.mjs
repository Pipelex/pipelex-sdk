#!/usr/bin/env node
/**
 * Check every package's manifest against the repository's one version.
 *
 * `VERSION` at the repository root is the version of the repository's latest
 * release. Each package's manifest carries the version that package last
 * shipped as: below `VERSION` when a release held the package back, never
 * above it, since only a release moves a version and `VERSION` names the
 * latest one. A project copied out of a template keeps the template's
 * manifest, so a template carries a version too.
 *
 *   node scripts/versions.mjs <unit>...            exit 1 on a violation
 *   node scripts/versions.mjs --release <unit>...  also check what a release pull request ships
 *
 * A unit is what ships as one. It is a directory, such as `js`, whose manifest
 * is its own, or `dir:sub1,sub2`, such as `method-apps:webapp-js,initializers/js`,
 * whose manifests are `dir/sub1`'s and `dir/sub2`'s and must carry one version
 * between them: the method apps ship as one unit, since the initializer packs
 * the templates of its release. A directory's manifest is its `package.json`,
 * or the `[project]` version of its `pyproject.toml`.
 *
 * `--release` adds what a release pull request must hold: at least one unit
 * carries exactly `VERSION`, since a release ships something, and each unit
 * that does has a `## [vX.Y.Z]` heading for it in its `CHANGELOG.md`, the one
 * in the unit's directory.
 *
 * It exits 0 when everything holds, 1 on a violation, and 2 when it cannot
 * check at all: a missing or malformed `VERSION`, or a unit with no manifest.
 *
 * Zero dependencies; runs on the Node the templates already need.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_FILE = "VERSION";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export class VersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "VersionError";
  }
}

/**
 * Compare two versions as semver orders them: major, minor and patch as
 * numbers, then a prerelease below the release it precedes. Returns -1, 0 or 1.
 */
export function compareVersions(a, b) {
  const [, ...x] = SEMVER.exec(a);
  const [, ...y] = SEMVER.exec(b);
  for (let i = 0; i < 3; i += 1) {
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  }
  if (x[3] === y[3]) return 0;
  if (x[3] === undefined) return 1;
  if (y[3] === undefined) return -1;
  const p = x[3].split(".");
  const q = y[3].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i += 1) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** The repository's version, from `VERSION` at its root. */
export function rootVersion(root) {
  const file = path.join(root, VERSION_FILE);
  if (!fs.existsSync(file)) throw new VersionError(`${VERSION_FILE} is missing`);
  const version = fs.readFileSync(file, "utf8").trim();
  if (!SEMVER.test(version)) {
    throw new VersionError(`${VERSION_FILE} holds ${JSON.stringify(version)}, not a version`);
  }
  return version;
}

/** The version a pyproject.toml's `[project]` table declares, or null. */
export function pyprojectVersion(text) {
  let inProject = false;
  for (const line of text.split("\n")) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (table) inProject = table[1].trim() === "project";
    const version = inProject && /^\s*version\s*=\s*["']([^"']+)["']/.exec(line);
    if (version) return version[1];
  }
  return null;
}

/** Where a directory declares its version, and what it says (null when it says nothing). */
export function manifestVersion(root, dir) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) throw new VersionError(`${dir}: no such directory`);
  const pkg = path.join(full, "package.json");
  if (fs.existsSync(pkg)) {
    return {
      manifest: `${dir}/package.json`,
      version: JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? null,
    };
  }
  const pyproject = path.join(full, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    return {
      manifest: `${dir}/pyproject.toml`,
      version: pyprojectVersion(fs.readFileSync(pyproject, "utf8")),
    };
  }
  throw new VersionError(`${dir}: no package.json or pyproject.toml to read a version from`);
}

/** A unit as written on the command line: its directory, and the directories of its manifests. */
export function parseUnit(spec) {
  const [dir, members, ...rest] = spec.split(":");
  if (!dir || rest.length > 0 || members === "") throw new VersionError(`${spec}: not a unit`);
  if (members === undefined) return { name: spec, dir, manifests: [dir] };
  const subs = members.split(",");
  if (subs.some((sub) => sub === "")) throw new VersionError(`${spec}: not a unit`);
  return { name: dir, dir, manifests: subs.map((sub) => `${dir}/${sub}`) };
}

/**
 * Every problem with the units' manifests against `VERSION`, and, with
 * `release`, with what the release ships: `{ version, shipped, problems }`,
 * each problem `{ kind, message }`.
 */
export function checkVersions(root, specs, { release = false } = {}) {
  const version = rootVersion(root);
  const problems = [];
  const shipped = [];
  for (const unit of specs.map(parseUnit)) {
    const read = unit.manifests.map((dir) => manifestVersion(root, dir));
    for (const { manifest, version: own } of read) {
      if (own === null) {
        problems.push({ kind: "no-version", message: `${manifest} carries no version.` });
      } else if (!SEMVER.test(own)) {
        problems.push({
          kind: "no-version",
          message: `${manifest} carries ${JSON.stringify(own)}, which is not a version.`,
        });
      } else if (compareVersions(own, version) > 0) {
        problems.push({
          kind: "above",
          message: `${manifest} carries ${own}, above ${VERSION_FILE}'s ${version}: only a release moves a version, and ${VERSION_FILE} names the latest.`,
        });
      }
    }
    if (new Set(read.map((each) => each.version)).size > 1) {
      problems.push({
        kind: "split",
        message: `${unit.name} ships as one, but its manifests disagree: ${read.map((each) => `${each.manifest} carries ${each.version ?? "no version"}`).join(", ")}.`,
      });
    }
    if (release && read.some((each) => each.version === version)) {
      shipped.push(unit.name);
      const changelog = path.join(root, unit.dir, "CHANGELOG.md");
      const heading = new RegExp(`^## \\[v${version.replace(/[.+]/g, "\\$&")}\\]( |$)`, "m");
      if (!fs.existsSync(changelog)) {
        problems.push({
          kind: "changelog",
          message: `${unit.name} ships at ${version}, and ${unit.dir}/CHANGELOG.md is missing.`,
        });
      } else if (!heading.test(fs.readFileSync(changelog, "utf8"))) {
        problems.push({
          kind: "changelog",
          message: `${unit.name} ships at ${version}, and ${unit.dir}/CHANGELOG.md has no "## [v${version}]" heading.`,
        });
      }
    }
  }
  if (release && shipped.length === 0) {
    problems.push({
      kind: "nothing-shipped",
      message: `No unit carries ${VERSION_FILE}'s ${version}, and a release ships at least one.`,
    });
  }
  return { version, shipped, problems };
}

export function main(argv) {
  const release = argv.includes("--release");
  const specs = argv.filter((arg) => arg !== "--release");
  if (specs.length === 0 || specs.some((arg) => arg.startsWith("-"))) {
    console.error("usage: node scripts/versions.mjs [--release] <dir | dir:sub1,sub2>...");
    return 2;
  }
  try {
    const { version, shipped, problems } = checkVersions(ROOT, specs, { release });
    if (problems.length === 0) {
      console.log(
        release
          ? `Every manifest is at or below ${VERSION_FILE}, ${version}, and the release ships ${shipped.join(", ")}, each with its changelog entry.`
          : `Every manifest is at or below ${VERSION_FILE}, ${version}, and each unit carries one version.`,
      );
      return 0;
    }
    for (const { message } of problems) console.error(message);
    return 1;
  } catch (err) {
    if (err instanceof VersionError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
