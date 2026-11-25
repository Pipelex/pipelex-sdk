// Every package directory's `install-if-needed` guard, the one its `agent-check` and `agent-test`
// run first: it installs a directory that was never installed, and installs again one whose
// lockfile moved after its last install, but leaves alone one that is current, whatever was
// installed over the locked packages since. Each case copies the directory's own Makefile into a
// temporary directory and reads, with `make -n`, whether the guard would reach the install. Run
// with `node --test`, as the root has no dependencies.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// How each kind of directory records an install, and the command its `make install` runs.
const PYTHON = {
  lock: "uv.lock",
  stamp: ".venv/.uv-lock-synced",
  installed: ".venv/bin/pytest",
  install: /\buv sync\b/,
  // Read when the Makefile is parsed: the interpreter and the project's name.
  files: { ".python-version": "3.13\n", "pyproject.toml": 'name = "fixture"\n' },
};
const JAVASCRIPT = {
  lock: "package-lock.json",
  stamp: "node_modules/.lock-installed",
  // npm's own record of the last install, which the guard reads where `make install` never ran.
  npmRecord: "node_modules/.package-lock.json",
  installed: "node_modules",
  install: /\bnpm (ci|install)\b/,
  files: {},
};
const DIRECTORIES = {
  python: PYTHON,
  "starter-python": PYTHON,
  "method-apps/cli-python": PYTHON,
  js: JAVASCRIPT,
  "starter-js": JAVASCRIPT,
  "method-apps/webapp-js": JAVASCRIPT,
};
const JAVASCRIPT_DIRECTORIES = Object.keys(DIRECTORIES).filter((name) => DIRECTORIES[name] === JAVASCRIPT);

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const EARLIER = new Date("2026-01-01T00:00:00Z");
const MIDDLE = new Date("2026-01-02T00:00:00Z");
const LATER = new Date("2026-01-03T00:00:00Z");

/** Write `file` under `root`, dated `when`. */
function write(root, file, content, when) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.utimesSync(target, when, when);
}

/**
 * A copy of `directory`'s Makefile in a temporary directory, its lockfile dated `lockAt`. With
 * `installed`, the directory looks installed, and each entry of `records`, a map from a path to a
 * date, is written at that date: the install's stamp, or npm's record.
 */
function fixture(directory, { installed = false, records = {}, lockAt = MIDDLE } = {}) {
  const kind = DIRECTORIES[directory];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-if-needed-"));
  roots.push(root);
  fs.copyFileSync(path.join(ROOT, directory, "Makefile"), path.join(root, "Makefile"));
  for (const [file, content] of Object.entries(kind.files)) write(root, file, content, EARLIER);
  write(root, kind.lock, "{}\n", lockAt);
  if (installed) {
    if (kind === PYTHON) {
      write(root, kind.installed, "", EARLIER);
      fs.chmodSync(path.join(root, kind.installed), 0o755);
    } else {
      fs.mkdirSync(path.join(root, kind.installed), { recursive: true });
    }
    for (const [file, when] of Object.entries(records)) write(root, file, "", when);
  }
  return root;
}

/** Run `make -n <target>` in `root`, with no make or interpreter variables inherited. */
function dryRun(root, target) {
  const env = { ...process.env };
  for (const name of ["MAKEFLAGS", "MAKELEVEL", "MFLAGS", "UV_PYTHON", "PYTHON_VERSION"]) delete env[name];
  const result = spawnSync("make", ["--no-print-directory", "-n", target], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * What `make -n install-if-needed` prints in `root`. A recipe line that runs a recursive make is
 * executed even under `-n`, so the guard's shell runs and its sub-make prints the install it would
 * run; the recipe's own text is printed too, indented, whichever branch runs.
 */
function guard(root) {
  return dryRun(root, "install-if-needed");
}

/** The line the guard prints when the lockfile moved, at the start of a line, where the recipe's copy is indented. */
function said(kind) {
  return new RegExp(`^${kind.lock.replace(".", "\\.")} has moved since`, "m");
}

for (const [directory, kind] of Object.entries(DIRECTORIES)) {
  describe(`${directory}'s install-if-needed`, () => {
    it("installs a directory that was never installed", () => {
      assert.match(guard(fixture(directory)), kind.install);
    });

    it("leaves alone a directory installed after its lockfile last moved", () => {
      const printed = guard(fixture(directory, { installed: true, records: { [kind.stamp]: LATER } }));
      assert.doesNotMatch(printed, kind.install);
      assert.doesNotMatch(printed, said(kind));
    });

    it(`installs again, and says why, when ${kind.lock} moved after the last install`, () => {
      const printed = guard(fixture(directory, { installed: true, records: { [kind.stamp]: EARLIER } }));
      assert.match(printed, kind.install);
      assert.match(printed, said(kind));
    });

    it("installs again when no install was ever recorded", () => {
      assert.match(guard(fixture(directory, { installed: true })), kind.install);
    });
  });
}

describe("the JavaScript guard's two records", () => {
  for (const directory of JAVASCRIPT_DIRECTORIES) {
    it(`${directory}: installs with npm ci when ${JAVASCRIPT.lock} moved after the stamp, though npm's record is newer`, () => {
      // `npm install --package-lock-only` rewrites npm's record without installing anything, and npm
      // trusts that record over node_modules, so only `npm ci` puts back exactly what the lock pins.
      const root = fixture(directory, { installed: true, records: { [JAVASCRIPT.stamp]: EARLIER, [JAVASCRIPT.npmRecord]: LATER } });
      assert.match(guard(root), /^npm ci\b/m);
    });

    it(`${directory}: reads npm's record where make install never ran, so a package installed over the lock stays`, () => {
      // The CI installs with `npm ci`, then `npm install --no-save` the next SDK, then runs agent-test.
      assert.doesNotMatch(guard(fixture(directory, { installed: true, records: { [JAVASCRIPT.npmRecord]: LATER } })), JAVASCRIPT.install);
      assert.match(guard(fixture(directory, { installed: true, records: { [JAVASCRIPT.npmRecord]: EARLIER } })), JAVASCRIPT.install);
    });
  }
});

describe("the install that records itself", () => {
  // The guard reads the stamp the install leaves, so an install that did not touch it after the
  // package manager ran would send the guard back to the install, or to npm's record, every time.
  const touch = (stamp) => new RegExp(`touch "?[^\\n]*${stamp.replace(/[.]/g, "\\.")}`);
  for (const directory of Object.keys(DIRECTORIES)) {
    const kind = DIRECTORIES[directory];
    it(`${directory}'s install touches ${kind.stamp} after installing`, () => {
      const printed = dryRun(fixture(directory), "install");
      const installs = printed.search(kind.install);
      const touches = printed.search(touch(kind.stamp));
      assert.ok(installs >= 0 && touches > installs, printed);
    });
  }
});

const JAVASCRIPT_TEMPLATES = ["starter-js", "method-apps/webapp-js"];

describe("the JavaScript templates' install-locked", () => {
  for (const directory of JAVASCRIPT_TEMPLATES) {
    it(`${directory}'s install-locked runs npm ci, then touches ${JAVASCRIPT.stamp}`, () => {
      const printed = dryRun(fixture(directory), "install-locked");
      const installs = printed.search(/^npm ci\b/m);
      assert.ok(installs >= 0 && printed.indexOf(JAVASCRIPT.stamp) > installs, printed);
    });
  }
});

describe("make lock in the JavaScript templates", () => {
  // The lock it writes is newer than the stamp, so the next agent target installs from it. Where no
  // stamp exists, the lock-only install rewrites npm's record too, so the target leaves an old stamp.
  for (const directory of JAVASCRIPT_TEMPLATES) {
    it(`${directory}'s lock regenerates the lock, then leaves an old stamp where none exists`, () => {
      const printed = dryRun(fixture(directory), "lock");
      const lock = printed.search(/^npm install --package-lock-only$/m);
      const stamp = printed.search(new RegExp(`\\[ -f ${JAVASCRIPT.stamp.replace(/[.]/g, "\\.")} \\] \\|\\| touch -t 200001010000 `));
      assert.ok(lock >= 0 && stamp > lock, printed);
      assert.doesNotMatch(printed, /\brm\b/);
    });
  }
});

describe("use-local runs the guard first", () => {
  // A local build installed over a stale tree would be replaced by the next agent target's install.
  for (const [directory, targets] of [
    ["starter-js", ["use-local"]],
    ["method-apps/webapp-js", ["use-local", "use-local-form"]],
    ["method-apps/cli-python", ["use-local"]],
  ]) {
    for (const target of targets) {
      it(`${directory}'s ${target} depends on install-if-needed`, () => {
        const makefile = fs.readFileSync(path.join(ROOT, directory, "Makefile"), "utf8");
        assert.match(makefile, new RegExp(`^${target}: install-if-needed\\b`, "m"));
      });
    }
  }
});

