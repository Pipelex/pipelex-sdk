// A whole run, against the stub npm: what reaches npm install and
// npm run create, what is printed, and what never is.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import { decodePack } from "../lib/pack.mjs";
import { loadTable, TABLE_FILE } from "../lib/templates.mjs";
import { shellQuote } from "../lib/verdict.mjs";
import {
  git,
  npmRecord,
  packs,
  runEnv,
  runInitializer,
  scopeIdentity,
  tempRoot,
} from "./support.mjs";

const KEY = "pk_test_never_printed_8d1f";

/** A fresh root with a `work/` directory to run from. */
function workspace() {
  const root = tempRoot("create-method-app-run-");
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  return { root, work };
}

describe("a run", () => {
  it("installs, then forwards every create value to npm run create as one argument, in the contract's order", async () => {
    const { root, work } = workspace();
    const tricky = (name) => `${name} Bob's "$5" \`x\` $(no) 'q'`;
    const flags = [
      ["--method", "METHOD", "mt_forward"],
      ["--name", "NAME", "my-pkg"],
      ["--title", "TITLE", tricky("TITLE")],
      ["--description", "DESCRIPTION", tricky("DESCRIPTION")],
      ["--pipe", "PIPE", "main_pipe"],
      ["--author-name", "AUTHOR_NAME", tricky("AUTHOR_NAME")],
      ["--author-email", "AUTHOR_EMAIL", "a@example.com"],
      ["--repo-url", "REPO_URL", "https://example.com/r"],
      ["--license", "LICENSE", "mit"],
      ["--license-holder", "LICENSE_HOLDER", tricky("LICENSE_HOLDER")],
      ["--license-year", "LICENSE_YEAR", "2026"],
      ["--method-name", "METHOD_NAME", "receipts"],
      ["--label", "LABEL", tricky("LABEL")],
    ];
    const argv = [
      "app",
      ...flags.reverse().flatMap(([flag, , value]) => [flag, value]),
      "--dry-run",
    ];
    const { verdict, output } = await runInitializer(argv, { cwd: work, env: runEnv(root) });
    assert.equal(verdict, "copied", output);
    const record = npmRecord(root);
    assert.deepEqual(
      record.calls.map((call) => call.args[0]),
      ["install", "run"],
      "npm install runs first, once",
    );
    assert.deepEqual(record.install.args, ["install"]);
    const words = [
      "mt_forward",
      "--name",
      "my-pkg",
      "--title",
      tricky("TITLE"),
      "--description",
      tricky("DESCRIPTION"),
      "--pipe",
      "main_pipe",
      "--author-name",
      tricky("AUTHOR_NAME"),
      "--author-email",
      "a@example.com",
      "--repo-url",
      "https://example.com/r",
      "--license",
      "mit",
      "--license-holder",
      tricky("LICENSE_HOLDER"),
      "--license-year",
      "2026",
      "--dry-run",
      "--method-name",
      "receipts",
      "--label",
      tricky("LABEL"),
    ];
    assert.deepEqual(record.create.args, ["run", "create", "--", ...words]);
    for (const call of record.calls) {
      assert.equal(call.cwd, path.join(work, "app"));
      assert.equal(call.sawKey, true);
    }
    const dest = path.join(work, "app");
    const next = words.filter((word) => word !== "--dry-run").map(shellQuote);
    assert.equal(
      output.trimEnd().split("\n").at(-1),
      `copied ${dest} (npm run create --dry-run changed nothing); next: cd ${dest} && npm run create -- ${next.join(" ")}`,
      "the next command drops --dry-run, and needs no install again",
    );
  });

  it("keeps a caller's GIT_DIR from npm, and from the repository it makes", async () => {
    const { root, work } = workspace();
    const theirs = path.join(root, "theirs");
    fs.mkdirSync(theirs);
    git(theirs, ["init", "-q"], runEnv(root));
    const env = { ...runEnv(root), GIT_DIR: path.join(theirs, ".git") };
    const { output, verdict } = await runInitializer(["app", "--method", "mt_1"], {
      cwd: work,
      env,
    });
    assert.equal(verdict, "created", output);
    for (const call of npmRecord(root).calls) assert.equal(call.gitDir, "unset");
    assert.equal(git(path.join(work, "app"), ["rev-list", "--count", "HEAD"], runEnv(root)), "1");
    assert.equal(fs.readdirSync(path.join(theirs, ".git", "refs", "heads")).length, 0);
  });

  it("makes a relative --method path absolute, and forwards anything else unchanged", async () => {
    const { root, work } = workspace();
    fs.mkdirSync(path.join(work, "methods"));
    fs.writeFileSync(path.join(work, "methods", "receipt.mthds"), 'domain = "receipt"\n');
    await runInitializer(["one", "--method", "methods/receipt.mthds"], {
      cwd: work,
      env: runEnv(root),
    });
    assert.ok(npmRecord(root).create.args.includes(path.join(work, "methods", "receipt.mthds")));

    for (const method of [
      "mt_abc123",
      "github.com/Pipelex/methods/text_stats@v0.2.0",
      "./no/such/bundle.mthds",
    ]) {
      const again = workspace();
      await runInitializer(["two", "--method", method], {
        cwd: again.work,
        env: runEnv(again.root),
      });
      assert.ok(npmRecord(again.root).create.args.includes(method), method);
    }
  });

  it("prints the gesture's warnings once each, then the git outcome, then the verdict", async () => {
    const { root, work } = workspace();
    const { output } = await runInitializer(["app", "--method", "mt_1"], {
      cwd: work,
      env: runEnv(root),
    });
    const lines = output.trimEnd().split("\n");
    const summary = lines.slice(lines.indexOf("warnings from npm run create:"));
    assert.deepEqual(summary.slice(0, 3), [
      "warnings from npm run create:",
      "  ! the method declares no description",
      "  warning: LICENSE copyright line left untouched — pass --license-holder to claim it.",
    ]);
    assert.match(
      summary[3],
      /^git: made a repository on main and committed the template as [0-9a-f]{12}, "Start from /,
    );
    assert.equal(
      summary[4],
      `created ${path.join(work, "app")}; next: cd ${path.join(work, "app")} && npm run serve`,
    );
    assert.equal(summary.length, 5);
    assert.ok(output.includes("create: 5/6 run npm run all"), "the stream reaches the output");
  });

  it("with --quiet, writes npm's output to a log and prints its path", async () => {
    const { root, work } = workspace();
    const tmpDir = tempRoot();
    const { output, verdict } = await runInitializer(["app", "--method", "mt_1", "--quiet"], {
      cwd: work,
      env: runEnv(root),
      tmpDir,
    });
    assert.equal(verdict, "created");
    assert.ok(
      !output.includes("create: 5/6 run npm run all"),
      "the stream stays out of the output",
    );
    const logFile = /their output goes to (\S+)$/m.exec(output)[1];
    assert.ok(logFile.startsWith(tmpDir));
    const log = fs.readFileSync(logFile, "utf8");
    assert.ok(log.includes("stub npm: installed"), "the install's output is in the log too");
    assert.ok(log.includes("create: 5/6 run npm run all"));
    assert.ok(
      output.includes("  ! the method declares no description"),
      "the warnings still reach the summary",
    );
  });

  it("with --quiet, names the log when npm run create fails", async () => {
    const { root, work } = workspace();
    const { output, verdict } = await runInitializer(["app", "--method", "mt_1", "--quiet"], {
      cwd: work,
      env: runEnv(root, { createExit: 2 }),
      tmpDir: tempRoot(),
    });
    assert.equal(verdict, "failed: create");
    assert.match(
      output.trimEnd().split("\n").at(-1),
      /npm run create exited 2\. The copy and its commit stand in .*the end of its log, .*create\.log, says what to run next/,
    );
  });

  it("runs no npm run create when npm install fails, and names both commands to run", async () => {
    const { root, work } = workspace();
    const { output, verdict } = await runInitializer(["app", "--method", "mt_1"], {
      cwd: work,
      env: runEnv(root, { installExit: 1 }),
    });
    assert.equal(verdict, "failed: create", output);
    const record = npmRecord(root);
    assert.notEqual(record.install, null);
    assert.equal(record.create, null, "npm run create did not run");
    const dest = path.join(work, "app");
    assert.equal(
      output.trimEnd().split("\n").at(-1),
      `failed: create — npm install exited 1, so npm run create did not start. The copy and its commit stand in ${dest}, and its own message above says why; once that is fixed, run cd ${dest} && npm install && npm run create -- mt_1`,
    );
    assert.ok(fs.existsSync(path.join(dest, "package.json")), "the copy stands");
  });

  it("leaves the install's stamp newer than the lock the gesture re-syncs, as make create does", async () => {
    const { root, work } = workspace();
    const env = { ...runEnv(root), STUB_NPM_MODULES: "1" };
    const { output, verdict } = await runInitializer(["app", "--method", "mt_1"], {
      cwd: work,
      env,
    });
    assert.equal(verdict, "created", output);
    const dest = path.join(work, "app");
    const stamp = fs.statSync(path.join(dest, "node_modules", ".lock-installed"));
    const lock = fs.statSync(path.join(dest, "package-lock.json"));
    assert.ok(stamp.mtimeMs >= lock.mtimeMs, "the stamp is not older than the lock");
  });

  it("never prints the key, whatever the verdict", async () => {
    const runs = [
      [["app", "--method", "mt_1"], {}],
      [["app", "--method", "mt_1", "--quiet"], {}],
      [["app", "--method", "mt_1"], { createExit: 2 }],
      [["app", "--method", "mt_1"], { installExit: 1 }],
      [["app"], {}],
      [["app", "--method", "mt_1", "--colour", "x"], {}],
      [["app", "--method", "mt_1"], { npm: false }],
    ];
    for (const [argv, options] of runs) {
      const { root, work } = workspace();
      const tmpDir = tempRoot();
      const { output } = await runInitializer(argv, {
        cwd: work,
        env: runEnv(root, options),
        tmpDir,
      });
      assert.ok(!output.includes(KEY), `${argv.join(" ")} printed the key`);
      for (const dir of fs.readdirSync(tmpDir)) {
        const log = path.join(tmpDir, dir, "create.log");
        if (fs.existsSync(log)) assert.ok(!fs.readFileSync(log, "utf8").includes(KEY));
      }
    }
  });

  it("makes the pristine commit with the version and the source the pack names", async () => {
    const { root, work } = workspace();
    await runInitializer(["app", "--no-create"], { cwd: work, env: runEnv(root) });
    const pack = decodePack(fs.readFileSync(path.join(packs(), "webapp-js.pack")));
    const env = runEnv(root);
    assert.equal(
      git(path.join(work, "app"), ["log", "-1", "--format=%s"], env),
      `Start from Pipelex/pipelex-sdk/method-apps/webapp-js ${pack.version} (${pack.source})`,
    );
    assert.equal(
      git(path.join(work, "app"), ["log", "-1", "--format=%an <%ae>"], env),
      "Case Runner <cases@example.com>",
    );
  });

  it("ends in failed: commit, with the copy standing, when git refuses the commit", async () => {
    const { root, work } = workspace();
    const env = runEnv(root);
    const hooks = path.join(root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(
      path.join(hooks, "pre-commit"),
      "#!/bin/sh\necho 'a global hook said no' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    fs.appendFileSync(env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${hooks}\n`);
    const { output, verdict, code } = await runInitializer(["app", "--method", "mt_1"], {
      cwd: work,
      env,
    });
    assert.equal(verdict, "failed: commit");
    assert.equal(code, 1);
    assert.ok(output.includes("a global hook said no"));
    assert.match(
      output.trimEnd().split("\n").at(-1),
      /commit it with git -C (\S+) init -q && git -C \1 symbolic-ref HEAD refs\/heads\/main && git -C \1 add --force -A && git -C \1 commit -m 'Start from .*', then run cd .* && npm install && npm run create -- mt_1$/,
    );
    assert.ok(fs.existsSync(path.join(work, "app", "package.json")), "the copy stands");
    assert.equal(npmRecord(root), null, "npm did not run");
  });

  it("commits every file of the template, whatever git is told to ignore", async () => {
    const { root, work } = workspace();
    const env = runEnv(root);
    const excludes = path.join(root, "global-excludes");
    fs.writeFileSync(excludes, ".vscode/\n.claude/\npackage-lock.json\n");
    fs.appendFileSync(env.GIT_CONFIG_GLOBAL, `[core]\n\texcludesFile = ${excludes}\n`);
    const dest = path.join(work, "app");
    fs.mkdirSync(dest);
    git(dest, ["init", "-q"], env);
    fs.writeFileSync(path.join(dest, ".git", "info", "exclude"), "*.md\n");

    const { output, verdict } = await runInitializer(["app", "--no-create"], { cwd: work, env });
    assert.equal(verdict, "copied", output);
    const packed = decodePack(fs.readFileSync(path.join(packs(), "webapp-js.pack")))
      .files.map((file) => file.path)
      .sort();
    assert.ok(
      packed.some((file) => file.startsWith(".claude/")),
      "the template carries .claude/",
    );
    assert.deepEqual(git(dest, ["ls-files"], env).split("\n").sort(), packed);
    assert.equal(git(dest, ["status", "--porcelain", "--ignored"], env), "");
  });

  it("makes its repository on main with a git that predates init -b", async () => {
    const { root, work } = workspace();
    const env = runEnv(root);
    const realGit = fs.realpathSync(path.join(env.PATH, "git"));
    fs.rmSync(path.join(env.PATH, "git"));
    fs.writeFileSync(
      path.join(env.PATH, "git"),
      `#!/bin/sh\nif [ "$1" = init ]; then for a in "$@"; do case "$a" in -b|--initial-branch*) echo "error: unknown switch 'b'" >&2; exit 129;; esac; done; fi\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    fs.appendFileSync(env.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = trunk\n");

    const { output, verdict } = await runInitializer(["app", "--no-create"], { cwd: work, env });
    assert.equal(verdict, "copied", output);
    const dest = path.join(work, "app");
    assert.equal(git(dest, ["symbolic-ref", "--short", "HEAD"], env), "main");
    assert.equal(git(dest, ["rev-list", "--count", "HEAD"], env), "1");
  });

  it("removes every directory its identity probe made when git has no identity there either", async () => {
    const { root, work } = workspace();
    const { output, verdict } = await runInitializer(["deep/er/app", "--no-create"], {
      cwd: work,
      env: runEnv(root, { identity: false }),
    });
    assert.equal(verdict, "refused: no-git-identity", output);
    assert.deepEqual(fs.readdirSync(work), []);
  });

  it("leaves a dangling symlink where its identity probe would have made a directory", async () => {
    for (const [link, typed] of [
      ["app", "app"],
      ["link", "link/app"],
    ]) {
      const { root, work } = workspace();
      const target = path.join(root, "unmounted", link);
      fs.symlinkSync(target, path.join(work, link));
      const { output, verdict } = await runInitializer([typed, "--no-create"], {
        cwd: work,
        env: runEnv(root, { identity: false }),
      });
      assert.equal(verdict, "refused: no-git-identity", output);
      assert.equal(fs.readlinkSync(path.join(work, link)), target);
    }
  });

  it("keeps what another process writes into a directory its identity probe made", async () => {
    const { root, work } = workspace();
    const env = runEnv(root, { identity: false });
    scopeIdentity(env, work);
    // The probe's `git init` is the moment: a wrapper writes beside the
    // destination, once, into the directory the probe has just made.
    const gitPath = path.join(env.PATH, "git");
    const realGit = fs.readlinkSync(gitPath);
    fs.rmSync(gitPath);
    fs.writeFileSync(
      gitPath,
      `#!/bin/sh\nif [ "$1" = init ] && [ ! -e "$RACE_MARK" ]; then : > "$RACE_MARK"; printf 'theirs\\n' > "$RACE_FILE"; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const theirs = path.join(work, "deep", "theirs.txt");
    const { output, verdict } = await runInitializer(["deep/app", "--no-create"], {
      cwd: work,
      env: { ...env, RACE_MARK: path.join(root, "race-mark"), RACE_FILE: theirs },
    });
    assert.equal(verdict, "copied", output);
    assert.equal(fs.readFileSync(theirs, "utf8"), "theirs\n");
  });

  it("commits with an identity git gives only to the repositories under a directory", async () => {
    const { root, work } = workspace();
    const env = runEnv(root, { identity: false });
    scopeIdentity(env, work);
    const { output, verdict } = await runInitializer(["deep/er/app", "--no-create"], {
      cwd: work,
      env,
    });
    assert.equal(verdict, "copied", output);
    assert.equal(
      git(path.join(work, "deep", "er", "app"), ["log", "-1", "--format=%an <%ae>"], env),
      "Scoped Runner <scoped@example.com>",
    );
  });

  it("names the repository that ignores the destination in its git outcome", async () => {
    const { root, work } = workspace();
    const env = runEnv(root);
    git(work, ["init", "-q"], env);
    fs.writeFileSync(path.join(work, ".gitignore"), "tmp/\n");
    fs.mkdirSync(path.join(work, "tmp"));
    const { output, verdict } = await runInitializer(["tmp/app", "--no-create"], {
      cwd: work,
      env,
    });
    assert.equal(verdict, "copied", output);
    const said = output.trimEnd().split("\n").at(-2);
    const expected = `git: ${work} ignores ${path.join(work, "tmp", "app")}, so the project got a repository of its own: made on main, with the template committed as `;
    assert.ok(said.startsWith(expected), said);
    assert.match(
      said,
      /as [0-9a-f]{12}, "Start from Pipelex\/pipelex-sdk\/method-apps\/webapp-js .*"\.$/,
    );
  });

  it("says a project is under no version control when its enclosing repository ignores every file of it", async () => {
    const { root, work } = workspace();
    const env = runEnv(root);
    git(work, ["init", "-q"], env);
    fs.writeFileSync(path.join(work, ".gitignore"), "*\n!*/\n");
    const { output, verdict } = await runInitializer(["app", "--no-create"], { cwd: work, env });
    assert.equal(verdict, "copied", output);
    const dest = path.join(work, "app");
    assert.equal(
      output.trimEnd().split("\n").at(-2),
      `git: ${dest} is inside the work tree of ${work}, which ignores every file of the project but not its directory, so no repository was made and the project is under no version control.`,
    );
    assert.equal(fs.existsSync(path.join(dest, ".git")), false);
  });

  it("does not say a project is under no version control when its enclosing repository tracks it", async () => {
    const { root, work } = workspace();
    const env = runEnv(root);
    git(work, ["init", "-q"], env);
    const first = await runInitializer(["app", "--no-create"], { cwd: work, env });
    assert.equal(first.verdict, "copied", first.output);
    git(work, ["add", "-A"], env);
    git(work, ["commit", "-q", "-m", "Their copy of the project"], env);
    const dest = path.join(work, "app");
    fs.rmSync(dest, { recursive: true });
    const { output, verdict } = await runInitializer(["app", "--no-create"], { cwd: work, env });
    assert.equal(verdict, "copied", output);
    assert.equal(git(work, ["status", "--porcelain"], env), "", "the copy is what was tracked");
    const said = output.trimEnd().split("\n").at(-2);
    assert.ok(
      said.startsWith(`git: ${dest} is inside the work tree of ${work}, so no repository was made`),
      said,
    );
    assert.doesNotMatch(said, /under no version control/);
  });

  it("names the copy and the next npm install and npm run create after --no-create", async () => {
    const { root, work } = workspace();
    const { output } = await runInitializer(["my app", "--no-create", "--title", "Bob's app"], {
      cwd: work,
      env: runEnv(root),
    });
    const dest = path.join(work, "my app");
    assert.equal(
      output.trimEnd().split("\n").at(-1),
      `copied ${dest}; next: cd '${dest}' && npm install && npm run create -- <method> --title 'Bob'\\''s app'`,
    );
  });

  it("refuses a Node below the template's floor", async () => {
    const { root, work } = workspace();
    let output = "";
    const { run } = await import("../lib/main.mjs");
    const code = await run(["app", "--method", "mt_1"], {
      cwd: work,
      env: runEnv(root),
      out: { write: (text) => (output += text) },
      packDir: packs(),
      nodeVersion: "22.12.9",
    });
    assert.equal(code, 1);
    assert.match(
      output,
      /^refused: node-too-old — webapp-js needs Node 22\.13\.0 or later, and this is Node 22\.12\.9/m,
    );
    assert.equal(fs.existsSync(path.join(work, "app")), false);
  });

  it("reads no template or ecosystem from what every object inherits", async () => {
    const { root, work } = workspace();
    for (const template of ["toString", "__proto__", "foo-constructor"]) {
      const { output, verdict } = await runInitializer(
        ["app", "--method", "mt_1", "--template", template],
        { cwd: work, env: runEnv(root) },
      );
      assert.equal(verdict, "refused: unknown-template", output);
      assert.ok(!output.includes("native code"), output);
    }
    assert.deepEqual(fs.readdirSync(work), []);
  });

  it("sends a Python template to the copy-out its README shows, writing nothing", async () => {
    const { root, work } = workspace();
    const { output, verdict } = await runInitializer(
      ["app", "--method", "mt_1", "--template", "cli-python"],
      { cwd: work, env: runEnv(root) },
    );
    assert.equal(verdict, "refused: other-ecosystem", output);
    assert.ok(
      output.includes(
        "no initializer serves it yet: copy it out of a release of Pipelex/pipelex-sdk as https://github.com/Pipelex/pipelex-sdk/tree/main/method-apps/cli-python#start-a-project-from-the-template shows",
      ),
      output,
    );
    assert.ok(!output.includes("uvx"), output);
    assert.deepEqual(fs.readdirSync(work), []);
  });

  it("sends another ecosystem's template to that ecosystem's initializer once it has one", async () => {
    const { root, work } = workspace();
    const raw = JSON.parse(fs.readFileSync(TABLE_FILE, "utf8"));
    raw.otherEcosystems.python = { initializer: "uvx create-pipelex-method-app" };
    const file = path.join(root, "templates.json");
    fs.writeFileSync(file, JSON.stringify(raw));
    const { output, verdict } = await runInitializer(
      ["app", "--method", "mt_1", "--template", "cli-python"],
      { cwd: work, env: runEnv(root), table: loadTable(file) },
    );
    assert.equal(verdict, "refused: other-ecosystem", output);
    assert.ok(
      output.includes(
        "uvx create-pipelex-method-app serves it: run uvx create-pipelex-method-app <dir> --template cli-python --method",
      ),
      output,
    );
    assert.deepEqual(fs.readdirSync(work), []);
  });

  it(
    "refuses a destination beneath a directory it cannot read, writing nothing",
    {
      skip: process.getuid?.() === 0 && "root reads every directory",
    },
    async () => {
      const { root, work } = workspace();
      const locked = path.join(work, "locked");
      fs.mkdirSync(locked, { mode: 0o000 });
      try {
        const { output, verdict } = await runInitializer(["locked/app", "--method", "mt_1"], {
          cwd: work,
          env: runEnv(root),
        });
        assert.equal(verdict, "refused: unusable-destination", output);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
      assert.deepEqual(fs.readdirSync(locked), []);
      assert.equal(npmRecord(root), null);
    },
  );

  it("ends in failed: write, having removed what it created, when interrupted", async () => {
    const { root, work } = workspace();
    const controller = new AbortController();
    const { output, verdict } = await (async () => {
      let text = "";
      const { run } = await import("../lib/main.mjs");
      const out = {
        write: (chunk) => {
          text += chunk;
          if (chunk.includes("writing webapp-js")) controller.abort("SIGINT");
        },
      };
      await run(["app", "--method", "mt_1"], {
        cwd: work,
        env: runEnv(root),
        out,
        packDir: packs(),
        signal: controller.signal,
      });
      return { output: text, verdict: text.trimEnd().split("\n").at(-1).split(" — ")[0] };
    })();
    assert.equal(verdict, "failed: write", output);
    assert.deepEqual(fs.readdirSync(work), []);
    assert.equal(npmRecord(root), null);
  });

  it("ends in failed: write when the package carries no pack", async () => {
    const { root, work } = workspace();
    let output = "";
    const { run } = await import("../lib/main.mjs");
    await run(["app", "--method", "mt_1"], {
      cwd: work,
      env: runEnv(root),
      out: { write: (text) => (output += text) },
      packDir: tempRoot(),
    });
    assert.match(
      output,
      /^failed: write — this copy of the initializer carries no packed webapp-js/m,
    );
    assert.deepEqual(fs.readdirSync(work), []);
  });

  it("prints its help and its version, and exits 0", async () => {
    const { root, work } = workspace();
    const help = await runInitializer(["--help"], { cwd: work, env: runEnv(root) });
    assert.equal(help.code, 0);
    assert.match(help.output, /usage: npm create @pipelex\/method-app@latest <dir> -- --method/);
    const version = await runInitializer(["--version"], { cwd: work, env: runEnv(root) });
    assert.equal(
      version.output.trim(),
      JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    );
  });
});
