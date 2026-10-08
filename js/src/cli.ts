#!/usr/bin/env node
/**
 * The `pipelex-sdk` executable, which `package.json` declares as the package's one `bin`, so that
 * `npx @pipelex/sdk run …` runs it. It hands the command the real process — its arguments, its
 * environment, its streams and Ctrl-C — and exits with the command's code (`docs/cli.md`).
 *
 * It uses no top-level `await`, as no module of `dist/` does, so that the package stays loadable
 * through `require(ESM)` (`docs/architecture.md`, "Module format & packaging").
 */

import process from "node:process";
import type { Writable } from "node:stream";

import { EXIT_INTERRUPTED } from "./cli/io.js";
import { runCommand } from "./cli/main.js";

const interrupt = new AbortController();
// Once: a second Ctrl-C finds no handler and ends the process the default way.
process.once("SIGINT", () => interrupt.abort());

// A reader that stops early (`| head`) closes the pipe; there is nothing left to tell it.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

void runCommand(process.argv.slice(2), {
  env: process.env,
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  },
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  interrupt: interrupt.signal,
}).then(exitWhenFlushed);

/**
 * Exit once both streams have flushed, rather than when the event loop empties: a request the
 * command stopped waiting for on Ctrl-C, such as the start of a run, would otherwise hold the
 * process open until the API answers it.
 *
 * After Ctrl-C, the process ends by the signal itself rather than by `process.exit(130)`, which a
 * POSIX shell reports as the same status, 130: Node's exit waits for its worker threads, and one
 * can be blocked for good in a read the command stopped waiting for, such as `--inputs` naming a
 * named pipe no one writes to, or `/dev/stdin` on a terminal. Ending by the signal also tells a
 * calling shell loop that the person interrupted. Windows has no such signal to end by, and exits
 * with 130.
 */
async function exitWhenFlushed(code: number): Promise<void> {
  await flush(process.stdout);
  await flush(process.stderr);
  if (code === EXIT_INTERRUPTED && interrupt.signal.aborted && process.platform !== "win32") {
    // The once-only handler is gone, so SIGINT has its default action again: ending the process.
    process.kill(process.pid, "SIGINT");
  }
  process.exit(code);
}

function flush(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) {
      resolve();
      return;
    }
    stream.write("", () => resolve());
  });
}
