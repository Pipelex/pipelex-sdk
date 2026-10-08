/**
 * The `pipelex-sdk` command: `run` runs a method and prints its main output, `script` writes the
 * per-method shell script. `docs/cli.md` describes both, and `tests/fixtures/cli-cases.json`
 * records what each prints for every case, which the Python twin answers too.
 *
 * Nothing in the SDK imports this module or its siblings, and the package entry does not export
 * them (`.dependency-cruiser.cjs`): the command sits at the top of the dependency graph, and reaches
 * the SDK only through its public barrel, as any other caller would.
 */

import { SDK_VERSION } from "../index.js";
import { MAIN_HELP } from "./help.js";
import { EXIT_OK, usageError, writeLines } from "./io.js";
import type { CommandIO } from "./io.js";
import { presentError } from "./present.js";
import { runCommandRun } from "./run.js";
import { runCommandScript } from "./script.js";

export type { CommandIO } from "./io.js";

/**
 * Run the command on `argv`, the arguments after the command's own name, and return its exit
 * code: 0 when it did what it was asked, 1 when the run failed or the API refused it, 2 for a
 * usage error and 130 when interrupted. Every failure is printed on stderr before it returns; it
 * never throws.
 */
export async function runCommand(argv: readonly string[], io: CommandIO): Promise<number> {
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case undefined:
        throw usageError("name a command: run or script.", [
          "Run 'pipelex-sdk --help' to see what each does.",
        ]);
      case "--help":
      case "-h":
        // The help wins whatever follows it, as it does in a subcommand.
        io.writeStdout(MAIN_HELP);
        return EXIT_OK;
      case "--version":
        // Unlike the help, the version is not printed over a command line it does not answer.
        if (rest.length > 0) {
          throw usageError(`unexpected argument "${rest[0]}" after --version.`, [
            "Run 'pipelex-sdk --version' alone to print the version.",
          ]);
        }
        io.writeStdout(`${SDK_VERSION}\n`);
        return EXIT_OK;
      case "run":
        return await runCommandRun(rest, io);
      case "script":
        return await runCommandScript(rest, io);
      default:
        throw usageError(
          command.startsWith("-") ? `unknown option ${command}.` : `unknown command "${command}".`,
          ["The commands are run and script. Run 'pipelex-sdk --help' to see what each does."],
        );
    }
  } catch (error) {
    const presented = presentError(error);
    writeLines(io, presented.lines);
    return presented.exitCode;
  }
}
