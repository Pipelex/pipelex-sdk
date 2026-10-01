// The package as npm ships it: the files `npm pack` puts in the tarball, and
// the bin run the way `npm exec` runs it, from a copy laid out as an install
// is, as a process of its own that a real signal can reach.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { packs, runEnv, tempRoot } from "./support.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A copy of the package's source, with the packs in `templates/` and nothing generated left out. */
function packageCopy() {
  const copy = path.join(tempRoot("create-method-app-package-"), "package");
  fs.cpSync(PACKAGE_ROOT, copy, {
    recursive: true,
    filter: (source) => {
      const generated = path.join(PACKAGE_ROOT, "templates");
      return source !== generated && !source.startsWith(`${generated}${path.sep}`);
    },
  });
  fs.cpSync(packs(), path.join(copy, "templates"), { recursive: true });
  return copy;
}

describe("the package", () => {
  it("ships the bin, the library, the table and the packs, and nothing else", () => {
    const copy = packageCopy();
    // The tarball itself, listed by tar, rather than npm's report of it, whose
    // shape changes between npm majors.
    const destination = tempRoot("create-method-app-tarball-");
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], {
      cwd: copy,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarballs = fs.readdirSync(destination);
    assert.equal(tarballs.length, 1, `npm pack wrote ${tarballs.join(", ")}`);
    const shipped = execFileSync("tar", ["-tzf", path.join(destination, tarballs[0])], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//, ""))
      .sort();
    const expected = [
      "LICENSE",
      "README.md",
      "package.json",
      "templates.json",
      "templates/webapp-js.pack",
      ...fs.readdirSync(path.join(PACKAGE_ROOT, "bin")).map((f) => `bin/${f}`),
      ...fs.readdirSync(path.join(PACKAGE_ROOT, "lib")).map((f) => `lib/${f}`),
    ].sort();
    assert.deepEqual(shipped, expected);
  });

  it("runs as a process, and ends a signalled make create in failed: create", async () => {
    const copy = packageCopy();
    const root = tempRoot("create-method-app-signal-");
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const env = runEnv(root);
    // A make that records its call, then waits to be stopped.
    fs.writeFileSync(
      path.join(env.PATH, "make"),
      `#!/bin/sh\nprintf '%s\\0' "$@" > "$STUB_MAKE_RECORD.args"\necho "make create is running"\nexec /bin/sleep 30\n`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [path.join(copy, "bin", "create-method-app.mjs"), "app", "--method", "mt_1"],
      {
        cwd: work,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let interrupted = false;
    const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      // One signal, as one Ctrl-C sends: a second arriving while the process
      // exits would be a different test.
      if (!interrupted && output.includes("make create is running")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await exited;
    assert.equal(code, 1, output);
    assert.match(
      output.trimEnd().split("\n").at(-1),
      /^failed: create — make create was stopped by SIGTERM\. The copy and its commit stand in /,
    );
    assert.ok(fs.existsSync(`${env.STUB_MAKE_RECORD}.args`), "make create ran");
    assert.ok(fs.existsSync(path.join(work, "app", "package.json")), "the copy stands");
  });

  it("refuses as a process with the verdict as its last line and exit 1", () => {
    const copy = packageCopy();
    const root = tempRoot();
    let failed;
    try {
      execFileSync(process.execPath, [path.join(copy, "bin", "create-method-app.mjs"), "app"], {
        cwd: root,
        env: runEnv(root),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failed = error;
    }
    assert.equal(failed.status, 1);
    assert.match(failed.stdout.trimEnd().split("\n").at(-1), /^refused: no-method — /);
  });
});
