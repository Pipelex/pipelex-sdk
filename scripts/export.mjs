#!/usr/bin/env node
/**
 * Export the starters to their template repositories, and check that each
 * mirror still holds what was exported (design DB4, `docs/export.md`).
 *
 * A starter's mirror receives one commit per release that ships the starter:
 * its tree is the starter's directory at the release's tag, `vX.Y.Z:<dir>`, and
 * its parent is the mirror's current `main`, so the push is a fast-forward and
 * the mirror's history stays. `main` and the mirror's own `vX.Y.Z` are pushed
 * together, atomically, then read back.
 *
 *   node scripts/export.mjs plan --tag <vX.Y.Z>
 *       Which starters the release ships: those whose manifest carries the
 *       release's version at the tag.
 *
 *   node scripts/export.mjs export --tag <vX.Y.Z> [--mirror <dir>=<url>]...
 *       Export each starter the release ships. Per mirror: skip it when its
 *       `vX.Y.Z` already holds the directory's tree, fail loudly when that tag
 *       holds another tree, leave it when it holds a later release already,
 *       refuse when the SDK version the starter's lockfile pins is not on its
 *       registry, and otherwise push and compare.
 *
 *   node scripts/export.mjs check [--ref <commit-ish>] [--mirror <dir>=<url>]...
 *       The scheduled comparison: each mirror's `main^{tree}` against
 *       `v<the starter's manifest version>:<dir>`, the release the starter last
 *       shipped in. A starter whose tag does not exist here was never exported
 *       from this repository, and its mirror still holds its own history, so it
 *       is reported without failing.
 *
 * `--mirror` replaces a mirror's GitHub URL, which is how the tests point the
 * export at local bare repositories. The push authenticates however git is
 * configured to; the release workflow gives git the export App's token through
 * a credential helper, so no token ever appears in a URL or an argument here.
 *
 * Exit codes: 0 when every mirror is as it should be, 1 when one is not, 2 on a
 * usage error.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ROOT,
  ReleaseError,
  commitOf,
  fileAt,
  git,
  liveRegistry,
  manifestVersionAt,
  output,
  remoteCommit,
  versionAt,
} from "./publish.mjs";
import { compareVersions } from "./versions.mjs";

/** The repository the mirrors are exported from, named in each export commit. */
export const SOURCE = "Pipelex/pipelex-sdk";

/** The starters, each with its mirror and the SDK its lockfile pins. */
export const STARTERS = [
  {
    dir: "starter-js",
    mirror: "Pipelex/pipelex-starter-js",
    manifest: "starter-js/package.json",
    sdk: { name: "@pipelex/sdk", registry: "npm", lock: "starter-js/package-lock.json" },
  },
  {
    dir: "starter-python",
    mirror: "Pipelex/pipelex-starter-python",
    manifest: "starter-python/pyproject.toml",
    sdk: { name: "pipelex-sdk", registry: "pypi", lock: "starter-python/uv.lock" },
  },
];

/** Where a starter's mirror lives on GitHub. */
export const githubUrl = (starter) => `https://github.com/${starter.mirror}.git`;

const NPM_REGISTRY = "https://registry.npmjs.org/";
const PYPI_INDEX = "https://pypi.org/simple";

/**
 * Who authors an export commit when the environment names nobody. The release
 * workflow names the export App's bot user instead.
 */
const DEFAULT_IDENTITY = {
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};

function identity() {
  return Object.fromEntries(Object.entries(DEFAULT_IDENTITY).filter(([key]) => !process.env[key]));
}

/**
 * The SDK version a starter's lockfile pins at a commit-ish, which is what a
 * project made from the template installs. Refused when the lockfile does not
 * take it from the registry, since the export's promise is that a template
 * never points at an SDK the registry does not serve.
 */
export function lockedSdk(repo, commitish, starter) {
  const { name, registry, lock } = starter.sdk;
  const text = fileAt(repo, commitish, lock);
  if (text === null) throw new ReleaseError(`${commitish} carries no ${lock}`);
  if (registry === "npm") {
    const entry = JSON.parse(text).packages?.[`node_modules/${name}`];
    if (!entry?.version) throw new ReleaseError(`${lock} at ${commitish} locks no ${name}`);
    if (!entry.resolved?.startsWith(NPM_REGISTRY)) {
      throw new ReleaseError(`${lock} at ${commitish} takes ${name} from ${entry.resolved ?? "nowhere"}, not from the npm registry`);
    }
    return { name, registry, version: entry.version };
  }
  const block = text
    .split(/^\[\[package\]\]$/m)
    .find((each) => new RegExp(`^name = "${name.replace(/[.-]/g, "[-_.]")}"$`, "m").test(each));
  const version = block && /^version = "([^"]+)"$/m.exec(block)?.[1];
  if (!version) throw new ReleaseError(`${lock} at ${commitish} locks no ${name}`);
  const source = /^source = \{ registry = "([^"]+)" \}$/m.exec(block)?.[1];
  if (source !== PYPI_INDEX) {
    throw new ReleaseError(`${lock} at ${commitish} does not take ${name} from ${PYPI_INDEX}`);
  }
  return { name, registry, version };
}

/** The release versions a mirror is tagged with, `vX.Y.Z` read as `X.Y.Z`. */
function mirrorVersions(repo, url) {
  return git(repo, ["ls-remote", "--tags", "--refs", url, "refs/tags/v*"])
    .split("\n")
    .map((line) => /\trefs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line)?.[1])
    .filter(Boolean);
}

/** Fetch a remote ref into a ref of our own and answer its tree, or null when the remote lacks it. */
function remoteTree(repo, url, ref, into) {
  if (remoteCommit(repo, url, ref) === null) return null;
  git(repo, ["fetch", "--quiet", "--no-tags", url, `+${ref}:${into}`]);
  return git(repo, ["rev-parse", `${into}^{tree}`]).trim();
}

/** Which starters a release ships: those whose manifest carries its version at the tag. */
export function planExport({ repo, tag }) {
  const commit = commitOf(repo, `refs/tags/${tag}`);
  if (commit === null) throw new ReleaseError(`there is no tag ${tag} here`);
  const version = versionAt(repo, commit);
  if (tag !== `v${version}`) throw new ReleaseError(`${tag} names a commit whose VERSION is ${version}`);
  return STARTERS.map((starter) => ({
    starter,
    version,
    own: manifestVersionAt(repo, commit, starter.manifest),
  })).map((each) => ({ ...each, ships: each.own === version }));
}

/**
 * Export one starter at the tag. Answers `{ status, message }`, the status
 * being `exported` or `skipped` when the mirror ends as it should,
 * `superseded` when the mirror already holds a later release, and `mismatch`
 * or `unresolved` when it does not; nothing is pushed in the last three.
 */
export async function exportStarter({ repo, tag, starter, url, registry }) {
  const commit = commitOf(repo, `refs/tags/${tag}`);
  if (commit === null) throw new ReleaseError(`there is no tag ${tag} here`);
  const tree = git(repo, ["rev-parse", `${commit}:${starter.dir}`]).trim();
  const scratch = `refs/export/${starter.dir}`;

  // The mirror's own tag says whether this release reached it already.
  const tagged = remoteTree(repo, url, `refs/tags/${tag}`, `${scratch}/tag`);
  if (tagged === tree) {
    return { status: "skipped", message: `${starter.mirror}'s ${tag} already holds ${starter.dir} at ${tag}, so it is left as it is.` };
  }
  if (tagged !== null) {
    return {
      status: "mismatch",
      message: `${starter.mirror}'s ${tag} holds the tree ${tagged}, and ${starter.dir} at ${tag} is ${tree}: the mirror's tag is not this release's, and nothing was pushed.`,
    };
  }

  // A later release reached the mirror already: exporting this one now, a
  // re-run of an older release's export, would put the older starter back on
  // top of the newer one.
  const version = tag.slice(1);
  const later = mirrorVersions(repo, url).filter((each) => compareVersions(each, version) > 0);
  if (later.length > 0) {
    const newest = later.sort(compareVersions).at(-1);
    return {
      status: "superseded",
      message: `${starter.mirror} already holds the later release v${newest}, so ${tag}'s export is superseded and nothing was pushed.`,
    };
  }

  // A template never points at an SDK the registry does not serve.
  const pin = lockedSdk(repo, commit, starter);
  if (!(await registry.has(pin.registry, pin.name, pin.version))) {
    return {
      status: "unresolved",
      message: `${starter.sdk.lock} at ${tag} pins ${pin.name} ${pin.version}, which ${pin.registry} does not serve, so ${starter.mirror} was not pushed.`,
    };
  }

  const parent = remoteCommit(repo, url, "refs/heads/main") === null ? null : `${scratch}/main`;
  if (parent !== null) git(repo, ["fetch", "--quiet", "--no-tags", url, `+refs/heads/main:${parent}`]);
  const exported = git(
    repo,
    [
      "commit-tree",
      "--no-gpg-sign",
      tree,
      ...(parent === null ? [] : ["-p", parent]),
      "-m",
      `Release ${tag}, from ${SOURCE}@${commit}`,
    ],
    { env: identity() },
  ).trim();
  // Atomic: the mirror gets both refs or neither, so its tag never stands without its main.
  git(repo, ["push", "--quiet", "--atomic", url, `${exported}:refs/heads/main`, `${exported}:refs/tags/${tag}`]);

  const main = remoteTree(repo, url, "refs/heads/main", `${scratch}/main`);
  const after = remoteTree(repo, url, `refs/tags/${tag}`, `${scratch}/tag`);
  if (main !== tree || after !== tree) {
    return {
      status: "mismatch",
      message: `pushed ${exported} to ${starter.mirror}, and its main holds ${main ?? "nothing"} and its ${tag} ${after ?? "nothing"} where ${starter.dir} at ${tag} is ${tree}.`,
    };
  }
  return { status: "exported", message: `Exported ${starter.dir} at ${tag} to ${starter.mirror} as ${exported}, with its tree read back.` };
}

/** Export every starter the release ships, each on its own, and answer every result. */
export async function exportAll({ repo, tag, registry, urls = {} }) {
  const results = [];
  for (const { starter, own, version, ships } of planExport({ repo, tag })) {
    if (!ships) {
      results.push({ dir: starter.dir, status: "held-back", message: `${starter.manifest} carries ${own}, not ${version}: ${starter.dir} is held back at ${tag}.` });
      continue;
    }
    try {
      const result = await exportStarter({ repo, tag, starter, url: urls[starter.dir] ?? githubUrl(starter), registry });
      results.push({ dir: starter.dir, ...result });
    } catch (error) {
      if (!(error instanceof ReleaseError)) throw error;
      results.push({ dir: starter.dir, status: "failed", message: error.message });
    }
  }
  return results;
}

/**
 * The scheduled comparison of one mirror. Answers `match`, `drift`, or
 * `not-exported` when this repository has no tag for the version the
 * starter's manifest carries, which is a starter never exported from here.
 */
export function checkMirror({ repo, ref = "HEAD", starter, url }) {
  const own = manifestVersionAt(repo, ref, starter.manifest);
  const tag = `v${own}`;
  const commit = commitOf(repo, `refs/tags/${tag}`);
  if (commit === null) {
    return {
      status: "not-exported",
      message: `${starter.manifest} carries ${own}, and this repository has no ${tag}: ${starter.dir} has not been exported from here yet, so ${starter.mirror} still holds its own history.`,
    };
  }
  const tree = git(repo, ["rev-parse", `${commit}:${starter.dir}`]).trim();
  const main = remoteTree(repo, url, "refs/heads/main", `refs/export/${starter.dir}/main`);
  if (main === tree) return { status: "match", message: `${starter.mirror}'s main holds ${starter.dir} at ${tag}.` };
  return {
    status: "drift",
    message: `${starter.mirror}'s main holds ${main === null ? "no main at all" : `the tree ${main}`}, and ${starter.dir} at ${tag} is ${tree}: the mirror changed after its export, or its export did not finish.`,
  };
}

const FAILED = new Set(["mismatch", "unresolved", "failed", "drift"]);

function mirrorUrls(values) {
  const urls = {};
  for (const value of values) {
    const at = value.indexOf("=");
    if (at <= 0) return null;
    urls[value.slice(0, at)] = value.slice(at + 1);
  }
  return urls;
}

/** `--key value` pairs, `--mirror` repeatable; null on anything else. */
function parse(argv, known) {
  const args = { mirror: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith("--") || !known.includes(key) || i + 1 >= argv.length) return null;
    if (key === "mirror") args.mirror.push(argv[i + 1]);
    else args[key] = argv[i + 1];
  }
  const urls = mirrorUrls(args.mirror);
  return urls === null ? null : { ...args, urls };
}

const USAGE = `usage:
  node scripts/export.mjs plan --tag <vX.Y.Z>
  node scripts/export.mjs export --tag <vX.Y.Z> [--mirror <dir>=<url>]...
  node scripts/export.mjs check [--ref <commit-ish>] [--mirror <dir>=<url>]...`;

function report(results) {
  for (const { dir, status, message } of results) {
    console.log(FAILED.has(status) ? `::error::${dir}: ${message}` : `${dir}: ${message}`);
  }
  return results.some(({ status }) => FAILED.has(status)) ? 1 : 0;
}

export async function main(argv, { repo = ROOT, registry = liveRegistry() } = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === "plan") {
      const args = parse(rest, ["tag"]);
      if (!args?.tag) return usage();
      const ships = planExport({ repo, tag: args.tag }).filter((each) => each.ships);
      output({ starters: ships.map((each) => each.starter.dir).join(","), any: String(ships.length > 0) });
      console.log(
        ships.length === 0
          ? `No starter carries ${args.tag.slice(1)}, so ${args.tag} exports nothing.`
          : `${args.tag} exports ${ships.map((each) => each.starter.dir).join(" and ")}.`,
      );
      return 0;
    }
    if (command === "export") {
      const args = parse(rest, ["tag", "mirror"]);
      if (!args?.tag) return usage();
      return report(await exportAll({ repo, tag: args.tag, registry, urls: args.urls }));
    }
    if (command === "check") {
      const args = parse(rest, ["ref", "mirror"]);
      if (args === null) return usage();
      return report(
        STARTERS.map((starter) => ({
          dir: starter.dir,
          ...checkMirror({ repo, ref: args.ref ?? "HEAD", starter, url: args.urls[starter.dir] ?? githubUrl(starter) }),
        })),
      );
    }
    return usage();
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`::error::${error.message}`);
      return 1;
    }
    throw error;
  }
}

function usage() {
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
