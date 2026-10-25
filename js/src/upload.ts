/**
 * `uploadFile` — the single-asset upload convenience over the raw `upload()` wire
 * call. Accepts web byte types in every runtime (`Blob`/`File`/`ArrayBuffer`/
 * `Uint8Array`) and, in Node only, a filesystem path string; returns an
 * {@link UploadRecord} assembled client-side. See `docs/input-preparation.md`.
 *
 * The MIME type and size are known client-side at upload time, so the record is
 * built without extending the `/v1/upload` response.
 */

import {
  InputPreparationError,
  InvalidLocalSourceError,
  RejectedAssetError,
  TestFileRefusedError,
  UploadAuthenticationError,
  UploadTransportError,
  UnsupportedUploadCapabilityError,
  argumentInvalidProblem,
} from "./errors.js";
import type { TestFileRefusalReason } from "./errors.js";
import { ABORT_TIMEOUT, ApiResponseError, ApiUnreachableError } from "./errors.js";
import { readProblemBody } from "mthds/protocol";
import { parseMethodSelector } from "./method-selector.js";
import { absenceCause, loadNodeHost } from "./node-host.js";
import type { UploadInput, UploadKind } from "./product-models.js";
import { throwIfAborted } from "./runs.js";

/** A local asset `uploadFile` accepts. A path string is Node-only (see {@link readLocalPath}). */
export type UploadableAsset = Blob | ArrayBuffer | Uint8Array | string;

/**
 * The record `uploadFile` returns for a prepared asset. Beyond the source identity
 * it guarantees the resulting `uri`, the MIME `contentType`, the `size` in bytes,
 * and the `filename`. A content checksum is deliberately not included — it is
 * best-effort at most, and within-preparation dedup keys on source identity.
 */
export interface UploadRecord {
  /** The `pipelex-storage://` reference for the uploaded asset. */
  uri: string;
  filename: string;
  /** MIME type, known client-side. Best-effort for raw bytes (falls back to `application/octet-stream`). */
  contentType: string;
  /** Size of the uploaded bytes. */
  size: number;
}

/**
 * What an upload is recorded as, sent with it to `POST /v1/upload`: its `kind` and, for a test
 * file, the method it is for. `uploadFile` takes these among its options and `prepareInputs` as
 * its `upload` member, for every file it uploads. Both are checked as the upload route checks
 * them, before any file is read: `kind: "test"` needs `method_id`, a bare catalog id, and only a
 * test file names a method.
 */
export interface UploadKindOptions {
  /** What the upload is recorded as; `uploaded` when omitted. */
  kind?: UploadKind;
  /**
   * The bare catalog id of the method a `test` file is for, required with `kind: "test"`
   * and refused without it.
   */
  method_id?: string;
}

/**
 * Per-call options for {@link uploadFile}. Fill in a filename/MIME for nameless byte sources, and
 * a `kind` with its `method_id` for a test file.
 */
export interface UploadFileOptions extends UploadKindOptions {
  filename?: string;
  contentType?: string;
  /**
   * Read once the asset's bytes are in hand, right before the upload request: once it has
   * aborted, nothing is uploaded and `uploadFile` throws the abort, however long the read took.
   * A request already sent runs to its end. It is not sent to the server.
   */
  signal?: AbortSignal;
}

/** The subset of the client `uploadFile` needs — the raw base64 `upload` wire call. */
export interface UploadCapableClient {
  upload(input: UploadInput): Promise<{
    uri: string;
    filename: string;
  }>;
}

/** The kinds an upload is recorded as, in the order the refusal of another one lists them. */
const UPLOAD_KINDS: readonly UploadKind[] = ["uploaded", "test"];

/** A value an upload's kind or method was given as, described for a refusal without quoting more than an id. */
function describedArgument(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}

/**
 * The `kind` and `method_id` an upload is sent with, checked as the upload route checks them, so
 * a request the route would refuse with a `422` is refused before any file is read: a `kind` is
 * `uploaded` or `test`, a `method_id` is a bare catalog id, `kind: "test"` needs one and only a
 * test file names one. Returns the members to send, each only when given; `null` reads as
 * absent, as it does on the route. A refusal is an `InputPreparationError` whose message opens
 * with `refusal` and names each member as `field` prefixes it, so `prepareInputs` names its
 * `upload.kind`.
 */
export function uploadKindFields(
  given: UploadKindOptions,
  refusal: string,
  field = "",
): UploadKindOptions {
  const raw = given as { kind?: unknown; method_id?: unknown };
  const kind = raw.kind ?? undefined;
  const methodId = raw.method_id ?? undefined;
  if (kind !== undefined && !(UPLOAD_KINDS as readonly unknown[]).includes(kind)) {
    throw new InputPreparationError(
      `${refusal}: \`${field}kind\` is "uploaded" or "test", got ${describedArgument(kind)}.`,
      { problem: argumentInvalidProblem(`${field}kind`, "unknown_value") },
    );
  }
  if (methodId !== undefined) {
    if (typeof methodId !== "string") {
      throw new InputPreparationError(
        `${refusal}: \`${field}method_id\` names a method by its bare catalog id, got ` +
          `${describedArgument(methodId)}.`,
        { problem: argumentInvalidProblem(`${field}method_id`, "not_a_string") },
      );
    }
    let bare: boolean;
    try {
      bare = parseMethodSelector(methodId).version === null;
    } catch (cause) {
      throw new InputPreparationError(
        `${refusal}: \`${field}method_id\` ${JSON.stringify(methodId)} is not a catalog id, ` +
          "which is mt_ followed by letters, digits, _ or -.",
        { problem: argumentInvalidProblem(`${field}method_id`, "not_a_catalog_id"), cause },
      );
    }
    if (!bare) {
      throw new InputPreparationError(
        `${refusal}: \`${field}method_id\` names the method a test file is for by its bare ` +
          `catalog id, with no version suffix, got ${JSON.stringify(methodId)}.`,
        { problem: argumentInvalidProblem(`${field}method_id`, "version_suffix") },
      );
    }
  }
  if (kind === "test" && methodId === undefined) {
    throw new InputPreparationError(
      `${refusal}: a test file names the method it is for; give \`${field}method_id\` with ` +
        `\`${field}kind: "test"\`.`,
      { problem: argumentInvalidProblem(`${field}method_id`, "missing") },
    );
  }
  if (kind !== "test" && methodId !== undefined) {
    throw new InputPreparationError(
      `${refusal}: only a test file names a method; give \`${field}method_id\` with ` +
        `\`${field}kind: "test"\` alone.`,
      { problem: argumentInvalidProblem(`${field}method_id`, "without_test_kind") },
    );
  }
  return {
    ...(kind === undefined ? {} : { kind: kind as UploadKind }),
    ...(methodId === undefined ? {} : { method_id: methodId }),
  };
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const DEFAULT_FILENAME = "upload.bin";

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
};

/** Filename tail of a path, splitting on both separators (no `node:path` import needed). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** MIME guess from a filename extension; `application/octet-stream` when unknown. */
export function guessContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return DEFAULT_CONTENT_TYPE;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME[ext] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Read a filesystem path into bytes — Node only. A path string in a non-Node
 * runtime cannot be read, so it fails as an invalid local source rather than
 * being silently misread as text or a URL. The file system comes from the Node
 * host (`node-host.ts`), which a bundler building for the browser resolves to a
 * module holding no Node built-in, so this module keeps the main entry
 * bundleable for the browser.
 */
export async function readLocalPath(path: string): Promise<Uint8Array> {
  const loaded = await loadNodeHost();
  if (loaded.host === null) {
    throw new InvalidLocalSourceError(
      loaded.reason === null
        ? `Cannot read the local path "${path}" outside Node — path strings are Node-only. ` +
            "In the browser or an edge runtime, pass the file as bytes (Blob/File/ArrayBuffer/Uint8Array)."
        : `Cannot read the local path "${path}": ${loaded.reason}`,
      path,
      absenceCause(loaded),
    );
  }
  const host = loaded.host;
  try {
    return await host.fs.readFile(path);
  } catch (cause) {
    throw new InvalidLocalSourceError(
      `Local file cannot be read: "${path}" (${(cause as { code?: string }).code ?? "read error"}).`,
      path,
      { cause },
    );
  }
}

/** Base64-encode bytes, cross-runtime (Buffer when present, else chunked btoa). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000; // stay under the String.fromCharCode argument cap
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Bytes + a filename/MIME derived from whatever asset form was supplied. */
interface AssetBytes {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

/** Normalize any accepted asset form into bytes plus a filename and MIME. */
async function toAssetBytes(
  asset: UploadableAsset,
  options: UploadFileOptions,
): Promise<AssetBytes> {
  if (typeof asset === "string") {
    const bytes = await readLocalPath(asset);
    const filename = options.filename ?? basename(asset);
    return { bytes, filename, contentType: options.contentType ?? guessContentType(filename) };
  }
  if (asset instanceof Uint8Array) {
    return assetBytesFromBuffer(asset, options);
  }
  if (asset instanceof ArrayBuffer) {
    return assetBytesFromBuffer(new Uint8Array(asset), options);
  }
  // Blob / File — File carries `.name`; both carry `.type`.
  const bytes = new Uint8Array(await asset.arrayBuffer());
  const name = options.filename ?? (asset as File).name;
  const filename = name && name.length > 0 ? name : DEFAULT_FILENAME;
  const contentType = options.contentType ?? (asset.type || guessContentType(filename));
  return { bytes, filename, contentType };
}

function assetBytesFromBuffer(bytes: Uint8Array, options: UploadFileOptions): AssetBytes {
  const filename = options.filename ?? DEFAULT_FILENAME;
  return { bytes, filename, contentType: options.contentType ?? guessContentType(filename) };
}

/**
 * Upload one local asset and return its {@link UploadRecord}. A `kind` and its `method_id` in
 * the options are checked before the asset is read and sent with it (see
 * {@link UploadKindOptions}). Maps the raw `upload()` transport errors onto the semantic
 * input-preparation errors: a `413` is a rejected asset, a test file refused for its role or its
 * method a {@link TestFileRefusedError}, any other `401`/`403` an auth failure, any other `404`
 * an unsupported upload capability, an unreachable host a transport failure.
 */
export async function uploadFile(
  client: UploadCapableClient,
  asset: UploadableAsset,
  options: UploadFileOptions = {},
): Promise<UploadRecord> {
  const claimed = uploadKindFields(options, "Cannot upload");
  const { bytes, filename, contentType } = await toAssetBytes(asset, options);
  // A slow read, or a Blob's `arrayBuffer()`, may outlast the caller's patience.
  throwIfAborted(options.signal);
  const data = bytesToBase64(bytes);
  let uploaded: { uri: string; filename: string };
  try {
    uploaded = await client.upload({ filename, data, content_type: contentType, ...claimed });
  } catch (error) {
    throw mapUploadError(error, filename, claimed.method_id);
  }
  // The record guarantees a filename: an answer that names none keeps the one sent.
  const stored: unknown = uploaded.filename;
  return {
    uri: uploaded.uri,
    filename: typeof stored === "string" ? stored : filename,
    contentType,
    size: bytes.length,
  };
}

/**
 * Which refusal of a test file an upload's error is, or `undefined` for any other. Each is read
 * off the problem's code, never the status alone, and only for an upload that named a method, as
 * a test file does: `auth.forbidden` is a role that may not change methods (any other `403` is a
 * refused credential), `pipelex.catalog.being_deleted` a method being erased, and
 * `pipelex.catalog.not_found` an unknown method, never the `404` of a deployment without the
 * route, whose body is no problem document of that code.
 */
function testFileRefusalOf(
  error: ApiResponseError,
  methodId: string | undefined,
): TestFileRefusalReason | undefined {
  if (methodId === undefined) return undefined;
  switch (error.code) {
    case "auth.forbidden":
      return "role_not_permitted";
    case "pipelex.catalog.being_deleted":
      return "method_being_deleted";
    case "pipelex.catalog.not_found":
      return "method_not_found";
    default:
      return undefined;
  }
}

/** The message of a test file's refusal, naming the file, the method and what to do. */
function testFileRefusalMessage(
  reason: TestFileRefusalReason,
  error: ApiResponseError,
  filename: string,
  methodId: string | undefined,
): string {
  const refused = `Upload of "${filename}" as a test file was refused (${error.status})`;
  const method = methodId === undefined ? "the method it names" : `the method "${methodId}"`;
  switch (reason) {
    case "role_not_permitted":
      return (
        `${refused}: ${withoutFinalPeriod(error.problem.detail)}. ` +
        'Upload it as "uploaded", or with the credential of a member who may change methods.'
      );
    case "method_not_found":
      return `${refused}: ${method} is not one of the organization's methods.`;
    case "method_being_deleted":
      return `${refused}: ${method} is being deleted.`;
  }
}

/** Translate a raw `upload()` transport error into the matching preparation error. */
function mapUploadError(error: unknown, filename: string, methodId?: string): Error {
  if (error instanceof ApiResponseError) {
    // A 2xx the client could not read: storage may hold the file, but under no reference the SDK
    // can return.
    if (error.status >= 200 && error.status < 300) {
      return new UploadTransportError(
        `Upload of "${filename}" was answered (${error.status}) with a body the SDK could not ` +
          "read, so whether and where the file was stored is unknown.",
        { cause: error, status: error.status, reason: "unexpected", filename },
      );
    }
    // A test file refused for what it claims, its role or its method, before the status alone is
    // read as a refused credential or a deployment without upload.
    const refusal = testFileRefusalOf(error, methodId);
    if (refusal !== undefined) {
      return new TestFileRefusedError(testFileRefusalMessage(refusal, error, filename, methodId), {
        cause: error,
        status: error.status,
        reason: refusal,
        filename,
        ...(methodId === undefined ? {} : { methodId }),
      });
    }
    switch (error.status) {
      case 413:
        return new RejectedAssetError(
          `The server rejected "${filename}": ${answeredDetail(error) ?? "asset exceeds the service size limit"}.`,
          filename,
          error.status,
          { cause: error, reason: "too_large", problem: error.problem },
        );
      case 401:
      case 403:
        return new UploadAuthenticationError(
          `Upload of "${filename}" was not authorized (${error.status}). Check the configured Pipelex API key.`,
          error.status,
          { cause: error, filename },
        );
      case 404:
        return new UnsupportedUploadCapabilityError(
          "The configured Pipelex deployment does not support file upload (no /v1/upload route). " +
            "Upload is a hosted Pipelex capability.",
          { cause: error, filename },
        );
      default:
        return new UploadTransportError(
          `Upload of "${filename}" failed (${error.status}): ${answeredDetail(error) ?? error.statusText}.`,
          {
            cause: error,
            status: error.status,
            reason: error.status >= 500 ? "server_error" : "unexpected",
            filename,
          },
        );
    }
  }
  if (error instanceof ApiUnreachableError) {
    return new UploadTransportError(
      `Upload of "${filename}" could not reach the Pipelex API (${error.networkCode ?? "unreachable"}).`,
      // The client's own request timeout surfaces as an unreachable host with this code.
      {
        cause: error,
        reason: error.networkCode === ABORT_TIMEOUT ? "timeout" : "unreachable",
        filename,
      },
    );
  }
  // Only errors thrown by the `client.upload()` call reach here — the local-source
  // and asset-type failures are raised in `toAssetBytes`, before this try block. Any
  // error that is neither of the two mapped types (a custom client throwing a plain
  // Error or a SyntaxError of its own) is wrapped so every upload failure stays
  // catchable as an InputPreparationError, never a raw escape.
  const detail = error instanceof Error ? error.message : String(error);
  return new UploadTransportError(`Upload of "${filename}" failed unexpectedly: ${detail}.`, {
    cause: error,
    reason: "unexpected",
    filename,
  });
}

/**
 * The `detail` of the problem document a refusal answered with, or `undefined` when its body was
 * none, so a message never quotes the sentence the SDK built for a bare answer as the server's.
 */
function answeredDetail(error: ApiResponseError): string | undefined {
  return error.problem.detail !== "" && readProblemBody(error.responseBody) !== undefined
    ? withoutFinalPeriod(error.problem.detail)
    : undefined;
}

/** `text` without the period that ends it, for a sentence quoted inside another. */
function withoutFinalPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}
