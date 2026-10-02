// What the release scripts' tests stand on: throwaway git repositories shaped
// like this one, a remote that plays GitHub, mirrors that play the template
// repositories, and registries and GitHub Releases faked in memory. Nothing
// here touches the network. Not a test file itself: `node --test` runs only
// `*.test.mjs`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after } from "node:test";

import { exportAll } from "./export.mjs";
import { PACKAGES, applyTag, commitOf, git, planPublish, planTag, publishRelease } from "./publish.mjs";

// Every git run in the tests, the scripts' own included, ignores the machine's
// configuration (a global hooks path, commit signing, a default branch name),
// and commits under one fixed identity.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Release Test",
  GIT_AUTHOR_EMAIL: "release-test@example.com",
  GIT_COMMITTER_NAME: "Release Test",
  GIT_COMMITTER_EMAIL: "release-test@example.com",
});

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the test file. */
export function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  dirs.push(dir);
  return dir;
}

function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    if (text === null) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const changelog = (version, line) => `# Changelog\n\n## [Unreleased]\n\n## [v${version}] - 2026-10-02\n\n- ${line}\n\n## [v0.0.1] - 2026-01-01\n\n- The first.\n`;
const pyproject = (name, version) => `[project]\nname = "${name}"\nversion = "${version}"\n`;
const npmLock = (version) =>
  json({
    name: "pipelex-starter-js",
    lockfileVersion: 3,
    packages: {
      "": { name: "pipelex-starter-js" },
      "node_modules/@pipelex/sdk": {
        version,
        resolved: `https://registry.npmjs.org/@pipelex/sdk/-/sdk-${version}.tgz`,
      },
    },
  });
const uvLock = (version) =>
  `version = 1\n\n[[package]]\nname = "httpx"\nversion = "0.28.1"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "pipelex-sdk"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "widget"\nversion = "0.2.1"\nsource = { editable = "." }\n`;

/**
 * The files of a repository shaped like this one, every package at `version`
 * unless an override holds it back, each starter's lockfile pinning the SDK
 * versions given.
 */
export function monorepo({
  version = "0.29.0",
  sdk = version,
  python = version,
  methodApps = version,
  starterJs = version,
  starterPython = version,
  lockedJs = "0.28.1",
  lockedPython = "0.16.0",
} = {}) {
  return {
    VERSION: `${version}\n`,
    "js/package.json": json({ name: "@pipelex/sdk", version: sdk }),
    "js/CHANGELOG.md": changelog(sdk, "The JavaScript SDK changed."),
    "js/src/index.ts": "export const sdk = 1;\n",
    "python/pyproject.toml": pyproject("pipelex-sdk", python),
    "python/CHANGELOG.md": changelog(python, "The Python SDK changed."),
    "python/src/pipelex_sdk/__init__.py": "SDK = 1\n",
    "method-apps/initializers/js/package.json": json({ name: "@pipelex/create-method-app", version: methodApps }),
    "method-apps/webapp-js/package.json": json({ name: "method-app-webapp-js", version: methodApps }),
    "method-apps/CHANGELOG.md": changelog(methodApps, "The method apps changed."),
    "starter-js/package.json": json({ name: "pipelex-starter-js", version: starterJs }),
    "starter-js/package-lock.json": npmLock(lockedJs),
    "starter-js/CHANGELOG.md": changelog(starterJs, "The JavaScript starter changed."),
    "starter-js/src/page.tsx": "export default function Page() { return null; }\n",
    "starter-python/pyproject.toml": pyproject("widget", starterPython),
    "starter-python/uv.lock": uvLock(lockedPython),
    "starter-python/CHANGELOG.md": changelog(starterPython, "The Python starter changed."),
    "starter-python/widget/main.py": "print('widget')\n",
  };
}

/**
 * A remote playing GitHub's copy of this repository, with a working clone that
 * pushes to it. `commit(files)` writes, commits and pushes `main`, answering
 * the new commit.
 */
export function upstream(files = monorepo()) {
  const origin = path.join(tmp("origin"), "pipelex-sdk.git");
  git(path.dirname(origin), ["init", "--quiet", "--bare", "-b", "main", origin]);
  const work = tmp("work");
  git(work, ["init", "--quiet", "-b", "main"]);
  git(work, ["remote", "add", "origin", origin]);
  const commit = (changes, message = "A change") => {
    write(work, changes);
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "--no-gpg-sign", "-m", message]);
    git(work, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    return commitOf(work, "HEAD");
  };
  const first = commit(files, "The release");
  return { origin, work, commit, first };
}

/**
 * What `actions/checkout` hands a job with `fetch-depth: 0`: a clone of the
 * remote with every branch and tag, standing detached on `ref`.
 */
export function checkout(origin, ref) {
  const dir = tmp("checkout");
  git(dir, ["clone", "--quiet", origin, "."]);
  git(dir, ["checkout", "--quiet", "--detach", ref]);
  return dir;
}

/**
 * A template repository playing a mirror, holding a history of its own on
 * `main`, as both starters' repositories did before their first export.
 * `reject(true)` makes it refuse every push, the way a push can fail mid-release.
 */
export function mirror(files = { "README.md": "The template's own history.\n" }) {
  const bare = path.join(tmp("mirror"), "mirror.git");
  git(path.dirname(bare), ["init", "--quiet", "--bare", "-b", "main", bare]);
  if (files !== null) {
    const seed = tmp("mirror-seed");
    git(seed, ["init", "--quiet", "-b", "main"]);
    write(seed, files);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "--quiet", "--no-gpg-sign", "-m", "The template's own history"]);
    git(seed, ["push", "--quiet", bare, "HEAD:refs/heads/main"]);
  }
  const hook = path.join(bare, "hooks", "pre-receive");
  fs.writeFileSync(hook, '#!/bin/sh\nif [ -f reject-pushes ]; then echo "this mirror refuses pushes for the test" >&2; exit 1; fi\n');
  fs.chmodSync(hook, 0o755);
  const marker = path.join(bare, "reject-pushes");
  return {
    url: bare,
    reject(on) {
      if (on) fs.writeFileSync(marker, "");
      else fs.rmSync(marker, { force: true });
    },
    main: () => commitOf(bare, "refs/heads/main"),
    tag: (tag) => commitOf(bare, `refs/tags/${tag}`),
    tree: (ref) => git(bare, ["rev-parse", `${ref}^{tree}`]).trim(),
  };
}

/**
 * npm and PyPI in memory: the versions they serve, seeded or published, and a
 * log of every publish with the commit it was built from.
 */
export function registry(seed = []) {
  const served = new Set(seed.map(([name, version]) => `${name}@${version}`));
  const log = [];
  return {
    log,
    async has(_registry, name, version) {
      return served.has(`${name}@${version}`);
    },
    publish({ name, version, commit }) {
      if (served.has(`${name}@${version}`)) throw new Error(`${name}@${version} is published already`);
      served.add(`${name}@${version}`);
      log.push({ name, version, commit });
    },
  };
}

/** GitHub Releases in memory. */
export function releases() {
  const created = [];
  return {
    created,
    exists: (tag) => created.some((each) => each.tag === tag),
    create(tag, notes) {
      created.push({ tag, notes });
    },
  };
}

const FAILED = new Set(["mismatch", "unresolved", "failed"]);

/**
 * One run of `.github/workflows/release.yml` on a push to `main` at `sha`,
 * job by job, each job in its own fresh checkout as on GitHub, gated the way
 * the workflow's `needs` and `if` gate them: the publishes after the tag, the
 * GitHub Release only when no publish failed, the export only after the
 * Release. Building is not simulated; a publish records the commit its
 * checkout stands on. `fail` names packages whose upload the registry refuses.
 * Answers each job's result.
 */
export async function runRelease({ origin, sha, registry: reg, releases: rel, urls, fail = [] }) {
  const jobs = {};
  let tag;
  try {
    const ws = checkout(origin, sha);
    ({ tag } = applyTag({ repo: ws, plan: planTag({ repo: ws, sha }) }));
    jobs.tag = "success";
  } catch (error) {
    return { tag: "failure", error: error.message };
  }
  for (const { name } of PACKAGES) {
    try {
      const ws = checkout(origin, `refs/tags/${tag}`);
      const plan = await planPublish({ repo: ws, tag, name, registry: reg, head: ws });
      if (plan.action === "publish") {
        if (fail.includes(name)) throw new Error(`the registry refused ${name}`);
        reg.publish({ name, version: plan.version, commit: commitOf(ws, "HEAD") });
      }
      jobs[name] = "success";
    } catch {
      jobs[name] = "failure";
    }
  }
  if (PACKAGES.some(({ name }) => jobs[name] === "failure")) return jobs;
  publishRelease({ repo: checkout(origin, `refs/tags/${tag}`), tag, releases: rel });
  jobs.release = "success";
  jobs.exported = await exportAll({ repo: checkout(origin, `refs/tags/${tag}`), tag, registry: reg, urls });
  jobs.export = jobs.exported.some(({ status }) => FAILED.has(status)) ? "failure" : "success";
  return jobs;
}
