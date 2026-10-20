/**
 * The files a bundle's steps read, sent with the bundle as the request's `resources`.
 *
 * A bundle sent as content has no directory, so a file one of its steps reads from beside the
 * bundle, such as a `PipeDocGen` step's `template_file`, has to travel with it. The runner takes
 * such files as `resources`: a JSON object mapping each file's path, exactly as the step names it,
 * relative to the bundle and written with forward slashes, to the file's bytes in standard padded
 * base64. It takes them beside `mthds_contents` (or a method bundle) on `/v1/validate`,
 * `/v1/execute` and `/v1/start`, and beside inline `files[]` on `/v1/pipe-io`, `/v1/resolve` and
 * `/v1/codegen`. A caller hands this SDK the bytes, keyed by that path, and the SDK encodes them.
 *
 * The SDK refuses before any request what the runner refuses for certain about the keys, with the
 * runner's own rule (`resource_path_refusal` in pipelex's `bundle_resource.py`): an empty path, a
 * backslash, a colon, a NUL character, an absolute path, a `..` segment, a path naming no file,
 * and two keys naming one file once `.` segments and repeated slashes collapse. Each is a
 * `RequestArgumentError` naming the key, where the runner answers a `422` `InvalidResourcePath`.
 * The sizes are left to the server, since a deployment configures them: 32 files, 5 MiB each and
 * 10 MiB in all by default, a `413` `PayloadTooLarge` beyond, and a `422` `MethodTreeTooLarge`
 * for files that take the method tree they join past the runner's tree limits, an `.html`
 * template file counted like any other. So is every rule that needs the parsed bundle: a file no
 * step names is a `422` `BundleResourceNotNamedError`.
 */

import { RequestArgumentError } from "./errors.js";
import { bytesToBase64 } from "./upload.js";

/** The bytes of one file a bundle's steps read: the byte forms `uploadFile` takes. */
export type BundleResourceBytes = Uint8Array | ArrayBuffer | Blob;

/**
 * The files a bundle's steps read, such as a `PipeDocGen` step's template file, keyed by the path
 * the step names (`templates/invoice.docx`), each as its bytes. `./templates/invoice.docx` names
 * the same file, so only one of the two spellings may be given.
 */
export type BundleResources = Readonly<Record<string, BundleResourceBytes>>;

/**
 * Whether `resources` is a plain object, the one shape a map of paths to bytes takes: its
 * prototype is `Object.prototype` or `null`. A `Map`, an array or a class instance is not one,
 * and the encoder refuses it rather than reading it as a map with no file in it.
 */
export function isResourceMap(resources: unknown): resources is Record<string, unknown> {
  if (typeof resources !== "object" || resources === null) return false;
  const prototype: unknown = Object.getPrototypeOf(resources);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether `resources` carries at least one file. An absent, `null` or empty map carries none, so
 * it is not sent, as an empty bundle encoding is not. A value that is not a plain object carries
 * none either; the encoder refuses it.
 */
export function hasBundleResources(resources: unknown): boolean {
  return isResourceMap(resources) && Object.keys(resources).length > 0;
}

/**
 * Python's whitespace, the set `str.strip()` removes and `str.isspace()` accepts, which the
 * runner's rule tests a path against. It differs from JavaScript's `trim()`: it holds the
 * separators U+001C to U+001F and U+0085, and not the byte-order mark U+FEFF.
 */
const PYTHON_WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
]);

/** Whether `path` holds nothing but Python's whitespace: `not path.strip()`, the runner's test. */
function isBlankForPython(path: string): boolean {
  for (const character of path) {
    if (!PYTHON_WHITESPACE.has(character.codePointAt(0)!)) return false;
  }
  return true;
}

/**
 * Why `path` cannot name a file inside a bundle, or `undefined` when it can — the runner's rule,
 * held by the key of a file sent with a bundle and by the path a step names.
 */
export function bundleResourcePathRefusal(path: string): string | undefined {
  if (isBlankForPython(path)) return "it is empty";
  if (path.includes("\\")) return "it holds a backslash; write the path with forward slashes";
  if (path.includes(":")) return "it holds a colon";
  if (path.includes("\0")) return "it holds a NUL character";
  if (path.startsWith("/")) return "it is absolute; write it relative to the bundle";
  const segments = pathSegments(path);
  if (segments.includes("..")) return "it leaves the bundle through a '..' segment";
  if (segments.length === 0) return "it names no file";
  return undefined;
}

/**
 * The one spelling of a bundle-relative path the runner keys a file by: `.` segments and repeated
 * slashes collapse, so `./templates//invoice.docx` is `templates/invoice.docx`. Only meaningful
 * for a path {@link bundleResourcePathRefusal} accepts.
 */
export function canonicalBundleResourcePath(path: string): string {
  return pathSegments(path).join("/");
}

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Encode `resources` for the wire: each key as given, each value as its bytes in standard padded
 * base64. Returns `undefined` when there is nothing to send, so the key stays off the wire.
 *
 * Every key is checked before any value is read, so a refused path costs no read of a `Blob`.
 *
 * @throws {RequestArgumentError} `resources` is not a map of paths to bytes, a key cannot name a
 *   file inside the bundle, two keys name one file, or a value is not bytes.
 */
export async function encodeBundleResources(
  resources: BundleResources | null | undefined,
): Promise<Record<string, string> | undefined> {
  if (resources === undefined || resources === null) return undefined;
  if (!isResourceMap(resources)) {
    throw new RequestArgumentError(
      "resources must be a plain object mapping each file's path, as the step names it, to the " +
        `file's bytes; got ${describeValue(resources)}.`,
    );
  }
  // Read once: a second read of a proxy or a getter could differ from the one checked.
  const entries = Object.entries(resources);
  if (entries.length === 0) return undefined;

  const pathByCanonical = new Map<string, string>();
  for (const [path] of entries) {
    const refusal = bundleResourcePathRefusal(path);
    if (refusal !== undefined) {
      throw new RequestArgumentError(
        `resources key ${JSON.stringify(path)} cannot name a file inside the bundle: ${refusal}.`,
      );
    }
    const canonical = canonicalBundleResourcePath(path);
    const first = pathByCanonical.get(canonical);
    if (first !== undefined) {
      throw new RequestArgumentError(
        `resources keys ${JSON.stringify(first)} and ${JSON.stringify(path)} name the same file ` +
          `"${canonical}": send it once.`,
      );
    }
    pathByCanonical.set(canonical, path);
  }

  // A null prototype, so a key such as `__proto__` is an own property that reaches the wire.
  const wire = Object.create(null) as Record<string, string>;
  for (const [path, value] of entries) {
    wire[path] = bytesToBase64(await resourceBytes(path, value));
  }
  return wire;
}

async function resourceBytes(path: string, value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new RequestArgumentError(
    `resources[${JSON.stringify(path)}] must be the file's bytes (a Uint8Array, an ArrayBuffer ` +
      `or a Blob); got ${describeValue(value)}.` +
      (typeof value === "string"
        ? " A string is read neither as a path nor as base64: read the file and pass its bytes."
        : ""),
  );
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof Map) return "a Map; pass Object.fromEntries(map)";
  if (typeof value === "string") return "a string";
  if (typeof value === "object") {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)
      ?.constructor?.name;
    return typeof name === "string" && name !== "" ? `an instance of ${name}` : "an object";
  }
  return `a value of type ${typeof value}`;
}
