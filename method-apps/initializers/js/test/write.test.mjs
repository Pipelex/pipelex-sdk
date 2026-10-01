// The write removes exactly what it created, and never writes over or into
// something that appeared after the destination was read.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { DestinationChanged, Interrupted, writeTree } from "../lib/write.mjs";
import { listTree, tempRoot } from "./support.mjs";

const files = [
  { path: "package.json", mode: "100644", data: Buffer.from("{}\n") },
  { path: "src/app/page.tsx", mode: "100644", data: Buffer.from("page\n") },
  { path: "src/app/layout.tsx", mode: "100644", data: Buffer.from("layout\n") },
  { path: "src/lib/api.ts", mode: "100644", data: Buffer.from("api\n") },
  { path: "scripts/run.sh", mode: "100755", data: Buffer.from("#!/bin/sh\n") },
  { path: "README.md", mode: "100644", data: Buffer.from("readme\n") },
];

/** Abort after the `n`th file is written. */
function interruptAfter(n) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    onFile: (index) => {
      if (index === n - 1) controller.abort("SIGINT");
    },
  };
}

describe("writeTree", () => {
  it("removes everything it created when interrupted, the destination and its new parents included", async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "keep.txt"), "the user's\n");
    const dest = path.join(root, "new", "deeper", "app");
    await assert.rejects(writeTree(dest, files, interruptAfter(3)), Interrupted);
    assert.deepEqual(fs.readdirSync(root), ["keep.txt"]);
  });

  it("leaves a destination it did not create, and its lone .git, as they were", async () => {
    const dest = path.join(tempRoot(), "app");
    fs.mkdirSync(path.join(dest, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(dest, ".git", "HEAD"), "ref: refs/heads/main\n");
    await assert.rejects(writeTree(dest, files, interruptAfter(4)), Interrupted);
    assert.deepEqual(fs.readdirSync(dest), [".git"]);
    assert.deepEqual(listTree(path.join(dest, ".git")).sort(), ["HEAD"]);
    assert.ok(fs.existsSync(path.join(dest, ".git", "objects")));
  });

  it("fails on a file that appears before it is written, and leaves that file alone", async () => {
    const dest = path.join(tempRoot(), "app");
    const onFile = (index) => {
      if (index === 1)
        fs.writeFileSync(path.join(dest, "src", "app", "layout.tsx"), "someone else's\n");
    };
    await assert.rejects(writeTree(dest, files, { onFile }), { code: "EEXIST" });
    assert.deepEqual(listTree(dest), ["src/app/layout.tsx"]);
    assert.equal(
      fs.readFileSync(path.join(dest, "src", "app", "layout.tsx"), "utf8"),
      "someone else's\n",
    );
  });

  it("fails on a directory that appears before it is made, and never writes into it", async () => {
    const dest = path.join(tempRoot(), "app");
    const onFile = (index) => {
      if (index === 2) fs.mkdirSync(path.join(dest, "src", "lib"));
    };
    await assert.rejects(writeTree(dest, files, { onFile }), { code: "EEXIST" });
    assert.deepEqual(listTree(dest), []);
    assert.deepEqual(fs.readdirSync(path.join(dest, "src")), ["lib"]);
    assert.deepEqual(fs.readdirSync(path.join(dest, "src", "lib")), []);
  });

  it("refuses a destination that is no longer empty when it is read again", async () => {
    const dest = path.join(tempRoot(), "app");
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, "arrived.txt"), "late\n");
    await assert.rejects(writeTree(dest, files), DestinationChanged);
    assert.deepEqual(fs.readdirSync(dest), ["arrived.txt"]);
  });

  it("writes every file with its mode when nothing interferes", async () => {
    const dest = path.join(tempRoot(), "app");
    await writeTree(dest, files);
    assert.deepEqual(listTree(dest), files.map((f) => f.path).sort());
    assert.notEqual(fs.statSync(path.join(dest, "scripts", "run.sh")).mode & 0o111, 0);
    assert.equal(fs.statSync(path.join(dest, "README.md")).mode & 0o111, 0);
  });
});
