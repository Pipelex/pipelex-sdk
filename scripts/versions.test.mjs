// The repository's one version: what the check reads, what it accepts, and
// what it refuses. Run with `node --test` — the root has no dependencies.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  ROOT,
  VersionError,
  checkVersions,
  compareVersions,
  parseUnit,
  pyprojectVersion,
  rootVersion,
} from "./versions.mjs";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway repository: a VERSION file, unless it is null, and the files given. */
function repository(version, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-version-"));
  roots.push(root);
  if (version !== null) fs.writeFileSync(path.join(root, "VERSION"), version);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const pkg = (version) => `${JSON.stringify({ name: "x", version }, null, 2)}\n`;
const pyproject = (version) =>
  `[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "x"\nversion = "${version}"\n`;
const kinds = (result) => result.problems.map((problem) => problem.kind);

describe("checkVersions", () => {
  it("accepts manifests that all carry VERSION", () => {
    const root = repository("0.2.0\n", {
      "a-js/package.json": pkg("0.2.0"),
      "b-python/pyproject.toml": pyproject("0.2.0"),
    });
    assert.deepEqual(checkVersions(root, ["a-js", "b-python"]).problems, []);
  });

  it("accepts a manifest held back below VERSION", () => {
    const root = repository("0.28.1\n", {
      "a-js/package.json": pkg("0.28.1"),
      "b-python/pyproject.toml": pyproject("0.16.0"),
      "c-js/package.json": pkg("0.28.1-rc.1"),
    });
    assert.deepEqual(checkVersions(root, ["a-js", "b-python", "c-js"]).problems, []);
  });

  it("refuses a manifest above VERSION, naming it", () => {
    const root = repository("0.2.0\n", {
      "a-js/package.json": pkg("0.2.0"),
      "b-python/pyproject.toml": pyproject("0.10.0"),
    });
    const { problems } = checkVersions(root, ["a-js", "b-python"]);
    assert.deepEqual(
      problems.map((problem) => problem.kind),
      ["above"],
    );
    assert.match(problems[0].message, /^b-python\/pyproject\.toml carries 0\.10\.0, above/);
  });

  it("refuses a manifest with no version, or one that is not a version", () => {
    const root = repository("0.2.0\n", {
      "a-js/package.json": `${JSON.stringify({ name: "x" })}\n`,
      "b-js/package.json": pkg("v0.1.0"),
    });
    assert.deepEqual(kinds(checkVersions(root, ["a-js", "b-js"])), ["no-version", "no-version"]);
  });

  it("refuses a missing or malformed VERSION, and a unit with no manifest", () => {
    assert.throws(() => rootVersion(repository(null, {})), VersionError);
    assert.throws(() => rootVersion(repository("v0.2.0\n", {})), VersionError);
    assert.throws(
      () => checkVersions(repository("0.2.0\n", { "a-js/README.md": "" }), ["a-js"]),
      VersionError,
    );
    assert.throws(() => checkVersions(repository("0.2.0\n", {}), ["a-js"]), VersionError);
  });

  it("holds the manifests of one unit to one version", () => {
    const files = {
      "apps/web-js/package.json": pkg("0.1.0"),
      "apps/init/js/package.json": pkg("0.1.0"),
    };
    const unit = "apps:web-js,init/js";
    assert.deepEqual(checkVersions(repository("0.2.0\n", files), [unit]).problems, []);
    const split = repository("0.2.0\n", { ...files, "apps/init/js/package.json": pkg("0.2.0") });
    const { problems } = checkVersions(split, [unit]);
    assert.deepEqual(
      problems.map((problem) => problem.kind),
      ["split"],
    );
    assert.match(problems[0].message, /apps\/web-js\/package\.json carries 0\.1\.0/);
  });
});

describe("checkVersions --release", () => {
  const changelog = (version) => `# Changelog\n\n## [v${version}] - 2026-10-01\n\n- A change.\n`;

  it("accepts a release whose shipped units each have their changelog entry", () => {
    const root = repository("0.3.0\n", {
      "a-js/package.json": pkg("0.3.0"),
      "a-js/CHANGELOG.md": changelog("0.3.0"),
      "apps/web-js/package.json": pkg("0.3.0"),
      "apps/init/js/package.json": pkg("0.3.0"),
      "apps/CHANGELOG.md": changelog("0.3.0"),
      "b-python/pyproject.toml": pyproject("0.2.0"),
    });
    const result = checkVersions(root, ["a-js", "apps:web-js,init/js", "b-python"], {
      release: true,
    });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.shipped, ["a-js", "apps"]);
  });

  it("refuses a release that ships nothing", () => {
    const root = repository("0.3.0\n", { "a-js/package.json": pkg("0.2.0") });
    assert.deepEqual(checkVersions(root, ["a-js"]).problems, []);
    assert.deepEqual(kinds(checkVersions(root, ["a-js"], { release: true })), ["nothing-shipped"]);
  });

  it("refuses a shipped unit whose changelog lacks the release's heading, or is missing", () => {
    const root = repository("0.3.0\n", {
      "a-js/package.json": pkg("0.3.0"),
      "a-js/CHANGELOG.md": `${changelog("0.2.0")}\n## [v0.3.0-rc.1]\n`,
      "b-js/package.json": pkg("0.3.0"),
      "c-js/package.json": pkg("0.2.0"),
    });
    const { problems } = checkVersions(root, ["a-js", "b-js", "c-js"], { release: true });
    assert.deepEqual(
      problems.map((problem) => problem.message),
      [
        'a-js ships at 0.3.0, and a-js/CHANGELOG.md has no "## [v0.3.0]" heading.',
        "b-js ships at 0.3.0, and b-js/CHANGELOG.md is missing.",
      ],
    );
  });
});

describe("compareVersions", () => {
  it("orders numbers as numbers, and a prerelease below its release", () => {
    const ordered = [
      "0.2.0",
      "0.10.0-alpha",
      "0.10.0-alpha.1",
      "0.10.0-alpha.beta",
      "0.10.0-beta.2",
      "0.10.0-beta.11",
      "0.10.0-rc.1",
      "0.10.0",
      "0.10.1",
      "1.0.0",
    ];
    for (const [i, a] of ordered.entries()) {
      for (const [j, b] of ordered.entries()) {
        assert.equal(compareVersions(a, b), Math.sign(i - j), `${a} against ${b}`);
      }
    }
  });
});

describe("parseUnit", () => {
  it("reads a directory, or a directory with the manifests it ships as one", () => {
    assert.deepEqual(parseUnit("js"), { name: "js", dir: "js", manifests: ["js"] });
    assert.deepEqual(parseUnit("method-apps:webapp-js,initializers/js"), {
      name: "method-apps",
      dir: "method-apps",
      manifests: ["method-apps/webapp-js", "method-apps/initializers/js"],
    });
    for (const bad of ["", ":a", "a:", "a:b,", "a:b:c"]) {
      assert.throws(() => parseUnit(bad), VersionError, bad);
    }
  });
});

describe("pyprojectVersion", () => {
  it("reads the [project] table's version and nothing else", () => {
    assert.equal(
      pyprojectVersion('[tool.x]\nversion = "9.9.9"\n\n[project]\nversion = "0.2.0"\n'),
      "0.2.0",
    );
    assert.equal(pyprojectVersion('[tool.x]\nversion = "9.9.9"\n'), null);
  });
});

describe("this repository", () => {
  it("holds every unit of the root Makefile at or below VERSION, each carrying one version", () => {
    const makefile = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const units = /^UNITS := (.+)$/m.exec(makefile)[1].trim().split(/\s+/);
    assert.ok(units.includes("method-apps:webapp-js,cli-python,initializers/js"));
    assert.deepEqual(checkVersions(ROOT, units).problems, []);
  });
});
