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
 * 10 MiB in all by default, a `413` `PayloadTooLarge` beyond, and 512 KiB in all for the `.html`
 * template files, a `413` `BundleResourcesTooLargeError`. So is every rule that needs the parsed
 * bundle: a file no step names is a `422` `BundleResourceNotNamedError`.
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
 * Whether `resources` carries at least one file. An absent, `null` or empty map carries none, so
 * it is not sent, as an empty bundle encoding is not.
 */
export function hasBundleResources(resources: unknown): boolean {
  return (
    typeof resources === "object" &&
    resources !== null &&
    !Array.isArray(resources) &&
    Object.keys(resources).length > 0
  );
}

/**
 * Why `path` cannot name a file inside a bundle, or `undefined` when it can — the runner's rule,
 * held by the key of a file sent with a bundle and by the path a step names.
 */
export function bundleResourcePathRefusal(path: string): string | undefined {
  if (path.trim() === "") return "it is empty";
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
  if (typeof resources !== "object" || Array.isArray(resources)) {
    throw new RequestArgumentError(
      "resources must map each file's path, as the step names it, to the file's bytes; " +
        `got ${describeValue(resources)}.`,
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
  if (typeof value === "string") return "a string";
  return `a value of type ${typeof value}`;
}
