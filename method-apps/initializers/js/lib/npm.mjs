/**
 * The copy's own gesture, run with npm: `npm install`, since a fresh copy has
 * no `node_modules` and the gesture's script needs its dependencies, then
 * `npm run create -- <method> [--flag value …]`. Both run with an argument
 * vector and no shell of the initializer's, so no value ever needs quoting
 * here: each reaches npm as one argument, and npm hands it to the script.
 * Nothing here needs `make`, so the same run works on Windows, where npm is a
 * `.cmd` file that Node will not spawn without a shell: there npm is run as
 * its own script, `npm-cli.js`, with this Node, as the template's
 * `scripts/lib/npm.mts` does.
 *
 * The output of both steps is streamed, or, with `--quiet`, written to one log
 * alone. Either way it is read for the gesture's warnings, which open with
 * `! ` (the gesture's own) or `warning: ` (the bootstrap's), and are printed
 * again at the end because `npm run all` fills the tail. The gesture runs its
 * bootstrap twice, a dry run then the write, so each warning is kept once.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { gitEnv } from "./git.mjs";
import { flagOf } from "./templates.mjs";

/** npm's own script, which npm names in `npm_execpath` for whatever it runs. */
const NPM_SCRIPT = "npm-cli.js";

/**
 * How to run npm: a command and the arguments that come before npm's own.
 * Under `npm create`, npm names its own script in `npm_execpath`, and it is run
 * with this Node, so the gesture runs under the npm that ran the initializer.
 * Another package manager names its own script there, which is not npm's and
 * is passed over. Elsewhere it is `npm` on the `PATH`, except on Windows, where
 * `npm` is `npm.cmd`: there npm's script is the one the Node installer puts
 * beside `node.exe`.
 */
export function npmInvocation(env, platform = process.platform, execPath = process.execPath) {
  const named = env.npm_execpath;
  const pathOf = platform === "win32" ? path.win32 : path.posix;
  if (named !== undefined && pathOf.basename(named) === NPM_SCRIPT) {
    return { command: execPath, args: [named] };
  }
  if (platform !== "win32") return { command: "npm", args: [] };
  return {
    command: execPath,
    args: [path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", NPM_SCRIPT)],
  };
}

/** The value of `name` in `env`, whose names Windows reads without regard to case. */
export function envValue(env, name, platform = process.platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Whether an executable named `tool` is on the `PATH` `env` carries. On
 * Windows a command is a file named `tool` plus one of the extensions
 * `PATHEXT` lists, such as `git.exe`.
 */
export function onPath(tool, env, platform = process.platform) {
  const pathOf = platform === "win32" ? path.win32 : path.posix;
  const names =
    platform === "win32"
      ? (envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter((ext) => ext !== "")
          .map((ext) => `${tool}${ext}`)
      : [tool];
  for (const dir of (envValue(env, "PATH", platform) ?? "").split(pathOf.delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = pathOf.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/**
 * Why npm cannot be run as `invocation` says, or null: `npm` not on the
 * `PATH`, or npm's script missing where it is named.
 */
export function npmProblem(invocation, env, platform = process.platform) {
  if (invocation.args.length === 0) {
    return onPath(invocation.command, env, platform)
      ? null
      : "npm is not on the PATH: install Node.js with its npm, or pass --no-create to write the template alone";
  }
  const script = invocation.args[0];
  return fs.existsSync(script)
    ? null
    : `npm is not where ${script} names it: reinstall Node.js with its npm, or pass --no-create to write the template alone`;
}

/**
 * The words `npm run create` takes after `--`: the method, then each value
 * given, in the contract's order, as its flag and the value as typed, and a
 * switch given as its flag alone. A template's `make create` forwards each
 * variable the same way, which the family's create contract holds it to.
 */
export function createWords(order, values, switches, required) {
  const words = values[required] === undefined ? [] : [values[required]];
  for (const variable of order) {
    if (variable === required) continue;
    if (switches.has(variable)) {
      if (values[variable]) words.push(flagOf(variable));
    } else if (values[variable] !== undefined) {
      words.push(flagOf(variable), values[variable]);
    }
  }
  return words;
}

/**
 * The stamp of the copy's last install, which its Makefile's install guard
 * reads: `make install` leaves it, and `make create` leaves it after its
 * install and again after the gesture, whose lock re-sync rewrites
 * `package-lock.json` and changes nothing `node_modules` holds. Left the same
 * way here, a project made by the initializer does not reinstall on its first
 * `make` check what is already installed.
 */
export const INSTALL_STAMP = path.join("node_modules", ".lock-installed");

/**
 * Leave the stamp of an install in `dir`, now, when it holds `node_modules`.
 * The stamp only spares a reinstall, so a stamp that cannot be written is let
 * go: the guard then reads npm's own record of the install instead.
 */
export function stampInstall(dir) {
  if (!fs.existsSync(path.join(dir, "node_modules"))) return;
  const stamp = path.join(dir, INSTALL_STAMP);
  try {
    fs.closeSync(fs.openSync(stamp, "a"));
    const now = new Date();
    fs.utimesSync(stamp, now, now);
  } catch {
    // best effort, as above
  }
}

/** The warnings in a run's output, each once, in the order they first appeared. */
export function extractWarnings(output) {
  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    if ((line.startsWith("! ") || line.startsWith("warning: ")) && !seen.has(line)) seen.add(line);
  }
  return [...seen];
}

/** How long a step has to end once it is stopped, before the run stops waiting for it. */
export const STOP_GRACE_MS = 10_000;

/**
 * Stop a child and everything it started. Elsewhere npm passes the signal on
 * to the script it runs; on Windows there is no signal to pass, so the whole
 * tree is ended with `taskkill`, which Windows ships. A `taskkill` that cannot
 * run, or that ends with a failure, as when it is denied access, falls back
 * to ending npm alone, which is all Node can do there.
 */
function stop(child, platform, taskkill) {
  if (platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  if (child.pid === undefined) return;
  const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  let fellBack = false;
  const fallBack = () => {
    if (fellBack) return;
    fellBack = true;
    child.kill();
  };
  killer.on("error", fallBack);
  killer.on("close", (code) => {
    if (code !== 0) fallBack();
  });
}

/** Run one npm command, sending its output to `take`. Resolves `{ status, signal, error }`. */
function runOne(invocation, args, { cwd, env, take, signal, platform, taskkill, graceMs }) {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let failed = null;
    let settled = false;
    let bound;
    // Stopped, the step gets a bounded time to end: a run whose step would
    // not stop ends anyway, saying the step may still run, rather than wait
    // for it as long as it takes.
    const onAbort = () => {
      stop(child, platform, taskkill);
      bound = setTimeout(() => {
        failed = new Error(
          `npm (pid ${child.pid}) did not stop within ${Math.round(graceMs / 1000)}s of the interruption, and may still be running`,
        );
        failed.stuck = true;
        // Let go of it, so the run can end while it runs on.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, null);
      }, graceMs);
      bound.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (status, killedBy) => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      signal?.removeEventListener("abort", onAbort);
      resolve({ status, signal: killedBy, error: failed });
    };
    child.on("error", (error) => {
      failed = error;
      // A process that never started emits no close of its own.
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", finish);
  });
}

/**
 * Run `npm install`, then, if it succeeded and nothing interrupted the run,
 * `npm run create -- <words>`, in `cwd`. Resolves
 * `{ step, status, signal, output, error }`, `step` being the one that ended
 * the run, `install` or `create`; never rejects. `out` receives the stream
 * unless `logFile` is given. An abort of `signal` stops the step running.
 */
export async function runCreate(
  words,
  {
    npm,
    cwd,
    env,
    out,
    logFile,
    signal,
    platform = process.platform,
    taskkill = "taskkill",
    graceMs = STOP_GRACE_MS,
  },
) {
  const log = logFile ? fs.openSync(logFile, "w", 0o600) : null;
  const chunks = [];
  const take = (chunk) => {
    chunks.push(chunk);
    if (log !== null) fs.writeSync(log, chunk);
    else out.write(chunk);
  };
  // Without the variables that point git elsewhere, which the initializer
  // drops for its own git calls too: the copy's install wires its hooks with
  // `git config`, which would otherwise write into the repository a caller's
  // `GIT_DIR` names rather than the copy's.
  const options = { cwd, env: gitEnv(env), take, signal, platform, taskkill, graceMs };
  let step = "install";
  let result;
  try {
    result = await runOne(npm, ["install"], options);
    if (result.error === null && result.status === 0) stampInstall(cwd);
    if (result.error === null && result.status === 0 && !signal?.aborted) {
      step = "create";
      result = await runOne(npm, ["run", "create", "--", ...words], options);
    }
  } finally {
    if (log !== null) fs.closeSync(log);
  }
  return { step, ...result, output: Buffer.concat(chunks).toString("utf8") };
}
