// The pack: the template it carries is exactly `git ls-files <template>`, byte
// for byte and mode for mode, and it refuses what a template must not carry.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";

import { decodePack, encodePack, PackError } from "../lib/pack.mjs";
import { loadTable } from "../lib/templates.mjs";
import { writeTree } from "../lib/write.mjs";
import {
  hasUncommittedChanges,
  packAll,
  packTemplate,
  PackRefusal,
} from "../scripts/pack-templates.mjs";
import { FAMILY_ROOT, git, packs, setupEnv, tempRoot } from "./support.mjs";

describe("the packed webapp-js", () => {
  it("writes exactly what git ls-files lists, byte for byte and mode for mode", async () => {
    const pack = decodePack(fs.readFileSync(path.join(packs(), "webapp-js.pack")));
    const dest = path.join(tempRoot(), "copy");
    await writeTree(dest, pack.files);

    const tracked = execFileSync(
      "git",
      ["-C", FAMILY_ROOT, "ls-files", "-s", "-z", "--", "webapp-js"],
      {
        encoding: "utf8",
      },
    )
      .split("\0")
      .filter(Boolean)
      .map((entry) => ({ mode: entry.slice(0, 6), path: entry.slice(entry.indexOf("\t") + 1) }));
    const written = [];
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
        else written.push(childRel);
      }
    };
    walk(dest, "");
    assert.deepEqual(
      written.sort(),
      tracked.map((file) => file.path.slice("webapp-js/".length)).sort(),
    );
    for (const file of tracked) {
      const rel = file.path.slice("webapp-js/".length);
      const copy = path.join(dest, rel);
      assert.ok(
        fs.readFileSync(copy).equals(fs.readFileSync(path.join(FAMILY_ROOT, file.path))),
        rel,
      );
      const executable = (fs.statSync(copy).mode & 0o111) !== 0;
      assert.equal(executable, file.mode === "100755", `${rel}'s mode`);
    }
  });

  it("names the family's version and the commit it was packed from", () => {
    const pack = decodePack(fs.readFileSync(path.join(packs(), "webapp-js.pack")));
    assert.equal(pack.version, fs.readFileSync(path.join(FAMILY_ROOT, "VERSION"), "utf8").trim());
    const head = execFileSync("git", ["-C", FAMILY_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const dirty = hasUncommittedChanges(FAMILY_ROOT, "webapp-js");
    assert.equal(pack.source, dirty ? `${head}-dirty` : head);
  });

  it("carries the version the initializer's package carries", () => {
    const own = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const pack = decodePack(fs.readFileSync(path.join(packs(), "webapp-js.pack")));
    assert.equal(own.version, pack.version);
  });
});

describe("the pack format", () => {
  const file = (p, data = "x", mode = "100644") => ({ path: p, mode, data: Buffer.from(data) });

  it("reads back what it wrote", () => {
    const files = [
      file("a.txt", "alpha"),
      file("dir/run.sh", "#!/bin/sh\n", "100755"),
      file(".gitignore", ""),
    ];
    const pack = decodePack(
      encodePack({ template: "t-js", version: "1.2.3", source: "abc", files }),
    );
    assert.equal(pack.template, "t-js");
    assert.deepEqual(
      pack.files.map((f) => [f.path, f.mode, f.data.toString()]),
      files.map((f) => [f.path, f.mode, f.data.toString()]),
    );
  });

  it("refuses a path that could leave the destination, or reach into a .git", () => {
    for (const bad of [
      "/etc/passwd",
      "../up",
      "a/../../b",
      "a//b",
      "./a",
      ".git/config",
      "a/.git/x",
      "a\\b",
      "",
    ]) {
      assert.throws(
        () => encodePack({ template: "t", version: "1", source: "s", files: [file(bad)] }),
        PackError,
        bad,
      );
    }
  });

  it("refuses a mode other than a plain or executable file", () => {
    for (const mode of ["120000", "160000", "100664"]) {
      assert.throws(
        () =>
          encodePack({ template: "t", version: "1", source: "s", files: [file("a", "x", mode)] }),
        PackError,
      );
    }
  });

  it("refuses a pack whose header and body disagree", () => {
    const header = (files) =>
      `${JSON.stringify({ format: 1, template: "t", version: "1", source: "s", files })}\n`;
    const pack = (text) => zlib.gzipSync(Buffer.from(text));
    assert.throws(() => decodePack(Buffer.from("not gzip")), PackError);
    assert.throws(
      () => decodePack(pack(header([{ path: "a", mode: "100644", size: 5 }]) + "abc")),
      PackError,
    );
    assert.throws(
      () => decodePack(pack(header([{ path: "a", mode: "100644", size: 1 }]) + "abc")),
      PackError,
    );
    assert.throws(
      () => decodePack(pack(header([{ path: "../a", mode: "100644", size: 1 }]) + "a")),
      PackError,
    );
    assert.throws(
      () =>
        decodePack(
          pack(
            header([
              { path: "a", mode: "100644", size: 1 },
              { path: "a", mode: "100644", size: 1 },
            ]) + "ab",
          ),
        ),
      PackError,
    );
    assert.throws(
      () => decodePack(pack(`${JSON.stringify({ format: 2, files: [] })}\n`)),
      PackError,
    );
  });
});

describe("pack-templates", () => {
  /** A throwaway family: VERSION, and a template `t-js` committed with the files given. */
  function family(files, { floor = ">=22.12.0" } = {}) {
    const root = tempRoot("create-method-app-family-");
    const env = setupEnv(root);
    const repo = path.join(root, "family");
    fs.mkdirSync(path.join(repo, "t-js"), { recursive: true });
    fs.writeFileSync(path.join(repo, "VERSION"), "9.9.9\n");
    const manifest = {
      name: "t",
      version: "9.9.9",
      ...(floor === null ? {} : { engines: { node: floor } }),
    };
    fs.writeFileSync(path.join(repo, "t-js", "package.json"), JSON.stringify(manifest));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, "t-js", rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, "t-js", rel), text);
    }
    git(repo, ["init", "-q", "-b", "main"], env);
    git(repo, ["add", "-A"], env);
    git(repo, ["commit", "-q", "-m", "family"], env);
    return { repo, env };
  }

  it("packs git's mode, so an executable file stays executable", async () => {
    const { repo, env } = family({ "bin/run.sh": "#!/bin/sh\n" });
    git(repo, ["update-index", "--chmod=+x", "t-js/bin/run.sh"], env);
    git(repo, ["commit", "-q", "-m", "executable"], env);
    fs.chmodSync(path.join(repo, "t-js/bin/run.sh"), 0o755);
    const pack = decodePack(packTemplate(repo, "t-js"));
    assert.equal(pack.files.find((f) => f.path === "bin/run.sh").mode, "100755");
    const dest = path.join(tempRoot(), "out");
    await writeTree(dest, pack.files);
    assert.notEqual(fs.statSync(path.join(dest, "bin/run.sh")).mode & 0o111, 0);
  });

  it("refuses a symlink and a submodule", () => {
    const { repo, env } = family({ "README.md": "hi\n" });
    fs.symlinkSync("README.md", path.join(repo, "t-js", "LINK.md"));
    git(repo, ["add", "t-js/LINK.md"], env);
    git(repo, ["commit", "-q", "-m", "link"], env);
    assert.throws(() => packTemplate(repo, "t-js"), /symlink/);

    const other = family({ "README.md": "hi\n" });
    const sha = git(other.repo, ["rev-parse", "HEAD"], other.env);
    git(other.repo, ["update-index", "--add", "--cacheinfo", `160000,${sha},t-js/sub`], other.env);
    git(other.repo, ["commit", "-q", "-m", "submodule"], other.env);
    assert.throws(() => packTemplate(other.repo, "t-js"), /submodule/);
  });

  it("refuses a tracked file the working tree lacks, and a template with no plain engines floor", () => {
    const { repo } = family({ "README.md": "hi\n" });
    fs.rmSync(path.join(repo, "t-js", "README.md"));
    assert.throws(() => packTemplate(repo, "t-js"), /missing from the working tree/);
    assert.throws(() => packTemplate(family({}, { floor: null }).repo, "t-js"), /engines\.node/);
    assert.throws(
      () => packTemplate(family({}, { floor: "^22.12.0" }).repo, "t-js"),
      /engines\.node/,
    );
  });

  it("packs uncommitted changes as <sha>-dirty, and refuses them with --publish", () => {
    const { repo, env } = family({ "README.md": "hi\n" });
    const head = git(repo, ["rev-parse", "HEAD"], env);
    assert.equal(decodePack(packTemplate(repo, "t-js")).source, head);
    fs.writeFileSync(path.join(repo, "t-js", "README.md"), "changed\n");
    const dirty = decodePack(packTemplate(repo, "t-js"));
    assert.equal(dirty.source, `${head}-dirty`);
    assert.equal(dirty.files.find((f) => f.path === "README.md").data.toString(), "changed\n");
    assert.throws(() => packTemplate(repo, "t-js", { publish: true }), PackRefusal);
  });

  it("refuses to publish when VERSION is not the package's version", () => {
    const { repo } = family({});
    const table = { ...loadTable(), templates: { "t-js": { extras: [] } } };
    const outDir = tempRoot();
    assert.throws(() => packAll(repo, { publish: true, outDir, table }), /one version/);
    assert.deepEqual(packAll(repo, { outDir, table }), [path.join(outDir, "t-js.pack")]);
  });
});
