// Git's reading of a destination inside another repository's work tree: which
// of its ignore sources count, and the patterns and paths `check-ignore` could
// misread. The family's table of cases covers a `.gitignore`; these cover what
// it does not vary.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { nearestExisting } from "../lib/destination.mjs";
import { readGit } from "../lib/git.mjs";
import { git, isolatedEnv, setupEnv, tempRoot } from "./support.mjs";

/** A repository with a commit, and what the enclosing `.gitignore` holds. */
function enclosing(gitignore = []) {
  const root = tempRoot("create-method-app-git-");
  const env = setupEnv(root);
  const repo = path.join(root, "theirs");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"], env);
  fs.writeFileSync(path.join(repo, "README.md"), "theirs\n");
  if (gitignore.length > 0)
    fs.writeFileSync(path.join(repo, ".gitignore"), `${gitignore.join("\n")}\n`);
  git(repo, ["add", "--force", "-A"], env);
  git(repo, ["commit", "-q", "-m", "Their first commit"], env);
  return { root, repo, env: isolatedEnv(root) };
}

/** Read git at a destination that does not exist yet, as the preflight does. */
function readMissing(dest, env) {
  return readGit({
    dest,
    from: nearestExisting(dest),
    destExists: false,
    destHasGit: false,
    env,
  });
}

/** Read git at an existing empty destination, as the preflight does. */
function readExisting(dest, env) {
  return readGit({ dest, from: dest, destExists: true, destHasGit: false, env });
}

describe("readGit inside another repository's work tree", () => {
  it("reads a destination ignored only through the repository's info/exclude", () => {
    const { repo, env } = enclosing();
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "play/\n");
    fs.mkdirSync(path.join(repo, "play"));
    assert.deepEqual(readMissing(path.join(repo, "play", "my-app"), env), {
      kind: "ignored",
      toplevel: repo,
    });
  });

  it("reads a destination ignored only through the user's core.excludesFile", () => {
    const { root, repo, env } = enclosing();
    const excludes = path.join(root, "global-excludes");
    fs.writeFileSync(excludes, "scratch/\n");
    const config = path.join(root, "gitconfig");
    fs.writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`);
    const reading = readMissing(path.join(repo, "scratch", "deep", "my-app"), {
      ...env,
      GIT_CONFIG_GLOBAL: config,
    });
    assert.deepEqual(reading, { kind: "ignored", toplevel: repo });
  });

  it("reads a destination whose name starts with a colon literally", () => {
    const { repo, env } = enclosing(["/:odd/"]);
    assert.deepEqual(readMissing(path.join(repo, ":odd"), env), {
      kind: "ignored",
      toplevel: repo,
    });
  });

  it("reads an existing empty directory the repository ignores", () => {
    const { repo, env } = enclosing(["my-app/"]);
    const dest = path.join(repo, "my-app");
    fs.mkdirSync(dest);
    assert.deepEqual(readExisting(dest, env), { kind: "ignored", toplevel: repo });
  });

  it("reads a directory ignored with everything else by *", () => {
    const { repo, env } = enclosing(["*"]);
    assert.deepEqual(readMissing(path.join(repo, "work", "my-app"), env), {
      kind: "ignored",
      toplevel: repo,
    });
  });

  for (const [what, patterns] of [
    ["* then !*/, which ignores its files alone", ["*", "!*/"]],
    ["my-app/*, which ignores what it holds alone", ["my-app/*", "!my-app/package.json"]],
  ]) {
    it(`reads a directory under ${what} as inside, whether or not it exists`, () => {
      const { repo, env } = enclosing(patterns);
      const dest = path.join(repo, "my-app");
      assert.deepEqual(readMissing(dest, env), { kind: "inside", toplevel: repo });
      assert.equal(fs.existsSync(dest), false, "the directory made for the reading is removed");
      fs.mkdirSync(dest);
      assert.deepEqual(readExisting(dest, env), { kind: "inside", toplevel: repo });
    });
  }

  it("reads a symlinked destination by the ignores of the repository it points into", () => {
    const { root, repo, env } = enclosing(["link"]);
    const setup = setupEnv(root);
    const theirs = path.join(root, "other");
    fs.mkdirSync(theirs);
    git(theirs, ["init", "-q", "-b", "main"], setup);
    fs.writeFileSync(path.join(theirs, "README.md"), "other\n");
    git(theirs, ["add", "-A"], setup);
    git(theirs, ["commit", "-q", "-m", "Other first commit"], setup);
    const target = path.join(theirs, "apps", "new");
    fs.mkdirSync(target, { recursive: true });
    const link = path.join(repo, "link");
    fs.symlinkSync(target, link);
    assert.deepEqual(readExisting(link, env), { kind: "inside", toplevel: theirs });
    fs.writeFileSync(path.join(theirs, ".gitignore"), "apps/new/\n");
    assert.deepEqual(readExisting(link, env), { kind: "ignored", toplevel: theirs });
  });

  it("reads a destination under a tracked path as inside", () => {
    const { repo, env } = enclosing(["*.log"]);
    assert.deepEqual(readMissing(path.join(repo, "src", "my-app"), env), {
      kind: "inside",
      toplevel: repo,
    });
  });
});
