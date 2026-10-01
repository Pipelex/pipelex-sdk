#!/usr/bin/env node
/**
 * Check that the family carries one version.
 *
 * `VERSION` at the root is the family's version, and the release reads it.
 * Each template's own manifest carries a version too, because a project copied
 * out of the template keeps that manifest, and each initializer publishes at
 * the family's version, since it carries the templates of that release; this
 * check holds each of them to the root's number, so a release that bumps one
 * and forgets another fails before it merges.
 *
 *   node scripts/versions.mjs <dir>...   exit 1 when a manifest disagrees
 *
 * Each directory is a template or an initializer. Its manifest is its
 * `package.json`, or its `pyproject.toml`'s `[project]` version. A directory
 * with neither is refused, since there would be nothing to hold to the
 * family's number.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_FILE = "VERSION";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class VersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "VersionError";
  }
}

export function familyVersion(root) {
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

/** Where a template declares its version, and what it says. */
export function templateVersion(root, template) {
  const dir = path.join(root, template);
  if (!fs.existsSync(dir)) throw new VersionError(`${template}: no such directory`);
  const pkg = path.join(dir, "package.json");
  if (fs.existsSync(pkg)) {
    return {
      manifest: `${template}/package.json`,
      version: JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? null,
    };
  }
  const pyproject = path.join(dir, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    return {
      manifest: `${template}/pyproject.toml`,
      version: pyprojectVersion(fs.readFileSync(pyproject, "utf8")),
    };
  }
  throw new VersionError(`${template}: no package.json or pyproject.toml to read a version from`);
}

/** Every manifest whose version is not the family's. */
export function mismatches(root, templates) {
  const expected = familyVersion(root);
  return {
    expected,
    wrong: templates
      .map((template) => templateVersion(root, template))
      .filter(({ version }) => version !== expected),
  };
}

export function main(argv) {
  if (argv.length === 0) {
    console.error("usage: node scripts/versions.mjs <template or initializer directory>...");
    return 2;
  }
  try {
    const { expected, wrong } = mismatches(ROOT, argv);
    if (wrong.length === 0) {
      console.log(`Every template and initializer carries the family's version, ${expected}.`);
      return 0;
    }
    for (const { manifest, version } of wrong) {
      console.error(
        `${manifest} carries ${version === null ? "no version" : version}, and ${VERSION_FILE} carries ${expected}.`,
      );
    }
    console.error("The family has one version: set each manifest to the number in VERSION.");
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
