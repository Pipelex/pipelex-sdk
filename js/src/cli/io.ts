/**
 * What the `pipelex-sdk` command reads from and writes to, and the two ways it stops early.
 *
 * The command never touches `process` directly, apart from the current directory that relative
 * paths resolve against: `src/cli.ts`, the executable, hands it the real streams, environment and
 * Ctrl-C, and the test suite hands it its own. That is what lets one recorded case table drive
 * the command in-process, in this SDK and in its Python twin (`docs/cli.md`).
 */

/** The command's world: its environment, its three streams and the interrupt. */
export interface CommandIO {
  /**
   * The environment the command reads: `PIPELEX_API_KEY`, `PIPELEX_BASE_URL` and the test-only
   * `PIPELEX_SDK_POLL_INTERVAL_MS`. Nothing else is read from it, and no `.env` file is read.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** All of stdin, as bytes. Read only for `--inputs -`. */
  readStdin(): Promise<Uint8Array>;
  /** Write to stdout, which carries the result and nothing else. */
  writeStdout(text: string): void;
  /** Write to stderr, which carries everything that is not the result. */
  writeStderr(text: string): void;
  /** Aborted when the person interrupts the command (Ctrl-C). */
  readonly interrupt: AbortSignal;
}

/** The command's exit codes (`docs/cli.md`): a script reads stdout, and these are presentation. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

/**
 * A failure the command words itself: a usage error (exit code 2), a refusal it reads off an
 * answer (exit code 1), or an interrupt (exit code 130). Its message is the sentence after
 * `Error: `, or the whole first line when `bare`, as an interrupt's is; `details` are the lines
 * printed under it, as they are.
 */
export class CommandError extends Error {
  public readonly exitCode: number;
  public readonly details: readonly string[];
  public readonly bare: boolean;

  constructor(
    message: string,
    options: { exitCode: number; details?: readonly string[]; bare?: boolean },
  ) {
    super(message);
    this.name = "CommandError";
    this.exitCode = options.exitCode;
    this.details = options.details ?? [];
    this.bare = options.bare ?? false;
  }
}

/** A usage error: something the person can fix on the command line or in the environment. */
export function usageError(message: string, details: readonly string[] = []): CommandError {
  return new CommandError(message, { exitCode: EXIT_USAGE, details });
}

/** The person interrupted the command while it was waiting on something. */
export class Interrupted extends Error {
  constructor() {
    super("Interrupted.");
    this.name = "Interrupted";
  }
}

/**
 * Wait for `promise`, unless the person interrupts first, which rejects with {@link Interrupted}.
 *
 * Several of the SDK's requests take no abort signal (the input preparation, the start request,
 * the blocking execute), so the command stops waiting for them rather than cancelling them; the
 * executable exits right after it has said so. The promise left behind is given a handler, so its
 * later failure is never reported as unhandled.
 */
export function untilInterrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new Interrupted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      promise.catch(() => undefined);
      reject(new Interrupted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Write each line to stderr, each ended by a newline. */
export function writeLines(io: CommandIO, lines: readonly string[]): void {
  io.writeStderr(lines.map((line) => `${line}\n`).join(""));
}
