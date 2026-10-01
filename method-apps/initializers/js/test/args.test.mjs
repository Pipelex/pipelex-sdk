// The command line, and the flags it takes: exactly the `make create`
// contract's variables, named after them, which are also the flags of the
// template's own `npm run create`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { EXTRAS, SHARED } from "../../../scripts/create-contract.mjs";
import { parseArgs } from "../lib/args.mjs";
import { flagOf, loadTable } from "../lib/templates.mjs";
import { FAMILY_ROOT } from "./support.mjs";

const table = loadTable();

const refusal = (argv) => {
  try {
    parseArgs(argv, table);
  } catch (error) {
    return error.word;
  }
  return null;
};

describe("the flags", () => {
  it("are the create contract's variables, each named after its make variable", () => {
    const expected = new Set(
      [...SHARED, ...Object.keys(table.templates).flatMap((t) => EXTRAS[t] ?? [])].map(flagOf),
    );
    assert.deepEqual(new Set(table.variables.keys()), expected);
    assert.equal(flagOf("AUTHOR_EMAIL"), "--author-email");
    assert.equal(flagOf("DRY_RUN"), "--dry-run");
  });

  it("are the flags of the template's own npm run create", () => {
    const source = fs.readFileSync(
      path.join(FAMILY_ROOT, "webapp-js/scripts/lib/create.mts"),
      "utf8",
    );
    const block = /const FLAGS: Record<string, ValueFlag> = \{([^}]*)\}/.exec(source)[1];
    const gesture = new Set([...block.matchAll(/"(--[a-z-]+)":/g)].map((m) => m[1]));
    gesture.add("--dry-run");
    gesture.add("--method");
    const own = new Set(table.variablesOf("webapp-js").map(flagOf));
    assert.deepEqual(own, gesture);
  });
});

describe("parseArgs", () => {
  it("reads a value as the next word or after =, and a switch alone", () => {
    const parsed = parseArgs(
      ["my-app", "--method", "./a.mthds", "--title=Bob's app", "--dry-run", "--no-git", "--quiet"],
      table,
    );
    assert.equal(parsed.dir, "my-app");
    assert.deepEqual(parsed.values, { METHOD: "./a.mthds", TITLE: "Bob's app", DRY_RUN: true });
    assert.equal(parsed.noGit, true);
    assert.equal(parsed.quiet, true);
    assert.equal(parsed.noCreate, false);
  });

  it("keeps a value exactly as typed, and drops a blank one", () => {
    const parsed = parseArgs(
      ["d", "--method", "mt_1", "--name", "", "--title", "  spaced  ", "--label", "   "],
      table,
    );
    assert.deepEqual(parsed.values, { METHOD: "mt_1", TITLE: "  spaced  " });
  });

  it("takes everything after -- as the directory", () => {
    assert.equal(parseArgs(["--method", "m", "--", "--odd-name"], table).dir, "--odd-name");
  });

  it("refuses what it cannot read, naming the kind", () => {
    assert.equal(refusal(["d", "--colour", "blue"]), "refused: unknown-option");
    assert.equal(refusal(["d", "-x"]), "refused: unknown-option");
    assert.equal(refusal(["d", "e"]), "refused: usage");
    assert.equal(refusal(["d", "--name"]), "refused: usage");
    assert.equal(refusal(["d", "--name", "--title", "t"]), "refused: usage");
    assert.equal(refusal(["d", "--dry-run=1"]), "refused: usage");
    assert.equal(refusal(["d", "--method", "a", "--method", "b"]), "refused: usage");
    assert.equal(refusal(["d", "--quiet", "--quiet"]), "refused: usage");
  });
});
