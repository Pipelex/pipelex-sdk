/**
 * `pipelex-sdk run`: run one method and print its main output.
 *
 * Every check that needs no request comes first, in this order, so that a mistake costs nothing:
 * the flags, `--pipe`'s form, the method (a path is read from disk), the inputs, the poll interval
 * and the key. Then the inputs are prepared, which uploads each local file at a file input; the
 * run is started through the SDK's start-and-wait, whose `onStarted` gives the run id to stderr
 * as soon as the run exists; and the main output reaches stdout once the run completes, however
 * long that takes.
 */

import { renderInputsTemplate } from "../index.js";
import type { PipelexApiClient, RunResults } from "../index.js";
import { parseFlags } from "./args.js";
import { readBundle } from "./bundle.js";
import { makeClient, readPollInterval } from "./environment.js";
import { RUN_HELP } from "./help.js";
import { readInputs } from "./inputs.js";
import {
  CommandError,
  EXIT_INTERRUPTED,
  EXIT_OK,
  Interrupted,
  untilInterrupted,
  usageError,
} from "./io.js";
import type { CommandIO } from "./io.js";
import { checkPipeRef, classifyMethod } from "./method.js";
import { printResult } from "./present.js";
import { crateSelector, describePipe, runSelector } from "./source.js";
import type { MethodSource } from "./source.js";

const RUN_FLAGS = {
  method: { type: "string" },
  pipe: { type: "string" },
  inputs: { type: "string" },
  "inputs-template": { type: "boolean" },
} as const;

/** Where a run stands, which decides what an interrupt says. */
type Stage =
  | { readonly kind: "local" }
  | { readonly kind: "starting" }
  | { readonly kind: "started"; readonly runId: string };

/** Run `pipelex-sdk run` and return its exit code. */
export async function runCommandRun(args: readonly string[], io: CommandIO): Promise<number> {
  const flags = parseFlags("run", args, RUN_FLAGS);
  if (flags.help) {
    io.writeStdout(RUN_HELP);
    return EXIT_OK;
  }
  const method = flags.strings.get("method");
  if (method === undefined) {
    throw usageError("--method is required.", ["Run 'pipelex-sdk run --help' to see its flags."]);
  }
  const inputsSource = flags.strings.get("inputs");
  const templateOnly = flags.booleans.has("inputs-template");
  if (templateOnly && inputsSource !== undefined) {
    throw usageError("--inputs-template prints the inputs a run takes, so it takes no --inputs.");
  }
  const pipe = flags.strings.get("pipe");
  if (pipe !== undefined) checkPipeRef(pipe);

  let stage: Stage = { kind: "local" };
  try {
    const source = await methodSource(method);
    const inputs = inputsSource === undefined ? undefined : await readInputs(inputsSource, io);
    const intervalMs = readPollInterval(io);
    const client = makeClient(io);

    if (templateOnly) {
      const described = await describePipe(client, source, pipe, io.interrupt);
      const template = renderInputsTemplate(described.descriptor, {
        explicit: false,
        format: "json",
      });
      io.writeStdout(`${template}\n`);
      return EXIT_OK;
    }

    const prepared = await prepare(client, source, pipe, inputs, io);
    const results: RunResults = await untilInterrupted(() => {
      // Only once the start is under way: an interrupt that landed before it starts nothing, and
      // the command says no run was started.
      stage = { kind: "starting" };
      return client.startAndWaitForResult(
        {
          ...runSelector(source),
          ...(pipe === undefined ? {} : { pipe_code: pipe }),
          ...(prepared === undefined ? {} : { inputs: prepared }),
        },
        {
          // A run takes as long as it takes: the command waits for it until it ends or the
          // person interrupts.
          timeoutMs: Number.POSITIVE_INFINITY,
          ...(intervalMs === undefined ? {} : { intervalMs }),
          signal: io.interrupt,
          artifacts: ["main_stuff"],
          onStarted: (ack) => {
            if (io.interrupt.aborted) return;
            stage = { kind: "started", runId: ack.pipeline_run_id };
            io.writeStderr(`Run started: ${ack.pipeline_run_id}\n`);
          },
        },
      );
    }, io.interrupt);
    printResult(results.main_stuff, io);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    throw new CommandError(interruptMessage(stage, templateOnly), {
      exitCode: EXIT_INTERRUPTED,
      bare: true,
    });
  }
}

/** The method `--method` names, a path being read from disk. */
async function methodSource(method: string): Promise<MethodSource> {
  const selector = classifyMethod(method);
  switch (selector.kind) {
    case "address":
      return { kind: "address", methodRef: selector.methodRef };
    case "catalog":
      return { kind: "catalog", methodId: selector.methodId };
    case "path":
      return { kind: "bundle", files: await readBundle(selector.path) };
  }
}

/**
 * Upload the local files the inputs name at the method's file inputs, through the SDK's input
 * preparation, and report each upload on stderr. Inputs that are absent or empty are sent as they
 * are, with no request: there is nothing to upload.
 */
async function prepare(
  client: PipelexApiClient,
  source: MethodSource,
  pipe: string | undefined,
  inputs: Record<string, unknown> | undefined,
  io: CommandIO,
): Promise<Record<string, unknown> | undefined> {
  if (inputs === undefined || Object.keys(inputs).length === 0) return inputs;
  const prepared = await untilInterrupted(
    () =>
      client.prepareInputs({
        ...crateSelector(source),
        ...(pipe === undefined ? {} : { pipe_ref: pipe }),
        inputs,
        // Once interrupted, no upload starts after the pipe I/O answer arrives.
        signal: io.interrupt,
      }),
    io.interrupt,
  );
  for (const upload of prepared.uploads) {
    io.writeStderr(`Uploaded ${upload.filename} as ${upload.uri}\n`);
  }
  return prepared.inputs;
}

/** What an interrupt says, by where the run stood. */
function interruptMessage(stage: Stage, templateOnly: boolean): string {
  if (templateOnly) return "Interrupted.";
  switch (stage.kind) {
    case "local":
      return "Interrupted. No run was started.";
    case "starting":
      return "Interrupted before the API answered with a run id. A run may or may not have started on the server.";
    case "started":
      return `Interrupted. Run ${stage.runId} keeps going on the server.`;
  }
}
