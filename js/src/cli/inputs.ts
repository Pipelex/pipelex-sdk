/**
 * The inputs `--inputs` names: a JSON object, one entry per input, read from a file or, for `-`,
 * from stdin. It is the shape `mthds run --inputs` and `cli-python`'s `--inputs` take, and the
 * shape `--inputs-template` prints.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { systemReason } from "./bundle.js";
import { untilInterrupted, usageError } from "./io.js";
import type { CommandIO } from "./io.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Read and parse the inputs. A relative path resolves against the current directory.
 *
 * @throws {CommandError} A usage error for an unreadable file, text that is not UTF-8 or not
 *   JSON, and JSON that is not an object.
 */
export async function readInputs(source: string, io: CommandIO): Promise<Record<string, unknown>> {
  const label = source === "-" ? "stdin" : `the inputs file "${source}"`;
  let bytes: Uint8Array;
  if (source === "-") {
    bytes = await untilInterrupted(io.readStdin(), io.interrupt);
  } else {
    try {
      bytes = await readFile(resolve(source));
    } catch (error) {
      throw usageError(`cannot read ${label}.`, [`Reason: ${systemReason(error)}`]);
    }
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw usageError(`${label} is not UTF-8 text.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw usageError(`${label} is not valid JSON.`, [
      `Reason: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(
      `${label} must hold a JSON object, one entry per input, and holds ${jsonKind(parsed)}.`,
      ["Run with --inputs-template to see the object this method takes."],
    );
  }
  return parsed as Record<string, unknown>;
}

/** What a JSON value is, said the way the refusal says it. */
function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    default:
      return "not an object";
  }
}
