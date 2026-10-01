/**
 * The verdicts. A run ends with one line whose first word is stable —
 * `created`, `copied`, `refused: <why>` or `failed: <what>` — and that line is
 * the last one printed. Everything goes to standard output, and a caller reads
 * the verdict from its last line, because under `npm create` npm prints its own
 * `npm error` lines on standard error after a run that exits 1. The exit code
 * is presentation: 0 for `created` and `copied`, 1 otherwise.
 *
 *   created <dir>            the copy, the git outcome, and a green make create
 *   copied <dir>             --no-create or --dry-run: the copy and the git outcome only
 *   refused: <why>           the preflight stopped, and nothing was written
 *   failed: write            the copy failed or was interrupted, and what it created was removed
 *   failed: commit           git refused the pristine commit; the copy stands
 *   failed: create           make create did not succeed; the copy and the commit stand, and its
 *                            own message says what to run next
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

/** Quote a word for a line a person may paste into a shell. */
export function shellQuote(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
