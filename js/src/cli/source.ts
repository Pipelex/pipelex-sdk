/**
 * The method as each route names it, and the one pipe I/O call that checks it.
 *
 * A bundle read from disk travels to the pipe I/O route as `files`, each file under its name in the
 * bundle, and to the run as `mthds_contents`, in the same order. An address travels as
 * `method_ref` and a catalog id as `method_id`, both resolved by the server.
 */

import type { FieldKind } from "mthds/protocol";
import type {
  PipeInputFormDescriptor,
  PipeIORequest,
  PipelexApiClient,
  PipeIOValidReport,
  PipelexStartOptions,
} from "../index.js";
import { inputFormFault } from "../index.js";
import type { BundleFile } from "./bundle.js";
import { CommandError, EXIT_FAILED, untilInterrupted } from "./io.js";
import { loadFailureLines, METHOD_DOES_NOT_LOAD_SENTENCE } from "./present.js";

/** A method the command can send: a bundle read from disk, an address or a catalog id. */
export type MethodSource =
  | { readonly kind: "bundle"; readonly files: readonly BundleFile[] }
  | { readonly kind: "address"; readonly methodRef: string }
  | { readonly kind: "catalog"; readonly methodId: string };

/** The method as the crate routes and the input preparation name it. */
export type CrateSelector =
  | { files: Array<{ content: string; source: string }> }
  | { method_ref: string }
  | { method_id: string };

export function crateSelector(source: MethodSource): CrateSelector {
  switch (source.kind) {
    case "bundle":
      return { files: source.files.map((file) => ({ content: file.content, source: file.name })) };
    case "address":
      return { method_ref: source.methodRef };
    case "catalog":
      return { method_id: source.methodId };
  }
}

/** The method as the run routes name it. */
export function runSelector(source: MethodSource): PipelexStartOptions {
  switch (source.kind) {
    case "bundle":
      return { mthds_contents: source.files.map((file) => file.content) };
    case "address":
      return { method_ref: source.methodRef };
    case "catalog":
      return { method_id: source.methodId };
  }
}

/** A pipe I/O answer's valid arm, and the input form of the pipe it selected. */
export interface DescribedPipe {
  readonly report: PipeIOValidReport;
  readonly pipeRef: string;
  readonly descriptor: PipeInputFormDescriptor;
}

/**
 * Ask `POST /v1/pipe-io` for the pipe the method and `--pipe` select, which spends no inference:
 * the same selection the run's input preparation makes.
 *
 * @throws {CommandError} When the method does not load, or the answer does not describe the pipe
 *   it selected or describes it with an input form the walk or the template cannot read. A refusal
 *   of the request itself propagates as the SDK's `ApiResponseError`.
 * @throws {Interrupted} When the person interrupts the wait.
 */
export async function describePipe(
  client: PipelexApiClient,
  source: MethodSource,
  pipe: string | undefined,
  interrupt: AbortSignal,
): Promise<DescribedPipe> {
  const request: PipeIORequest = {
    ...crateSelector(source),
    ...(pipe === undefined ? {} : { pipe_ref: pipe }),
  };
  const answer: unknown = await untilInterrupted(() => client.pipeIo(request), interrupt);
  if (!isPlainObject(answer) || typeof answer.is_valid !== "boolean") {
    throw new CommandError(
      "the API's pipe I/O answer says neither that the method loads nor why it does not.",
      {
        exitCode: EXIT_FAILED,
      },
    );
  }
  if (!answer.is_valid) {
    throw new CommandError(METHOD_DOES_NOT_LOAD_SENTENCE, {
      exitCode: EXIT_FAILED,
      details: loadFailureLines(answer.validation_errors, answer.message),
    });
  }
  const report = answer as unknown as PipeIOValidReport;
  const pipeRef = report.pipe_ref;
  const inputForm: unknown = report.input_form;
  if (
    typeof pipeRef !== "string" ||
    !isPlainObject(inputForm) ||
    !Object.hasOwn(inputForm, pipeRef)
  ) {
    throw new CommandError("the API's pipe I/O answer does not describe the pipe it selected.", {
      exitCode: EXIT_FAILED,
    });
  }
  // The template is rendered from this entry, so it is checked as input preparation checks it,
  // and then for what the template reads beyond the walk: a malformed entry would otherwise crash
  // the rendering or print a template under made-up keys. The sentence is the Python command's,
  // printed when its client cannot parse an entry, which cannot say where, so neither command
  // names the fault. Python's closed models refuse more than this, such as a member the standard
  // does not define, which the template never reads.
  const entry = inputForm[pipeRef];
  if (inputFormFault(entry) !== undefined || !templateReadable(entry as Record<string, unknown>)) {
    throw new CommandError(
      "the API's pipe I/O answer describes the pipe it selected with a malformed input form.",
      { exitCode: EXIT_FAILED },
    );
  }
  return { report, pipeRef, descriptor: entry as unknown as PipeInputFormDescriptor };
}

/**
 * Whether an entry `inputFormFault` passed also holds what the inputs template reads beyond the
 * walk, in a shape it can render: every node's `concept_ref` a string, its `refines` a list of
 * strings, an enum's `choices` a list and a list's `item_count` a whole number of at least two,
 * the last three when present. Members the template only tests for truth are not checked.
 */
function templateReadable(entry: Record<string, unknown>): boolean {
  return (entry.fields as Array<Record<string, unknown>>).every(templateReadableNode);
}

function templateReadableNode(node: Record<string, unknown>): boolean {
  if (node.concept_ref !== undefined && typeof node.concept_ref !== "string") return false;
  if (
    node.refines !== undefined &&
    node.refines !== null &&
    !(Array.isArray(node.refines) && node.refines.every((ref) => typeof ref === "string"))
  ) {
    return false;
  }
  // Every kind is listed, so a kind a newer `mthds` pin adds stops the build here until the
  // template's reads of it are checked, as it does in the walk's own table.
  const kind = node.kind as FieldKind;
  switch (kind) {
    case "text":
    case "prose":
    case "date":
    case "number":
    case "boolean":
    case "document":
    case "image":
    case "unknown":
      return true;
    case "object":
      return templateReadable(node);
    case "enum":
      return Array.isArray(node.choices);
    case "list":
      return (
        (node.item_count === undefined ||
          node.item_count === null ||
          (Number.isInteger(node.item_count) && (node.item_count as number) >= 2)) &&
        templateReadableNode(node.item as Record<string, unknown>)
      );
    default: {
      // Unreachable: `inputFormFault` refused a kind outside the walk's table.
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
