import type { PipelineError } from "@/lib/errors";
// Type-only, so nothing of the SDK reaches the client bundle through this
// module. The descriptor types are the MTHDS standard's (`mthds/protocol`),
// re-exported by the SDK whose `prepareInputs` walks the same nodes.
import type { InputFormItem, PipeInputFormDescriptor } from "@pipelex/sdk";

/**
 * The rules for a run's file inputs, on both sides of the server boundary.
 *
 * **A file reaches a run as a reference, never as bytes.** The browser sends
 * each file straight to Pipelex storage the moment it is dropped: `useFileInputs`
 * asks the method's Server Action for an upload grant, sends the file with it,
 * and writes the `pipelex-storage://` reference into the form's value. So the
 * bytes cross neither this app's server nor the API gateway, and no request of
 * this app carries more than a file's name, type and size. Two gates follow:
 *
 * - `checkUploadRequest` — what a grant action accepts: a file of a media type
 *   the method takes, no larger than `MAX_FILE_BYTES`. The grant signs the type
 *   and the size, so storage refuses a file that differs from what was declared.
 * - `checkFileInputs` — what a run action accepts at a file position: a
 *   reference in a closed set of schemes, and nothing else. The security half,
 *   because the SDK's `prepareInputs` resolves an unrecognised string as a
 *   **local filesystem path**; see {@link ALLOWED_FILE_SCHEMES}.
 *
 * Pure: no React, no `process.env`, safe to import from either side.
 */

/**
 * Largest file a file input will send, in bytes: the platform's own limit on one
 * upload (`MAX_UPLOAD_MIB`), which a grant request declaring more is refused
 * with a `413`. That refusal stays the authority. This constant is the early
 * exit that spares the browser a round trip, and the grant action's own check.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * A refused file: too large, not an accepted type, or not a file that can be
 * sent at all — no name, or nothing in it.
 */
export type FileInputError = {
  kind: "file_too_large" | "unsupported_file_type" | "invalid_file";
  message: string;
};

/**
 * What the browser tells a grant action about a file it is about to upload —
 * the SDK's `UploadGrantInput`, with the type required, since a type the method
 * does not take is refused before any grant is asked for.
 */
export interface UploadRequest {
  filename: string;
  content_type: string;
  size: number;
}

/** Human-readable megabytes, e.g. `8` or `11.4`. */
function mb(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The "too large" rejection, built here so the browser's early exit and the
 * grant action cannot word the same refusal two different ways.
 */
export function fileTooLargeError(bytes: number, maxBytes: number): FileInputError {
  return {
    kind: "file_too_large",
    message: `File is ${mb(bytes)} MB; the limit is ${mb(maxBytes)} MB.`,
  };
}

/**
 * Whether a grant action may ask for a grant for this file. Returns the refusal,
 * or null when the request is acceptable.
 *
 * A Server Action is a public endpoint, so the request is read as untrusted
 * JSON: each field is checked for its type before its value. The browser's own
 * size check is an early exit, not this gate — it is trivially bypassed.
 */
export function checkUploadRequest(
  request: unknown,
  opts: { allowedMimes: string[]; maxBytes: number },
): FileInputError | null {
  const { filename, content_type: type, size } = (request ?? {}) as Partial<UploadRequest>;
  if (typeof filename !== "string" || filename.length === 0) {
    return { kind: "invalid_file", message: "The file has no name." };
  }
  if (typeof type !== "string" || !opts.allowedMimes.includes(type)) {
    const stated = typeof type === "string" && type.length > 0 ? `"${type}"` : "an unknown type";
    return {
      kind: "unsupported_file_type",
      message: `Unsupported file type ${stated}. Expected: ${opts.allowedMimes.join(", ")}.`,
    };
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    return { kind: "invalid_file", message: "The file is empty." };
  }
  if (size > opts.maxBytes) return fileTooLargeError(size, opts.maxBytes);
  return null;
}

/**
 * References a file input may carry. A **closed** set, and that is the point.
 *
 * `prepareInputs` resolves any string it does not recognise as a **local
 * filesystem path**, reads it and uploads it (`@pipelex/sdk`'s
 * `prepare-inputs.js` → `readLocalPath`). A Server Action is a public endpoint,
 * so an unconstrained `url` is an arbitrary server-side file read whose contents
 * come back rendered to the caller. `http://` is left out deliberately: nothing
 * in this template needs a cleartext fetch, and the narrower set is the safer
 * default for code adopters copy.
 *
 * What the two schemes mean:
 *
 * - `pipelex-storage://` is a file in this app's own storage scope, which
 *   `prepareInputs` passes through untouched. It is what a dropped file becomes:
 *   the browser uploads it with a grant and the form's value holds its
 *   reference. The URIs are server-generated opaque ids, so this is not
 *   guessable — and a reference obtained from an earlier run round-trips too.
 * - `https://` is the kernel's "paste a URL instead" affordance. Accepting it
 *   means the **runner** fetches that URL server-side, which is the feature —
 *   and it is also why a host that must not reach arbitrary origins wants an
 *   allow-list here rather than a scheme test. Left open in the template
 *   because a plausible allow-list for a template does not exist.
 *
 * `data:` is not in the set. Nothing in this app sends a file inline any more,
 * and a run request carrying bytes is exactly what outgrew the Server Action's
 * body limit once a method took a list of files.
 */
const ALLOWED_FILE_SCHEMES = ["https://", "pipelex-storage://"];

/** Strict plain-object test — the SDK's own, so the two walks agree on what an object is. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * The kernel's explicit `{ concept, content }` envelope — exact keys, not a
 * superset, which is the SDK's test (`isExplicitEnvelope`) and the runtime's
 * (`input_shaper.py`'s `_is_explicit`). A structured input that merely happens
 * to carry both fields is not an envelope.
 */
function isExplicitEnvelope(value: unknown): value is { concept: unknown; content: unknown } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && "concept" in value && "content" in value;
}

/** One file position the descriptor declares, with the source the value put there. */
interface FilePosition {
  /** Dotted, list indices included: `document`, `cvs.1`, `packet.scan`. */
  path: string;
  /** What `prepareInputs` would resolve: `value.url` for `{url}` content, else the value. */
  source: unknown;
}

/**
 * The file positions under one descriptor node, found by walking the
 * DESCRIPTOR — never the value. This is `prepareInputs`'s `resolveNode`, read
 * rather than resolved: `document` / `image` is a file position whatever the
 * value's shape, `object` descends the fields it declares (a key the descriptor
 * does not name is copied through untouched by the SDK, so it is not a file
 * position here either), `list` descends `item` against each element, and
 * every other kind passes through at any depth — `unknown` included, which the
 * SDK deliberately does not interpret. A value whose shape disagrees with the
 * node (a scalar at an `object`, a non-array at a `list`) is left to the shape
 * gate and the run.
 *
 * At a file position the source is read the way `resolveFilePosition` reads
 * it: canonical `{url}` content yields its `url`, anything else IS the source.
 */
function collectFilePositions(
  node: InputFormItem,
  value: unknown,
  path: string,
  out: FilePosition[],
): void {
  switch (node.kind) {
    case "document":
    case "image": {
      out.push({ path, source: isPlainObject(value) && "url" in value ? value["url"] : value });
      return;
    }
    case "object": {
      if (!isPlainObject(value)) return;
      for (const child of node.fields) {
        if (Object.hasOwn(value, child.name)) {
          collectFilePositions(child, value[child.name], `${path}.${child.name}`, out);
        }
      }
      return;
    }
    case "list": {
      if (!Array.isArray(value)) return;
      value.forEach((entry, index) => {
        collectFilePositions(node.item, entry, `${path}.${index}`, out);
      });
      return;
    }
    default:
      return;
  }
}

/**
 * The scheme gate for the file-bearing inputs in a gated payload. The kernel
 * gate proves the *shape*; this proves what the contract cannot express — that
 * every file position holds a reference this app accepts. The media type and the
 * size were checked when the file's upload grant was asked for, and storage held
 * the file to both, so a run action only ever sees what already passed them.
 *
 * **The descriptor is the classifier, never the value's shape.** The SDK's
 * `prepareInputs` finds the positions it will resolve by walking the method's
 * wire input-form descriptor — `document` / `image` at any depth, through
 * `object` fields and `list` items — and this gate walks the same descriptor,
 * so the set of positions it verifies is exactly the set the SDK goes on to
 * read. That is what lets a method take `cvs: list[Document]`, or a file inside
 * a structured concept, without a value heuristic on either side: a `text`
 * field merely *named* `url` is not a file, and a `Document` two levels down
 * is. The earlier shape of this gate read `content.url` one level down and
 * refused anything deeper, because a value walk cannot tell a document string
 * from a text one; the descriptor can.
 *
 * Three properties worth keeping when adapting this:
 *
 * 1. **Refuse by default.** Treating an unfamiliar string as "nothing to check"
 *    is how the local-file read above opens — the absence of bytes to inspect
 *    is not the absence of something to verify.
 * 2. **Keyed on the descriptor, not on an input's name.** Hard-coding
 *    `inputs.document` makes this whole gate return "fine" the day the bundle
 *    renames that input, while codegen carries the rename into the form, the
 *    readiness rules and the wire envelope. The descriptor is regenerated with
 *    them, so a rename moves the gate too.
 * 3. **A file position holds a string, or it is refused.** `prepareInputs`
 *    accepts a *bare source string* at a file position as readily as `{url}`
 *    and resolves the two identically, so both are read here. Anything else
 *    that is present — raw bytes, which the SDK would upload unchecked, or an
 *    object with no `url` — is refused rather than skipped: the verdict rests on this walk,
 *    never on the schema gate in front of it happening to refuse the same
 *    thing. `null` and `undefined` are the one exception, because they are how
 *    an optional file position is left empty, and nothing reads a file for them.
 *
 * This is the authoritative check, and it runs in the run's Server Action; the
 * browser never runs it.
 */
export function checkFileInputs(
  descriptor: PipeInputFormDescriptor,
  inputs: Record<string, unknown>,
): PipelineError | null {
  const positions: FilePosition[] = [];
  for (const field of descriptor.fields) {
    if (!Object.hasOwn(inputs, field.name)) continue;
    const value = inputs[field.name];
    // The kernel gate hands over `{ concept, content }` envelopes; the SDK reads
    // the inner content against the same node, and so does this.
    const content = isExplicitEnvelope(value) ? value.content : value;
    collectFilePositions(field, content, field.name, positions);
  }

  for (const { path, source } of positions) {
    if (source === undefined || source === null) continue; // An empty optional position.
    if (typeof source !== "string" || !ALLOWED_FILE_SCHEMES.some((s) => source.startsWith(s))) {
      return {
        kind: "bad_request",
        title: "Unsupported file reference",
        message:
          `The "${path}" input must be an uploaded file, an https:// URL, or a ` +
          `pipelex-storage:// reference.`,
        details: `unsupported_scheme: ${path}`,
      };
    }
  }
  return null;
}

const FILE_ERROR_TITLES: Record<FileInputError["kind"], string> = {
  file_too_large: "File too large",
  unsupported_file_type: "Unsupported file type",
  invalid_file: "File can't be uploaded",
};

/**
 * Render a `FileInputError` as a `PipelineError` for `<ErrorDisplay>`. The title
 * says "File", not "PDF": the gates are generic over whatever a method declares,
 * and the message underneath already names the type and the limit.
 */
export function fileInputErrorToPipelineError(
  fileError: FileInputError,
  filename: string,
): PipelineError {
  return {
    kind: fileError.kind,
    title: FILE_ERROR_TITLES[fileError.kind],
    message: fileError.message,
    details: `${fileError.kind}: ${filename || "(no filename)"}`,
  };
}
