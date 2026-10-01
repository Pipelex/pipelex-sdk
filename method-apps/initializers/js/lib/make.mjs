/**
 * The copy's `make create`, run with an argument vector and no shell, so no
 * value ever needs quoting: each variable reaches make as one `NAME=value`
 * word, which the template's Makefile reads with `$(value …)` and hands to its
 * gesture exactly as typed.
 *
 * The output is streamed, or, with `--quiet`, written to a log alone. Either
 * way it is read for the gesture's warnings, which open with `! ` (the
 * gesture's own) or `warning: ` (the bootstrap's), and are printed again at the
 * end because `make all` fills the tail. The gesture runs its bootstrap twice,
 * a dry run then the write, so each warning is kept once.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

import { gitEnv } from "./git.mjs";

/**
 * Variables through which an enclosing make would reach this one as if they
 * had been typed on its command line. The Makefile trusts only command-line
 * values, so none may arrive any other way.
 */
const MAKE_CHANNELS = ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"];

/**
 * The environment `make create` runs in: without the make channels, and
 * without the variables that point git elsewhere, which the initializer drops
 * for its own git calls too. The copy's install wires its hooks with
 * `git config`, which would otherwise write into the repository a caller's
 * `GIT_DIR` names rather than the copy's.
 */
export function makeEnv(env) {
  const clean = gitEnv(env);
  for (const name of MAKE_CHANNELS) delete clean[name];
  return clean;
}

/** `make create`'s arguments: `create`, then `NAME=value` for each value given, in the contract's order. */
export function makeArgs(order, values, switches) {
  const args = ["create"];
  for (const variable of order) {
    if (switches.has(variable)) {
      if (values[variable]) args.push(`${variable}=1`);
    } else if (values[variable] !== undefined) {
      args.push(`${variable}=${values[variable]}`);
    }
  }
  return args;
}

/** The warnings in a run's output, each once, in the order they first appeared. */
export function extractWarnings(output) {
  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    if ((line.startsWith("! ") || line.startsWith("warning: ")) && !seen.has(line)) seen.add(line);
  }
  return [...seen];
}

/**
 * Run `make` in `cwd`. Resolves `{ status, signal, output, error }`; never
 * rejects. `out` receives the stream unless `logFile` is given. An abort of
 * `signal` passes SIGTERM on to make.
 */
export function runMake(args, { cwd, env, out, logFile, signal }) {
  return new Promise((resolve) => {
    const log = logFile ? fs.openSync(logFile, "w", 0o600) : null;
    const chunks = [];
    const child = spawn("make", args, {
      cwd,
      env: makeEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (chunk) => {
      chunks.push(chunk);
      if (log !== null) fs.writeSync(log, chunk);
      else out.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    let failed = null;
    let settled = false;
    const finish = (status, killedBy) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (log !== null) fs.closeSync(log);
      resolve({
        status,
        signal: killedBy,
        output: Buffer.concat(chunks).toString("utf8"),
        error: failed,
      });
    };
    child.on("error", (error) => {
      failed = error;
      // A make that never started emits no close of its own.
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", finish);
  });
}
