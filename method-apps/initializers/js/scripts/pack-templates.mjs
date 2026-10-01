#!/usr/bin/env node
/**
 * Pack every template this initializer serves into `templates/<name>.pack`,
 * the files the published package carries (see `lib/pack.mjs` for why a
 * template travels as one file).
 *
 *   node scripts/pack-templates.mjs              pack the templates as they stand
 *   node scripts/pack-templates.mjs --publish    refuse unless each is exactly a commit
 *   node scripts/pack-templates.mjs --out <dir>  write the packs somewhere else
 *
 * A template's tree is what `git ls-files <template>` lists, read from the
 * working tree, with git's mode for each file. The pack refuses a symlink, a
 * submodule, any mode but a plain or executable file, a file git lists that
 * the working tree lacks, and a template whose `engines.node` is not a plain
 * `>=` floor, which the initializer's preflight reads.
 *
 * `--publish` is what `npm pack` and `npm publish` run (the package's
 * `prepack`). It refuses a template with uncommitted changes, and a family
 * whose `VERSION` is not this package's version, so that what reaches the
 * registry is the template at the commit and the version the pristine commit
 * will name. Without it, a template with uncommitted changes is packed as it
 * stands, and its source is named `<sha>-dirty`. The packs are gitignored.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { encodePack, MODES } from "../lib/pack.mjs";
import { loadTable, PACKAGE_ROOT } from "../lib/templates.mjs";

/** The family's repository: `initializers/js/` is two levels below it. */
export const FAMILY_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

export const PACKS_DIR = path.join(PACKAGE_ROOT, "templates");

/** The floor a JS template's `engines.node` must be, so the preflight can read it. */
export const NODE_FLOOR = /^>=\d+\.\d+\.\d+$/;

export class PackRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "PackRefusal";
  }
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `git ls-files -s` for one template: `[{ mode, path }]`, paths from the repository's root. */
export function listTracked(root, template) {
  const out = git(root, ["ls-files", "-s", "-z", "--", template]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, , stage] = entry.slice(0, tab).split(" ");
      return { mode, stage, path: entry.slice(tab + 1) };
    });
}

/** Whether the template differs from HEAD in any file git tracks. */
export function hasUncommittedChanges(root, template) {
  return git(root, ["status", "--porcelain", "-z", "--untracked-files=no", "--", template]) !== "";
}

/** The family's version, from `VERSION` at the repository's root. */
export function familyVersion(root) {
  return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
}

/** One template's pack, as a Buffer. */
export function packTemplate(root, template, { publish = false } = {}) {
  const prefix = `${template}/`;
  const tracked = listTracked(root, template);
  if (tracked.length === 0)
    throw new PackRefusal(`${template}: git tracks no file under ${prefix}`);
  const dirty = hasUncommittedChanges(root, template);
  if (publish && dirty) {
    throw new PackRefusal(
      `${template} has uncommitted changes, and a published pack must be exactly a commit: commit or discard them first`,
    );
  }

  const files = tracked.map(({ mode, stage, path: rel }) => {
    if (stage !== "0") throw new PackRefusal(`${rel} is in a merge conflict`);
    if (mode === "120000")
      throw new PackRefusal(`${rel} is a symlink, which a template must not carry`);
    if (mode === "160000")
      throw new PackRefusal(`${rel} is a submodule, which a template must not carry`);
    if (!(mode in MODES))
      throw new PackRefusal(`${rel} has mode ${mode}, which a template must not carry`);
    const full = path.join(root, rel);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      throw new PackRefusal(
        `${rel} is tracked but missing from the working tree: restore it or commit its removal`,
      );
    }
    if (!stat.isFile())
      throw new PackRefusal(`${rel} is tracked as a file but is not one in the working tree`);
    return { path: rel.slice(prefix.length), mode, data: fs.readFileSync(full) };
  });

  const manifest = files.find((file) => file.path === "package.json");
  const floor = manifest && JSON.parse(manifest.data.toString("utf8")).engines?.node;
  if (!floor || !NODE_FLOOR.test(floor)) {
    throw new PackRefusal(
      `${template}/package.json must declare engines.node as a floor such as ">=22.12.0", and declares ${JSON.stringify(floor ?? null)}`,
    );
  }

  const head = git(root, ["rev-parse", "HEAD"]).trim();
  return encodePack({
    template,
    version: familyVersion(root),
    source: dirty ? `${head}-dirty` : head,
    files,
  });
}

/** Pack every template the table names into `outDir`, returning the files written. */
export function packAll(root, { publish = false, outDir = PACKS_DIR, table = loadTable() } = {}) {
  if (publish) {
    const own = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ).version;
    const family = familyVersion(root);
    if (own !== family) {
      throw new PackRefusal(
        `VERSION says ${family} and this package says ${own}: the family has one version`,
      );
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  return Object.keys(table.templates).map((template) => {
    const file = path.join(outDir, `${template}.pack`);
    fs.writeFileSync(file, packTemplate(root, template, { publish }));
    return file;
  });
}

export function main(argv) {
  const publish = argv.includes("--publish");
  const at = argv.indexOf("--out");
  const outDir = at >= 0 ? path.resolve(argv[at + 1] ?? "") : PACKS_DIR;
  const unknown = argv.filter(
    (arg, i) => arg !== "--publish" && !(arg === "--out" || argv[i - 1] === "--out"),
  );
  if (unknown.length > 0 || (at >= 0 && argv[at + 1] === undefined)) {
    console.error("usage: node scripts/pack-templates.mjs [--publish] [--out <dir>]");
    return 2;
  }
  try {
    for (const file of packAll(FAMILY_ROOT, { publish, outDir })) {
      console.log(
        `packed ${path.relative(process.cwd(), file) || file} (${fs.statSync(file).size} bytes)`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof PackRefusal) {
      console.error(`pack-templates: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
