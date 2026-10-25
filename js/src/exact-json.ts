/**
 * JSON whose integers stay exact.
 *
 * JavaScript reads every JSON number as a double, so an integer past `Number.MAX_SAFE_INTEGER`
 * (2^53 - 1) reads rounded, `12345678901234567891` as `12345678901234567000`, and is written back
 * rounded. `parseExactJson` reads such an integer as a `bigint` holding its exact digits instead,
 * and `stringifyExactJson` writes a `bigint` back as those digits where `JSON.stringify` throws;
 * everything else reads and writes exactly as `JSON.parse` and `JSON.stringify` read and write it,
 * since both are those very functions. A number with a fraction or an exponent stays a double:
 * `3.0` reads as `3`, as it does everywhere in JavaScript, and is written back as `3`.
 *
 * Both rest on the JSON source-text proposal, which every runtime this package supports provides:
 * the reader on the source text `JSON.parse` hands its reviver (`context.source`), the writer on
 * `JSON.rawJSON`. On a runtime without them, neither ever rounds: the reader refuses a number it
 * cannot read exactly with `ExactJsonUnsupportedError`, and the writer refuses a `bigint` with the
 * `TypeError` `JSON.stringify` throws for one.
 *
 * The client reads with `parseExactJson` every answer that carries a person's data, a method
 * example's inputs and a run's inputs, outputs and working memory, and writes every request body
 * with `stringifyExactJson`, so such data goes back to the platform digit for digit. The barrel
 * exports both and the error, for a caller that shows such data as JSON text or reads it back from
 * it. This module imports nothing but the standard's problem builder.
 */

import { ProblemError, buildProblem } from "mthds/protocol";

/** An integer as JSON spells one: a sign and digits, with no fraction and no exponent. */
const INTEGER_TOKEN = /^-?\d+$/;

/**
 * A run of 16 digits. Every integer past the safe range spells at least that many, the smallest
 * being `9007199254740992`, so a text without one holds no such integer, and `JSON.parse` reads
 * it exactly with no reviver to call. A run inside a string only costs the reviver's calls.
 */
const LONG_DIGIT_RUN = /\d{16}/;

/** `JSON`, with the `rawJSON` the TypeScript library this package compiles against does not declare. */
const JSON_WITH_RAW = JSON as unknown as { rawJSON?: (text: string) => unknown };

/** What `JSON.parse` hands a reviver beside a value, on a runtime with the source-text proposal. */
interface ReviverContext {
  /** The value's JSON text, given for a primitive value only. */
  source?: string;
}

/**
 * Thrown by `parseExactJson` on a runtime whose `JSON.parse` does not hand a reviver the source
 * text of a value, for a text holding a number it then cannot read exactly: one past
 * `Number.MAX_SAFE_INTEGER` that reads as a whole number, or as `Infinity`. Without the source
 * text, such a number cannot be told from a float of the same value, so the reader refuses it
 * rather than read it rounded. Every runtime this package supports hands the source text.
 *
 * Outside the `PipelexRequestError` family, since nothing was requested, it is a `ProblemError`
 * (from `mthds/protocol`) all the same, so a caller reads it as it reads every SDK error: its
 * problem is `client.tool_outdated`, naming the JavaScript runtime and its version when it is
 * Node's, since running on a runtime the package supports is what fixes it. Its message is the
 * reader's own sentence.
 */
export class ExactJsonUnsupportedError extends ProblemError {
  constructor(message: string) {
    super(
      buildProblem("client.tool_outdated", {
        tool: "JavaScript runtime",
        version: runtimeVersion(),
      }),
    );
    this.name = "ExactJsonUnsupportedError";
    this.message = message;
  }
}

/** The version of the JavaScript runtime, as Node names its own, or `unknown` on another. */
function runtimeVersion(): string {
  const node = (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions
    ?.node;
  return typeof node === "string" ? `Node.js ${node}` : "unknown";
}

/**
 * Read a JSON text as `JSON.parse` reads it, except that an integer past `Number.MAX_SAFE_INTEGER`
 * in either direction is a `bigint` holding its exact digits. Throws the `SyntaxError`
 * `JSON.parse` throws for a text that is not JSON, and `ExactJsonUnsupportedError` on a runtime
 * that cannot read such an integer exactly.
 */
export function parseExactJson(text: string): unknown {
  return LONG_DIGIT_RUN.test(text) ? JSON.parse(text, readIntegerExactly) : JSON.parse(text);
}

/**
 * Write a value as `JSON.stringify` writes it, `space` indenting as its own does, except that a
 * `bigint` is written as its exact digits rather than refused. It is one `JSON.stringify` call,
 * whose replacer writes each `bigint` as raw JSON text, so every getter and every `toJSON` in the
 * value runs once, and whatever one of them throws propagates as thrown. A `toJSON` a `bigint`
 * inherits, such as the common polyfill `BigInt.prototype.toJSON`, is passed over: the `bigint`
 * is still written as its digits, not as what that `toJSON` makes of it, unless a getter returns
 * it, since reading it again would run the getter twice. That rests on `JSON.rawJSON`, which
 * every runtime this package supports provides; on one without it, a `bigint` is refused with a
 * `TypeError`, as `JSON.stringify` refuses it, and never written rounded. Any other failure, a
 * cycle for instance, is the `TypeError` `JSON.stringify` throws for it.
 */
export function stringifyExactJson(value: unknown, space?: string | number): string {
  // `toJSON` runs before the replacer, so under such a `toJSON` the replacer is handed what it
  // made of a `bigint`, a string most often, and finds the `bigint` in the holder instead.
  const bigIntHasToJson = typeof (BigInt.prototype as { toJSON?: unknown }).toJSON === "function";
  return JSON.stringify(
    value,
    function writeBigIntExactly(this: unknown, key: string, item: unknown): unknown {
      if (typeof item === "bigint") return rawBigInt(item);
      if (!bigIntHasToJson) return item;
      const held = ownDataValue(this, key);
      return typeof held === "bigint" ? rawBigInt(held) : item;
    },
    space,
  );
}

/**
 * The reviver of `parseExactJson`: a number past the safe range spelled as an integer becomes a
 * `bigint` of its source text, which also covers one too long for a double, which `JSON.parse`
 * reads as `Infinity`. Every other value is returned as `JSON.parse` read it, so an object is
 * built as `JSON.parse` builds one, `__proto__` and repeated keys included.
 */
function readIntegerExactly(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  if (typeof source === "string") return INTEGER_TOKEN.test(source) ? BigInt(source) : value;
  // No source text: a fraction stays the double it is, but a whole number past the safe range,
  // `Infinity` included, may have been spelled as an integer this read would round.
  if (Number.isFinite(value) && !Number.isInteger(value)) return value;
  throw new ExactJsonUnsupportedError(
    `This runtime's JSON.parse gives a reviver no source text, so the number read as ${value} ` +
      "cannot be read exactly.",
  );
}

/** A `bigint` as the raw JSON text of its exact digits, refused on a runtime without `rawJSON`. */
function rawBigInt(value: bigint): unknown {
  if (typeof JSON_WITH_RAW.rawJSON !== "function") {
    throw new TypeError(
      `This runtime has no JSON.rawJSON, so the bigint ${value.toString()} cannot be written ` +
        "as its exact digits.",
    );
  }
  return JSON_WITH_RAW.rawJSON(value.toString());
}

/**
 * The value `holder` holds under `key` as an own data property, read from its descriptor so that
 * no getter runs again, or `undefined` for an accessor or no such property.
 */
function ownDataValue(holder: unknown, key: string): unknown {
  if (typeof holder !== "object" || holder === null) return undefined;
  return Object.getOwnPropertyDescriptor(holder, key)?.value;
}
