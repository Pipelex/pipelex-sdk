// The wire-format table that holds `cli-python` to the form kernel: the
// committed recording must be what the kernel `webapp-js` installs sends today,
// byte for byte, so a kernel upgrade that changes a payload fails here until the
// table is recorded again and the CLI agrees with it. The recorder imports
// `webapp-js`'s TypeScript fixtures, so it runs in a child process, given
// `--experimental-strip-types` where this Node does not strip types by default.
// Run with `node --test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { describe, it } from "node:test";

import path from "node:path";

import {
  CASES,
  CONTRACTS_SUBDIR,
  FAMILY_ROOT,
  optionStyle,
  render,
  sample,
  staleContracts,
} from "./record-wire-table.mjs";

/** The flags this Node needs to import a TypeScript module. */
const STRIP_TYPES = process.features.typescript ? [] : ["--experimental-strip-types"];

describe("the wire-format table", () => {
  it("is what the installed form kernel sends, byte for byte", () => {
    const run = spawnSync(
      process.execPath,
      [...STRIP_TYPES, "--no-warnings", "scripts/record-wire-table.mjs", "--check"],
      {
        cwd: FAMILY_ROOT,
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /is current/);
  });

  it("records every pipe with every input, the required ones only, and none", () => {
    assert.deepEqual(CASES, ["every input", "required only", "nothing"]);
  });

  it("renders two-space JSON with a final newline, so a recording is stable", () => {
    assert.equal(render({ b: [1], a: "x" }), '{\n  "b": [\n    1\n  ],\n  "a": "x"\n}\n');
  });

  it("counts a recorded contract whose fixture is gone as stale, and nothing else", () => {
    const kept = path.join(CONTRACTS_SUBDIR, "text-stats.json");
    const files = { [kept]: "{}\n", "table.json": "{}\n" };
    assert.deepEqual(staleContracts(["text-stats.json", "removed.json", "notes.txt"], files), [
      path.join(CONTRACTS_SUBDIR, "removed.json"),
    ]);
    assert.deepEqual(staleContracts(["text-stats.json"], files), []);
    assert.deepEqual(staleContracts([], files), []);
  });
});

describe("how the CLI takes each kind", () => {
  it("takes a scalar kind as one value, a list of one as a repeatable value, and anything else as JSON", () => {
    assert.equal(optionStyle({ kind: "number" }), "scalar");
    assert.equal(optionStyle({ kind: "list", item: { kind: "image" } }), "repeatable");
    assert.equal(optionStyle({ kind: "list", item: { kind: "object" } }), "json");
    assert.equal(optionStyle({ kind: "object" }), "json");
    assert.equal(optionStyle({ kind: "unknown" }), "json");
  });

  it("samples a boolean as false with every input and true with the required ones, so both values are recorded", () => {
    assert.equal(sample({ kind: "boolean" }, "agreed", "every input"), false);
    assert.equal(sample({ kind: "boolean" }, "agreed", "required only"), true);
  });

  it("samples a fixed-count list with exactly its count of items", () => {
    const items = sample(
      { kind: "list", item_count: 3, item: { kind: "text" } },
      "lines",
      "every input",
    );
    assert.deepEqual(items, ["A lines-1", "A lines-2", "A lines-3"]);
  });

  it("samples an image as a file uploaded from a local name, and a document as a URL", () => {
    assert.deepEqual(sample({ kind: "image" }, "picture", "every input"), {
      url: "pipelex-storage://wire-table/picture.png",
      filename: "picture.png",
    });
    assert.deepEqual(sample({ kind: "document" }, "report", "every input"), {
      url: "https://example.com/files/report.pdf",
    });
  });
});
