// The starters' export to their template repositories, against local bare
// repositories playing the mirrors, with the registry faked: a fresh export, a
// re-run that skips, a mirror whose tag holds another tree, a pin the registry
// does not serve, a starter held back, and the scheduled comparison. Run with
// `node --test`; nothing here touches the network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STARTERS, checkMirror, exportAll, exportStarter, lockedSdk, main, planExport } from "./export.mjs";
import { applyTag, commitOf, git, planTag } from "./publish.mjs";
import { checkout, mirror, monorepo, registry, upstream } from "./release.fixture.mjs";

const [starterJs, starterPython] = STARTERS;
const served = () =>
  registry([
    ["@pipelex/sdk", "0.28.1"],
    ["pipelex-sdk", "0.16.0"],
  ]);

/** A repository whose main is released as v0.29.0, and a checkout of the tag, as the export job has. */
function released(files = monorepo()) {
  const up = upstream(files);
  const ws = checkout(up.origin, up.first);
  applyTag({ repo: ws, plan: planTag({ repo: ws, sha: up.first }) });
  const repo = checkout(up.origin, "refs/tags/v0.29.0");
  const tree = (dir) => git(repo, ["rev-parse", `HEAD:${dir}`]).trim();
  return { ...up, repo, tree };
}

describe("exportStarter", () => {
  it("adds one commit on the mirror's main whose tree is the directory, and pushes the tag", async () => {
    const { repo, tree, first } = released();
    const m = mirror();
    const history = m.main();
    const result = await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: m.url, registry: served() });
    assert.equal(result.status, "exported");
    assert.equal(m.tree("refs/heads/main"), tree("starter-js"));
    assert.equal(m.tag("v0.29.0"), m.main());
    assert.equal(commitOf(m.url, "refs/heads/main^"), history, "a fast-forward onto the mirror's own history");
    const message = git(m.url, ["log", "-1", "--format=%B", "refs/heads/main"]).trim();
    assert.equal(message, `Release v0.29.0, from Pipelex/pipelex-sdk@${first}`);
  });

  it("exports onto an empty mirror as its first commit", async () => {
    const { repo, tree } = released();
    const m = mirror(null);
    const result = await exportStarter({ repo, tag: "v0.29.0", starter: starterPython, url: m.url, registry: served() });
    assert.equal(result.status, "exported");
    assert.equal(m.tree("refs/heads/main"), tree("starter-python"));
    assert.equal(git(m.url, ["rev-list", "--count", "refs/heads/main"]).trim(), "1");
  });

  it("skips a mirror whose tag already holds the directory's tree", async () => {
    const { repo } = released();
    const m = mirror();
    await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: m.url, registry: served() });
    const exported = m.main();
    const again = await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: m.url, registry: served() });
    assert.equal(again.status, "skipped");
    assert.equal(m.main(), exported);
  });

  it("fails loudly on a mirror whose tag holds another tree, and pushes nothing", async () => {
    const { repo } = released();
    const m = mirror();
    git(m.url, ["tag", "v0.29.0", "refs/heads/main"]);
    const history = m.main();
    const result = await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: m.url, registry: served() });
    assert.equal(result.status, "mismatch");
    assert.match(result.message, /the mirror's tag is not this release's, and nothing was pushed/);
    assert.equal(m.main(), history);
  });

  it("refuses a starter whose pinned SDK the registry does not serve, and pushes nothing", async () => {
    const { repo } = released(monorepo({ lockedJs: "0.29.0" }));
    const m = mirror();
    const history = m.main();
    const result = await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: m.url, registry: served() });
    assert.equal(result.status, "unresolved");
    assert.match(result.message, /pins @pipelex\/sdk 0\.29\.0, which npm does not serve/);
    assert.equal(m.main(), history);
    assert.equal(m.tag("v0.29.0"), null);
  });
});

describe("an export re-run after a later release", () => {
  it("leaves a mirror that holds a later release, rather than put the older starter back", async () => {
    const up = upstream(monorepo());
    const first = checkout(up.origin, up.first);
    applyTag({ repo: first, plan: planTag({ repo: first, sha: up.first }) });
    const m = mirror();
    m.reject(true);
    const older = await exportStarter({
      repo: checkout(up.origin, "refs/tags/v0.29.0"),
      tag: "v0.29.0",
      starter: starterJs,
      url: m.url,
      registry: served(),
    }).catch((error) => ({ status: "failed", message: error.message }));
    assert.equal(older.status, "failed");
    m.reject(false);

    const next = up.commit(monorepo({ version: "0.30.0" }), "The next release");
    const second = checkout(up.origin, next);
    applyTag({ repo: second, plan: planTag({ repo: second, sha: next }) });
    const newer = await exportStarter({
      repo: checkout(up.origin, "refs/tags/v0.30.0"),
      tag: "v0.30.0",
      starter: starterJs,
      url: m.url,
      registry: served(),
    });
    assert.equal(newer.status, "exported");
    const exported = m.main();

    const rerun = await exportStarter({
      repo: checkout(up.origin, "refs/tags/v0.29.0"),
      tag: "v0.29.0",
      starter: starterJs,
      url: m.url,
      registry: served(),
    });
    assert.equal(rerun.status, "superseded");
    assert.match(rerun.message, /already holds the later release v0\.30\.0/);
    assert.equal(m.main(), exported);
    assert.equal(m.tag("v0.29.0"), null);
  });
});

describe("exportAll", () => {
  it("exports the starters that carry the release's version and holds back the others", async () => {
    const { repo, tree } = released(monorepo({ starterPython: "0.2.1" }));
    const js = mirror();
    const python = mirror();
    const history = python.main();
    assert.deepEqual(
      planExport({ repo, tag: "v0.29.0" }).map(({ starter, ships }) => [starter.dir, ships]),
      [
        ["starter-js", true],
        ["starter-python", false],
      ],
    );
    const results = await exportAll({
      repo,
      tag: "v0.29.0",
      registry: served(),
      urls: { "starter-js": js.url, "starter-python": python.url },
    });
    assert.deepEqual(
      results.map(({ dir, status }) => [dir, status]),
      [
        ["starter-js", "exported"],
        ["starter-python", "held-back"],
      ],
    );
    assert.equal(js.tree("refs/heads/main"), tree("starter-js"));
    assert.equal(python.main(), history);
  });

  it("goes on to the next mirror when one fails, and reports the failure", async () => {
    const { repo } = released();
    const js = mirror();
    const python = mirror();
    js.reject(true);
    const results = await exportAll({
      repo,
      tag: "v0.29.0",
      registry: served(),
      urls: { "starter-js": js.url, "starter-python": python.url },
    });
    assert.deepEqual(
      results.map(({ dir, status }) => [dir, status]),
      [
        ["starter-js", "failed"],
        ["starter-python", "exported"],
      ],
    );
  });

  it("exits 1 from the command line when a mirror is not as it should be", async () => {
    const { repo } = released();
    const js = mirror();
    git(js.url, ["tag", "v0.29.0", "refs/heads/main"]);
    const python = mirror();
    const quiet = console.log;
    console.log = () => {};
    try {
      const code = await main(
        ["export", "--tag", "v0.29.0", "--mirror", `starter-js=${js.url}`, "--mirror", `starter-python=${python.url}`],
        { repo, registry: served() },
      );
      assert.equal(code, 1);
    } finally {
      console.log = quiet;
    }
  });
});

describe("lockedSdk", () => {
  it("reads the SDK version each starter's lockfile pins", () => {
    const { repo } = released();
    assert.deepEqual(lockedSdk(repo, "HEAD", starterJs), { name: "@pipelex/sdk", registry: "npm", version: "0.28.1" });
    assert.deepEqual(lockedSdk(repo, "HEAD", starterPython), { name: "pipelex-sdk", registry: "pypi", version: "0.16.0" });
  });

  it("refuses an SDK the lockfile takes from somewhere other than the registry", () => {
    const files = monorepo();
    files["starter-js/package-lock.json"] = files["starter-js/package-lock.json"].replace(
      /"resolved": "[^"]+"/,
      '"resolved": "git+ssh://git@github.com/Pipelex/pipelex-sdk.git#0123456"',
    );
    files["starter-python/uv.lock"] = files["starter-python/uv.lock"].replace(
      /name = "pipelex-sdk"\nversion = "0.16.0"\nsource = \{ registry = "https:\/\/pypi.org\/simple" \}/,
      'name = "pipelex-sdk"\nversion = "0.16.0"\nsource = { git = "https://github.com/Pipelex/pipelex-sdk.git?subdirectory=python#0123456" }',
    );
    const { repo } = released(files);
    assert.throws(() => lockedSdk(repo, "HEAD", starterJs), /not from the npm registry/);
    assert.throws(() => lockedSdk(repo, "HEAD", starterPython), /does not take pipelex-sdk from https:\/\/pypi\.org\/simple/);
  });
});

describe("checkMirror, the scheduled comparison", () => {
  it("does not alarm before a starter's first export from here", () => {
    // The starters arrived at 0.6.3 and 0.2.1, versions this repository never tagged.
    const { repo } = released(monorepo({ starterJs: "0.6.3", starterPython: "0.2.1" }));
    const result = checkMirror({ repo, starter: starterJs, url: mirror().url });
    assert.equal(result.status, "not-exported");
    assert.match(result.message, /has not been exported from here yet/);
  });

  it("matches a mirror whose main holds the starter's directory at its own tag", async () => {
    const { repo } = released();
    const m = mirror();
    await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: m.url, registry: served() });
    assert.equal(checkMirror({ repo, starter: starterJs, url: m.url }).status, "match");
  });

  it("compares a starter held back at a later release with the release it last shipped in", async () => {
    const up = upstream(monorepo());
    const first = checkout(up.origin, up.first);
    applyTag({ repo: first, plan: planTag({ repo: first, sha: up.first }) });
    const m = mirror();
    await exportStarter({
      repo: checkout(up.origin, "refs/tags/v0.29.0"),
      tag: "v0.29.0",
      starter: starterJs,
      url: m.url,
      registry: served(),
    });
    // v0.30.0 ships the SDK alone; the starter keeps 0.29.0, and its mirror keeps v0.29.0's tree.
    const next = up.commit(monorepo({ version: "0.30.0", starterJs: "0.29.0" }), "The next release");
    const second = checkout(up.origin, next);
    applyTag({ repo: second, plan: planTag({ repo: second, sha: next }) });
    assert.equal(checkMirror({ repo: checkout(up.origin, "main"), starter: starterJs, url: m.url }).status, "match");
  });

  it("reports drift when the mirror changed after its export", async () => {
    const { repo } = released();
    const m = mirror();
    await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: m.url, registry: served() });
    const hand = checkout(m.url, "main");
    git(hand, ["rm", "--quiet", "-r", "src"]);
    git(hand, ["commit", "--quiet", "--no-gpg-sign", "-m", "A push made by hand"]);
    git(hand, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    const result = checkMirror({ repo, starter: starterJs, url: m.url });
    assert.equal(result.status, "drift");
    assert.match(result.message, /the mirror changed after its export, or its export did not finish/);
  });

  it("exits 0 from the command line with a mirror not exported yet, and 1 on drift", async () => {
    const { repo } = released(monorepo({ starterPython: "0.2.1" }));
    const js = mirror();
    const python = mirror();
    const urls = ["--mirror", `starter-js=${js.url}`, "--mirror", `starter-python=${python.url}`];
    const quiet = console.log;
    console.log = () => {};
    try {
      // starter-js ships at v0.29.0 but its mirror was never exported: drift.
      assert.equal(await main(["check", ...urls], { repo }), 1);
      await exportStarter({ repo, tag: "v0.29.0", starter: starterJs, url: js.url, registry: served() });
      assert.equal(await main(["check", ...urls], { repo }), 0);
    } finally {
      console.log = quiet;
    }
  });
});
