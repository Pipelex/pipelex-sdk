/**
 * `pipelex-sdk script`: write the per-method command, a short shell script that runs one method
 * through this SDK's `run`, its version pinned.
 *
 * The checks that need no request come first, in this order: the flags, `--pipe`'s form, a
 * control character in any value the script would carry, the method's form (a local bundle is
 * refused), `--name`, `--dir`, the target file when its name is already known, and the key. Then
 * one pipe I/O call checks the method and the pipe, which spends no inference; a catalog id with
 * no `--name` is named from its catalog entry; and the file is written, never over an existing
 * one, with the permissions of an executable.
 */

import { lstat, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { SDK_VERSION } from "../index.js";
import type { PipelexApiClient } from "../index.js";
import { parseFlags } from "./args.js";
import { systemReason } from "./bundle.js";
import { makeClient } from "./environment.js";
import { SCRIPT_HELP } from "./help.js";
import {
  CommandError,
  EXIT_INTERRUPTED,
  EXIT_OK,
  Interrupted,
  untilInterrupted,
  usageError,
} from "./io.js";
import type { CommandIO } from "./io.js";
import {
  addressName,
  addressTag,
  checkPipeRef,
  classifyMethod,
  hasControlCharacter,
  kebabCase,
  scriptNameProblem,
  shellQuote,
} from "./method.js";
import { describePipe } from "./source.js";
import type { MethodSource } from "./source.js";

const SCRIPT_FLAGS = {
  method: { type: "string" },
  pipe: { type: "string" },
  name: { type: "string" },
  dir: { type: "string" },
} as const;

/** The package a written script runs, and what its runner needs. */
export const SCRIPT_RUNNER = `npx --yes @pipelex/sdk@${SDK_VERSION}`;
export const SCRIPT_WRITER = "@pipelex/sdk";
export const SCRIPT_NEEDS = "Node 22.12 or later";

/** Run `pipelex-sdk script` and return its exit code. */
export async function runCommandScript(args: readonly string[], io: CommandIO): Promise<number> {
  const flags = parseFlags("script", args, SCRIPT_FLAGS);
  if (flags.help) {
    io.writeStdout(SCRIPT_HELP);
    return EXIT_OK;
  }
  const method = flags.strings.get("method");
  if (method === undefined) {
    throw usageError("--method is required.", [
      "Run 'pipelex-sdk script --help' to see its flags.",
    ]);
  }
  const pipe = flags.strings.get("pipe");
  if (pipe !== undefined) checkPipeRef(pipe);
  const givenName = flags.strings.get("name");
  for (const [flag, value] of [
    ["--method", method],
    ["--pipe", pipe],
    ["--name", givenName],
  ] as const) {
    if (value !== undefined && hasControlCharacter(value)) {
      throw usageError(`${flag} holds a control character, which no line of a script may carry.`);
    }
  }

  const selector = classifyMethod(method);
  if (selector.kind === "path") {
    throw usageError(
      `script takes a method address or a catalog id, and "${method}" is neither: a script naming a local bundle breaks as soon as the script or the bundle moves.`,
      [
        "Publish the method in a git repository and pass its address: github.com/<owner>/<repo>[/<package>]@<tag>",
        "Or save it to your organization's catalog and pass its id: mt_...",
        "To run a local bundle, use: pipelex-sdk run --method <path>",
      ],
    );
  }
  const source: MethodSource =
    selector.kind === "address"
      ? { kind: "address", methodRef: selector.methodRef }
      : { kind: "catalog", methodId: selector.methodId };

  if (givenName !== undefined) {
    const problem = scriptNameProblem(givenName);
    if (problem !== undefined) throw usageError(`--name ${problem}.`);
  }
  const dir = flags.strings.get("dir");
  const shownDir = dir === undefined ? "." : dir.replace(/\/+$/, "");
  await checkDirectory(dir ?? ".");

  let name: string | undefined = givenName;
  if (name === undefined && source.kind === "address") {
    name = defaultName(addressName(source.methodRef), method);
  }
  if (name !== undefined) await checkFree(shownDir, name);

  const client = makeClient(io);
  try {
    await describePipe(client, source, pipe, io.interrupt);
    if (name === undefined && source.kind === "catalog") {
      name = defaultName(await catalogName(client, source.methodId, io), method);
      await checkFree(shownDir, name);
    }
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    throw new CommandError("Interrupted. Nothing was written.", {
      exitCode: EXIT_INTERRUPTED,
      bare: true,
    });
  }
  if (name === undefined) throw new Error("a script's name is known once the method is checked");

  if (source.kind === "address" && addressTag(source.methodRef) === undefined) {
    io.writeStderr(
      `Warning: ${source.methodRef} has no tag, so the script runs whatever its repository's default branch holds each time it runs. Add @<tag> to pin a release.\n`,
    );
  }
  const target = `${shownDir}/${name}`;
  try {
    await writeFile(resolve(target), scriptBody(name, method, pipe), { flag: "wx", mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw alreadyThere(target);
    throw usageError(`cannot write "${target}".`, [`Reason: ${systemReason(error)}`]);
  }
  io.writeStdout(`${target}\n`);
  io.writeStderr(`Wrote ${target}. Run it with: ${target} --inputs inputs.json\n`);
  return EXIT_OK;
}

/**
 * The script's text: the shebang, a header saying what it runs, which SDK wrote it, what it needs
 * and how to use it, and the one line that runs it, every value single-quoted.
 */
export function scriptBody(name: string, method: string, pipe: string | undefined): string {
  const pipeArgument = pipe === undefined ? "" : ` --pipe ${shellQuote(pipe)}`;
  return [
    "#!/bin/sh",
    `# ${name}: runs ${method} on the Pipelex API.`,
    `# Written by ${SCRIPT_WRITER} ${SDK_VERSION}. Needs ${SCRIPT_NEEDS}, and PIPELEX_API_KEY in the environment.`,
    `# Usage: ./${name} --inputs inputs.json, or ./${name} --inputs-template to see what to fill in.`,
    `exec ${SCRIPT_RUNNER} run --method ${shellQuote(method)}${pipeArgument} "$@"`,
    "",
  ].join("\n");
}

/** A default name, held to the rules of a file name, or the usage error asking for `--name`. */
function defaultName(candidate: string, method: string): string {
  if (scriptNameProblem(candidate) !== undefined) {
    throw usageError(`no script name can be made from "${method}"; give one with --name.`);
  }
  return candidate;
}

/** A catalog method's name, kebab-cased, read from its catalog entry. */
async function catalogName(
  client: PipelexApiClient,
  methodId: string,
  io: CommandIO,
): Promise<string> {
  const entry = await untilInterrupted(() => client.getMethod(methodId), io.interrupt);
  return kebabCase(entry.name);
}

async function checkDirectory(dir: string): Promise<void> {
  let found: Awaited<ReturnType<typeof stat>>;
  try {
    found = await stat(resolve(dir));
  } catch (error) {
    throw usageError(`--dir "${dir}" does not exist.`, [`Reason: ${systemReason(error)}`]);
  }
  if (!found.isDirectory()) throw usageError(`--dir "${dir}" is not a directory.`);
}

/** Refuse a target that exists, whatever it is, a link that leads nowhere included. */
async function checkFree(shownDir: string, name: string): Promise<void> {
  const target = `${shownDir}/${name}`;
  try {
    await lstat(resolve(target));
  } catch {
    return;
  }
  throw alreadyThere(target);
}

function alreadyThere(target: string): CommandError {
  return usageError(`"${target}" already exists, and script never overwrites a file.`, [
    "Remove it, or choose another name with --name or another directory with --dir.",
  ]);
}
