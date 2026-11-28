/**
 * The verdicts. A run ends with one line whose first word is stable —
 * `created`, `copied`, `refused: <why>` or `failed: <what>` — and that line is
 * the last one printed. Everything goes to standard output, and a caller reads
 * the verdict from its last line, because under `npm create` npm prints its own
 * `npm error` lines on standard error after a run that exits 1. The exit code
 * is presentation: 0 for `created` and `copied`, 1 otherwise.
 *
 *   created <dir>            the copy, the git outcome, and a green npm run create
 *   copied <dir>             --no-create or --dry-run: the copy and the git outcome only
 *   refused: <why>           the preflight stopped, and nothing was written
 *   failed: write            the copy failed or was interrupted, and what it created was removed
 *   failed: commit           git refused the pristine commit; the copy stands
 *   failed: create           npm install or npm run create did not succeed; the copy and the
 *                            commit stand, and npm's or the gesture's own message says what to
 *                            run next
 */

export const EXIT_OK = 0;
export const EXIT_STOPPED = 1;

/** A run's end, thrown from wherever it is decided and printed once by the orchestration. */
export class Verdict extends Error {
  constructor(word, detail, exitCode) {
    super(`${word} — ${detail}`);
    this.name = "Verdict";
    this.word = word;
    this.detail = detail;
    this.exitCode = exitCode;
  }

  static refused(why, detail) {
    return new Verdict(`refused: ${why}`, detail, EXIT_STOPPED);
  }

  static failed(what, detail) {
    return new Verdict(`failed: ${what}`, detail, EXIT_STOPPED);
  }

  /** The line printed last. */
  get line() {
    return this.message;
  }
}

import process from "node:process";

/**
 * Quote a word for a line a person may paste into this system's shell. A POSIX
 * shell takes single quotes. Windows has two shells and no quoting they share
 * entirely: double quotes are quotes in both PowerShell and `cmd`, where single
 * quotes are not quotes to `cmd`, so a word is double-quoted there, unless it
 * holds a `$` or a backquote, which PowerShell would expand inside double
 * quotes, and then it is single-quoted as PowerShell reads it. A word left bare
 * on Windows holds nothing either shell reads specially: no `@`, which
 * PowerShell splats, no `,`, which it makes a list, and no `%`, though `cmd`
 * expands a `%NAME%` even between quotes.
 */
export function shellQuote(word, platform = process.platform) {
  if (platform !== "win32") {
    return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  }
  if (/^[\w+=:./\\-]+$/.test(word)) return word;
  if (/[$`]/.test(word)) return `'${word.replaceAll("'", "''")}'`;
  return `"${word.replaceAll('"', '""')}"`;
}

/**
 * Commands a person runs one after the other, each in backquotes, as npm names
 * a command: no separator between two commands reads the same in every shell,
 * since Windows PowerShell 5.1 has no `&&` and `cmd` no `;`.
 */
export function inTurn(commands) {
  return commands.map((command) => `\`${command}\``).join(", then ");
}

/**
 * The npm a person types on this system, as the verdicts name it: `npm.cmd` on
 * Windows, `npm` elsewhere. Windows PowerShell 5.1, under the execution policy
 * Windows sets by default and an IT department may pin, runs a typed `npm` as
 * `npm.ps1` and refuses it, while `npm.cmd` runs there, in PowerShell 7 and in
 * `cmd` alike. The template's `scripts/lib/npm.mts` names it the same way.
 */
export function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}
