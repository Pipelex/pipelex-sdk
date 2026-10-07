/**
 * The flags of one subcommand, read with `node:util`'s `parseArgs` and held to rules the Python
 * twin's `argparse` can follow word for word, so both commands refuse the same command lines.
 *
 * `parseArgs` runs in its lenient mode and returns its tokens, and the rules are applied to the
 * tokens in command-line order, the first problem being the one reported:
 *
 * - `--help` or `-h` anywhere before `--` asks for the subcommand's help, whatever else is there.
 * - An option the subcommand does not take is refused, and so is any positional argument.
 * - A flag given twice is refused, rather than the last one winning: a script written by
 *   `script` passes its own arguments through, and a second `--method` must not quietly run
 *   another method.
 * - A string flag needs a non-empty value, given as the next argument or after `=`. A next
 *   argument that starts with `-` is not taken as the value, except `-` alone, which `--inputs`
 *   reads as stdin; `--name=-x` is how a value starting with `-` is given.
 * - A boolean flag takes no value.
 */

import { parseArgs } from "node:util";

import { usageError } from "./io.js";
import type { CommandError } from "./io.js";

/** One flag a subcommand takes, by its long name. */
export interface FlagSpec {
  readonly type: "string" | "boolean";
}

/** The flags a subcommand takes, by long name, without the `--`. */
export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

/** What a subcommand's command line asked for. */
export interface ParsedFlags {
  /** Whether `--help` was asked for, in which case nothing else was read. */
  readonly help: boolean;
  readonly strings: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

/**
 * Read a subcommand's command line against its flags.
 *
 * @throws {CommandError} A usage error naming the first problem, in command-line order.
 */
export function parseFlags(
  command: string,
  args: readonly string[],
  specs: FlagSpecs,
): ParsedFlags {
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = {
    help: { type: "boolean", short: "h" },
  };
  for (const [name, spec] of Object.entries(specs)) options[name] = { type: spec.type };
  const { tokens } = parseArgs({
    args: [...args],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  if (tokens.some((token) => token.kind === "option" && token.name === "help")) {
    return { help: true, strings: new Map(), booleans: new Set() };
  }

  const strings = new Map<string, string>();
  const booleans = new Set<string>();
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind === "option-terminator") continue;
    if (token.kind === "positional") {
      throw misuse(command, `unexpected argument "${token.value}"`);
    }
    const spec = Object.hasOwn(specs, token.name) ? specs[token.name] : undefined;
    if (spec === undefined) {
      throw misuse(command, `unknown option ${token.rawName}`);
    }
    const flag = `--${token.name}`;
    if (seen.has(token.name)) {
      throw misuse(command, `${flag} was given more than once`);
    }
    seen.add(token.name);
    if (spec.type === "boolean") {
      if (token.value !== undefined) throw misuse(command, `${flag} takes no value`);
      booleans.add(token.name);
      continue;
    }
    const value = token.value;
    const takenFromNext = !token.inlineValue;
    if (
      value === undefined ||
      value === "" ||
      (takenFromNext && value.startsWith("-") && value !== "-")
    ) {
      throw misuse(command, `${flag} needs a value`);
    }
    strings.set(token.name, value);
  }
  return { help: false, strings, booleans };
}

function misuse(command: string, message: string): CommandError {
  return usageError(`${message}.`, [`Run 'pipelex-sdk ${command} --help' to see its flags.`]);
}
