// The family's table of cases, `initializers/cases.json`, executed against this
// initializer. The Python twin executes the same table, so the two print the
// same verdict for the same destination, git state and flags. The legend in
// the file says what each field sets up and what each expectation means.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { decodePack } from "../lib/pack.mjs";
import {
  git,
  listTree,
  makeRecord,
  packs,
  runEnv,
  runInitializer,
  scopeIdentity,
  setupEnv,
  tempRoot,
} from "./support.mjs";

const TABLE = JSON.parse(fs.readFileSync(new URL("../../cases.json", import.meta.url), "utf8"));

/** A template the other ecosystem's initializer serves. */
const OTHER_ECOSYSTEM = "cli-python";

/**
 * For each `within` inside an enclosing repository: what its committed
 * `.gitignore` holds, and the directory under its root the destination's
 * parent is.
 */
const ENCLOSING = {
  "work-tree": { ignores: [], under: "" },
  "template-checkout": { ignores: [], under: "" },
  "ignored-parent": { ignores: ["tmp/"], under: "tmp" },
  "ignored-by-name": { ignores: ["my-app/"], under: "" },
  "re-included": { ignores: ["apps/*", "!apps/my-app/"], under: "apps" },
  "ignores-everything": { ignores: ["*"], under: "" },
  "ignores-files-only": { ignores: ["*", "!*/"], under: "" },
  "contents-ignored": { ignores: ["my-app/*", "!my-app/package.json"], under: "" },
};

/** The destination's parent, inside what the case says. */
function within(root, kind) {
  const env = setupEnv(root);
  if (kind === undefined || kind === "nothing") {
    const parent = path.join(root, "work");
    fs.mkdirSync(parent);
    return { parent, repo: null };
  }
  if (!Object.hasOwn(ENCLOSING, kind)) throw new Error(`cases.json: unknown within ${kind}`);
  const { ignores, under } = ENCLOSING[kind];
  const repo = path.join(root, "theirs");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"], env);
  fs.writeFileSync(path.join(repo, "README.md"), "theirs\n");
  if (ignores.length > 0)
    fs.writeFileSync(path.join(repo, ".gitignore"), `${ignores.join("\n")}\n`);
  git(repo, ["add", "--force", "-A"], env);
  git(repo, ["commit", "-q", "-m", "Their first commit"], env);
  const origin =
    kind === "template-checkout"
      ? "https://github.com/Pipelex/pipelex-method-apps.git"
      : "https://github.com/someone/theirs.git";
  git(repo, ["remote", "add", "origin", origin], env);
  const parent = path.join(repo, under);
  fs.mkdirSync(parent, { recursive: true });
  return { parent, repo };
}

/** Put what the case says at the destination. */
function destination(dest, kind, env) {
  switch (kind) {
    case "missing":
      return;
    case "empty":
      fs.mkdirSync(dest);
      return;
    case "git-without-commit":
      fs.mkdirSync(dest);
      git(dest, ["init", "-q"], env);
      return;
    case "git-with-history":
      fs.mkdirSync(dest);
      git(dest, ["init", "-q"], env);
      fs.writeFileSync(path.join(dest, "old.txt"), "old\n");
      git(dest, ["add", "old.txt"], env);
      git(dest, ["commit", "-q", "-m", "History"], env);
      fs.rmSync(path.join(dest, "old.txt"));
      return;
    case "git-with-staged-file":
      fs.mkdirSync(dest);
      git(dest, ["init", "-q"], env);
      fs.writeFileSync(path.join(dest, "notes.txt"), "mine\n");
      git(dest, ["add", "notes.txt"], env);
      fs.rmSync(path.join(dest, "notes.txt"));
      return;
    case "ds-store":
      fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, ".DS_Store"), "");
      return;
    case "user-file":
      fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, "notes.txt"), "mine\n");
      return;
    case "beneath-a-file":
      fs.writeFileSync(path.dirname(dest), "mine\n");
      return;
    default:
      throw new Error(`cases.json: unknown destination ${kind}`);
  }
}

/** What stands at a path, to compare before and after a run that writes nothing. */
function snapshot(dest, env) {
  if (!fs.existsSync(dest)) return { exists: false };
  const hasGit = fs.existsSync(path.join(dest, ".git"));
  return {
    exists: true,
    files: listTree(dest),
    head: hasGit ? headOf(dest, env) : null,
  };
}

function headOf(repo, env) {
  try {
    return git(repo, ["rev-parse", "HEAD"], env);
  } catch {
    return null;
  }
}

const packedFiles = () => decodePack(fs.readFileSync(path.join(packs(), "webapp-js.pack"))).files;

describe("initializers/cases.json", () => {
  for (const c of TABLE.cases) {
    it(c.name, async () => {
      const root = tempRoot("create-method-app-case-");
      const env = setupEnv(root);
      const { parent, repo } = within(root, c.within);
      const leaf = c.spelled === "space" ? "my app" : "my-app";
      const name = c.destination === "beneath-a-file" ? `notes.txt/${leaf}` : leaf;
      const dest = path.join(parent, name);
      destination(dest, c.destination, env);
      const before = snapshot(dest, env);
      const enclosingHead = repo === null ? null : headOf(repo, env);

      const argv = [];
      if (c.spelled === "dot") argv.push(".");
      else if (c.spelled !== "absent") argv.push(name);
      if (c.method !== false) argv.push("--method", "mt_case");
      argv.push(
        ...(c.args ?? []).map((arg) => (arg === "{other-ecosystem}" ? OTHER_ECOSYSTEM : arg)),
      );

      const identity = c.git_identity ?? true;
      const runsIn = runEnv(root, {
        tools: c.tools,
        identity: identity === true,
        key: c.key !== false,
        makeExit: c.make_exit ?? 0,
      });
      if (identity === "under-parent") scopeIdentity(runsIn, parent);
      if (identity === "enclosing-only") {
        if (repo === null)
          throw new Error("cases.json: enclosing-only needs an enclosing repository");
        git(repo, ["config", "user.name", "Enclosing Runner"], env);
        git(repo, ["config", "user.email", "enclosing@example.com"], env);
      }
      const { code, output, verdict } = await runInitializer(argv, {
        cwd: c.spelled === "dot" ? dest : parent,
        env: runsIn,
      });

      const expect = c.expect;
      assert.equal(verdict, expect.verdict, output);
      assert.equal(code, ["created", "copied"].includes(verdict) ? 0 : 1, output);

      if (expect.written) {
        assert.deepEqual(
          listTree(dest),
          packedFiles()
            .map((file) => file.path)
            .sort(),
          output,
        );
      } else {
        assert.deepEqual(snapshot(dest, env), before, output);
      }

      const record = makeRecord(root);
      assert.equal(record !== null, expect.make, output);
      for (const arg of expect.forwarded ?? []) {
        assert.ok(record.args.includes(arg), `${arg} not among ${JSON.stringify(record.args)}`);
      }

      const pristine =
        /^Start from Pipelex\/pipelex-method-apps\/webapp-js \d+\.\d+\.\d+ \([0-9a-f]{40}(-dirty)?\)$/;
      switch (expect.git) {
        case "initialized":
          assert.equal(git(dest, ["rev-parse", "--show-prefix"], env), "");
          assert.equal(git(dest, ["symbolic-ref", "--short", "HEAD"], env), "main");
          assert.equal(git(dest, ["rev-list", "--count", "HEAD"], env), "1");
          assert.match(git(dest, ["log", "-1", "--format=%s"], env), pristine);
          assert.equal(
            git(dest, ["status", "--porcelain"], env),
            "",
            "the commit holds the whole copy",
          );
          if (repo !== null) {
            assert.equal(headOf(repo, env), enclosingHead, "the enclosing repository did not move");
            assert.equal(
              git(repo, ["status", "--porcelain", "--untracked-files=all"], env),
              "",
              "the enclosing repository sees nothing of the project",
            );
          }
          break;
        case "first-commit":
          assert.equal(git(dest, ["rev-list", "--count", "HEAD"], env), "1");
          assert.match(git(dest, ["log", "-1", "--format=%s"], env), pristine);
          assert.equal(
            git(dest, ["status", "--porcelain"], env),
            "",
            "the commit holds the whole copy",
          );
          break;
        case "none":
          assert.equal(
            fs.existsSync(path.join(dest, ".git")),
            false,
            "no repository inside the destination",
          );
          if (repo !== null)
            assert.equal(headOf(repo, env), enclosingHead, "the enclosing repository did not move");
          break;
        case "untouched":
          assert.deepEqual(snapshot(dest, env), before);
          break;
        case undefined:
          break;
        default:
          throw new Error(`cases.json: unknown git expectation ${expect.git}`);
      }
    });
  }
});
