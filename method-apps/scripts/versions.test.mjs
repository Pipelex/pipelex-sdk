// The family's one version: what the check reads, and what it refuses. Run
// with `node --test` — the root has no dependencies.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { ROOT, VersionError, familyVersion, mismatches, pyprojectVersion } from "./versions.mjs";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway family: a VERSION file and one file per template. */
function family(version, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "family-version-"));
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

describe("mismatches", () => {
  it("accepts templates that all carry the family's version", () => {
    const root = family("0.2.0\n", {
      "a-js/package.json": pkg("0.2.0"),
      "b-python/pyproject.toml": pyproject("0.2.0"),
    });
    assert.deepEqual(mismatches(root, ["a-js", "b-python"]), { expected: "0.2.0", wrong: [] });
  });

  it("names every manifest that disagrees", () => {
    const root = family("0.2.0\n", {
      "a-js/package.json": pkg("0.1.0"),
      "b-python/pyproject.toml": pyproject("0.3.0"),
    });
    assert.deepEqual(
      mismatches(root, ["a-js", "b-python"]).wrong.map(({ manifest, version }) => [
        manifest,
        version,
      ]),
      [
        ["a-js/package.json", "0.1.0"],
        ["b-python/pyproject.toml", "0.3.0"],
      ],
    );
  });

  it("refuses a missing or malformed VERSION, and a template with no manifest", () => {
    assert.throws(() => familyVersion(family(null, {})), VersionError);
    assert.throws(() => familyVersion(family("v0.2.0\n", {})), VersionError);
    assert.throws(
      () => mismatches(family("0.2.0\n", { "a-js/README.md": "" }), ["a-js"]),
      VersionError,
    );
    assert.throws(() => mismatches(family("0.2.0\n", {}), ["a-js"]), VersionError);
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
  it("carries one version across its templates and its initializers", () => {
    const makefile = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const list = (name) =>
      new RegExp(`^${name} := (.+)$`, "m").exec(makefile)[1].trim().split(/\s+/);
    const initializers = list("INITIALIZERS");
    assert.ok(initializers.includes("initializers/js"));
    assert.deepEqual(mismatches(ROOT, [...list("TEMPLATES"), ...initializers]).wrong, []);
  });
});
