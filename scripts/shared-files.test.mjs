// The shared case files: what the declaration may hold, what the check reports, and what the
// copy writes. Run with `node --test`, as the root has no dependencies.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { ROOT, SETS, SharedFileError, checkSets, compareSets, main, writeSets } from "./shared-files.mjs";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A temporary repository holding `files`, a map from path to content. */
function repository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-files-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const SET = [{ source: "js/cases.json", copies: ["python/tests/fixtures/cases.json"] }];

/** Run `main` with its console output captured. */
function run(argv, options) {
  const lines = { out: [], err: [] };
  const log = console.log;
  const error = console.error;
  console.log = (line) => lines.out.push(line);
  console.error = (line) => lines.err.push(line);
  try {
    return { code: main(argv, options), ...lines };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("the declared sets", () => {
  it("hold together, each source existing in this repository", () => {
    checkSets(SETS);
    for (const { source } of SETS) assert.ok(fs.existsSync(path.join(ROOT, source)), source);
  });

  it("are current in this repository", () => {
    assert.deepEqual(compareSets(ROOT, SETS), []);
  });

  it("refuse a set with no copy, a path declared twice and a path that leaves the root", () => {
    assert.throws(() => checkSets([{ source: "a.json", copies: [] }]), SharedFileError);
    assert.throws(
      () => checkSets([{ source: "a.json", copies: ["b.json"] }, { source: "c.json", copies: ["b.json"] }]),
      /b\.json is declared twice/,
    );
    assert.throws(() => checkSets([{ source: "a.json", copies: ["a.json"] }]), /declared twice/);
    assert.throws(() => checkSets([{ source: "../a.json", copies: ["b.json"] }]), /not a plain path/);
    assert.throws(() => checkSets([{ source: "/a.json", copies: ["b.json"] }]), /not a plain path/);
    assert.throws(() => checkSets([{ source: "js/../a.json", copies: ["b.json"] }]), /not a plain path/);
  });
});

describe("the check", () => {
  it("passes when every copy holds its source's bytes", () => {
    const root = repository({ "js/cases.json": "{}\n", "python/tests/fixtures/cases.json": "{}\n" });
    const { code, out } = run(["--check"], { root, sets: SET });
    assert.equal(code, 0);
    assert.deepEqual(out, ["Shared files are current."]);
  });

  it("reports a missing copy and a copy that differs, by a single byte too", () => {
    const sets = [{ source: "js/cases.json", copies: ["python/a.json", "python/b.json"] }];
    const root = repository({ "js/cases.json": "{}\n", "python/b.json": "{}" });
    assert.deepEqual(compareSets(root, sets), [
      { source: "js/cases.json", copy: "python/a.json", kind: "missing" },
      { source: "js/cases.json", copy: "python/b.json", kind: "differs" },
    ]);
    const { code, err } = run(["--check"], { root, sets });
    assert.equal(code, 1);
    assert.match(err.join("\n"), /missing: python\/a\.json, the copy of js\/cases\.json/);
    assert.match(err.join("\n"), /run `make shared-files`/);
  });

  it("cannot check when a source is missing", () => {
    const root = repository({ "python/tests/fixtures/cases.json": "{}\n" });
    const { code, err } = run(["--check"], { root, sets: SET });
    assert.equal(code, 2);
    assert.match(err.join("\n"), /the source js\/cases\.json does not exist/);
  });

  it("refuses an argument it does not know", () => {
    assert.equal(run(["--fix"], { root: repository({}), sets: SET }).code, 2);
  });
});

describe("the copy", () => {
  it("writes a missing copy, its directory included, and a stale one, then has nothing to do", () => {
    const sets = [{ source: "js/cases.json", copies: ["python/tests/fixtures/cases.json", "other.json"] }];
    const root = repository({ "js/cases.json": "{\"a\": 1}\n", "other.json": "stale" });
    const written = writeSets(root, sets);
    assert.deepEqual(
      written.map(({ copy }) => copy),
      ["python/tests/fixtures/cases.json", "other.json"],
    );
    for (const copy of sets[0].copies) {
      assert.equal(fs.readFileSync(path.join(root, copy), "utf8"), "{\"a\": 1}\n");
    }
    const { code, out } = run([], { root, sets });
    assert.equal(code, 0);
    assert.deepEqual(out, ["Shared files are already current."]);
  });

  it("leaves the source alone", () => {
    const root = repository({ "js/cases.json": "source\n", "python/tests/fixtures/cases.json": "copy\n" });
    writeSets(root, SET);
    assert.equal(fs.readFileSync(path.join(root, "js/cases.json"), "utf8"), "source\n");
  });
});
