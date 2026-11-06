// The create proofs' offline half: the arguments, the refusals before anything runs, each check
// a proof makes on a created copy, and the table of templates held to the templates themselves.
// The live half runs only under the root's `make live-create`. Run with `node --test`, as the
// root has no dependencies.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  API_KEY_ENV,
  BASE_URL_ENV,
  CLI_RUNS,
  ROOT,
  STOP_SIGNALS,
  TEMPLATES,
  checkCliIdentity,
  checkEnvFile,
  checkPage,
  checkPaths,
  checkWebappIdentity,
  childEnv,
  copyTemplate,
  envAssignments,
  filesHolding,
  main,
  parseArgs,
  pyprojectIdentity,
  shownUrl,
  templateTree,
} from "./live-create.mjs";

const BASE_URL = "https://api-dev.pipelex.com";
const WEBAPP = TEMPLATES["method-apps/webapp-js"];
const CLI = TEMPLATES["method-apps/cli-python"];

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory holding `files`, a map from path to content, each file with `mode`. */
function copyOf(files, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-create-test-"));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content, { mode });
  }
  return dir;
}

/** Run `main` with its console output captured. */
async function run(argv, options) {
  const lines = { out: [], err: [] };
  const log = console.log;
  const error = console.error;
  console.log = (line) => lines.out.push(line);
  console.error = (line) => lines.err.push(line);
  try {
    return { code: await main(argv, options), ...lines };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("the arguments", () => {
  it("take the template's own proofs when no method is named", () => {
    assert.deepEqual(parseArgs(["--template", "method-apps/webapp-js"]), {
      template: "method-apps/webapp-js",
      methods: WEBAPP.methods,
    });
  });

  it("take each method named, in order, and a template with a trailing slash", () => {
    assert.deepEqual(parseArgs(["--template", "method-apps/cli-python/", "--method", "a", "--method", "b c"]), {
      template: "method-apps/cli-python",
      methods: ["a", "b c"],
    });
  });

  it("refuse a template with no create proof, an unknown argument, and a flag without its value", () => {
    assert.throws(() => parseArgs(["--template", "starter-js"]), /not a method-app template with a create proof/);
    assert.throws(() => parseArgs([]), /Name the template/);
    assert.throws(() => parseArgs(["--template", "method-apps/webapp-js", "--fast"]), /Unknown argument/);
    assert.throws(() => parseArgs(["--template", "method-apps/webapp-js", "--method"]), /--method needs a value/);
    assert.throws(() => parseArgs(["--template", "method-apps/webapp-js", "--method", ""]), /--method needs a value/);
  });
});

describe("the refusals before anything runs", () => {
  it("exit 2 on a usage error", async () => {
    const result = await run(["--template", "nowhere"], { env: {} });
    assert.equal(result.code, 2);
    assert.match(result.err.join("\n"), /not a method-app template/);
  });

  it("exit 2 without a base URL, naming who sets it", async () => {
    const result = await run(["--template", "method-apps/webapp-js"], { env: { [API_KEY_ENV]: "set" } });
    assert.equal(result.code, 2);
    assert.match(result.err.join("\n"), /PIPELEX_BASE_URL is not set.*make live-create/);
  });

  it("exit 2 without a key, naming test-account run", async () => {
    const result = await run(["--template", "method-apps/webapp-js"], { env: { [BASE_URL_ENV]: BASE_URL } });
    assert.equal(result.code, 2);
    assert.match(result.err.join("\n"), /PIPELEX_API_KEY is not set.*test-account run/);
  });
});

describe("a base URL as the lines show it", () => {
  it("is its scheme and host alone", () => {
    assert.equal(shownUrl("https://someone:secret-word@api-dev.pipelex.com:8443/v1?token=x#y"), "https://api-dev.pipelex.com:8443");
  });

  it("is never the text of a value that is not a URL", () => {
    assert.equal(shownUrl("secret-word"), "a value that is not a URL");
  });
});

describe("the env file the gesture wrote", () => {
  it("reads each assignment of a variable, unquoted, an exported one included", () => {
    const text = `# comment\nexport ${BASE_URL_ENV}='${BASE_URL}'\n${API_KEY_ENV}=\n${BASE_URL_ENV} = "x"\nOTHER=1\n`;
    assert.deepEqual(envAssignments(text, BASE_URL_ENV), [BASE_URL, "x"]);
    assert.deepEqual(envAssignments(text, API_KEY_ENV), [""]);
  });

  it("passes with one base URL line, the one the run used, an empty key line, readable by its owner alone", () => {
    const copy = copyOf({ ".env": `${BASE_URL_ENV}='${BASE_URL}'\n${API_KEY_ENV}=\n` });
    assert.deepEqual(checkEnvFile(copy, ".env", BASE_URL), []);
  });

  it("names a key line with a value without showing the value", () => {
    const copy = copyOf({ ".env.local": `${BASE_URL_ENV}=${BASE_URL}\n${API_KEY_ENV}=a-key-value\n` });
    const failures = checkEnvFile(copy, ".env.local", BASE_URL);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /gives PIPELEX_API_KEY a value, which is not shown/);
    assert.doesNotMatch(failures[0], /a-key-value/);
  });

  it("names a missing key line, two base URL lines, and a file others can read", () => {
    const copy = copyOf({ ".env": `${BASE_URL_ENV}=${BASE_URL}\n${BASE_URL_ENV}=${BASE_URL}\n` }, 0o644);
    assert.deepEqual(checkEnvFile(copy, ".env", BASE_URL), [
      ".env is readable beyond its owner, mode 644",
      ".env assigns PIPELEX_BASE_URL on 2 lines, where the gesture writes one line",
      ".env assigns PIPELEX_API_KEY nowhere, where the gesture writes one empty line",
    ]);
  });

  it("names another base URL by its scheme and host, and says when the two differ past the host", () => {
    const other = copyOf({ ".env": `${BASE_URL_ENV}=https://api.pipelex.com\n${API_KEY_ENV}=\n` });
    assert.deepEqual(checkEnvFile(other, ".env", BASE_URL), [
      ".env sets PIPELEX_BASE_URL to https://api.pipelex.com, not to the https://api-dev.pipelex.com the run used",
    ]);
    const pastHost = copyOf({ ".env": `${BASE_URL_ENV}=${BASE_URL}/secret-path\n${API_KEY_ENV}=\n` });
    const [failure] = checkEnvFile(pastHost, ".env", BASE_URL);
    assert.match(failure, /the two differing past the host$/);
    assert.doesNotMatch(failure, /secret-path/);
  });

  it("names a file the gesture did not write", () => {
    assert.deepEqual(checkEnvFile(copyOf({}), ".env.local", BASE_URL), [".env.local was not written"]);
  });
});

describe("the template's own paths", () => {
  it("name a removed path still there and a kept path gone", () => {
    const copy = copyOf({ "scripts/create.py": "", "docs/other.md": "" });
    assert.deepEqual(checkPaths(copy, CLI), ["scripts/create.py is still there", ".claude/skills/bump-sdk is gone, where the project keeps it"]);
  });

  it("pass once the gesture removed and kept what it promised", () => {
    assert.deepEqual(checkPaths(copyOf({ ".claude/skills/bump-sdk/SKILL.md": "" }), CLI), []);
  });
});

describe("a created web app's name", () => {
  it("must no longer be the template's", () => {
    assert.deepEqual(checkWebappIdentity(copyOf({ "package.json": JSON.stringify({ name: WEBAPP.identity }) }), WEBAPP).failures, [
      "package.json still carries the template's name, pipelex-method-webapp-js",
    ]);
    assert.deepEqual(checkWebappIdentity(copyOf({ "package.json": JSON.stringify({ name: "receipt-review" }) }), WEBAPP), {
      failures: [],
      name: "receipt-review",
    });
  });
});

const PYPROJECT = `[project]\nname = "receipt-review"\nversion = "0.1.0"\n\n[project.scripts]\nreceipt-review = "receipt_review.cli:main"\n\n[tool.uv]\nname = "not-this"\n`;

describe("a created CLI's identity", () => {
  it("reads the project's name and its scripts from pyproject.toml", () => {
    assert.deepEqual(pyprojectIdentity(PYPROJECT), {
      name: "receipt-review",
      scripts: [{ command: "receipt-review", target: "receipt_review.cli:main" }],
    });
  });

  it("passes once the distribution, the package and the command are the method's, the template's import name left only where the grep skips", () => {
    const copy = copyOf({
      "pyproject.toml": PYPROJECT,
      "src/receipt_review/cli.py": "",
      ".git/objects/x": "pipelex_method_cli_python",
      ".venv/lib/x.py": "pipelex_method_cli_python",
      "scripts/__pycache__/create.pyc": "pipelex_method_cli_python",
    });
    assert.deepEqual(checkCliIdentity(copy, CLI), { failures: [], command: "receipt-review" });
  });

  it("names the template's name, a command not the method's, a missing package, and every file still holding the template's import name", () => {
    const copy = copyOf({
      "pyproject.toml": `[project]\nname = "${CLI.identity}"\n\n[project.scripts]\nother = "x.cli:main"\n`,
      "Makefile": "pipelex_method_cli_python",
      "src/x/a.py": "import pipelex_method_cli_python",
    });
    assert.deepEqual(checkCliIdentity(copy, CLI).failures, [
      "pyproject.toml still carries the template's name, pipelex-method-cli-python",
      '[project.scripts] declares other = "x.cli:main", where the gesture declares only pipelex-method-cli-python = "pipelex_method_cli_python.cli:main"',
      "src/pipelex_method_cli_python is not there",
      "pipelex_method_cli_python is still in Makefile, src/x/a.py",
    ]);
  });

  it("finds a name in any file, binary ones included, outside the skipped directories at any depth", () => {
    const copy = copyOf({ "a/b/data.bin": Buffer.from([0, 1, ...Buffer.from("needle"), 2]), "a/.git/c": "needle", "d.txt": "no" });
    assert.deepEqual(filesHolding(copy, "needle"), [path.join("a", "b", "data.bin")]);
  });
});

describe("the created web app's page", () => {
  const form = `<html><head><title>Receipt Review</title></head><body><h1>Receipt Review</h1><form class="x"></form></body></html>`;

  it("passes with a title of its own and the method's form", () => {
    assert.deepEqual(checkPage(form, WEBAPP), { failures: [], title: "Receipt Review" });
    assert.equal(checkPage(form.replaceAll("Receipt Review", "Bob&#x27;s &amp; Co"), WEBAPP).title, "Bob's & Co");
  });

  it("names the template's title, the empty state and a page with no form", () => {
    assert.deepEqual(checkPage(`<title>${WEBAPP.title}</title><h2>No method yet</h2>`, WEBAPP).failures, [
      `the page is still titled "${WEBAPP.title}", the template's own title`,
      "the page shows the empty state, no method",
    ]);
    assert.deepEqual(checkPage("<title>Receipt Review</title><formula/>", WEBAPP).failures, ["the page shows no form"]);
    assert.deepEqual(checkPage("<form></form>", WEBAPP).failures, ["the page has no title"]);
  });
});

describe("the environment a proof's commands run with", () => {
  it("drops what the root's make set for itself and the template's host and port, keeps the rest, and turns telemetry off", () => {
    const env = childEnv({
      MAKEFLAGS: "IN=method-apps/webapp-js",
      MAKELEVEL: "1",
      MFLAGS: "-s",
      MAKEOVERRIDES: "x",
      APP_HOST: "0.0.0.0",
      APP_PORT: "4301",
      [BASE_URL_ENV]: BASE_URL,
      [API_KEY_ENV]: "set",
      PATH: "/bin",
    });
    assert.deepEqual(env, { [BASE_URL_ENV]: BASE_URL, [API_KEY_ENV]: "set", PATH: "/bin", DO_NOT_TRACK: "1" });
  });
});

describe("the table of templates", () => {
  for (const [template, spec] of Object.entries(TEMPLATES)) {
    it(`matches ${template} as this repository holds it`, () => {
      const dir = path.join(ROOT, template);
      if (spec.kind === "webapp") {
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).name, spec.identity);
        assert.match(fs.readFileSync(path.join(dir, "src", "site.ts"), "utf-8"), new RegExp(`title: "${spec.title}"`));
      } else {
        assert.equal(pyprojectIdentity(fs.readFileSync(path.join(dir, "pyproject.toml"), "utf-8")).name, spec.identity);
      }
      for (const own of [...spec.removed, ...spec.kept, ".env.example"]) {
        assert.ok(fs.existsSync(path.join(dir, own)), `${template}/${own}`);
      }
      for (const method of spec.methods.filter((m) => !m.startsWith("github.com/"))) {
        assert.ok(fs.statSync(path.join(dir, method)).isDirectory(), `${template}/${method}`);
      }
    });
  }

  it("gives each created command a run whose files exist", () => {
    for (const { args } of Object.values(CLI_RUNS)) {
      for (const arg of args.filter((a) => path.isAbsolute(a))) assert.ok(fs.existsSync(arg), arg);
    }
  });
});

/** A git environment of its own: no system or user configuration, and an author given where needed. */
function gitEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-create-test-home-"));
  dirs.push(home);
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), ...extra };
}

function git(cwd, env, ...args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf-8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A repository whose `tpl/` is committed, then changed: one file edited, one added, an env file beside them. */
function checkoutWithChanges() {
  const repo = copyOf({ "tpl/kept.txt": "as committed\n", "tpl/.gitignore": ".env.local\n", "other.txt": "outside\n" }, 0o644);
  const env = gitEnv();
  git(repo, env, "init", "-q");
  git(repo, env, "add", "-A");
  git(repo, env, "-c", "user.name=test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  return { repo, env };
}

describe("the template a proof copies", () => {
  it("is the template as HEAD holds it when the checkout holds no change", async () => {
    const { repo, env } = checkoutWithChanges();
    assert.equal(await templateTree(repo, "tpl", env), git(repo, env, "rev-parse", "HEAD:tpl").trim());
  });

  it("holds the checkout's uncommitted changes and untracked files, never an ignored one, and leaves its index alone", async () => {
    const { repo, env } = checkoutWithChanges();
    fs.writeFileSync(path.join(repo, "tpl", "kept.txt"), "as bumped\n");
    fs.writeFileSync(path.join(repo, "tpl", "added.txt"), "new\n");
    fs.writeFileSync(path.join(repo, "tpl", ".env.local"), "PIPELEX_API_KEY=never-copied\n");
    const status = git(repo, env, "status", "--porcelain");
    const tree = await templateTree(repo, "tpl", env);
    assert.notEqual(tree, git(repo, env, "rev-parse", "HEAD:tpl").trim());
    assert.equal(git(repo, env, "status", "--porcelain"), status);

    // A machine may give git no author at all outside the repositories it configures.
    const strict = gitEnv();
    fs.writeFileSync(strict.GIT_CONFIG_GLOBAL, "[user]\n\tuseConfigOnly = true\n");
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "live-create-test-copy-")), "proof");
    dirs.push(path.dirname(copy));
    await copyTemplate(repo, tree, copy, strict);
    assert.deepEqual(fs.readdirSync(copy).sort(), [".git", ".gitignore", "added.txt", "kept.txt"]);
    assert.equal(fs.readFileSync(path.join(copy, "kept.txt"), "utf-8"), "as bumped\n");
    assert.equal(git(copy, strict, "status", "--porcelain"), "");
    assert.equal(git(copy, strict, "log", "--format=%an %s").trim(), "live-create as copied");
  });
});

describe("a signal while a step's command runs", () => {
  const script = pathToFileURL(path.join(ROOT, "scripts", "live-create.mjs")).href;
  for (const [signal, code] of Object.entries(STOP_SIGNALS)) {
    it(`stops the run on ${signal} before the next step, with ${code}`, () => {
      // A terminal's Ctrl-C reaches the step's command and this process together; the command
      // here signals its parent, which is the same ordering.
      const program = [
        'import { spawnSync } from "node:child_process";',
        `import { settle, stopOnSignals } from ${JSON.stringify(script)};`,
        'stopOnSignals({ onStop: () => console.log("servers stopped") });',
        `spawnSync("sh", ["-c", "kill -${signal.slice(3)} $PPID; sleep 0.2"]);`,
        "await settle();",
        'console.log("next step");',
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf-8" });
      assert.equal(result.status, code, result.stderr);
      assert.equal(result.stdout, "servers stopped\n");
      assert.match(result.stderr, new RegExp(`stopped by ${signal}`));
    });
  }
});
