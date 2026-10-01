/**
 * The command line:
 *
 *   create-method-app <dir> --method <bundle | mt_… | address> [create options]
 *                     [--template <name>] [--no-create] [--no-git] [--quiet]
 *
 * Each create option is a flag named after its make variable, taking its value
 * as the next word or after `=`; a switch such as `--dry-run` takes none. A
 * blank value is not given, as the Makefile's `given` ignores one. Nothing is
 * ever asked: a missing value is a refusal naming the flag.
 */

import { Verdict } from "./verdict.mjs";

export const USAGE =
  "usage: npm create @pipelex/method-app@latest <dir> -- --method <path/to/bundle | mt_… | github.com/owner/repo[/package][@tag]> " +
  "[--name <package>] [--title <title>] [--description <text>] [--pipe <pipe_code>] " +
  "[--author-name <name>] [--author-email <email>] [--repo-url <url>] [--license <mit|proprietary|spdx>] " +
  "[--license-holder <holder>] [--license-year <year>] [--dry-run] [--method-name <dir-name>] [--label <label>] " +
  "[--template webapp-js] [--no-create] [--no-git] [--quiet]";

/** Appended to a refusal of the command line, which stays one line. */
export const HELP_HINT = "(--help lists the options)";

const OWN_SWITCHES = { "--no-create": "noCreate", "--no-git": "noGit", "--quiet": "quiet" };

/**
 * Parse `argv` against the table. Returns
 * `{ help, version, dir, template, values, given, noCreate, noGit, quiet }`,
 * `values` holding each create variable given, by name, and `given` the flag
 * each came from; throws a `Verdict` refusal otherwise.
 */
export function parseArgs(argv, table) {
  const parsed = {
    help: false,
    version: false,
    dir: undefined,
    template: undefined,
    values: {},
    given: {},
    noCreate: false,
    noGit: false,
    quiet: false,
  };
  const seen = new Set();
  const once = (flag) => {
    if (seen.has(flag)) throw Verdict.refused("usage", `${flag} is given twice. ${HELP_HINT}`);
    seen.add(flag);
  };

  let options = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options || !arg.startsWith("-") || arg === "-") {
      if (parsed.dir !== undefined) {
        throw Verdict.refused(
          "usage",
          `${JSON.stringify(arg)} is a second directory; the template is written into one. ${HELP_HINT}`,
        );
      }
      parsed.dir = arg;
      continue;
    }

    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const noValue = () => {
      if (inline !== undefined)
        throw Verdict.refused("usage", `${flag} takes no value. ${HELP_HINT}`);
    };
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw Verdict.refused("usage", `${flag} needs a value. ${HELP_HINT}`);
      }
      i += 1;
      return next;
    };

    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
    } else if (flag === "--version") {
      parsed.version = true;
    } else if (flag in OWN_SWITCHES) {
      noValue();
      once(flag);
      parsed[OWN_SWITCHES[flag]] = true;
    } else if (flag === "--template") {
      once(flag);
      parsed.template = value().trim() || undefined;
    } else if (table.variables.has(flag)) {
      once(flag);
      const variable = table.variables.get(flag);
      if (table.switches.has(variable)) {
        noValue();
        parsed.values[variable] = true;
      } else {
        const given = value();
        if (given.trim() !== "") parsed.values[variable] = given;
      }
      parsed.given[variable] = flag;
    } else {
      throw Verdict.refused(
        "unknown-option",
        `${flag} is not an option of this initializer. ${HELP_HINT}`,
      );
    }
  }
  return parsed;
}
