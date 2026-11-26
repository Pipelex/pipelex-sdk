/**
 * `npm run dev` and `npm run start` — `next dev` and `next start`, bound to
 * `APP_HOST` and `APP_PORT`.
 *
 * The app must not be reachable from the network unless the person says so:
 * its Server Actions run methods with the `PIPELEX_API_KEY` in the server's
 * environment and nothing authenticates the browser calling them, and `next`
 * given no host binds every interface. So the server is always given `-H`,
 * loopback unless `APP_HOST` names another host, and `-p`, 4300 unless
 * `APP_PORT` names another port. A blank value is not given, as in the
 * Makefile, which declares and exports both.
 *
 * This was a shell expansion in `package.json`, `${APP_HOST:-127.0.0.1}`, which
 * npm hands to `cmd.exe` on Windows, where it is not expanded and `next`
 * received it as written. A script reads the environment the same way on every
 * system.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import process from "node:process";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = "4300";

export type NextMode = "dev" | "start";

export class RunNextUsageError extends Error {}

/** Whether a word of `next`'s command line names a host or a port, in any form `next` takes. */
export function isHostOrPortOption(word: string): boolean {
  return /^(-H|-p|--hostname(=|$)|--port(=|$))/.test(word.replace(/^["']/, ""));
}

/** The arguments `next` is given for `mode`: the mode, then the host and port the environment names. */
export function nextArgs(
  mode: string,
  env: NodeJS.ProcessEnv,
  rest: readonly string[] = [],
): string[] {
  if (mode !== "dev" && mode !== "start") {
    throw new RunNextUsageError(`usage: run-next.mts dev|start [next's own options]`);
  }
  // `next` takes the last host it is given, so one passed after ours would
  // open the server wherever it says, past every check of APP_HOST.
  const named = rest.find(isHostOrPortOption);
  if (named !== undefined) {
    throw new RunNextUsageError(
      `run-next.mts: ${named} is not taken here: the host is APP_HOST and the port APP_PORT, ` +
        "from the environment",
    );
  }
  const host = env.APP_HOST?.trim() || DEFAULT_HOST;
  const port = env.APP_PORT?.trim() || DEFAULT_PORT;
  return [mode, "-H", host, "-p", port, ...rest];
}

/** Where `next`'s own command lives, in this project's `node_modules`. */
export function nextBin(): string {
  return createRequire(import.meta.url).resolve("next/dist/bin/next");
}

/**
 * Run `next` with Node, as its own process, and end as it ends. A signal sent
 * to this process alone, rather than to its group, is passed on to `next`; one
 * sent to the group, as a terminal's Ctrl-C or serve's stop, reaches `next`
 * twice, which `next` takes once (its `handleSessionStop` returns at once when
 * a stop is under way).
 * The process is hidden on Windows, so a server started in the background
 * opens no window.
 */
export async function runNext(argv: readonly string[]): Promise<number> {
  let args: string[];
  try {
    args = nextArgs(argv[0] ?? "", process.env, argv.slice(1));
  } catch (error) {
    if (!(error instanceof RunNextUsageError)) throw error;
    console.error(error.message);
    return 2;
  }
  const child = spawn(process.execPath, [nextBin(), ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  return new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(`run-next: could not run next: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      for (const each of signals) process.off(each, forward);
      resolve(exitCodeOf(code, signal));
    });
  });
}

/**
 * The exit code a shell gives a process that ended so: its own code, or 128
 * plus the number of the signal that ended it, as 137 for SIGKILL.
 */
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}
