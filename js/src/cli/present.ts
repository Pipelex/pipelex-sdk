/**
 * What the command prints: a finished run's result on stdout, and every failure on stderr.
 *
 * A failure is worded by the command from the error's typed fields, never from an SDK message
 * whose wording is the SDK's own, wherever the fields carry what a person needs: the API's reason,
 * the next step it advises and the request id support asks for. That keeps the two commands, this
 * one and its Python twin, saying the same thing for the same answer, which is what the recorded
 * case table holds them to.
 */

import {
  ApiResponseError,
  ApiUnreachableError,
  InputPreparationError,
  InvalidInputValueError,
  InvalidLocalSourceError,
  MethodLoadError,
  PipelineRequestError,
  RunFailedError,
} from "../index.js";
import type { ValidationErrorItem } from "../index.js";
import { CommandError, EXIT_FAILED, EXIT_USAGE } from "./io.js";
import type { CommandIO } from "./io.js";

/** A failure as the command prints it: its lines, and the exit code it ends with. */
export interface PresentedError {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

/** Word any failure for stderr and choose its exit code. */
export function presentError(error: unknown): PresentedError {
  if (error instanceof CommandError) {
    const first = error.bare ? error.message : `Error: ${error.message}`;
    return { lines: [first, ...error.details], exitCode: error.exitCode };
  }
  if (error instanceof RunFailedError) {
    const report = error.error;
    const lines = [`Error: run ${error.runId} ended with status ${error.status}.`];
    lines.push(`Reason: ${report?.message ?? error.message}`);
    if (report?.user_action?.detail) lines.push(`Next step: ${report.user_action.detail}`);
    return { lines, exitCode: EXIT_FAILED };
  }
  if (error instanceof InvalidLocalSourceError) {
    // A file the inputs name that cannot be read is the inputs' fault, as an unreadable inputs
    // file is, so it is a usage error.
    return {
      lines: [
        `Error: ${error.message}`,
        "A relative path in the inputs resolves against the current directory.",
      ],
      exitCode: EXIT_USAGE,
    };
  }
  if (error instanceof InvalidInputValueError) {
    // A value at a file input that is no file, such as a data: URL that does not decode or a
    // number, is the inputs' fault too.
    return {
      lines: [
        "Error: the inputs hold a value at a file input that cannot be read as a file.",
        `Reason: ${error.message}`,
        FILE_INPUT_FORMS,
      ],
      exitCode: EXIT_USAGE,
    };
  }
  if (error instanceof MethodLoadError) {
    // The same lines whichever route said so: the input preparation here, the pipe I/O call of
    // `--inputs-template` and `script` in `source.ts`.
    return {
      lines: [
        METHOD_DOES_NOT_LOAD,
        ...loadFailureLines(error.validationErrors, error.serverMessage),
      ],
      exitCode: EXIT_FAILED,
    };
  }
  if (error instanceof InputPreparationError && error.cause instanceof ApiResponseError) {
    return presentRefusal(error.cause);
  }
  if (error instanceof ApiResponseError) {
    return presentRefusal(error);
  }
  if (error instanceof ApiUnreachableError) {
    return {
      lines: [
        `Error: could not reach the Pipelex API at ${error.apiUrl} (${error.code ?? "network error"}).`,
      ],
      exitCode: EXIT_FAILED,
    };
  }
  if (error instanceof PipelineRequestError) {
    return { lines: [`Error: ${error.message}`], exitCode: EXIT_FAILED };
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { lines: [`Error: unexpected failure, ${detail}`], exitCode: EXIT_FAILED };
}

/** An answer the API gave instead of a result: its status, its reason and its advice. */
function presentRefusal(error: ApiResponseError): PresentedError {
  const lines =
    error.status >= 200 && error.status < 300
      ? [`Error: the API's answer could not be read (status ${error.status}).`]
      : [`Error: the API refused the request (status ${error.status}).`];
  lines.push(`Reason: ${error.serverMessage ?? error.title ?? "the answer gives no reason"}`);
  for (const item of error.validationErrors ?? []) lines.push(validationLine(item));
  if (error.userAction?.detail) lines.push(`Next step: ${error.userAction.detail}`);
  if (error.requestId) lines.push(`Request id: ${error.requestId}`);
  return { lines, exitCode: EXIT_FAILED };
}

/** What a file input takes, the hint under a value it cannot take. */
const FILE_INPUT_FORMS =
  'A file input takes a local path, an http(s) or pipelex-storage:// URL, a data: URL, or an object whose "url" is one of these.';

/** The first line of a method that does not load, after `Error: `. */
export const METHOD_DOES_NOT_LOAD_SENTENCE = "the method does not load.";
const METHOD_DOES_NOT_LOAD = `Error: ${METHOD_DOES_NOT_LOAD_SENTENCE}`;

/**
 * The lines under "the method does not load": one per validation item that carries a string
 * `category` and `message`, the rule the SDK reads a failed load's items by, and when there is
 * none, the answer's own message.
 */
export function loadFailureLines(items: unknown, message: unknown): string[] {
  const lines = (Array.isArray(items) ? items : []).filter(isLoadItem).map(validationLine);
  if (lines.length === 0) {
    lines.push(`  - ${typeof message === "string" ? message : "the answer gives no reason"}`);
  }
  return lines;
}

function isLoadItem(value: unknown): value is { message: string; source?: unknown } {
  return (
    isPlainObject(value) && typeof value.category === "string" && typeof value.message === "string"
  );
}

/** One validation error, as an indented line naming its file when it has one. */
export function validationLine(
  item: Pick<ValidationErrorItem, "message"> & { source?: unknown },
): string {
  const source = typeof item.source === "string" && item.source !== "" ? `${item.source}: ` : "";
  return `  - ${source}${item.message}`;
}

/** The keys of the runtime's absence document, and no other. */
const ABSENCE_KEYS = ["absent", "variable_name", "kind", "reason", "producing_pipe", "upstream"];
const ABSENCE_KINDS = ["declared_absent", "skipped", "not_provided"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a run's main output is the absence of one: nothing at all, or the runtime's absence
 * document, matched by its whole shape (exactly its keys, each of the type the runtime writes) and
 * never by its `absent` key alone, since a method's own output may carry such a field. The same
 * rule `cli-python` applies.
 */
export function isAbsence(mainStuff: unknown): boolean {
  if (mainStuff === null || mainStuff === undefined) return true;
  if (!isPlainObject(mainStuff)) return false;
  const keys = Object.keys(mainStuff);
  if (keys.length !== ABSENCE_KEYS.length || !ABSENCE_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  const { absent, variable_name, kind, reason, producing_pipe, upstream } = mainStuff;
  return (
    absent === true &&
    typeof variable_name === "string" &&
    typeof kind === "string" &&
    ABSENCE_KINDS.includes(kind) &&
    typeof reason === "string" &&
    (producing_pipe === null || typeof producing_pipe === "string") &&
    (upstream === null || isPlainObject(upstream))
  );
}

/**
 * Print a finished run's main output on stdout, as the method produced it: indented JSON,
 * unvalidated and unrepaired, a list included whichever shape it arrived in. An output the method
 * left absent prints `null`, and a line on stderr says so.
 */
export function printResult(mainStuff: unknown, io: CommandIO): void {
  if (isAbsence(mainStuff)) {
    io.writeStdout("null\n");
    if (isPlainObject(mainStuff)) {
      io.writeStderr(
        `The method left its output "${String(mainStuff.variable_name)}" absent (${String(mainStuff.reason)}), so the result is null.\n`,
      );
    } else {
      io.writeStderr("The method produced no output, so the result is null.\n");
    }
    return;
  }
  io.writeStdout(`${JSON.stringify(mainStuff, null, 2)}\n`);
}
