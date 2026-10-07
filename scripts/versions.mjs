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
 *   node scripts/versions.mjs --release [--copy-out <file>]... <unit>...
 *                                                  also check what a release pull request ships
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
 * `--copy-out <file>` names a README whose copy-out command copies the
 * template beside it out of a release's tag, as one does while no initializer
 * serves that template, and a release then checks the `TAG=vX.Y.Z` the command
 * sets: the tag must be a release that holds the template, or the copy-out
 * downloads or extracts nothing. It holds when the tag exists and has the
 * template's directory, or when it is this release's own tag, which the release
 * workflow cuts on the merge, and the unit holding the README ships in it. A
 * tag above the version that unit carries names no release of it. The tags are
 * the ones this checkout last fetched.
 *
 * It exits 0 when everything holds, 1 on a violation, and 2 when it cannot
 * check at all: a missing or malformed `VERSION`, a unit with no manifest, or a
 * copy-out file that is missing or in none of the units.
 *
 * Zero dependencies; runs on the Node the templates already need.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_FILE = "VERSION";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// A release tag as the release workflow cuts it from `VERSION`: `vX.Y.Z`, never a prerelease.
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

// The tag a copy-out command sets, at the start of a line: `TAG=v0.32.0   # a comment`.
const COPY_OUT_TAG = /^TAG=(\S*)/gm;

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

/** What git prints, trimmed, or null when the command fails: a lookup whose miss is an answer. */
function lookup(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** Whether the repository has the tag, and whether that tag holds the directory. */
function taggedTree(root, tag, dir) {
  if (lookup(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]) === null) {
    return { tagged: false, holds: false };
  }
  const sha = lookup(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}:${dir}`]);
  return { tagged: true, holds: sha !== null && lookup(root, ["cat-file", "-t", sha]) === "tree" };
}

/** Every `TAG=` a copy-out file sets, in order, as written. */
export function copyOutTags(text) {
  return [...text.matchAll(COPY_OUT_TAG)].map((match) => match[1]);
}

/**
 * Every problem with one copy-out at a release of `version`: each `TAG=` its
 * file sets must be a release that holds the template beside the file. `units`
 * are the parsed units, and `carried` maps each unit's name to the one version
 * its manifests carry, absent when they carry none or disagree, which is a
 * problem of its own.
 */
export function copyOutProblems(root, file, units, carried, version) {
  const unit = units.find((each) => file.startsWith(`${each.dir}/`));
  if (unit === undefined) throw new VersionError(`${file}: in none of the units given`);
  const full = path.join(root, file);
  if (!fs.existsSync(full)) throw new VersionError(`${file}: no such file`);
  const template = path.posix.dirname(file);
  const tags = copyOutTags(fs.readFileSync(full, "utf8"));
  if (tags.length === 0) {
    return [
      {
        kind: "copy-out",
        message: `${file} sets no TAG= for a copy-out: once nothing copies ${template}/ out of a release, drop it from the root Makefile's COPY_OUTS.`,
      },
    ];
  }
  const own = carried.get(unit.name);
  const problems = [];
  for (const tag of new Set(tags)) {
    const named = RELEASE_TAG.exec(tag);
    if (named === null) {
      problems.push({
        kind: "copy-out",
        message: `${file}'s copy-out sets TAG=${tag}, which is not a release tag such as v${version}.`,
      });
      continue;
    }
    if (own === undefined) continue;
    if (compareVersions(named[1], own) > 0) {
      problems.push({
        kind: "copy-out",
        message: `${file}'s copy-out names ${tag}, above the ${own} ${unit.name} carries: no release ships ${template}/ at that version.`,
      });
      continue;
    }
    const { tagged, holds } = taggedTree(root, tag, template);
    if (tagged && !holds) {
      problems.push({
        kind: "copy-out",
        message: `${file}'s copy-out names ${tag}, a release that holds no ${template}/, so the copy-out extracts nothing.`,
      });
    } else if (!tagged && named[1] !== version) {
      // This release's own tag, not cut yet, passes: the tag is at or below the unit's version, and
      // checkVersions refuses a manifest above VERSION, so a tag naming VERSION names a unit shipping in it.
      problems.push({
        kind: "copy-out",
        message: `${file}'s copy-out names ${tag}, which is neither a tag of this repository nor this release's, v${version}: the copy-out downloads nothing.`,
      });
    }
  }
  return problems;
}

/**
 * Every problem with the units' manifests against `VERSION`, and, with
 * `release`, with what the release ships and with the tag each of `copyOuts`
 * names: `{ version, shipped, problems }`, each problem `{ kind, message }`.
 */
export function checkVersions(root, specs, { release = false, copyOuts = [] } = {}) {
  const version = rootVersion(root);
  const problems = [];
  const shipped = [];
  const units = specs.map(parseUnit);
  const carried = new Map();
  for (const unit of units) {
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
    } else if (read[0].version !== null && SEMVER.test(read[0].version)) {
      carried.set(unit.name, read[0].version);
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
  if (release) {
    for (const file of copyOuts) problems.push(...copyOutProblems(root, file, units, carried, version));
  }
  return { version, shipped, problems };
}

export function main(argv) {
  const usage = "usage: node scripts/versions.mjs [--release [--copy-out <file>]...] <dir | dir:sub1,sub2>...";
  const specs = [];
  const copyOuts = [];
  let release = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--release") release = true;
    else if (argv[i] === "--copy-out" && i + 1 < argv.length) copyOuts.push(argv[(i += 1)]);
    else specs.push(argv[i]);
  }
  const misused = copyOuts.length > 0 && !release;
  if (specs.length === 0 || misused || [...specs, ...copyOuts].some((arg) => arg.startsWith("-"))) {
    console.error(usage);
    return 2;
  }
  try {
    const { version, shipped, problems } = checkVersions(ROOT, specs, { release, copyOuts });
    if (problems.length === 0) {
      const copied = copyOuts.length > 0 ? `, and every copy-out names a release that holds its template` : "";
      console.log(
        release
          ? `Every manifest is at or below ${VERSION_FILE}, ${version}, and the release ships ${shipped.join(", ")}, each with its changelog entry${copied}.`
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
