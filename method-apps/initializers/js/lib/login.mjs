/**
 * The key the Pipelex login saved, read as the last source of the key.
 *
 * `npx -y @pipelex/mcp@latest login` saves its key as `PIPELEX_API_KEY` in
 * `~/.pipelex/.env`, or in the `.env` of `PIPELEX_HOME` when that is set, and
 * the Pipelex plugin's tools read that file on every call. The initializer's
 * preflight reads it too, after the environment, so one login serves the tools
 * and the method app. The copy's `npm run create` reads the same file under
 * the same rules, which the template's `scripts/lib/create.mts` restates
 * because a template may import nothing from outside its directory; both
 * suites execute the family's `initializers/login-key.json` to keep the two
 * readings identical, and both follow `pipelex-mcp`'s `src/credentials.ts`,
 * which owns the file.
 *
 * The rules:
 *
 * - **The file is read only when the environment holds no key**, and the key
 *   is never copied anywhere, nor printed.
 * - **Where it is**: `PIPELEX_HOME`, read from the environment alone, `~` or a
 *   leading `~/` (`~\` on Windows) expanded against the user's home directory;
 *   else `.pipelex` under the user's home directory. A `PIPELEX_HOME` that is
 *   neither absolute nor `~`-prefixed, `~user/…` included, is refused rather
 *   than resolved against the working directory, where a cloned repository
 *   could put a `.env` of its own.
 * - **What counts as the file**: a regular file of at most
 *   {@link MAX_LOGIN_FILE_BYTES}, a symlink followed to its target, parsed
 *   with Node's own `.env` parser, a leading byte-order mark dropped.
 * - **An empty value is no value**, for `PIPELEX_API_KEY`, `PIPELEX_BASE_URL`
 *   and `PIPELEX_HOME` alike.
 * - **The file's `PIPELEX_BASE_URL` comes with the file's key, and with it
 *   alone**, so that a development key saved beside a development base URL is
 *   not sent to production. The initializer makes no request and reads it only
 *   for the shared cases; `npm run create` pairs it with the key.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
// The module, not the named export: `parseEnv` arrived in Node 20.12, and a
// named import of it would fail to link on an older Node before the
// initializer could print its `refused: node-too-old`.
import util from "node:util";

import { npmCommand } from "./verdict.mjs";

/** The home directory's name under the user's home, when `PIPELEX_HOME` is not set. */
export const HOME_DIR_NAME = ".pipelex";

/** The file in the home directory that holds the saved key. */
export const LOGIN_FILENAME = ".env";

/** A file past this is not the credentials file, and counts as unreadable. */
export const MAX_LOGIN_FILE_BYTES = 1024 * 1024;

/**
 * The command that saves a key, as the person types it on this system: on
 * Windows, `npx.cmd`, which runs in Windows PowerShell 5.1 whatever its
 * execution policy, where a typed `npx` may be refused.
 */
export function loginCommand(platform = process.platform) {
  return `${platform === "win32" ? "npx.cmd" : "npx"} -y @pipelex/mcp@latest login`;
}

/**
 * The directory that holds the login's file, or `null` for a `PIPELEX_HOME`
 * this reader refuses.
 */
export function loginHome(env, homedir = os.homedir) {
  const configured = env.PIPELEX_HOME;
  if (!configured) return path.join(homedir(), HOME_DIR_NAME);
  if (configured === "~") return path.normalize(homedir());
  if (configured.startsWith("~/") || (path.sep === "\\" && configured.startsWith("~\\"))) {
    return path.join(homedir(), configured.slice(2));
  }
  if (path.isAbsolute(configured)) return path.normalize(configured);
  return null;
}

/**
 * What reading the login's file found. Never throws.
 *
 *   { status: "key", file, key, baseUrl }   a key, with the file's base URL or undefined
 *   { status: "no-key", file }              a readable file that holds no key
 *   { status: "missing", file }             no file there
 *   { status: "unreadable", file }          a file that cannot be read as the credentials file
 *   { status: "relative-home" }             a PIPELEX_HOME this reader refuses
 */
export function readLoginKey(env, { homedir = os.homedir } = {}) {
  let home;
  try {
    home = loginHome(env, homedir);
  } catch {
    // `os.homedir()` throws only when the user has no home directory at all.
    return { status: "unreadable", file: path.join("~", HOME_DIR_NAME, LOGIN_FILENAME) };
  }
  if (home === null) return { status: "relative-home" };
  const file = path.join(home, LOGIN_FILENAME);
  let text;
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > MAX_LOGIN_FILE_BYTES) return { status: "unreadable", file };
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable", file };
  }
  let values;
  try {
    values = util.parseEnv(text.replace(/^\uFEFF/, ""));
  } catch {
    return { status: "unreadable", file };
  }
  const key = values.PIPELEX_API_KEY || undefined;
  if (key === undefined) return { status: "no-key", file };
  return { status: "key", file, key, baseUrl: values.PIPELEX_BASE_URL || undefined };
}

/** A path as a message shows it: `~/…` under the user's home directory, absolute otherwise. */
export function displayPath(file, homedir = os.homedir) {
  try {
    const relative = path.relative(homedir(), file);
    const outside = relative === ".." || relative.startsWith(`..${path.sep}`);
    if (relative !== "" && !outside && !path.isAbsolute(relative)) return `~${path.sep}${relative}`;
  } catch {
    // No home directory to abbreviate against.
  }
  return file;
}

/**
 * Why no key was found, for the `refused: no-key` verdict: the login first,
 * then the shell, then writing `.env.local` by hand.
 */
export function noKeyDetail(read, { homedir = os.homedir, platform = process.platform } = {}) {
  const login = loginCommand(platform);
  const rest = `export PIPELEX_API_KEY in this shell, or pass --no-create and write .env.local yourself before running ${npmCommand(platform)} run create; npm run create never copies the key into the project`;
  if (read.status === "relative-home") {
    return `PIPELEX_API_KEY is not set, and the login's saved key is not read because PIPELEX_HOME is neither an absolute path nor one starting with ~/: fix PIPELEX_HOME and run ${login}, ${rest}`;
  }
  const shown = displayPath(read.file, homedir);
  if (read.status === "unreadable") {
    return `PIPELEX_API_KEY is not set, and ${shown}, where the login saves it, cannot be read: make it a file you can read and run ${login}, ${rest}`;
  }
  return `PIPELEX_API_KEY is not set, and no key is saved in ${shown}: run ${login} to save one there, ${rest}`;
}
