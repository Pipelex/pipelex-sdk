// The release workflow's decisions: the tag taken before anything publishes,
// each package's publish guarded on the registry, the GitHub Release, the
// sprint prerelease, and recovery after a failure at each publication
// boundary. Run with `node --test`; nothing here touches the network.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import {
  ReleaseError,
  applyTag,
  changelogEntry,
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

  it("refuses a commit whose manifest is not a plain X.Y.Z", async () => {
    const up = upstream(monorepo({ version: "0.28.1" }));
    const odd = up.commit({ "js/package.json": '{ "name": "@pipelex/sdk", "version": "0.28.1-rc.1" }\n' });
    await assert.rejects(
      planSprint({ repo: checkout(up.origin, "main"), sha: odd, registry: registry() }),
      /next patch above a plain X\.Y\.Z/,
    );
  });

  it("writes the version, the commit and whether to publish", async () => {
    const { ws, sprint } = sprintRepo();
    const result = await cli(["sprint", "--sha", sprint, "--package", "@pipelex/sdk", "--version", ""], {
      repo: ws,
      registry: registry(),
    });
    assert.deepEqual(result, {
      code: 0,
      outputs: { publish: "true", version: `0.28.2-sprint.g${sprint}`, commit: sprint },
    });
  });
});

describe("the live registry", () => {
  const answering = (...statuses) => {
    const asked = [];
    return {
      asked,
      fetchImpl: async (url) => {
        asked.push(url);
        const status = statuses.shift();
        if (status instanceof Error) throw status;
        return { status };
      },
    };
  };

  it("asks npm and PyPI for one version", () => {
    assert.equal(registryUrl("npm", "@pipelex/sdk", "0.29.0"), "https://registry.npmjs.org/@pipelex%2fsdk/0.29.0");
    assert.equal(registryUrl("pypi", "pipelex-sdk", "0.29.0"), "https://pypi.org/pypi/pipelex-sdk/0.29.0/json");
  });

  it("reads 200 as published and 404 as not", async () => {
    assert.equal(await liveRegistry(answering(200)).has("npm", "@pipelex/sdk", "0.29.0"), true);
    assert.equal(await liveRegistry(answering(404)).has("pypi", "pipelex-sdk", "0.29.0"), false);
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
