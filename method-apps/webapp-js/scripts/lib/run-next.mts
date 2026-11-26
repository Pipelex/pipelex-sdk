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
import process from "node:process";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = "4300";

export type NextMode = "dev" | "start";

export class RunNextUsageError extends Error {}

/** The arguments `next` is given for `mode`: the mode, then the host and port the environment names. */
export function nextArgs(
  mode: string,
  env: NodeJS.ProcessEnv,
  rest: readonly string[] = [],
): string[] {
  if (mode !== "dev" && mode !== "start") {
    throw new RunNextUsageError(`usage: run-next.mts dev|start [next's own options]`);
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
 * to this process alone, rather than to its group, is passed on to `next`.
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
      resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return numbers[signal];
}
