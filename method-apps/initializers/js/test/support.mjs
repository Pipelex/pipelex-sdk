// What the initializer's suites share: throwaway directories, the template
// packed from this checkout, a stub npm that records how it was called, named
// to the initializer by `npm_execpath` as npm names itself under `npm create`,
// a PATH holding the real git alone, and a git configuration of the suite's
// own, so that no hook, identity or signing setting of the machine's reaches
// a test. The stub is a Node script and every path is built with Node, so the
// suites need no POSIX shell.

import { execFileSync } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

import { run } from "../lib/main.mjs";
import { packAll, FAMILY_ROOT } from "../scripts/pack-templates.mjs";

export { FAMILY_ROOT };

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway directory, by its real path, since macOS reaches the temporary directory through a symlink. */
export function tempRoot(prefix = "create-method-app-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

let packDir;
/** The templates packed from this checkout as it stands, once per process. */
export function packs() {
  if (packDir === undefined) {
    packDir = tempRoot("create-method-app-packs-");
    packAll(FAMILY_ROOT, { outDir: packDir });
  }
  return packDir;
}

/** Where `tool` is on this process's PATH, or null. */
function which(tool) {
  const windows = process.platform === "win32";
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const names = windows
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => `${tool}${ext}`)
    : [tool];
  for (const dir of (process.env[pathKey] ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

const REAL_GIT = which("git");

/**
 * A stand-in for npm, run as npm's own script is, with Node. Each call
 * appends a line to `$STUB_NPM_RECORD.calls`: its arguments, the directory it
 * ran in, what reached it through GIT_DIR, and whether it saw a key. Its
 * `install` prints a line and exits with STUB_NPM_INSTALL_EXIT, having made
 * `node_modules` with STUB_NPM_MODULES, with which its `run create` also
 * rewrites `package-lock.json`, as the gesture's lock re-sync does. Its
 * `run create` prints the way `npm run create` does, warnings included, each
 * of the bootstrap's twice, and exits with STUB_NPM_EXIT, or, with
 * STUB_NPM_HANG, says it is running and waits to be stopped.
 */
const STUB_NPM = `"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.STUB_NPM_RECORD + ".calls",
  JSON.stringify({
    args,
    cwd: fs.realpathSync(process.cwd()),
    gitDir: process.env.GIT_DIR ?? "unset",
    sawKey: Boolean(process.env.PIPELEX_API_KEY),
  }) + "\\n",
);
if (args[0] === "install") {
  if (process.env.STUB_NPM_MODULES) fs.mkdirSync("node_modules", { recursive: true });
  console.log("stub npm: installed");
  process.exit(Number(process.env.STUB_NPM_INSTALL_EXIT ?? 0));
}
if (process.env.STUB_NPM_HANG) {
  console.log("npm run create is running");
  setTimeout(() => {}, 30000);
} else {
  if (process.env.STUB_NPM_MODULES) {
    const now = new Date();
    fs.utimesSync("package-lock.json", now, now);
  }
  console.log("create: Stub Method");
  console.log("");
  console.log("! the method declares no description");
  console.error("warning: LICENSE copyright line left untouched — pass --license-holder to claim it.");
  console.log("create: 5/6 run npm run all");
  console.error("warning: LICENSE copyright line left untouched — pass --license-holder to claim it.");
  console.log("  a line that only mentions warning: inside it");
  process.exit(Number(process.env.STUB_NPM_EXIT ?? 0));
}
`;

/** The stub npm's script, `npm-cli.js` as npm's own is, in a directory of its own under `root`. */
export function stubNpm(root) {
  const dir = path.join(root, "npm");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "commonjs" }\n');
  const script = path.join(dir, "npm-cli.js");
  fs.writeFileSync(script, STUB_NPM);
  return script;
}

/**
 * The PATH a run gets: git alone when `tools` names it, and nothing else. On
 * Windows, where a link to git.exe outside its installation does not run, it
 * is git's own directory, which holds git and its siblings alone.
 */
export function toolsPath(root, tools = ["git"]) {
  const dir = path.join(root, "bin");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  if (!tools.includes("git")) return dir;
  if (process.platform === "win32") return [dir, path.dirname(REAL_GIT)].join(path.delimiter);
  fs.symlinkSync(REAL_GIT, path.join(dir, "git"));
  return dir;
}

/** Variables that would let the machine's git, npm or key reach a test. */
const AMBIENT = /^(GIT_|MAKE|MFLAGS$|EMAIL$|PIPELEX_|STUB_NPM_|npm_)/i;

/** The environment without anything ambient, and git confined to `root`. */
export function isolatedEnv(root, extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !AMBIENT.test(name)),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "no-gitconfig"),
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    ...extra,
  };
}

/** The environment a setup step runs git in: isolated, with an identity. */
export function setupEnv(root) {
  return isolatedEnv(root, {
    GIT_AUTHOR_NAME: "Setup",
    GIT_AUTHOR_EMAIL: "setup@example.com",
    GIT_COMMITTER_NAME: "Setup",
    GIT_COMMITTER_EMAIL: "setup@example.com",
  });
}

/**
 * The environment the initializer runs in: git on the PATH unless `tools`
 * leaves it out, and nothing else; the stub npm named in `npm_execpath`, or,
 * when `npm` is false, a script there that does not exist; a git
 * configuration with an identity or one that refuses to guess; and the key
 * unless `key` is false.
 */
export function runEnv(
  root,
  {
    tools = ["git"],
    npm = true,
    identity = true,
    key = true,
    installExit = 0,
    createExit = 0,
  } = {},
) {
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(
    config,
    identity
      ? "[user]\n\tname = Case Runner\n\temail = cases@example.com\n"
      : "[user]\n\tuseConfigOnly = true\n",
  );
  // Windows spells the PATH `Path`, and a copy of the environment keeps that
  // spelling, which would stand beside the one set here.
  const env = Object.fromEntries(
    Object.entries(isolatedEnv(root)).filter(([name]) => name.toUpperCase() !== "PATH"),
  );
  return {
    ...env,
    PATH: toolsPath(root, tools),
    GIT_CONFIG_GLOBAL: config,
    npm_execpath: npm ? stubNpm(root) : path.join(root, "no-npm", "npm-cli.js"),
    STUB_NPM_RECORD: path.join(root, "npm-record"),
    STUB_NPM_INSTALL_EXIT: String(installExit),
    STUB_NPM_EXIT: String(createExit),
    ...(key ? { PIPELEX_API_KEY: "pk_test_never_printed_8d1f" } : {}),
  };
}

/**
 * Give git an identity only for the repositories under `dir`, through an
 * `includeIf "gitdir:…"` section, in the configuration `runEnv` wrote.
 */
export function scopeIdentity(env, dir) {
  const scoped = `${env.GIT_CONFIG_GLOBAL}-scoped`;
  fs.writeFileSync(scoped, "[user]\n\tname = Scoped Runner\n\temail = scoped@example.com\n");
  fs.appendFileSync(env.GIT_CONFIG_GLOBAL, `[includeIf "gitdir:${dir}/"]\n\tpath = ${scoped}\n`);
}

/**
 * What the stub npm recorded: every call, in order, and the `install` and the
 * `run create` among them, each null when it never ran; or null when npm never
 * ran at all.
 */
export function npmRecord(root) {
  const file = path.join(root, "npm-record.calls");
  if (!fs.existsSync(file)) return null;
  const calls = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    calls,
    install: calls.find((call) => call.args[0] === "install") ?? null,
    create: calls.find((call) => call.args[0] === "run" && call.args[1] === "create") ?? null,
  };
}

/** Run git for a setup or an assertion. */
export function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Run the initializer in-process, capturing everything it prints. */
export async function runInitializer(argv, { cwd, env, signal, tmpDir, table, packDir = packs() }) {
  let output = "";
  const out = { write: (chunk) => (output += chunk.toString()) };
  const code = await run(argv, { cwd, env, out, packDir, signal, tmpDir, table });
  return { code, output, verdict: verdictOf(output) };
}

/** The verdict: the last line's first word, or its first two for `refused:` and `failed:`. */
export function verdictOf(output) {
  const last = output.trimEnd().split("\n").at(-1) ?? "";
  const words = last.split(" ");
  return words[0].endsWith(":") ? `${words[0]} ${words[1]}` : words[0];
}

/** Every file under `dir`, relative, leaving `.git` out. */
export function listTree(dir) {
  const out = [];
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (rel === "" && entry.name === ".git") continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(at, entry.name), childRel);
      else out.push(childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}
