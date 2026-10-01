// A whole run, against the stub make: what reaches make create, what is
// printed, and what never is.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import { decodePack } from "../lib/pack.mjs";
import {
  git,
  makeRecord,
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
  it("forwards every create value to make as one NAME=value word, in the contract's order", async () => {
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
    const env = { ...runEnv(root), MAKEFLAGS: "NAME=from-an-enclosing-make", MAKELEVEL: "1" };
    const { verdict, output } = await runInitializer(argv, { cwd: work, env });
    assert.equal(verdict, "copied", output);
    const record = makeRecord(root);
    assert.deepEqual(record.args, [
      "create",
      "METHOD=mt_forward",
      "NAME=my-pkg",
      `TITLE=${tricky("TITLE")}`,
      `DESCRIPTION=${tricky("DESCRIPTION")}`,
      "PIPE=main_pipe",
      `AUTHOR_NAME=${tricky("AUTHOR_NAME")}`,
      "AUTHOR_EMAIL=a@example.com",
      "REPO_URL=https://example.com/r",
      "LICENSE=mit",
      `LICENSE_HOLDER=${tricky("LICENSE_HOLDER")}`,
      "LICENSE_YEAR=2026",
      "DRY_RUN=1",
      "METHOD_NAME=receipts",
      `LABEL=${tricky("LABEL")}`,
    ]);
    assert.equal(record.cwd, path.join(work, "app"));
    assert.equal(
      record.makeflags,
      "unset",
      "an enclosing make's variables do not reach make create",
    );
    assert.equal(record.sawKey, true);
  });

  it("keeps a caller's GIT_DIR from make create, and from the repository it makes", async () => {
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
    assert.equal(makeRecord(root).gitDir, "unset");
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
    assert.ok(
      makeRecord(root).args.includes(`METHOD=${path.join(work, "methods", "receipt.mthds")}`),
    );

    for (const method of [
      "mt_abc123",
      "github.com/Pipelex/methods/text_stats@v0.1.1",
      "./no/such/bundle.mthds",
    ]) {
      const again = workspace();
      await runInitializer(["two", "--method", method], {
        cwd: again.work,
        env: runEnv(again.root),
      });
      assert.ok(makeRecord(again.root).args.includes(`METHOD=${method}`), method);
    }
  });

  it("prints the gesture's warnings once each, then the git outcome, then the verdict", async () => {
    const { root, work } = workspace();
    const { output } = await runInitializer(["app", "--method", "mt_1"], {
      cwd: work,
      env: runEnv(root),
    });
    const lines = output.trimEnd().split("\n");
    const summary = lines.slice(lines.indexOf("warnings from make create:"));
    assert.deepEqual(summary.slice(0, 3), [
      "warnings from make create:",
      "  ! the method declares no description",
      "  warning: LICENSE copyright line left untouched — pass --license-holder to claim it.",
    ]);
    assert.match(
      summary[3],
      /^git: made a repository on main and committed the template as [0-9a-f]{12}, "Start from /,
    );
    assert.equal(
      summary[4],
      `created ${path.join(work, "app")}; next: cd ${path.join(work, "app")} && make serve`,
    );
    assert.equal(summary.length, 5);
    assert.ok(output.includes("create: 5/6 run make all"), "the stream reaches the output");
  });

  it("with --quiet, writes make create's output to a log and prints its path", async () => {
    const { root, work } = workspace();
    const tmpDir = tempRoot();
    const { output, verdict } = await runInitializer(["app", "--method", "mt_1", "--quiet"], {
      cwd: work,
      env: runEnv(root),
      tmpDir,
    });
    assert.equal(verdict, "created");
    assert.ok(!output.includes("create: 5/6 run make all"), "the stream stays out of the output");
    const logFile = /its output goes to (\S+)$/m.exec(output)[1];
    assert.ok(logFile.startsWith(tmpDir));
    const log = fs.readFileSync(logFile, "utf8");
    assert.ok(log.includes("create: 5/6 run make all"));
    assert.ok(
      output.includes("  ! the method declares no description"),
      "the warnings still reach the summary",
    );
  });

  it("with --quiet, names the log when make create fails", async () => {
    const { root, work } = workspace();
    const { output, verdict } = await runInitializer(["app", "--method", "mt_1", "--quiet"], {
      cwd: work,
      env: runEnv(root, { makeExit: 2 }),
      tmpDir: tempRoot(),
    });
    assert.equal(verdict, "failed: create");
    assert.match(
      output.trimEnd().split("\n").at(-1),
      /make create exited 2\. The copy and its commit stand in .*the end of its log, \/.*make-create\.log, says what to run next/,
    );
  });

  it("never prints the key, whatever the verdict", async () => {
    const runs = [
      [["app", "--method", "mt_1"], {}],
      [["app", "--method", "mt_1", "--quiet"], {}],
      [["app", "--method", "mt_1"], { makeExit: 2 }],
      [["app"], {}],
      [["app", "--method", "mt_1", "--colour", "x"], {}],
      [["app", "--method", "mt_1"], { tools: ["git"] }],
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
        const log = path.join(tmpDir, dir, "make-create.log");
        if (fs.existsSync(log)) assert.ok(!fs.readFileSync(log, "utf8").includes(KEY));
      }
    }
  });

  it("makes the pristine commit with the family version and the source the pack names", async () => {
    const { root, work } = workspace();
    await runInitializer(["app", "--no-create"], { cwd: work, env: runEnv(root) });
    const pack = decodePack(fs.readFileSync(path.join(packs(), "webapp-js.pack")));
    const env = runEnv(root);
    assert.equal(
      git(path.join(work, "app"), ["log", "-1", "--format=%s"], env),
      `Start from Pipelex/pipelex-method-apps/webapp-js ${pack.version} (${pack.source})`,
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
      /commit it with git -C (\S+) init -q && git -C \1 symbolic-ref HEAD refs\/heads\/main && git -C \1 add --force -A && git -C \1 commit -m 'Start from .*', then run cd .* && make create METHOD=mt_1$/,
    );
    assert.ok(fs.existsSync(path.join(work, "app", "package.json")), "the copy stands");
    assert.equal(makeRecord(root), null, "make create did not run");
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
      /as [0-9a-f]{12}, "Start from Pipelex\/pipelex-method-apps\/webapp-js .*"\.$/,
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

  it("names the copy and the next make create after --no-create", async () => {
    const { root, work } = workspace();
    const { output } = await runInitializer(["my app", "--no-create", "--title", "Bob's app"], {
      cwd: work,
      env: runEnv(root),
    });
    const dest = path.join(work, "my app");
    assert.equal(
      output.trimEnd().split("\n").at(-1),
      `copied ${dest}; next: cd '${dest}' && make create METHOD=<method> 'TITLE=Bob'\\''s app'`,
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
      nodeVersion: "22.11.9",
    });
    assert.equal(code, 1);
    assert.match(
      output,
      /^refused: node-too-old — webapp-js needs Node 22\.12\.0 or later, and this is Node 22\.11\.9/m,
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
      assert.equal(makeRecord(root), null);
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
    assert.equal(makeRecord(root), null);
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
