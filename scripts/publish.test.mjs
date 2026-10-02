// The release workflow's decisions: the tag taken before anything publishes,
// each package's publish guarded on the registry, the GitHub Release, the
// sprint prerelease, and recovery after a failure at each publication
// boundary. Run with `node --test`; nothing here touches the network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import {
  ROOT,
  ReleaseError,
  SPRINT_ENVIRONMENT,
  applyTag,
  changelogEntry,
  checkDispatch,
  checkDistributions,
  checkTarball,
  commitOf,
  git,
  liveRegistry,
  main,
  planPublish,
  planSprint,
  planTag,
  publishRelease,
  registryUrl,
  releaseNotes,
  remoteTagCommit,
  sprintVersion,
  stampSdkVersion,
} from "./publish.mjs";
import { checkout, mirror, monorepo, registry, releases, runRelease, tmp, upstream } from "./release.fixture.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Run the CLI with `$GITHUB_OUTPUT` captured, answering its exit code and outputs. */
async function cli(argv, options) {
  const file = path.join(tmp("output"), "github-output");
  fs.writeFileSync(file, "");
  const saved = process.env.GITHUB_OUTPUT;
  const log = console.log;
  const error = console.error;
  process.env.GITHUB_OUTPUT = file;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await main(argv, options);
    const outputs = Object.fromEntries(
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { code, outputs };
  } finally {
    if (saved === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = saved;
    console.log = log;
    console.error = error;
  }
}

describe("planTag and applyTag", () => {
  it("creates the tag on the pushed commit when the remote has none", () => {
    const { origin, first } = upstream();
    const ws = checkout(origin, first);
    const plan = planTag({ repo: ws, sha: first });
    assert.equal(plan.action, "create");
    assert.equal(plan.tag, "v0.29.0");
    applyTag({ repo: ws, plan });
    assert.equal(remoteTagCommit(ws, "origin", "v0.29.0"), first);
  });

  it("finds the tag already on the commit, which is a re-run", () => {
    const { origin, first } = upstream();
    const ws = checkout(origin, first);
    applyTag({ repo: ws, plan: planTag({ repo: ws, sha: first }) });
    const again = planTag({ repo: checkout(origin, first), sha: first });
    assert.equal(again.action, "exists");
    assert.doesNotThrow(() => applyTag({ repo: ws, plan: again }));
  });

  it("refuses a push whose version is tagged on another commit, and never moves the tag", () => {
    const { origin, first, commit } = upstream();
    const ws = checkout(origin, first);
    applyTag({ repo: ws, plan: planTag({ repo: ws, sha: first }) });
    const later = commit({ "js/src/index.ts": "export const sdk = 2;\n" }, "A push to main without a version bump");
    const plan = planTag({ repo: checkout(origin, later), sha: later });
    assert.equal(plan.action, "elsewhere");
    assert.throws(() => applyTag({ repo: ws, plan }), /already tags .* nothing is tagged again and nothing publishes/);
    assert.equal(remoteTagCommit(ws, "origin", "v0.29.0"), first);
  });

  it("refuses a VERSION that is not a plain X.Y.Z", () => {
    const { origin, first } = upstream(monorepo({ version: "0.29.0-rc.1" }));
    assert.throws(() => planTag({ repo: checkout(origin, first), sha: first }), /not a release version/);
  });

  it("writes the tag, version and commit the later jobs read", async () => {
    const { origin, first } = upstream();
    const { code, outputs } = await cli(["tag", "--sha", first], { repo: checkout(origin, first) });
    assert.equal(code, 0);
    assert.deepEqual(outputs, { version: "0.29.0", tag: "v0.29.0", commit: first });
  });

  it("exits 1 on the refusal, so the run fails and nothing after it runs", async () => {
    const { origin, first, commit } = upstream();
    await cli(["tag", "--sha", first], { repo: checkout(origin, first) });
    const later = commit({ "js/src/index.ts": "export const sdk = 2;\n" });
    const { code, outputs } = await cli(["tag", "--sha", later], { repo: checkout(origin, later) });
    assert.equal(code, 1);
    assert.deepEqual(outputs, {});
  });
});

describe("planPublish", () => {
  async function tagged(files) {
    const { origin, first, commit } = upstream(files);
    const ws = checkout(origin, first);
    applyTag({ repo: ws, plan: planTag({ repo: ws, sha: first }) });
    return { origin, first, commit, ws: checkout(origin, "refs/tags/v0.29.0") };
  }

  it("publishes a package whose manifest carries the version and the registry lacks it", async () => {
    const { ws, first } = await tagged();
    const plan = await planPublish({ repo: ws, tag: "v0.29.0", name: "@pipelex/sdk", registry: registry(), head: ws });
    assert.equal(plan.action, "publish");
    assert.equal(plan.commit, first);
  });

  it("leaves a package the registry has already", async () => {
    const { ws } = await tagged();
    const reg = registry([["pipelex-sdk", "0.29.0"]]);
    const plan = await planPublish({ repo: ws, tag: "v0.29.0", name: "pipelex-sdk", registry: reg, head: ws });
    assert.equal(plan.action, "published");
  });

  it("holds back a package whose manifest carries an earlier version", async () => {
    const { ws } = await tagged(monorepo({ methodApps: "0.5.7" }));
    const plan = await planPublish({
      repo: ws,
      tag: "v0.29.0",
      name: "@pipelex/create-method-app",
      registry: registry(),
      head: ws,
    });
    assert.equal(plan.action, "held-back");
    assert.equal(plan.own, "0.5.7");
  });

  it("refuses a checkout that does not stand on the tag", async () => {
    const { origin, commit } = await tagged();
    const later = commit({ "python/src/pipelex_sdk/__init__.py": "SDK = 2\n" });
    const ws = checkout(origin, later);
    await assert.rejects(
      planPublish({ repo: ws, tag: "v0.29.0", name: "pipelex-sdk", registry: registry(), head: ws }),
      /a release builds from its tag/,
    );
  });

  it("refuses a shipping package with no changelog entry for the version", async () => {
    const files = monorepo();
    files["python/CHANGELOG.md"] = "# Changelog\n\n## [Unreleased]\n";
    const { ws } = await tagged(files);
    await assert.rejects(
      planPublish({ repo: ws, tag: "v0.29.0", name: "pipelex-sdk", registry: registry(), head: ws }),
      /has no "## \[v0\.29\.0\]" entry/,
    );
  });

  it("writes publish=true or false for the job's later steps", async () => {
    const { ws } = await tagged(monorepo({ sdk: "0.28.1" }));
    const shipped = await cli(["check", "--tag", "v0.29.0", "--package", "pipelex-sdk"], { repo: ws, registry: registry() });
    assert.deepEqual(shipped, { code: 0, outputs: { publish: "true", version: "0.29.0" } });
    const held = await cli(["check", "--tag", "v0.29.0", "--package", "@pipelex/sdk"], { repo: ws, registry: registry() });
    assert.deepEqual(held, { code: 0, outputs: { publish: "false", version: "0.29.0" } });
  });
});

describe("the GitHub Release", () => {
  it("carries each shipped unit's changelog entry, and none for a unit held back", () => {
    const { origin, first } = upstream(monorepo({ starterPython: "0.2.1" }));
    const ws = checkout(origin, first);
    applyTag({ repo: ws, plan: planTag({ repo: ws, sha: first }) });
    const notes = releaseNotes({ repo: checkout(origin, "refs/tags/v0.29.0"), tag: "v0.29.0" });
    assert.match(notes, /## `@pipelex\/sdk` on npm\n\n- The JavaScript SDK changed\./);
    assert.match(notes, /- The JavaScript starter changed\./);
    assert.doesNotMatch(notes, /Python starter/);
    assert.doesNotMatch(notes, /The first\./);
  });

  it("is created once, and a re-run finds it", () => {
    const { origin, first } = upstream();
    const ws = checkout(origin, first);
    applyTag({ repo: ws, plan: planTag({ repo: ws, sha: first }) });
    const rel = releases();
    const tagged = checkout(origin, "refs/tags/v0.29.0");
    assert.equal(publishRelease({ repo: tagged, tag: "v0.29.0", releases: rel }).action, "created");
    assert.equal(publishRelease({ repo: tagged, tag: "v0.29.0", releases: rel }).action, "exists");
    assert.equal(rel.created.length, 1);
  });

  it("reads one changelog entry, up to the next heading", () => {
    const text = "## [v0.2.0] - 2026-10-02\n\n- Two.\n\n### Fixed\n\n- A fix.\n\n## [v0.1.0] - 2026-01-01\n\n- One.\n";
    assert.equal(changelogEntry(text, "0.2.0"), "- Two.\n\n### Fixed\n\n- A fix.");
    assert.equal(changelogEntry(text, "0.3.0"), null);
  });
});

describe("the sprint prerelease", () => {
  it("is the next patch above a plain X.Y.Z, with the full SHA", () => {
    assert.equal(sprintVersion("0.28.1", SHA), `0.28.2-sprint.g${SHA}`);
    assert.equal(sprintVersion("1.0.0", SHA), `1.0.1-sprint.g${SHA}`);
    for (const refused of ["0.28.1-rc.1", "0.28", "0.28.01", "v0.28.1", "0.28.1+build", ""]) {
      assert.equal(sprintVersion(refused, SHA), null, refused);
    }
  });

  function sprintRepo() {
    const up = upstream(monorepo({ version: "0.28.1" }));
    const sprint = up.commit({ "js/src/index.ts": "export const sdk = 3;\n" }, "A sprint's change");
    return { ...up, sprint, ws: checkout(up.origin, "main") };
  }

  it("publishes a pushed commit as the version wt pin computes", async () => {
    const { ws, sprint } = sprintRepo();
    const plan = await planSprint({ repo: ws, sha: sprint, version: `0.28.2-sprint.g${sprint}`, registry: registry() });
    assert.equal(plan.action, "publish");
    assert.equal(plan.version, `0.28.2-sprint.g${sprint}`);
  });

  it("does nothing for a prerelease the registry has already", async () => {
    const { ws, sprint } = sprintRepo();
    const reg = registry([["@pipelex/sdk", `0.28.2-sprint.g${sprint}`]]);
    assert.equal((await planSprint({ repo: ws, sha: sprint, registry: reg })).action, "published");
  });

  it("refuses another package, a short SHA, and a version other than the computed one", async () => {
    const { ws, sprint } = sprintRepo();
    const reg = registry();
    await assert.rejects(planSprint({ repo: ws, sha: sprint, name: "pipelex-sdk", registry: reg }), /only @pipelex\/sdk/);
    await assert.rejects(planSprint({ repo: ws, sha: sprint.slice(0, 7), registry: reg }), /not a full commit SHA/);
    await assert.rejects(
      planSprint({ repo: ws, sha: sprint, version: `0.29.0-sprint.g${sprint}`, registry: reg }),
      /is not the one .* is published as/,
    );
  });

  it("refuses a commit no branch of the repository carries", async () => {
    const { ws } = sprintRepo();
    git(ws, ["commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "Only here"]);
    const local = commitOf(ws, "HEAD");
    await assert.rejects(planSprint({ repo: ws, sha: local, registry: registry() }), /on no branch of this repository/);
  });

  it("refuses a commit whose js/package.json names another package", async () => {
    const up = upstream(monorepo({ version: "0.28.1" }));
    const other = up.commit({ "js/package.json": '{ "name": "@pipelex/create-method-app", "version": "0.28.1" }\n' });
    await assert.rejects(
      planSprint({ repo: checkout(up.origin, "main"), sha: other, registry: registry() }),
      /names "@pipelex\/create-method-app", not @pipelex\/sdk/,
    );
  });

  it("refuses a commit whose manifest is not a plain X.Y.Z", async () => {
    const up = upstream(monorepo({ version: "0.28.1" }));
    const odd = up.commit({ "js/package.json": '{ "name": "@pipelex/sdk", "version": "0.28.1-rc.1" }\n' });
    await assert.rejects(
      planSprint({ repo: checkout(up.origin, "main"), sha: odd, registry: registry() }),
      /next patch above a plain X\.Y\.Z/,
    );
  });

  it("is dispatched only from dev, the branch the npm environment allows beside main", () => {
    const { origin, ws, sprint, first } = sprintRepo();
    assert.equal(checkDispatch({ repo: ws, ref: "refs/heads/dev", head: sprint }), "dev");
    assert.throws(
      () => checkDispatch({ repo: ws, ref: "refs/heads/feature/Sprint-work", head: sprint }),
      /from dev alone, not feature\/Sprint-work: the npm environment/,
    );
    assert.throws(() => checkDispatch({ repo: ws, ref: "refs/heads/main", head: sprint }), /never dispatched from main/);
    assert.throws(() => checkDispatch({ repo: ws, ref: "refs/heads/release/v0.29.0", head: sprint }), /never dispatched from release\/v0\.29\.0/);
    assert.throws(() => checkDispatch({ repo: ws, ref: "refs/tags/v0.28.1", head: first }), /is not a branch/);
    // dev fast-forwarded onto a release's merge commit by the landing's back-merge.
    applyTag({ repo: ws, plan: planTag({ repo: ws, sha: first }) });
    const tagged = checkout(origin, "main");
    assert.throws(() => checkDispatch({ repo: tagged, ref: "refs/heads/dev", head: first }), /the release v0\.28\.1/);
  });

  it("writes the version, the commit and whether to publish", async () => {
    const { ws, sprint } = sprintRepo();
    const dispatch = ["--ref", "refs/heads/dev", "--head", sprint];
    const result = await cli(["sprint", "--sha", sprint, "--package", "@pipelex/sdk", "--version", "", ...dispatch], {
      repo: ws,
      registry: registry(),
    });
    assert.deepEqual(result, {
      code: 0,
      outputs: { publish: "true", version: `0.28.2-sprint.g${sprint}`, commit: sprint },
    });
    const refused = await cli(["sprint", "--sha", sprint, "--ref", "refs/heads/main", "--head", sprint], {
      repo: ws,
      registry: registry(),
    });
    assert.deepEqual(refused, { code: 1, outputs: {} });
  });

  it("stamps the prerelease's version on the SDK's own constant", () => {
    const file = path.join(tmp("version"), "version.ts");
    fs.writeFileSync(file, '/** The version. */\nexport const SDK_VERSION = "0.28.1";\n');
    stampSdkVersion({ file, version: `0.28.2-sprint.g${SHA}` });
    assert.equal(fs.readFileSync(file, "utf8"), `/** The version. */\nexport const SDK_VERSION = "0.28.2-sprint.g${SHA}";\n`);
    fs.writeFileSync(file, "export const VERSION = 1;\n");
    assert.throws(() => stampSdkVersion({ file, version: "0.28.2" }), /declares no SDK_VERSION/);
  });
});

describe("checkTarball", () => {
  function tarball(manifest) {
    const dir = tmp("tarball");
    fs.mkdirSync(path.join(dir, "package"));
    fs.writeFileSync(path.join(dir, "package", "package.json"), JSON.stringify(manifest));
    const file = path.join(dir, "pkg.tgz");
    const made = spawnSync("tar", ["-czf", file, "-C", dir, "package"]);
    assert.equal(made.status, 0);
    return file;
  }

  it("accepts the package and version the job decided to publish", () => {
    const file = tarball({ name: "@pipelex/sdk", version: "0.29.0" });
    assert.equal(checkTarball({ file, name: "@pipelex/sdk", version: "0.29.0" }).name, "@pipelex/sdk");
  });

  it("refuses another package or another version", () => {
    const file = tarball({ name: "@pipelex/create-method-app", version: "0.29.0" });
    assert.throws(() => checkTarball({ file, name: "@pipelex/sdk", version: "0.29.0" }), /carries @pipelex\/create-method-app@0\.29\.0/);
    const other = tarball({ name: "@pipelex/sdk", version: "1.0.0" });
    assert.throws(() => checkTarball({ file: other, name: "@pipelex/sdk", version: "0.29.0" }), /carries @pipelex\/sdk@1\.0\.0/);
  });

  it("refuses a file that is not an npm tarball", () => {
    const file = path.join(tmp("tarball"), "not.tgz");
    fs.writeFileSync(file, "not a tarball");
    assert.throws(() => checkTarball({ file, name: "@pipelex/sdk", version: "0.29.0" }), ReleaseError);
  });
});

describe("checkDistributions", () => {
  const metadata = (name, version) => `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n`;
  const run = (command, args, cwd) => assert.equal(spawnSync(command, args, { cwd }).status, 0, `${command} ${args.join(" ")}`);

  /** A dist/ directory with an sdist and a wheel built by hand, declaring the metadata given. */
  function dists({ version = "0.29.0", sdistMeta = metadata("pipelex-sdk", version), wheelMeta = metadata("pipelex-sdk", version), extra = [] } = {}) {
    const root = tmp("dists");
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const stem = `pipelex_sdk-${version}`;
    fs.mkdirSync(path.join(root, stem));
    fs.writeFileSync(path.join(root, stem, "PKG-INFO"), sdistMeta);
    run("tar", ["-czf", path.join(dist, `${stem}.tar.gz`), stem], root);
    fs.mkdirSync(path.join(root, `${stem}.dist-info`));
    fs.writeFileSync(path.join(root, `${stem}.dist-info`, "METADATA"), wheelMeta);
    run("zip", ["-q", "-r", path.join(dist, `${stem}-py3-none-any.whl`), `${stem}.dist-info`], root);
    for (const file of extra) fs.writeFileSync(path.join(dist, file), "");
    return dist;
  }

  it("accepts one sdist and one wheel of the package at the version", () => {
    assert.deepEqual(checkDistributions({ dir: dists(), name: "pipelex-sdk", version: "0.29.0" }), [
      "pipelex_sdk-0.29.0-py3-none-any.whl",
      "pipelex_sdk-0.29.0.tar.gz",
    ]);
  });

  it("refuses distributions of another version, and an extra file", () => {
    assert.throws(
      () => checkDistributions({ dir: dists({ version: "99.0.0" }), name: "pipelex-sdk", version: "0.29.0" }),
      /the release uploads exactly pipelex_sdk-0\.29\.0\.tar\.gz/,
    );
    assert.throws(
      () => checkDistributions({ dir: dists({ extra: ["pipelex_sdk-99.0.0-py3-none-any.whl"] }), name: "pipelex-sdk", version: "0.29.0" }),
      /are pipelex_sdk-0\.29\.0-py3-none-any\.whl, pipelex_sdk-0\.29\.0\.tar\.gz, pipelex_sdk-99\.0\.0/,
    );
  });

  it("refuses a distribution whose metadata declares another version than its name", () => {
    assert.throws(
      () => checkDistributions({ dir: dists({ wheelMeta: metadata("pipelex-sdk", "99.0.0") }), name: "pipelex-sdk", version: "0.29.0" }),
      /declares pipelex-sdk 99\.0\.0/,
    );
    assert.throws(
      () => checkDistributions({ dir: dists({ sdistMeta: metadata("another-package", "0.29.0") }), name: "pipelex-sdk", version: "0.29.0" }),
      /declares another-package 0\.29\.0/,
    );
  });
});

describe("the live registry", () => {
  const answering = (...answers) => {
    const asked = [];
    return {
      asked,
      fetchImpl: async (url) => {
        asked.push(url);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        const { status, body = {} } = typeof answer === "number" ? { status: answer } : answer;
        return { status, json: async () => body };
      },
    };
  };
  const pypiFiles = (...kinds) => ({ status: 200, body: { urls: kinds.map((packagetype) => ({ packagetype })) } });

  it("asks npm and PyPI for one version", () => {
    assert.equal(registryUrl("npm", "@pipelex/sdk", "0.29.0"), "https://registry.npmjs.org/@pipelex%2fsdk/0.29.0");
    assert.equal(registryUrl("pypi", "pipelex-sdk", "0.29.0"), "https://pypi.org/pypi/pipelex-sdk/0.29.0/json");
  });

  it("reads 200 as published and 404 as not", async () => {
    assert.equal(await liveRegistry(answering(200)).has("npm", "@pipelex/sdk", "0.29.0"), true);
    assert.equal(await liveRegistry(answering(404)).has("pypi", "pipelex-sdk", "0.29.0"), false);
  });

  it("reads a PyPI version as published only with both its wheel and its sdist", async () => {
    const has = (...kinds) => liveRegistry(answering(pypiFiles(...kinds))).has("pypi", "pipelex-sdk", "0.29.0");
    assert.equal(await has("bdist_wheel", "sdist"), true);
    assert.equal(await has("bdist_wheel"), false, "an upload that stopped after the wheel still publishes");
    assert.equal(await has("sdist"), false);
  });

  it("retries an unreadable answer, then refuses rather than guess", async () => {
    const recovering = answering(503, new Error("socket hang up"), 404);
    assert.equal(await liveRegistry({ ...recovering, pauseMs: 0 }).has("npm", "@pipelex/sdk", "0.29.0"), false);
    assert.equal(recovering.asked.length, 3);
    const down = answering(500, 500, 500);
    await assert.rejects(liveRegistry({ ...down, pauseMs: 0 }).has("npm", "@pipelex/sdk", "0.29.0"), ReleaseError);
  });
});

describe("recovery at each publication boundary", () => {
  // The starters pin SDK versions already on the registries, as a lockfile must.
  const seeded = () =>
    registry([
      ["@pipelex/sdk", "0.28.1"],
      ["pipelex-sdk", "0.16.0"],
    ]);
  const mirrors = () => ({ "starter-js": mirror(), "starter-python": mirror() });
  const urls = (m) => ({ "starter-js": m["starter-js"].url, "starter-python": m["starter-python"].url });
  const count = (reg, name) => reg.log.filter((entry) => entry.name === name).length;

  it("after npm published and PyPI failed, a re-run publishes PyPI alone, from the tag", async () => {
    const { origin, first, commit } = upstream();
    const reg = seeded();
    const rel = releases();
    const m = mirrors();

    const failed = await runRelease({ origin, sha: first, registry: reg, releases: rel, urls: urls(m), fail: ["pipelex-sdk"] });
    assert.equal(failed["@pipelex/sdk"], "success");
    assert.equal(failed["@pipelex/create-method-app"], "success");
    assert.equal(failed["pipelex-sdk"], "failure");
    assert.equal(failed.release, undefined, "no GitHub Release while a publish failed");
    assert.equal(failed.export, undefined, "no export while a publish failed");
    assert.deepEqual(
      reg.log.map((entry) => entry.name),
      ["@pipelex/sdk", "@pipelex/create-method-app"],
    );

    // main moves on with the same version before the re-run: the re-run must not build from it.
    const moved = commit({ "python/src/pipelex_sdk/__init__.py": "SDK = 2\n" }, "A later push carrying the same version");

    const rerun = await runRelease({ origin, sha: first, registry: reg, releases: rel, urls: urls(m) });
    assert.equal(rerun.tag, "success");
    assert.equal(count(reg, "@pipelex/sdk"), 1, "npm is not published again");
    assert.equal(count(reg, "@pipelex/create-method-app"), 1, "npm is not published again");
    assert.deepEqual(reg.log.at(-1), { name: "pipelex-sdk", version: "0.29.0", commit: first });
    assert.notEqual(reg.log.at(-1).commit, moved);
    assert.equal(rel.created.length, 1);
    assert.equal(rerun.export, "success");

    // That later push is refused at the tag, and publishes nothing.
    const pushed = await runRelease({ origin, sha: moved, registry: reg, releases: rel, urls: urls(m) });
    assert.equal(pushed.tag, "failure");
    assert.match(pushed.error, /already tags/);
    assert.equal(reg.log.length, 3);
  });

  it("after every publish and a failed export, a re-run only exports", async () => {
    const { origin, first } = upstream();
    const reg = seeded();
    const rel = releases();
    const m = mirrors();
    const before = { js: m["starter-js"].main(), python: m["starter-python"].main() };
    m["starter-python"].reject(true);

    const failed = await runRelease({ origin, sha: first, registry: reg, releases: rel, urls: urls(m) });
    assert.equal(failed.export, "failure");
    assert.deepEqual(
      failed.exported.map(({ dir, status }) => [dir, status]),
      [
        ["starter-js", "exported"],
        ["starter-python", "failed"],
      ],
    );
    assert.equal(reg.log.length, 3);
    assert.equal(rel.created.length, 1);
    assert.equal(m["starter-python"].main(), before.python);
    const exportedJs = m["starter-js"].main();

    m["starter-python"].reject(false);
    const rerun = await runRelease({ origin, sha: first, registry: reg, releases: rel, urls: urls(m) });
    assert.equal(rerun.export, "success");
    assert.equal(reg.log.length, 3, "nothing is published again");
    assert.equal(rel.created.length, 1, "the GitHub Release is not created again");
    assert.deepEqual(
      rerun.exported.map(({ dir, status }) => [dir, status]),
      [
        ["starter-js", "skipped"],
        ["starter-python", "exported"],
      ],
    );
    assert.equal(m["starter-js"].main(), exportedJs, "the exported mirror is left as it was");
    assert.equal(commitOf(m["starter-python"].url, "refs/heads/main^"), before.python);
    const tree = git(checkout(origin, "refs/tags/v0.29.0"), ["rev-parse", "HEAD:starter-python"]).trim();
    assert.equal(m["starter-python"].tree("refs/heads/main"), tree);
  });
});

describe("the environments the trusted publishers name", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");

  /** Each job of `release.yml`, by its id, as the text of its block. */
  function releaseJobs() {
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
    const blocks = jobs.split(/^(?=  [\w-]+:\n)/m).slice(1);
    return new Map(blocks.map((block) => [block.match(/^  ([\w-]+):/)[1], block]));
  }

  // A job takes the workflow's permissions unless it sets its own, and `write-all` grants the
  // id-token too, so the literal `id-token: write` below is the only way a job can hold it only
  // while the workflow grants nothing and every job writes its permissions out as a mapping.
  it("grants nothing at the workflow's level, and every job writes out its own permissions", () => {
    assert.match(workflow.slice(0, workflow.indexOf("\njobs:\n")), /^permissions: \{\}$/m);
    for (const [id, block] of releaseJobs()) {
      assert.match(block, /^    permissions:\n      [\w-]+: (read|write|none)$/m, `${id} sets its permissions as a mapping`);
    }
  });

  it("holds an environment on exactly the jobs that can mint the publishers' id-token", () => {
    const held = [...releaseJobs()].map(([id, block]) => {
      const environment = block.match(/^    environment:(?: (\S+)|\n      name: (\S+))$/m);
      return [id, /^      id-token: write$/m.test(block), environment ? (environment[1] ?? environment[2]) : null];
    });
    assert.deepEqual(
      held.filter(([, idToken, environment]) => idToken || environment !== null),
      [
        ["npm-sdk-publish", true, SPRINT_ENVIRONMENT],
        ["npm-initializer-publish", true, SPRINT_ENVIRONMENT],
        ["pypi-publish", true, "pypi"],
        ["sprint-publish", true, SPRINT_ENVIRONMENT],
      ],
    );
  });
});
