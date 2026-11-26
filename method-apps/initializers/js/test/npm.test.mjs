// How the initializer runs the copy's gesture without make: which npm it
// runs, how it finds a tool on the PATH, what it refuses before writing
// anything, and the words it hands `npm run create`, which are the words the
// template's own `make create` forwards. Written for every system: each test
// either takes the system as an argument or builds what it needs with Node.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import {
  createWords,
  envValue,
  extractWarnings,
  npmInvocation,
  npmProblem,
  onPath,
} from "../lib/npm.mjs";
import { loadTable } from "../lib/templates.mjs";
import { FAMILY_ROOT, tempRoot } from "./support.mjs";

const table = loadTable();
const ORDER = table.variablesOf("webapp-js");
const words = (values) => createWords(ORDER, values, table.switches, table.required);

describe("npmInvocation", () => {
  it("runs the npm that named its own script with this Node, on every system", () => {
    for (const [platform, script, node] of [
      ["darwin", "/usr/local/lib/node_modules/npm/bin/npm-cli.js", "/usr/local/bin/node"],
      ["linux", "/usr/lib/node_modules/npm/bin/npm-cli.js", "/usr/bin/node"],
      [
        "win32",
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "C:\\nodejs\\node.exe",
      ],
    ]) {
      assert.deepEqual(npmInvocation({ npm_execpath: script }, platform, node), {
        command: node,
        args: [script],
      });
    }
  });

  it("passes over another package manager's script, as under yarn create", () => {
    const env = { npm_execpath: "/usr/lib/node_modules/yarn/bin/yarn.js" };
    assert.deepEqual(npmInvocation(env, "linux", "/usr/bin/node"), { command: "npm", args: [] });
  });

  it("is npm on the PATH outside Windows, and npm's script beside node.exe on Windows", () => {
    assert.deepEqual(npmInvocation({}, "darwin", "/usr/local/bin/node"), {
      command: "npm",
      args: [],
    });
    assert.deepEqual(npmInvocation({}, "win32", "C:\\Program Files\\nodejs\\node.exe"), {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    });
  });
});

describe("onPath and envValue", () => {
  it("find an executable on the PATH this system reads", () => {
    const root = tempRoot("create-method-app-npm-");
    const dir = path.join(root, "bin");
    fs.mkdirSync(dir);
    const file = path.join(dir, process.platform === "win32" ? "tool.EXE" : "tool");
    fs.writeFileSync(file, "", { mode: 0o755 });
    const env = { PATH: [path.join(root, "missing"), dir].join(path.delimiter) };
    assert.equal(onPath("tool", env), true);
    assert.equal(onPath("other", env), false);
    assert.equal(onPath("tool", { PATH: "" }), false);
  });

  it("read a variable in any case on Windows alone", () => {
    assert.equal(envValue({ Path: "C:\\bin" }, "PATH", "win32"), "C:\\bin");
    assert.equal(envValue({ Path: "/bin" }, "PATH", "linux"), undefined);
    assert.equal(envValue({ PATH: "/bin" }, "PATH", "linux"), "/bin");
  });
});

describe("npmProblem", () => {
  it("accepts an npm that is there, and names the one that is not", () => {
    const root = tempRoot("create-method-app-npm-");
    const script = path.join(root, "npm-cli.js");
    fs.writeFileSync(script, "");
    assert.equal(npmProblem({ command: process.execPath, args: [script] }, {}), null);
    const missing = path.join(root, "nowhere", "npm-cli.js");
    assert.equal(
      npmProblem({ command: process.execPath, args: [missing] }, {}),
      `npm is not where ${missing} names it: reinstall Node.js with its npm, or pass --no-create to write the template alone`,
    );
    assert.equal(
      npmProblem({ command: "npm", args: [] }, { PATH: path.join(root, "nowhere") }),
      "npm is not on the PATH: install Node.js with its npm, or pass --no-create to write the template alone",
    );
  });
});

describe("createWords", () => {
  it("puts the method first, then each value as its flag and itself, and a switch alone", () => {
    assert.deepEqual(words({ METHOD: "mt_1" }), ["mt_1"]);
    assert.deepEqual(
      words({ LABEL: "Bob's", DRY_RUN: true, METHOD: "-odd", TITLE: "  spaced  " }),
      ["-odd", "--title", "  spaced  ", "--dry-run", "--label", "Bob's"],
    );
    assert.deepEqual(words({ DRY_RUN: false, NAME: "pkg" }), ["--name", "pkg"]);
  });

  it(
    "are the words, flag for flag, the template's make create forwards to npm run create",
    { skip: !onPath("make", process.env) && "make is not installed here" },
    () => {
      const values = {
        METHOD: "./my methods/a.mthds",
        NAME: "pkg",
        TITLE: "Bob's app",
        DESCRIPTION: "one two",
        PIPE: "main",
        AUTHOR_NAME: "Ann",
        AUTHOR_EMAIL: "a@example.com",
        REPO_URL: "https://example.com/r",
        LICENSE: "mit",
        LICENSE_HOLDER: "Ann & Co",
        LICENSE_YEAR: "2026",
        DRY_RUN: "1",
        METHOD_NAME: "receipts",
        LABEL: "Receipts",
      };
      const env = { ...process.env };
      for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"]) delete env[name];
      const printed = execFileSync(
        "make",
        [
          "-n",
          "--no-print-directory",
          "-C",
          path.join(FAMILY_ROOT, "webapp-js"),
          "create",
          ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
        ],
        { encoding: "utf8", env },
      );
      const line = printed.split("\n").find((l) => l.startsWith("npm run create -- "));
      assert.ok(line, printed);
      // The gesture reads its flags in any order, so the order is not compared.
      const forwarded = shellWords(line).slice(4);
      assert.deepEqual(byFlag(words({ ...values, DRY_RUN: true })), byFlag(forwarded));
    },
  );
});

describe("extractWarnings", () => {
  it("keeps each warning line once, in order, and nothing that only mentions one", () => {
    const output = [
      "create: Stub",
      "! no description",
      "warning: a",
      "  warning: indented",
      "! no description",
      "warning: a\r",
      "warning: b",
    ].join("\n");
    assert.deepEqual(extractWarnings(output), ["! no description", "warning: a", "warning: b"]);
  });
});

/** The method, then each flag with its value, or true for a switch, sorted by flag. */
function byFlag(list) {
  const [method, ...rest] = list;
  const pairs = [];
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    pairs.push(table.switches.has(table.variables.get(flag)) ? [flag, true] : [flag, rest[++i]]);
  }
  return [method, ...pairs.sort(([a], [b]) => a.localeCompare(b))];
}

/** Split a line make prints into words, undoing the single quotes and backslashes it quotes with. */
function shellWords(line) {
  const out = [];
  let word = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === "\\") {
      word = (word ?? "") + line[i + 1];
      i += 1;
    } else if (c === " ") {
      if (word !== null) out.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) out.push(word);
  return out;
}
