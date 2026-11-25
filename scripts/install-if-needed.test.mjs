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
  record: ".venv/.uv-lock-synced",
  installed: ".venv/bin/pytest",
  install: /\buv sync\b/,
  // Read when the Makefile is parsed: the interpreter and the project's name.
  files: { ".python-version": "3.13\n", "pyproject.toml": 'name = "fixture"\n' },
};
const JAVASCRIPT = {
  lock: "package-lock.json",
  record: "node_modules/.package-lock.json",
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

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const EARLIER = new Date("2026-01-01T00:00:00Z");
const LATER = new Date("2026-01-02T00:00:00Z");

/** Write `file` under `root`, dated `when`. */
function write(root, file, content, when) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.utimesSync(target, when, when);
}

/**
 * A copy of `directory`'s Makefile in a temporary directory, its lockfile dated `lockAt`. With
 * `installed`, the directory looks installed, and with `recordAt` as well, its last install is
 * recorded at that date.
 */
function fixture(directory, { installed = false, recordAt, lockAt = EARLIER } = {}) {
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
    if (recordAt) write(root, kind.record, "", recordAt);
  }
  return root;
}

/** What `make -n install-if-needed` prints in `root`: a recursive make runs, the rest is printed. */
function guard(root) {
  const env = { ...process.env };
  for (const name of ["MAKEFLAGS", "MAKELEVEL", "MFLAGS", "UV_PYTHON", "PYTHON_VERSION"]) delete env[name];
  const result = spawnSync("make", ["--no-print-directory", "-n", "install-if-needed"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

for (const [directory, kind] of Object.entries(DIRECTORIES)) {
  describe(`${directory}'s install-if-needed`, () => {
    it("installs a directory that was never installed", () => {
      assert.match(guard(fixture(directory)), kind.install);
    });

    it("leaves alone a directory installed after its lockfile last moved", () => {
      assert.doesNotMatch(guard(fixture(directory, { installed: true, recordAt: LATER })), kind.install);
    });

    it(`installs again, and says why, when ${kind.lock} moved after the last install`, () => {
      const printed = guard(fixture(directory, { installed: true, recordAt: EARLIER, lockAt: LATER }));
      assert.match(printed, kind.install);
      assert.match(printed, new RegExp(`${kind.lock.replace(".", "\\.")} has moved since`));
    });

    it("installs again when no install was ever recorded", () => {
      assert.match(guard(fixture(directory, { installed: true })), kind.install);
    });
  });
}

describe("the install that records itself", () => {
  // The guard reads the record that the install leaves, so a Python install that synced .venv
  // without touching the stamp would send every later check back to the install.
  for (const directory of Object.keys(DIRECTORIES).filter((name) => DIRECTORIES[name] === PYTHON)) {
    it(`${directory}'s install touches ${PYTHON.record} after uv sync`, () => {
      const printed = spawnSync("make", ["--no-print-directory", "-n", "install"], {
        cwd: fixture(directory),
        encoding: "utf8",
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !["MAKEFLAGS", "MAKELEVEL", "MFLAGS"].includes(name))),
      }).stdout;
      const sync = printed.search(PYTHON.install);
      const touch = printed.search(/touch "?[^\n]*\.venv\/\.uv-lock-synced/);
      assert.ok(sync >= 0 && touch > sync, printed);
    });
  }
});
