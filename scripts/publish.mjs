#!/usr/bin/env node
/**
 * The release workflow's decisions, each taken from git and the registries
 * rather than from the commit a run happens to stand on.
 *
 * `.github/workflows/release.yml` runs this script at each of its steps, so
 * that what decides a publish is code with tests (`publish.test.mjs`) and the
 * workflow only carries out the answer:
 *
 *   node scripts/publish.mjs tag --sha <commit>
 *       Tag the release before anything publishes: read `VERSION` at the
 *       commit and push `vX.Y.Z` on it, or find the tag already there. A tag
 *       standing on another commit is refused, so a push to `main` never
 *       re-tags and never publishes a commit other than the tag's.
 *
 *   node scripts/publish.mjs check --tag <vX.Y.Z> --package <name>
 *       Whether one package ships from the tag: its manifest carries the
 *       release's version, its changelog has the entry, the checkout stands on
 *       the tag, and the registry does not have that version yet (for PyPI, a
 *       wheel and an sdist both, so a part-way upload is finished).
 *
 *   node scripts/publish.mjs tarball --file <tgz> --package <name> --version <version>
 *       Refuse an npm tarball that is not that package at that version: the
 *       job that publishes checks what the unprivileged build handed it.
 *
 *   node scripts/publish.mjs distributions --dir <dist> --package <name> --version <version>
 *       The same for Python: exactly one sdist and one wheel of that package
 *       at that version, by filename and by the metadata inside them.
 *
 *   node scripts/publish.mjs release --tag <vX.Y.Z>
 *       Create the GitHub Release from the shipped packages' changelog
 *       entries, unless it exists already.
 *
 *   node scripts/publish.mjs sprint --sha <commit> --ref <GITHUB_REF> --head <GITHUB_SHA> [--package <name>] [--version <version>]
 *       Whether to publish the sprint prerelease of `@pipelex/sdk` at a commit,
 *       and as which version: `X.Y.Z-sprint.g<full sha>`, `X.Y.Z` being the next
 *       patch above the version `js/package.json` carries at that commit
 *       (design DB6). `--version`, which `wt pin` passes, must be the same one.
 *       The dispatch's own ref and head are refused unless they are `dev`'s,
 *       the one branch beside `main` that the `npm` environment allows, and
 *       while `dev` stands on a release tag, where its run could be read as
 *       the release's.
 *
 *   node scripts/publish.mjs stamp --file <js/src/version.ts> --version <version>
 *       Write the prerelease's version into the SDK's `SDK_VERSION` constant.
 *
 * Each subcommand prints what it decided and, inside GitHub Actions, writes its
 * answers to `$GITHUB_OUTPUT`. It exits 0 on a decision, 1 on a refusal, and 2
 * on a usage error.
 *
 * Zero dependencies, like the root's other scripts.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { pyprojectVersion } from "./versions.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The packages a release publishes, each from its directory at the tag. */
export const PACKAGES = [
  {
    name: "@pipelex/sdk",
    registry: "npm",
    manifest: "js/package.json",
    changelog: "js/CHANGELOG.md",
  },
  {
    name: "@pipelex/create-method-app",
    registry: "npm",
    manifest: "method-apps/initializers/js/package.json",
    changelog: "method-apps/CHANGELOG.md",
  },
  {
    name: "pipelex-sdk",
    registry: "pypi",
    manifest: "python/pyproject.toml",
    changelog: "python/CHANGELOG.md",
  },
];

/**
 * What a release ships, in the order its GitHub Release lists them: the
 * published packages, then the starters its export pushes to their mirrors.
 */
export const UNITS = [
  { title: "`@pipelex/sdk` on npm", manifest: "js/package.json", changelog: "js/CHANGELOG.md" },
  { title: "`pipelex-sdk` on PyPI", manifest: "python/pyproject.toml", changelog: "python/CHANGELOG.md" },
  {
    title: "`@pipelex/create-method-app` on npm, with the method-app templates",
    manifest: "method-apps/initializers/js/package.json",
    changelog: "method-apps/CHANGELOG.md",
  },
  {
    title: "The JavaScript starter, `Pipelex/pipelex-starter-js`",
    manifest: "starter-js/package.json",
    changelog: "starter-js/CHANGELOG.md",
  },
  {
    title: "The Python starter, `Pipelex/pipelex-starter-python`",
    manifest: "starter-python/pyproject.toml",
    changelog: "starter-python/CHANGELOG.md",
  },
];

/** The one package a sprint prerelease is published for (design DB6). */
export const SPRINT_PACKAGE = "@pipelex/sdk";
export const SPRINT_MANIFEST = "js/package.json";
export const SPRINT_DIST_TAG = "sprint";
/**
 * The one branch a sprint prerelease is dispatched from, and the environment
 * its publish job holds, which allows `main` and this branch alone.
 */
export const SPRINT_BRANCH = "dev";
export const SPRINT_ENVIRONMENT = "npm";

/** A release's version: a plain `X.Y.Z`, which is what a `release/vX.Y.Z` branch can spell. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** A decision this script refuses to take, with the reason a person reads. */
export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** Run git in `cwd`, returning its output, or null when `allowFail` and git refused. */
export function git(cwd, args, { env = {}, allowFail = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFail) return null;
    throw new ReleaseError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** The full commit a commit-ish names, or null when it names none. */
export function commitOf(repo, commitish) {
  const out = git(repo, ["rev-parse", "--verify", "--quiet", `${commitish}^{commit}`], { allowFail: true });
  return out === null ? null : out.trim();
}

/** A file's text at a commit-ish, or null when that commit has no such file. */
export function fileAt(repo, commitish, file) {
  if (git(repo, ["cat-file", "-e", `${commitish}:${file}`], { allowFail: true }) === null) return null;
  return git(repo, ["show", `${commitish}:${file}`]);
}

/** The repository's version, from `VERSION` at a commit-ish. */
export function versionAt(repo, commitish) {
  const text = fileAt(repo, commitish, "VERSION");
  if (text === null) throw new ReleaseError(`${commitish} carries no VERSION`);
  const version = text.trim();
  if (!RELEASE_VERSION.test(version)) {
    throw new ReleaseError(`VERSION at ${commitish} holds ${JSON.stringify(version)}, not a release version X.Y.Z`);
  }
  return version;
}

/** The version a manifest declares at a commit-ish, or null when it declares none. */
export function manifestVersionAt(repo, commitish, manifest) {
  const text = fileAt(repo, commitish, manifest);
  if (text === null) throw new ReleaseError(`${commitish} carries no ${manifest}`);
  if (manifest.endsWith(".json")) return JSON.parse(text).version ?? null;
  return pyprojectVersion(text);
}

/** Whether a changelog's text has the entry `## [vX.Y.Z]` for a version. */
export function hasChangelogEntry(text, version) {
  const heading = new RegExp(`^## \\[v${version.replace(/\./g, "\\.")}\\]( |$)`, "m");
  return heading.test(text);
}

/** The body of a changelog's entry for a version, without its heading, or null. */
export function changelogEntry(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => hasChangelogEntry(line, version));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * The commit a remote ref points at, peeled through an annotated tag, or null
 * when the remote has no such ref.
 */
export function remoteCommit(repo, remote, ref) {
  const out = git(repo, ["ls-remote", remote, ref, `${ref}^{}`]);
  const lines = out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const peeled = lines.find(([, name]) => name === `${ref}^{}`);
  const plain = lines.find(([, name]) => name === ref);
  return (peeled ?? plain)?.[0] ?? null;
}

/** The commit a remote's tag points at, or null when the remote has no such tag. */
export function remoteTagCommit(repo, remote, tag) {
  return remoteCommit(repo, remote, `refs/tags/${tag}`);
}

/**
 * What the push to `main` does about the release's tag. `create` when the
 * remote has no `vX.Y.Z`, `exists` when it already names this commit (a re-run),
 * and `elsewhere` when it names another commit, which the release refuses: that
 * version was released from that commit, and a push carrying the same version
 * is not a release, so nothing is tagged again and nothing publishes.
 */
export function planTag({ repo, sha, remote = "origin" }) {
  const commit = commitOf(repo, sha);
  if (commit === null) throw new ReleaseError(`${sha} is not a commit of this repository`);
  const version = versionAt(repo, commit);
  const tag = `v${version}`;
  const tagged = remoteTagCommit(repo, remote, tag);
  if (tagged === null) return { action: "create", version, tag, commit, tagged };
  if (tagged === commit) return { action: "exists", version, tag, commit, tagged };
  return { action: "elsewhere", version, tag, commit, tagged };
}

/** Carry out `planTag`'s answer, pushing the tag when it is missing. Returns the plan. */
export function applyTag({ repo, plan, remote = "origin" }) {
  if (plan.action === "elsewhere") {
    throw new ReleaseError(
      `${plan.tag} already tags ${plan.tagged}, and this push to main stands on ${plan.commit} with the same VERSION. ` +
        `A version is released from one commit only, so nothing is tagged again and nothing publishes: ` +
        `a release needs a new version, and a release that failed part-way is finished by re-running its own run, at ${plan.tagged}.`,
    );
  }
  if (plan.action === "exists") return plan;
  const pushed = git(repo, ["push", remote, `${plan.commit}:refs/tags/${plan.tag}`], { allowFail: true });
  // Read the remote back either way: a refused push is fine when the tag now
  // names this commit, and a push is not done until the remote says so.
  const tagged = remoteTagCommit(repo, remote, plan.tag);
  if (tagged !== plan.commit) {
    throw new ReleaseError(
      pushed === null
        ? `pushing ${plan.tag} on ${plan.commit} was refused, and the remote's ${plan.tag} names ${tagged ?? "nothing"}`
        : `pushed ${plan.tag} on ${plan.commit}, and the remote's ${plan.tag} names ${tagged ?? "nothing"}`,
    );
  }
  return plan;
}

/** The registries, asked over HTTP: whether a package's version is published. */
export function registryUrl(registry, name, version) {
  if (registry === "npm") {
    return `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`;
  }
  if (registry === "pypi") {
    return `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  }
  throw new ReleaseError(`no registry named ${registry}`);
}

/**
 * The distributions a release of a Python package is complete with. PyPI
 * creates a version on its first uploaded file, so a version that answers but
 * lacks one of these was uploaded part-way, and still has to publish.
 */
export const PYPI_DISTRIBUTIONS = ["sdist", "bdist_wheel"];

/**
 * The live registry: `has` answers whether a version is published in full,
 * true on 200 (for PyPI, with both of `PYPI_DISTRIBUTIONS` among its files),
 * false on 404, and refuses on anything else after a few attempts, since a
 * publish decided on an unread registry could be wrong either way.
 */
export function liveRegistry({ fetchImpl = globalThis.fetch, attempts = 3, pauseMs = 2000 } = {}) {
  return {
    async has(registry, name, version) {
      const url = registryUrl(registry, name, version);
      let last = "";
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await fetchImpl(url, { headers: { accept: "application/json" } });
          if (response.status === 200 && registry !== "pypi") return true;
          if (response.status === 200) {
            const kinds = new Set(((await response.json()).urls ?? []).map((file) => file.packagetype));
            return PYPI_DISTRIBUTIONS.every((kind) => kinds.has(kind));
          }
          if (response.status === 404) return false;
          last = `HTTP ${response.status}`;
        } catch (error) {
          last = error.message;
        }
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      throw new ReleaseError(`${registry} could not say whether ${name} ${version} is published (${url}: ${last})`);
    },
  };
}

/**
 * Whether one package ships from the tag. Refuses when the checkout does not
 * stand on the tag (`head`, a checkout to compare), when the tag does not name
 * its own `VERSION`, or when a shipping package lacks its changelog entry.
 * Answers `held-back` when its manifest carries another version, `published`
 * when the registry has the version, and `publish` otherwise.
 */
export async function planPublish({ repo, tag, name, registry, head = null }) {
  const pkg = PACKAGES.find((each) => each.name === name);
  if (!pkg) throw new ReleaseError(`${name} is not a package this repository publishes`);
  const commit = commitOf(repo, `refs/tags/${tag}`);
  if (commit === null) throw new ReleaseError(`there is no tag ${tag} here`);
  if (head !== null) {
    const standing = commitOf(head, "HEAD");
    if (standing !== commit) {
      throw new ReleaseError(`the checkout stands on ${standing}, not on ${tag} (${commit}): a release builds from its tag`);
    }
  }
  const version = versionAt(repo, commit);
  if (tag !== `v${version}`) throw new ReleaseError(`${tag} names a commit whose VERSION is ${version}`);
  const own = manifestVersionAt(repo, commit, pkg.manifest);
  const base = { name, version, tag, commit, manifest: pkg.manifest, own };
  if (own !== version) return { ...base, action: "held-back" };
  const changelog = fileAt(repo, commit, pkg.changelog);
  if (changelog === null || !hasChangelogEntry(changelog, version)) {
    throw new ReleaseError(`${name} ships at ${version}, and ${pkg.changelog} at ${tag} has no "## [v${version}]" entry`);
  }
  if (await registry.has(pkg.registry, name, version)) return { ...base, action: "published" };
  return { ...base, action: "publish" };
}

/** The GitHub Release's notes: each shipped unit's changelog entry, under its title. */
export function releaseNotes({ repo, tag }) {
  const commit = commitOf(repo, `refs/tags/${tag}`);
  if (commit === null) throw new ReleaseError(`there is no tag ${tag} here`);
  const version = versionAt(repo, commit);
  const sections = [];
  for (const unit of UNITS) {
    if (manifestVersionAt(repo, commit, unit.manifest) !== version) continue;
    const text = fileAt(repo, commit, unit.changelog);
    const entry = text === null ? null : changelogEntry(text, version);
    sections.push(`## ${unit.title}\n\n${entry || `No changelog entry for v${version}.`}`);
  }
  if (sections.length === 0) throw new ReleaseError(`no package carries ${version} at ${tag}, so ${tag} ships nothing`);
  return `${sections.join("\n\n")}\n`;
}

/** The live GitHub Releases, through the `gh` CLI, which reads `GH_TOKEN` and `GH_REPO`. */
export function liveReleases() {
  const gh = (args) => spawnSync("gh", args, { encoding: "utf8" });
  return {
    exists(tag) {
      const result = gh(["release", "view", tag, "--json", "tagName"]);
      if (result.status === 0) return true;
      if (/release not found/i.test(result.stderr)) return false;
      throw new ReleaseError(`gh could not say whether the release ${tag} exists: ${result.stderr.trim()}`);
    },
    create(tag, notes) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-")), "notes.md");
      fs.writeFileSync(file, notes);
      // --verify-tag: the tag is the release workflow's to create, never gh's.
      const result = gh(["release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", file]);
      if (result.status !== 0) throw new ReleaseError(`gh could not create the release ${tag}: ${result.stderr.trim()}`);
    },
  };
}

/** Create the GitHub Release for the tag unless it exists. Answers `created` or `exists`. */
export function publishRelease({ repo, tag, releases }) {
  if (releases.exists(tag)) return { action: "exists", tag };
  releases.create(tag, releaseNotes({ repo, tag }));
  return { action: "created", tag };
}

/**
 * The sprint prerelease a commit is published as, from the version its
 * manifest carries there: the next patch above a plain `X.Y.Z`, suffixed
 * `-sprint.g<full sha>`. The workspace's `wt pin` computes the same string
 * (`workspace/wt/manifests.py`, `sprint_prerelease_of`), so the rule is kept
 * as narrow as there: anything but a plain `X.Y.Z` answers null.
 */
export function sprintVersion(manifestVersion, sha) {
  const parts = String(manifestVersion).trim().split(".");
  const plain = (part) => /^[0-9]+$/.test(part) && (part === "0" || !part.startsWith("0"));
  if (parts.length !== 3 || !parts.every(plain)) return null;
  const [major, minor, patch] = parts.map(Number);
  return `${major}.${minor}.${patch + 1}-${SPRINT_DIST_TAG}.g${sha}`;
}

/**
 * Refuse a dispatch that could not publish, or whose run could be read as a
 * release's. The sprint publish job holds the `npm` environment, whose
 * deployment branch policy allows `main` and `dev` alone, and `ledger land`
 * verifies a release from the newest run of `release.yml` at the release's
 * merge commit or its release branch's head, so a sprint dispatch is taken
 * only from `dev` (`ref`, the run's `GITHUB_REF`), and only while its head
 * (`head`, the run's `GITHUB_SHA`) carries no release tag `v*`, as it does
 * right after a landing fast-forwards it onto a release. Refusing here, before
 * the build, says why; the environment would only fail the publish job after
 * the commit was built.
 */
export function checkDispatch({ repo, ref, head }) {
  if (!ref.startsWith("refs/heads/")) {
    throw new ReleaseError(`a sprint prerelease is dispatched from ${SPRINT_BRANCH}, and ${ref} is not a branch`);
  }
  const branch = ref.slice("refs/heads/".length);
  if (branch === "main" || branch.startsWith("release/")) {
    throw new ReleaseError(
      `a sprint prerelease is never dispatched from ${branch}, whose runs stand where a release's are read: dispatch it from ${SPRINT_BRANCH}`,
    );
  }
  if (branch !== SPRINT_BRANCH) {
    throw new ReleaseError(
      `a sprint prerelease is dispatched from ${SPRINT_BRANCH} alone, not ${branch}: the ${SPRINT_ENVIRONMENT} environment its publish job holds allows main and ${SPRINT_BRANCH}, so a run from ${branch} could not publish`,
    );
  }
  const tags = git(repo, ["tag", "--points-at", head, "--list", "v*"]).split("\n").filter(Boolean);
  if (tags.length > 0) {
    throw new ReleaseError(
      `${branch} stands on ${head}, the release ${tags.join(", ")}, where a run of this workflow would be read as the release's: dispatch once ${branch} has moved on`,
    );
  }
  return branch;
}

/**
 * Whether to publish the sprint prerelease of `@pipelex/sdk` at a commit, and
 * as which version. The commit must be a full SHA on a branch of this
 * repository (`refs/remotes/<remote>/`), so that a commit only a fork's pull
 * request carries is never published under the package's name, and its
 * `js/package.json` must name the package, so a commit cannot steer the
 * publish onto another one.
 */
export async function planSprint({ repo, sha, name = SPRINT_PACKAGE, version = "", registry, remote = "origin" }) {
  if (name !== SPRINT_PACKAGE) {
    throw new ReleaseError(`only ${SPRINT_PACKAGE} takes a sprint prerelease (design DB6), not ${name}`);
  }
  if (!FULL_SHA.test(sha)) {
    throw new ReleaseError(`${JSON.stringify(sha)} is not a full commit SHA: a sprint prerelease names its commit in full`);
  }
  if (commitOf(repo, sha) !== sha) throw new ReleaseError(`${sha} is not a commit of this repository`);
  const branches = git(repo, ["for-each-ref", "--contains", sha, "--format=%(refname)", `refs/remotes/${remote}/`])
    .split("\n")
    .filter((ref) => ref && !ref.endsWith("/HEAD"));
  if (branches.length === 0) {
    throw new ReleaseError(`${sha} is on no branch of this repository, and a sprint prerelease is published from a pushed commit only`);
  }
  const manifest = JSON.parse(fileAt(repo, sha, SPRINT_MANIFEST) ?? "{}");
  if (manifest.name !== SPRINT_PACKAGE) {
    throw new ReleaseError(`${SPRINT_MANIFEST} at ${sha} names ${JSON.stringify(manifest.name)}, not ${SPRINT_PACKAGE}`);
  }
  const own = manifest.version ?? null;
  const computed = sprintVersion(own ?? "", sha);
  if (computed === null) {
    throw new ReleaseError(
      `${SPRINT_MANIFEST} at ${sha} carries ${JSON.stringify(own)}, and a sprint prerelease is the next patch above a plain X.Y.Z`,
    );
  }
  if (version && version !== computed) {
    throw new ReleaseError(`the version asked for, ${version}, is not the one ${sha} is published as, ${computed}`);
  }
  const base = { name, commit: sha, version: computed, own };
  if (await registry.has("npm", name, computed)) return { ...base, action: "published" };
  return { ...base, action: "publish" };
}

/** The `package.json` an npm tarball carries, read without unpacking it. */
export function tarballManifest(file) {
  const result = spawnSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new ReleaseError(`${file} is not an npm tarball: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

/**
 * Refuse a tarball that is not the package and version the job decided to
 * publish. The tarball is built in a job without publishing rights, so the job
 * that publishes it checks what it carries rather than trusting the build.
 */
export function checkTarball({ file, name, version }) {
  const manifest = tarballManifest(file);
  if (manifest.name !== name || manifest.version !== version) {
    throw new ReleaseError(
      `${path.basename(file)} carries ${manifest.name}@${manifest.version}, and this job publishes ${name}@${version}`,
    );
  }
  return manifest;
}

/** A Python distribution name as PEP 503 normalizes it, for comparing names. */
const normalizedName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The `Name` and `Version` a distribution's core metadata declares. */
function coreMetadata(text) {
  const field = (key) => new RegExp(`^${key}: *(.+)$`, "m").exec(text)?.[1]?.trim() ?? null;
  return { name: field("Name"), version: field("Version") };
}

/**
 * Refuse a directory of Python distributions that is not exactly one sdist and
 * one wheel of the package at the version, by their filenames and by the core
 * metadata inside them (the wheel's `METADATA`, the sdist's `PKG-INFO`). The
 * distributions are built in a job without publishing rights, and PyPI's
 * trusted publisher accepts any version of the project, so the job that
 * uploads checks what it was handed.
 */
export function checkDistributions({ dir, name, version }) {
  const stem = name.replace(/[-.]/g, "_");
  const files = fs.readdirSync(dir).sort();
  const sdist = `${stem}-${version}.tar.gz`;
  const wheelName = new RegExp(`^${stem}-${version.replace(/\./g, "\\.")}-[^-]+-[^-]+-[^-]+\\.whl$`);
  const wheels = files.filter((file) => wheelName.test(file));
  const unexpected = files.filter((file) => file !== sdist && !wheelName.test(file));
  if (!files.includes(sdist) || wheels.length !== 1 || unexpected.length > 0) {
    throw new ReleaseError(
      `the distributions to upload are ${files.join(", ") || "none"}, and the release uploads exactly ${sdist} and one ${stem}-${version} wheel`,
    );
  }
  const read = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new ReleaseError(`${args.at(-2) ?? args[0]}: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const declared = [
    [wheels[0], coreMetadata(read("unzip", ["-p", path.join(dir, wheels[0]), `${stem}-${version}.dist-info/METADATA`]))],
    [sdist, coreMetadata(read("tar", ["-xzOf", path.join(dir, sdist), `${stem}-${version}/PKG-INFO`]))],
  ];
  for (const [file, meta] of declared) {
    if (normalizedName(meta.name ?? "") !== normalizedName(name) || meta.version !== version) {
      throw new ReleaseError(`${file} declares ${meta.name} ${meta.version}, and the release uploads ${name} ${version}`);
    }
  }
  return [...wheels, sdist];
}

/**
 * Write a version into the SDK's `SDK_VERSION` constant, which the client
 * stamps on its user agent: a sprint prerelease takes its own version there as
 * well as in `package.json`. A file without the constant is refused rather
 * than published with a version it does not report.
 */
export function stampSdkVersion({ file, version }) {
  const text = fs.readFileSync(file, "utf8");
  const constant = /export const SDK_VERSION = "[^"]*";/;
  if (!constant.test(text)) throw new ReleaseError(`${file} declares no SDK_VERSION constant to stamp`);
  fs.writeFileSync(file, text.replace(constant, `export const SDK_VERSION = "${version}";`));
}

/** Write a step output, when running inside GitHub Actions. */
export function output(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

/** `--key value` pairs, every key known, every value present (possibly empty). */
export function parseArgs(argv, known) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || !known.includes(key.slice(2)) || i + 1 >= argv.length) return null;
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

const USAGE = `usage:
  node scripts/publish.mjs tag --sha <commit>
  node scripts/publish.mjs check --tag <vX.Y.Z> --package <name>
  node scripts/publish.mjs tarball --file <tgz> --package <name> --version <version>
  node scripts/publish.mjs distributions --dir <dist> --package <name> --version <version>
  node scripts/publish.mjs release --tag <vX.Y.Z>
  node scripts/publish.mjs sprint --sha <commit> --ref <GITHUB_REF> --head <GITHUB_SHA> [--package <name>] [--version <version>]
  node scripts/publish.mjs stamp --file <js/src/version.ts> --version <version>`;

export async function main(argv, { repo = ROOT, registry = liveRegistry(), releases = null } = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === "tag") {
      const args = parseArgs(rest, ["sha"]);
      if (!args?.sha) return usage();
      const plan = applyTag({ repo, plan: planTag({ repo, sha: args.sha }) });
      output({ version: plan.version, tag: plan.tag, commit: plan.commit });
      console.log(
        plan.action === "create"
          ? `Tagged ${plan.commit} ${plan.tag}: every publish and the export build from it.`
          : `${plan.tag} already tags ${plan.commit}, so this run builds from it and publishes only what ${plan.version} still lacks.`,
      );
      return 0;
    }
    if (command === "check") {
      const args = parseArgs(rest, ["tag", "package"]);
      if (!args?.tag || !args.package) return usage();
      const plan = await planPublish({ repo, tag: args.tag, name: args.package, registry, head: repo });
      output({ publish: String(plan.action === "publish"), version: plan.version });
      const said = {
        publish: `${plan.name} ${plan.version} is not published yet: it ships from ${plan.tag} (${plan.commit}).`,
        published: `${plan.name} ${plan.version} is published already, so there is nothing to do for it.`,
        "held-back": `${plan.manifest} carries ${plan.own}, not ${plan.version}: ${plan.name} is held back at this release.`,
      };
      console.log(said[plan.action]);
      return 0;
    }
    if (command === "release") {
      const args = parseArgs(rest, ["tag"]);
      if (!args?.tag) return usage();
      const result = publishRelease({ repo, tag: args.tag, releases: releases ?? liveReleases() });
      console.log(
        result.action === "created" ? `Created the GitHub Release ${result.tag}.` : `The GitHub Release ${result.tag} exists already.`,
      );
      return 0;
    }
    if (command === "sprint") {
      const args = parseArgs(rest, ["sha", "package", "version", "ref", "head"]);
      if (!args?.sha || !args.ref || !args.head) return usage();
      checkDispatch({ repo, ref: args.ref, head: args.head });
      const plan = await planSprint({
        repo,
        sha: args.sha,
        name: args.package || SPRINT_PACKAGE,
        version: args.version ?? "",
        registry,
      });
      output({ publish: String(plan.action === "publish"), version: plan.version, commit: plan.commit });
      console.log(
        plan.action === "publish"
          ? `${plan.name}@${plan.version} is not published yet: it ships from ${plan.commit} on the ${SPRINT_DIST_TAG} dist-tag.`
          : `${plan.name}@${plan.version} is published already, so there is nothing to do.`,
      );
      return 0;
    }
    if (command === "tarball") {
      const args = parseArgs(rest, ["file", "package", "version"]);
      if (!args?.file || !args.package || !args.version) return usage();
      checkTarball({ file: args.file, name: args.package, version: args.version });
      console.log(`${path.basename(args.file)} carries ${args.package}@${args.version}.`);
      return 0;
    }
    if (command === "distributions") {
      const args = parseArgs(rest, ["dir", "package", "version"]);
      if (!args?.dir || !args.package || !args.version) return usage();
      const files = checkDistributions({ dir: args.dir, name: args.package, version: args.version });
      console.log(`${files.join(" and ")} are ${args.package} ${args.version}.`);
      return 0;
    }
    if (command === "stamp") {
      const args = parseArgs(rest, ["file", "version"]);
      if (!args?.file || !args.version) return usage();
      stampSdkVersion({ file: args.file, version: args.version });
      console.log(`${args.file} now reports ${args.version}.`);
      return 0;
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
