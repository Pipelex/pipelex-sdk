/**
 * `prepareInputs` — signature-driven input preparation. Reads the target pipe's
 * declared inputs from the **input-form descriptor** `POST /v1/pipe-io` returns,
 * interprets the caller's inputs top-down against it, uploads the file-bearing
 * values, and returns rewritten inputs (canonical content carrying
 * `pipelex-storage://` in `url`) plus one upload record per prepared asset.
 *
 * The method is named the same three ways every other method-taking operation
 * takes it — inline `files`, a `method_ref` address, or a stored `method_id` —
 * exactly one per call. All three are pass-throughs to `POST /v1/pipe-io`, which
 * resolves an address on the runner and an id on the platform, so nothing is
 * expanded client-side. The route also SELECTS the pipe: the caller's qualified
 * `pipe_ref`, else the method's own entry pipe, and the ref it answers with is
 * the one prepared. It runs no dry run, so preparing inputs costs one static load.
 *
 * Per input, the caller may submit EITHER the **compact** value (a bare source /
 * canonical `{url}` content) OR the explicit `{ concept, content }` envelope —
 * its `content` is interpreted exactly as the compact value would be, and the
 * envelope is preserved on output (the `concept` annotation rides through; the
 * runtime accepts it — see `pipelex`'s `input_shaper.py` `_is_explicit` /
 * `input_normalizer.py`).
 *
 * **The descriptor is the classifier, never the value's shape.** `input_form`
 * (the MTHDS standard's artifact) states the kind at every depth — `document` /
 * `image` mark a file position, `object` recurses through `fields`, `list`
 * through `item`, everything else passes through. That is what makes an
 * OPTIONAL nested file field prepare like a required one, and a `text` field
 * merely *named* `url` stay untouched: both were misread while the signature
 * came from the rendered inputs template, whose file signal was a `url`-bearing
 * dict. See `docs/input-preparation.md`, which `pipelex-sdk-python` mirrors case
 * for case.
 */

import type {
  FieldKind,
  InputFormItem,
  InputFormTopLevelField,
  PipeInputFormDescriptor,
} from "mthds/protocol";
import { isValidationItem } from "./error-models.js";
import { throwIfAborted } from "./runs.js";
import {
  ApiResponseError,
  InputPreparationError,
  InvalidInputValueError,
  MethodLoadError,
  UploadNotAllowedError,
} from "./errors.js";
import type { MthdsFileItem, PipeIORequest, PipeIOResponse, PipeIOValidReport } from "./models.js";
import type { UploadCapableClient, UploadRecord } from "./upload.js";
import { uploadFile } from "./upload.js";

const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Every `kind` the walk handles, in the standard's order, and the only kinds a descriptor may name:
 * any other is refused. It is the walk's own table rather than the `FIELD_KINDS` of whichever
 * `mthds` is installed beside the SDK, so a newer `mthds` defining a new kind, which may be a file
 * kind, cannot reach the walk at run time. Moving the pin onto such an `mthds` stops the build
 * here, where `satisfies` requires every `FieldKind`, and in `resolveNode`'s exhaustive switch.
 */
const WALKED_KINDS = {
  text: true,
  prose: true,
  date: true,
  number: true,
  boolean: true,
  enum: true,
  document: true,
  image: true,
  object: true,
  list: true,
  unknown: true,
} as const satisfies Record<FieldKind, true>;
const KNOWN_KINDS: ReadonlySet<string> = new Set(Object.keys(WALKED_KINDS));

/**
 * The `error_type`s of the route's pipe-selection refusals — the only `422`s
 * `prepareInputs` turns into an `InputPreparationError`. They are the runtime's
 * entry-lookup classes, the vocabulary the run routes speak too: a ref that names
 * no pipe, or no entry pipe at all, is `EntryPipeNotFoundError`; a code that
 * matches pipes in several domains, or several `main_pipe` declarations, is
 * `EntryPipeAmbiguousError`. Every other `422` (a malformed body, an over-limit
 * file, a fetched package with no `.mthds` file, a stored method with no source)
 * shares the generic `ValidationError` type and stays an `ApiResponseError`.
 */
const PIPE_SELECTION_ERROR_TYPES: ReadonlySet<string> = new Set([
  "EntryPipeNotFoundError",
  "EntryPipeAmbiguousError",
]);

/** The shared half of the request: the target pipe and the caller's inputs. */
export interface PrepareInputsBase {
  /**
   * The pipe to prepare inputs for, as a QUALIFIED `domain.pipe_code` ref. Omit
   * it and the server picks the method's own entry pipe — see "Pipe selection" in
   * `docs/input-preparation.md`. A bare `pipe_code` is refused before any request:
   * a request names a pipe by its qualified ref, and search is a run-route
   * affordance this helper deliberately does not grow. So is an
   * `alias->domain.pipe_code` ref: the alias names a dependency package's pipe,
   * and preparation covers the method's own pipes.
   */
  pipe_ref?: string;
  /** The caller's inputs (variable name → value), compact or explicit-envelope per input. */
  inputs: Record<string, unknown>;
  /**
   * Stops the preparation between its steps, a file's read and its upload included: once it has
   * aborted, neither the pipe I/O request nor any upload starts, and `prepareInputs` throws the
   * abort. A request already sent runs to its end. It is not sent to the server.
   */
  signal?: AbortSignal;
  /**
   * Whether preparation may upload, `true` when omitted. With `false`, a value at a file input
   * that would need an upload — a local path, a `data:` URL, bytes — is refused with an
   * {@link UploadNotAllowedError} naming the input, and nothing is read from disk, decoded or
   * sent to the upload route; `http(s)` URLs and `pipelex-storage://` references pass through as
   * always. It is for a server preparing inputs on a caller's behalf, which must never read a file
   * of its own because the caller named it. It is not sent to the server.
   */
  allowUploads?: boolean;
}

/**
 * How the method is named — exactly one of the three selectors, each pinning the
 * other two to `never` so a second one is a compile error (the same XOR
 * `ValidateMethodSelector` states for `validate`). All three reach the
 * server as-is: `files` inline, `method_ref` resolved by the runner, `method_id`
 * resolved by the platform.
 */
export type PrepareInputsClosure =
  | { files: MthdsFileItem[]; method_ref?: never; method_id?: never }
  | { method_ref: string; files?: never; method_id?: never }
  | { method_id: string; files?: never; method_ref?: never };

/** What `prepareInputs` takes: one method selector, the target pipe, the caller's inputs. */
export type PrepareInputsRequest = PrepareInputsBase & PrepareInputsClosure;

/** The result of `prepareInputs`: rewritten inputs (copy-on-write) plus upload records. */
export interface PreparedInputs {
  /** A copy of `inputs` with each file-bearing value rewritten to canonical content carrying `pipelex-storage://` in `url`. */
  inputs: Record<string, unknown>;
  /** One record per uploaded asset, exposing `uri`. Pass-through references (http(s), existing storage URIs) produce no record. */
  uploads: UploadRecord[];
}

/**
 * The client surface `prepareInputs` needs: raw `upload`, and `pipeIo` as the
 * signature source. Typed as the client's own `pipeIo` signature so
 * `PipelexApiClient` satisfies it structurally.
 */
export interface PrepareCapableClient extends UploadCapableClient {
  pipeIo(request: PipeIORequest): Promise<PipeIOResponse>;
}

/** Mutable state threaded through one preparation walk. */
interface PrepareContext {
  client: UploadCapableClient;
  signal: AbortSignal | undefined;
  /** False under `allowUploads: false`: every upload-needing value is refused before it is read. */
  allowUploads: boolean;
  uploads: UploadRecord[];
  /** Dedup by source identity: same source (string value / bytes reference) uploads once. */
  dedup: Map<unknown, Promise<string>>;
}

/** Strict plain-object test — excludes arrays, `Uint8Array`, `Blob`, and other exotics. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** A trimmed non-empty string, or `undefined` — the "empty is absent" rule. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A canonical Image/Document content is a plain object carrying a `url` key.
 * A VALUE-shape helper only: it is consulted at a position the descriptor has
 * already declared a file, never as the signal that one is there.
 */
function isFileContent(node: unknown): node is Record<string, unknown> {
  return isPlainObject(node) && "url" in node;
}

/**
 * The explicit envelope: a plain object whose keys are EXACTLY `concept` and
 * `content`. Matches the runtime's `_is_explicit` (`pipelex`'s
 * `input_shaper.py`): exact keys, not a superset, so a structured-content input
 * that merely happens to carry both fields is not misread as an envelope.
 */
function isExplicitEnvelope(value: unknown): value is { concept: unknown; content: unknown } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && "concept" in value && "content" in value;
}

/** Decode a `data:` URL into bytes plus its MIME type. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new InvalidInputValueError(
      `Malformed data URL (no comma separator): ${dataUrl.slice(0, 32)}…`,
    );
  }
  const header = dataUrl.slice(5, comma); // strip "data:"
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  const contentType = header.split(";")[0] || "application/octet-stream";
  // Decoding can throw on a malformed payload — a URIError from percent-decoding,
  // or an InvalidCharacterError from `atob` on bad base64. Surface those as a typed
  // InvalidInputValueError so a bad data URL stays within the preparation contract.
  try {
    if (isBase64) {
      // Decode via atob in every runtime. atob rejects malformed base64 with an
      // InvalidCharacterError — Buffer.from(payload, "base64") does NOT: in Node it
      // silently drops invalid characters and returns truncated/empty bytes, which would
      // upload corrupt content instead of failing the preparation contract. atob is a
      // global in every supported runtime (engines.node >= 22.12).
      return { bytes: base64ToBytes(payload), contentType };
    }
    const text = decodeURIComponent(payload);
    return { bytes: new TextEncoder().encode(text), contentType };
  } catch (cause) {
    throw new InvalidInputValueError(
      `Malformed data URL payload (${isBase64 ? "invalid base64" : "invalid percent-encoding"}): ${dataUrl.slice(0, 32)}…`,
      { cause },
    );
  }
}

/**
 * Strict cross-runtime base64 decode via `atob` — the single decoder for data-URL
 * payloads in every runtime. `atob` throws an `InvalidCharacterError` on malformed
 * base64, unlike the lenient `Buffer.from(payload, "base64")`, so a bad payload
 * fails the preparation contract instead of yielding truncated/empty bytes.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * A source at a file position, classified once from its type and prefix, never from the file a
 * path names. The guard under `allowUploads: false` and `doResolveSource` read this one answer, and
 * the guard refuses every kind but the two that need no upload, so a source the resolver would
 * upload is a source the guard refuses: a new kind of source is an `UploadNotAllowedKind` or the
 * guard does not compile.
 *
 * - `reference` — a `pipelex-storage://` reference or an http(s) URL, which passes through;
 * - `data_url`, `local_path`, `bytes` — what an upload is needed for;
 * - `unsupported` — a value no file input takes, refused as an `InvalidInputValueError` whether
 *   uploads are allowed or not.
 */
type FileSource =
  | { kind: "reference"; value: string }
  | { kind: "data_url"; value: string }
  | { kind: "local_path"; value: string }
  | { kind: "bytes"; value: Blob | ArrayBuffer | Uint8Array }
  | { kind: "unsupported"; value: unknown };

function classifySource(source: unknown): FileSource {
  if (typeof source === "string") {
    if (source.startsWith(PIPELEX_STORAGE_SCHEME) || HTTP_URL_RE.test(source)) {
      return { kind: "reference", value: source };
    }
    if (source.startsWith("data:")) return { kind: "data_url", value: source };
    // Anything else is a local filesystem path — Node only (uploadFile enforces it).
    return { kind: "local_path", value: source };
  }
  if (source instanceof Blob || source instanceof ArrayBuffer || source instanceof Uint8Array) {
    return { kind: "bytes", value: source };
  }
  return { kind: "unsupported", value: source };
}

/** Resolve one classified source to the URL/URI to write, deduped by the caller's value's identity. */
function resolveSource(ctx: PrepareContext, source: FileSource): Promise<string> {
  const cached = ctx.dedup.get(source.value);
  if (cached !== undefined) return cached;
  const pending = doResolveSource(ctx, source);
  ctx.dedup.set(source.value, pending);
  return pending;
}

async function doResolveSource(ctx: PrepareContext, source: FileSource): Promise<string> {
  switch (source.kind) {
    case "reference":
      return source.value; // already prepared, or a reachable URL — pass through
    case "data_url": {
      const { bytes, contentType } = decodeDataUrl(source.value);
      throwIfAborted(ctx.signal);
      const record = await uploadFile(ctx.client, bytes, { contentType, signal: ctx.signal });
      ctx.uploads.push(record);
      return record.uri;
    }
    case "local_path":
    case "bytes": {
      throwIfAborted(ctx.signal);
      const record = await uploadFile(ctx.client, source.value, { signal: ctx.signal });
      ctx.uploads.push(record);
      return record.uri;
    }
    case "unsupported":
      // An unrecognized value sits at a file-bearing position (neither a source string,
      // bytes, nor a canonical `{url}` content dict). Fail with a typed error rather than
      // letting a raw TypeError escape from the byte-extraction path.
      throw new InvalidInputValueError(
        `Unsupported value at a file input: expected a path string, bytes (Blob/File/ArrayBuffer/Uint8Array), ` +
          `a data URL, an http(s)/pipelex-storage:// URL, or canonical {url} content; got ${typeof source.value}.`,
      );
  }
}

/**
 * Where a value sits in the caller's inputs: the input it belongs to, and its path inside that
 * input, `.field` for an object's declared field and `[index]` for a list's element. An explicit
 * envelope adds nothing to the path, since its `content` is the input's value.
 */
interface InputPosition {
  name: string;
  path: string;
}

/**
 * Resolve a value known to sit at a file position into canonical content with a rewritten `url`.
 * Under `allowUploads: false`, a source that would need an upload is refused here, before
 * `resolveSource` could read, decode or upload it.
 */
async function resolveFilePosition(
  ctx: PrepareContext,
  callerValue: unknown,
  at: InputPosition,
): Promise<unknown> {
  const fileContent = isFileContent(callerValue);
  const source = classifySource(fileContent ? callerValue.url : callerValue);
  if (!ctx.allowUploads && source.kind !== "reference" && source.kind !== "unsupported") {
    throw new UploadNotAllowedError({
      inputName: at.name,
      inputPath: at.path,
      valueKind: source.kind,
    });
  }
  const resolved = await resolveSource(ctx, source);
  return fileContent ? { ...callerValue, url: resolved } : { url: resolved };
}

/**
 * Descriptor-guided walk, discriminated on the node's `kind`:
 *
 * - `document` / `image` — a file position, whatever the value's shape;
 * - `object` — walk the declared `fields` by name; keys the descriptor does not
 *   name are copied through untouched;
 * - `list` — walk `item` against each element;
 * - every other kind (`text`, `prose`, `date`, `number`, `boolean`, `enum`,
 *   `unknown`) — pass through at any depth. `unknown` is the standard's escape
 *   hatch for a `Dynamic` / `Composite` input, and it is NOT interpreted: the
 *   signature declares no file there, and uploading by value shape is the defect
 *   this walk removes. A caller with such an input uploads with `uploadFile`
 *   first and passes the storage URI.
 *
 * A caller value whose shape disagrees with the node (a scalar at an `object`, a
 * non-array at a `list`) passes through for the run to reject — preparation never
 * second-guesses the signature.
 *
 * Every node it receives was checked by {@link inputFormFault}: an `object`
 * carries a list of named fields, a `list` carries a node, and every `kind` is one
 * of {@link WALKED_KINDS}, so the walk trusts the descriptor's types without a
 * guard. The switch names every kind, so a kind the standard adds does not
 * compile until the walk decides what it is.
 */
async function resolveNode(
  ctx: PrepareContext,
  node: InputFormItem,
  callerValue: unknown,
  at: InputPosition,
): Promise<unknown> {
  switch (node.kind) {
    case "document":
    case "image":
      return resolveFilePosition(ctx, callerValue, at);
    case "object": {
      if (!isPlainObject(callerValue)) return callerValue;
      const result: Record<string, unknown> = { ...callerValue };
      for (const field of node.fields) {
        if (Object.hasOwn(callerValue, field.name)) {
          result[field.name] = await resolveNode(ctx, field, callerValue[field.name], {
            name: at.name,
            path: `${at.path}.${field.name}`,
          });
        }
      }
      return result;
    }
    case "list": {
      if (!Array.isArray(callerValue)) return callerValue;
      return Promise.all(
        callerValue.map((element, index) =>
          resolveNode(ctx, node.item, element, { name: at.name, path: `${at.path}[${index}]` }),
        ),
      );
    }
    case "text":
    case "prose":
    case "date":
    case "number":
    case "boolean":
    case "enum":
    case "unknown":
      return callerValue;
    default: {
      // Unreachable: the descriptor was checked against WALKED_KINDS before the walk began.
      const unwalked: never = node;
      throw new InputPreparationError(
        `Cannot prepare inputs: the walk has no arm for the kind ${described((unwalked as { kind: unknown }).kind)}.`,
        { verdict: { errorDomain: "runtime", retryable: false } },
      );
    }
  }
}

/** The method selector, normalized: empty is absent, and exactly one must remain. */
type ResolvedSelector = { files: MthdsFileItem[] } | { method_ref: string } | { method_id: string };

/**
 * Normalize and check the three selectors. Empty is absent (`files: []`,
 * `method_ref: ""`, `method_id: "  "`), mirroring the run options' rule and the
 * Python `CrateRequestBase` normalisers, and exactly one must remain — the check
 * lives here because this helper is the one that composes the `pipeIo` call.
 * The illegal shapes are compile errors for typed callers; this backs them up for
 * untyped (JS) ones with a typed `InputPreparationError`.
 */
function resolveSelector(request: PrepareInputsRequest): ResolvedSelector {
  const raw = request as unknown as Record<string, unknown>;
  const files =
    Array.isArray(raw["files"]) && raw["files"].length > 0
      ? (raw["files"] as MthdsFileItem[])
      : undefined;
  const methodRef = nonEmptyString(raw["method_ref"]);
  const methodId = nonEmptyString(raw["method_id"]);

  const given: string[] = [];
  if (files !== undefined) given.push("`files`");
  if (methodRef !== undefined) given.push("`method_ref`");
  if (methodId !== undefined) given.push("`method_id`");

  if (given.length === 0) {
    throw new InputPreparationError(
      "Cannot prepare inputs: no method selector. Supply exactly one of `files` (an inline MTHDS " +
        "closure), `method_ref` (a published method's address) or `method_id` (a stored method's " +
        "catalog id).",
    );
  }
  if (given.length > 1) {
    throw new InputPreparationError(
      `Cannot prepare inputs: ${given.join(" and ")} were ${given.length === 2 ? "both" : "all"} ` +
        "given. Supply exactly one method " +
        "selector — `files`, `method_ref` or `method_id`.",
    );
  }
  if (files !== undefined) return { files };
  if (methodRef !== undefined) return { method_ref: methodRef };
  return { method_id: methodId as string };
}

/**
 * Normalize the caller's `pipe_ref` and refuse, before any request, the two
 * spellings preparation cannot honour. Empty is absent, so the route's selection
 * chain decides.
 *
 * - A **bare** `pipe_code` is refused because a request names a pipe by its
 *   qualified ref. The route will refuse it too once the runner's shared
 *   selection enforces that rule; until then it would resolve a bare code across
 *   domains, and preparation does not lean on that fallback.
 * - An **`alias->domain.pipe_code`** ref is refused because the alias names a
 *   dependency package's pipe, and preparation covers the method's own pipes: the
 *   crate routes do not load an address-based dependency at all. The run route
 *   takes such a ref; preparation refuses it, and that asymmetry is deliberate.
 */
function normalizePipeRef(raw: unknown): string | undefined {
  const pipeRef = nonEmptyString(raw);
  if (pipeRef === undefined) return undefined;
  if (pipeRef.includes("->")) {
    throw new InputPreparationError(
      `Cannot prepare inputs: \`pipe_ref\` "${pipeRef}" names a dependency package's pipe. ` +
        "Preparation covers the method's own pipes: name one as `domain.pipe_code`.",
    );
  }
  if (!pipeRef.includes(".")) {
    throw new InputPreparationError(
      `Cannot prepare inputs: \`pipe_ref\` must be qualified (\`domain.pipe_code\`), got the bare ` +
        `"${pipeRef}".`,
    );
  }
  return pipeRef;
}

/**
 * Read the caller's `allowUploads`: `true` when omitted, the boolean when given, and refused
 * before any request otherwise. A value of the wrong type is not read as either answer, since
 * reading a stray `"false"` as permission would upload exactly what the caller meant to refuse.
 */
function resolveAllowUploads(raw: unknown): boolean {
  if (raw === undefined) return true;
  if (typeof raw === "boolean") return raw;
  throw new InputPreparationError(
    `Cannot prepare inputs: \`allowUploads\` must be a boolean, got ${raw === null ? "null" : typeof raw}.`,
  );
}

/**
 * Ask `POST /v1/pipe-io` for the pipe and its signature, whatever the selector,
 * and hand back the valid report.
 *
 * The route runs no dry run and does not refuse a method with pending
 * signatures elsewhere: preparation needs a pipe's DECLARED inputs, and whether
 * the method runs is the run's verdict, not preparation's. The `is_valid: false`
 * arm means the closure does not load, which is a preparation failure. So is a
 * selection the route refuses — an unknown `pipe_ref`, no entry pipe, several —
 * which it answers with a `422` typed by one of {@link PIPE_SELECTION_ERROR_TYPES};
 * every other failure is re-thrown unchanged. An answer with no boolean `is_valid`
 * is neither arm, so it fails the preparation with a `runtime` verdict, as an
 * `input_form` that does not describe the selected pipe does, and one whose
 * descriptor is malformed where the walk reads it.
 */
async function fetchSignature(
  client: PrepareCapableClient,
  selector: ResolvedSelector,
  pipeRef: string | undefined,
): Promise<PipeIOValidReport> {
  const request: PipeIORequest =
    pipeRef === undefined ? { ...selector } : { ...selector, pipe_ref: pipeRef };
  let result: PipeIOResponse;
  try {
    result = await client.pipeIo(request);
  } catch (error) {
    if (
      error instanceof ApiResponseError &&
      error.status === 422 &&
      error.errorType !== undefined &&
      PIPE_SELECTION_ERROR_TYPES.has(error.errorType)
    ) {
      const detail = error.serverMessage ?? error.message;
      throw new InputPreparationError(`Cannot prepare inputs: ${detail}`, { cause: error });
    }
    throw error;
  }

  const answer: unknown = result;
  if (!isPlainObject(answer) || typeof answer.is_valid !== "boolean") {
    // An answer with no boolean discriminant is neither arm: the route broke its own contract,
    // which no change to the request fixes.
    throw new InputPreparationError(
      "Cannot prepare inputs: the pipe I/O answer carries no boolean `is_valid`, so it says " +
        "neither that the method loaded nor why it did not.",
      { verdict: { errorDomain: "runtime", retryable: false } },
    );
  }
  if (!answer.is_valid) {
    const items = answer.validation_errors;
    throw new MethodLoadError(
      `Cannot prepare inputs: the method signature did not resolve — ${invalidReason(answer)}`,
      {
        validationErrors: Array.isArray(items) ? items.filter(isValidationItem) : [],
        serverMessage: typeof answer.message === "string" ? answer.message : undefined,
      },
    );
  }
  return result as PipeIOValidReport;
}

/**
 * Why an invalid pipe I/O answer says the closure did not load: its first validation item's
 * message, else its own `message`. Each is read only when it has its declared type, since the
 * answer is the server's, and an answer carrying neither still fails the preparation.
 */
function invalidReason(answer: Record<string, unknown>): string {
  const items = answer.validation_errors;
  const first: unknown = Array.isArray(items) ? items[0] : undefined;
  if (isPlainObject(first) && typeof first.message === "string") return first.message;
  return typeof answer.message === "string" ? answer.message : "the answer gives no reason";
}

/**
 * The descriptor of the pipe the route selected. The route answers a
 * single-pipe request with `input_form` keyed by exactly the `pipe_ref` it
 * resolved, so a missing ref or a missing key is the answer contradicting itself
 * — preparing any other pipe would silently walk the wrong signature. The entry
 * found is then checked whole, by {@link checkedDescriptor}, before it is trusted.
 */
function selectedDescriptor(report: PipeIOValidReport): PipeInputFormDescriptor {
  const pipeRef = nonEmptyString(report.pipe_ref);
  const inputForm: unknown = report.input_form;
  if (pipeRef === undefined || !isPlainObject(inputForm) || !Object.hasOwn(inputForm, pipeRef)) {
    const describedPipes = isPlainObject(inputForm)
      ? Object.keys(inputForm).join(", ") || "none"
      : "none";
    // The route broke its own contract, which no change to the request fixes.
    throw new InputPreparationError(
      `Cannot prepare inputs: the pipe I/O answer selected ${pipeRef === undefined ? "no pipe" : `"${pipeRef}"`}, ` +
        `but its \`input_form\` does not describe it (it describes: ${describedPipes}).`,
      { verdict: { errorDomain: "runtime", retryable: false } },
    );
  }
  return checkedDescriptor(pipeRef, inputForm[pipeRef]);
}

/**
 * The selected entry of `input_form`, checked whole by {@link inputFormFault}
 * before any caller value is read and before anything is uploaded, and refused at
 * its first fault.
 *
 * A malformation is the route breaking its contract, at whatever depth and under
 * whichever input, so it is refused with a `runtime` verdict, not retryable. It is
 * never passed through: a node the SDK cannot read may be a file position, and
 * under the default mode passing it through would send the caller's local path to
 * the runner verbatim. A `kind` outside {@link WALKED_KINDS} is refused for the
 * same reason, since it may be a file kind a newer standard defines.
 */
function checkedDescriptor(pipeRef: string, entry: unknown): PipeInputFormDescriptor {
  const found = inputFormFault(entry);
  if (found !== undefined) {
    throw new InputPreparationError(
      `Cannot prepare inputs: the pipe I/O answer's \`input_form\` for "${pipeRef}" ` +
        `is ${found.message}.`,
      { verdict: { errorDomain: "runtime", retryable: false } },
    );
  }
  return entry as PipeInputFormDescriptor;
}

/**
 * Where an input-form entry breaks the shape `prepareInputs` reads, and what was
 * found there.
 */
export interface InputFormFault {
  /** Where, in the entry's own terms (`fields[3].item`, `fields[2].fields[0].kind`); empty for the entry itself. */
  path: string;
  /** What was expected there and what was found. */
  problem: string;
  /** The two in one phrase: `malformed at fields[3].item: expected a node with a string kind, got null`. */
  message: string;
}

/**
 * The first fault of one pipe's input-form entry (`input_form[pipe_ref]`) in
 * document order, or `undefined` when `prepareInputs` can walk it. It checks what
 * the walk reads and only that: the entry is an object whose `fields` is a list;
 * every field, at the top level or in an `object` node, is an object with a string
 * `name`; every node, a field or a `list` node's `item`, has a string `kind` this
 * SDK walks, the standard's vocabulary at the `mthds` it pins; an `object` node's
 * `fields` is a list and a `list` node's `item` is a node. Members the walk does
 * not read (`concept_ref`, `presence`, `hints`, …) are not checked. `prepareInputs`
 * refuses an entry with a fault before it uploads anything; a caller that reads an
 * entry itself, to render a form or a template, checks it here first.
 */
export function inputFormFault(entry: unknown): InputFormFault | undefined {
  if (!isPlainObject(entry)) {
    return fault("", `expected an object with a list of fields, got ${described(entry)}`);
  }
  return fieldsFault(entry.fields, "fields");
}

function fault(path: string, problem: string): InputFormFault {
  return {
    path,
    problem,
    message: `malformed${path === "" ? "" : ` at ${path}`}: ${problem}`,
  };
}

function fieldsFault(fields: unknown, path: string): InputFormFault | undefined {
  if (!Array.isArray(fields)) {
    return fault(path, `expected a list of fields, got ${described(fields)}`);
  }
  for (const [index, field] of (fields as unknown[]).entries()) {
    const at = `${path}[${index}]`;
    if (!isPlainObject(field)) {
      return fault(at, `expected a field with a string name and kind, got ${described(field)}`);
    }
    if (typeof field.name !== "string") {
      return fault(`${at}.name`, `expected a string, got ${described(field.name)}`);
    }
    const found = nodeFault(field, at);
    if (found !== undefined) return found;
  }
  return undefined;
}

function nodeFault(node: unknown, path: string): InputFormFault | undefined {
  if (!isPlainObject(node)) {
    return fault(path, `expected a node with a string kind, got ${described(node)}`);
  }
  const kind = node.kind;
  if (typeof kind !== "string") {
    return fault(`${path}.kind`, `expected a string, got ${described(kind)}`);
  }
  if (!KNOWN_KINDS.has(kind)) {
    return fault(
      `${path}.kind`,
      `${described(kind)} is not a kind this version of @pipelex/sdk knows ` +
        `(${[...KNOWN_KINDS].join(", ")}); a newer API may need a newer SDK`,
    );
  }
  if (kind === "object") return fieldsFault(node.fields, `${path}.fields`);
  if (kind === "list") return nodeFault(node.item, `${path}.item`);
  return undefined;
}

/**
 * A value of the server's answer, described for a message: `null`, `nothing` for
 * an absent member, a string quoted and cut at 40 characters, a number or a
 * boolean as written, else what it is.
 */
function described(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "a list";
  if (isPlainObject(value)) return "an object";
  return typeof value;
}

/**
 * Prepare a pipe's inputs: upload local/byte/data-URL assets at the signature's
 * file-bearing positions and return copy-on-write rewritten inputs plus upload
 * records. HTTP(S) URLs and existing `pipelex-storage://` URIs pass through
 * unchanged. All failures are raised before any run is created.
 *
 * With `allowUploads: false`, nothing is read from disk or uploaded: a value that
 * would need either throws {@link UploadNotAllowedError}, naming the input and
 * where inside it the value sits.
 *
 * The pipe and its signature come from one `POST /v1/pipe-io`, whatever the
 * selector — inline `files`, a `method_ref` the runner resolves, or a
 * `method_id` the platform resolves. A bare or alias-qualified `pipe_ref`, a
 * closure that does not load, and a selection the route refuses (an unknown
 * `pipe_ref`, no entry pipe, several) throw {@link InputPreparationError}. So
 * does an answer that breaks the route's contract, with a `runtime` verdict that
 * is not retryable: no boolean `is_valid`, an `input_form` that does not describe
 * the selected pipe, or a descriptor that is malformed or names a kind this SDK
 * does not know, which is checked whole before anything is uploaded. Any other
 * failure from the route (a malformed selector, an unknown or foreign-org id, no
 * package at the address, auth, a server fault, a deployment that does not serve
 * the route) surfaces as `ApiResponseError`, unchanged.
 */
export async function prepareInputs(
  client: PrepareCapableClient,
  request: PrepareInputsRequest,
): Promise<PreparedInputs> {
  const selector = resolveSelector(request);
  const pipeRef = normalizePipeRef(request.pipe_ref);
  const allowUploads = resolveAllowUploads((request as { allowUploads?: unknown }).allowUploads);
  throwIfAborted(request.signal);
  const report = await fetchSignature(client, selector, pipeRef);
  throwIfAborted(request.signal);
  const descriptor = selectedDescriptor(report);

  const declared = new Map<string, InputFormTopLevelField>(
    descriptor.fields.map((field) => [field.name, field]),
  );

  const ctx: PrepareContext = {
    client,
    signal: request.signal,
    allowUploads,
    uploads: [],
    dedup: new Map(),
  };
  const rewritten: Record<string, unknown> = { ...request.inputs };
  for (const [name, callerValue] of Object.entries(request.inputs)) {
    const field = declared.get(name);
    if (field === undefined) {
      continue; // Not a declared input — pass through untouched, as today.
    }
    if (isExplicitEnvelope(callerValue)) {
      // The caller filled the explicit `{ concept, content }` envelope: walk the
      // inner content against the same node, then re-wrap so the concept
      // annotation rides through to the run (the runtime accepts the envelope).
      const walked = await resolveNode(ctx, field, callerValue.content, { name, path: name });
      rewritten[name] = { ...callerValue, content: walked };
    } else {
      rewritten[name] = await resolveNode(ctx, field, callerValue, { name, path: name });
    }
  }

  return { inputs: rewritten, uploads: ctx.uploads };
}
