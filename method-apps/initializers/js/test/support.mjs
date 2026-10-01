// What the initializer's suites share: throwaway directories, the template
// packed from this checkout, a stub `make` that records how it was called, a
// PATH holding it beside the real git, and a git configuration of the suite's
// own, so that no hook, identity or signing setting of the machine's reaches
// a test.

import { execFileSync } from "node:child_process";
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

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/**
 * A stand-in for `make`. It records its arguments (NUL-separated), the
 * directory it ran in, what reached it through MAKEFLAGS and GIT_DIR, and
 * whether it saw a key, then prints the way `make create` does, warnings included, each of the
 * bootstrap's twice, and exits with STUB_MAKE_EXIT.
 */
const STUB_MAKE = `#!/bin/sh
record="$STUB_MAKE_RECORD"
printf '%s\\0' "$@" > "$record.args"
pwd -P > "$record.cwd"
printf '%s\\n' "\${MAKEFLAGS-unset}" > "$record.makeflags"
printf '%s\\n' "\${GIT_DIR-unset}" > "$record.gitdir"
[ -n "$PIPELEX_API_KEY" ] && echo present > "$record.key"
echo "create: Stub Method"
echo ""
echo "! the method declares no description"
echo "warning: LICENSE copyright line left untouched — pass --license-holder to claim it." >&2
echo "create: 5/6 run make all"
echo "warning: LICENSE copyright line left untouched — pass --license-holder to claim it." >&2
echo "  a line that only mentions warning: inside it"
exit "\${STUB_MAKE_EXIT:-0}"
`;

/** A directory for the PATH, holding the stub make and a link to the real git, as asked. */
export function toolsDir(root, tools = ["make", "git"]) {
  const dir = path.join(root, "bin");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  if (tools.includes("make")) fs.writeFileSync(path.join(dir, "make"), STUB_MAKE, { mode: 0o755 });
  if (tools.includes("git")) fs.symlinkSync(REAL_GIT, path.join(dir, "git"));
  return dir;
}

/** Variables that would let the machine's git, make or key reach a test. */
const AMBIENT = /^(GIT_|MAKE|MFLAGS$|EMAIL$|PIPELEX_|STUB_MAKE_)/;

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
 * The environment the initializer runs in: the tools on the PATH and nothing
 * else, a git configuration with an identity or one that refuses to guess,
 * and the key unless `key` is false.
 */
export function runEnv(
  root,
  { tools = ["make", "git"], identity = true, key = true, makeExit = 0 } = {},
) {
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(
    config,
    identity
      ? "[user]\n\tname = Case Runner\n\temail = cases@example.com\n"
      : "[user]\n\tuseConfigOnly = true\n",
  );
  return isolatedEnv(root, {
    PATH: toolsDir(root, tools),
    GIT_CONFIG_GLOBAL: config,
    STUB_MAKE_RECORD: path.join(root, "make-record"),
    STUB_MAKE_EXIT: String(makeExit),
    ...(key ? { PIPELEX_API_KEY: "pk_test_never_printed_8d1f" } : {}),
  });
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

/** What the stub make recorded, or null when it never ran. */
export function makeRecord(root) {
  const base = path.join(root, "make-record");
  if (!fs.existsSync(`${base}.args`)) return null;
  const read = (suffix) =>
    fs.existsSync(base + suffix) ? fs.readFileSync(base + suffix, "utf8") : null;
  return {
    args: read(".args").split("\0").slice(0, -1),
    cwd: read(".cwd").trim(),
    makeflags: read(".makeflags").trim(),
    gitDir: read(".gitdir").trim(),
    sawKey: read(".key") !== null,
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
