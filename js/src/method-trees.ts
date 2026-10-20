/**
 * A saved method's tree on the client side (see `docs/method-trees.md`): the source a save reads a
 * tree from, how that tree becomes the `files` map a save sends, inline or by hash, the blob routes
 * that let a large tree travel by hash (mthds/docs/spec/protocol.md, "Sending files by hash"), the
 * upload of a blob the platform lacks, and the writing of a saved tree to disk.
 *
 * The tree-sending part mirrors the `mthds` npm package's own helpers, which its published
 * `mthds/protocol` subpath does not export yet. This SDK imports `mthds` through that subpath alone,
 * so it carries this copy, held to the same rule: the same inline threshold, the same text-or-Base64
 * choice per file, and each file added as an own property. It needs no Node built-in: SHA-256 is Web
 * Crypto's, and Base64 is written here. Only `writeMethodTreeTo` needs Node, which it loads when
 * called.
 */

import type { FileEntry, MethodFiles } from "mthds/protocol";

import { fallbackVerdict } from "./error-verdicts.js";
import {
  MethodFileTransferError,
  RequestArgumentError,
  type MethodFileTransferCode,
} from "./errors.js";
import type { SavedMethodFile } from "./product-models.js";
import { throwIfAborted } from "./runs.js";

// ── The source of a tree ─────────────────────────────────────────────

/** A file of a {@link MethodTreeSource}. */
export interface MethodTreeSourceFile {
  /** Its tree path. */
  readonly path: string;
  /** Its length in bytes. */
  readonly size: number;
  /** The SHA-256 of its bytes, in lowercase hexadecimal. */
  readonly sha256: string;
}

/**
 * A method tree a save reads from: its files, its digest, and a way to read each file's bytes. The
 * `MethodTree` the `mthds` package's `listMethodTree` returns is one, so a tree listed from a
 * directory, under the limits `methodTreeLimits` reports, is passed as it is.
 */
export interface MethodTreeSource {
  /** Every file of the tree, each tree path once. */
  readonly files: readonly MethodTreeSourceFile[];
  /** The tree digest, `sha256:` and 64 lowercase hexadecimal digits. */
  readonly digest: string;
  /** The bytes of the file at `treePath`, which must hash to the SHA-256 the listing gives it. */
  readFile(treePath: string): Promise<Uint8Array>;
}

/**
 * The limits a deployment holds a tree to, in the shape the `mthds` package's `listMethodTree`
 * takes as its `limits` option, so a lister stops at the first breach before hashing anything. A
 * limit the deployment does not announce is absent.
 */
export interface MethodTreeLimits {
  /** The most files a tree may hold. */
  readonly maxFileCount?: number;
  /** The largest one file may be, in bytes. */
  readonly maxFileSize?: number;
  /** The largest all the files together may be, in bytes. */
  readonly maxTotalSize?: number;
}

// ── The blob routes (`POST /v1/blobs/missing`) ───────────────────────

/** A blob a sender is about to send by hash, named by its SHA-256 and its size. */
export interface BlobRef {
  sha256: string;
  size: number;
}

/**
 * Body of `POST /v1/blobs/missing`: the blobs a sender is about to send by hash, each hash listed
 * once, and the digest of the tree they make up, which lets a platform that holds that tree whole
 * answer at once.
 */
export interface MissingBlobsRequest {
  blobs: BlobRef[];
  digest?: string;
}

/**
 * Where to upload one blob: its bytes as the whole body of a request with this method to this URL,
 * carrying exactly these headers. The URL is signed by storage and is a bearer credential.
 */
export interface UploadTarget {
  method: string;
  url: string;
  headers: Record<string, string>;
  [extension: string]: unknown;
}

/** A blob the platform lacks, with where to upload it. */
export interface MissingBlob {
  sha256: string;
  size: number;
  upload: UploadTarget;
  [extension: string]: unknown;
}

/** The `200` answer of `POST /v1/blobs/missing`; an empty `missing` means nothing to upload. */
export interface MissingBlobsResult {
  missing: MissingBlob[];
  [extension: string]: unknown;
}

// ── Choosing how a tree travels ──────────────────────────────────────

/**
 * The heaviest inline map, in bytes of its JSON serialization in UTF-8, that a save sends inline
 * to a deployment keeping a blob store. Below it a tree is cheaper to send whole than to check and
 * upload; above it every file travels by hash. `mthds`'s clients use the same threshold.
 */
export const INLINE_TREE_MAX_BYTES = 256 * 1024;

/** How many blobs a save uploads at once, and how many files `writeMethodTree` downloads at once. */
export const MAX_CONCURRENT_TRANSFERS = 8;

/**
 * What a tree is prepared for, as its refusals and its failed uploads say it: a save of a method, or
 * a request that reads one (`resolve`, `codegen`, `pipeIo`).
 */
export interface TreeSending {
  /** What did not happen because an upload failed, ending its message. */
  readonly unsent: string;
  /** What to give instead of a tree holding no file, when there is something. */
  readonly emptyRemedy?: string;
}

/** A save's: a tree holding no file is given as `files: null`, which empties a draft. */
export const SAVE_SENDING: TreeSending = {
  unsent: "the method was not saved",
  emptyRemedy: "give files: null for an empty draft",
};

/** A crate request's: a method has at least one file, so there is nothing to give instead. */
export const REQUEST_SENDING: TreeSending = { unsent: "the request was not sent" };

/** How a crate request prepares its tree, beyond what a save needs. */
export interface TreeSendOptions {
  /**
   * Read before each step the tree costs: each file read, the version handshake's use, the blob
   * route and each upload. Once it has aborted, none of them starts and the abort is thrown; a
   * request already sent runs to its end.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * The request's `read_scope`, under which the blob route is asked which blobs are missing, so
   * the blobs are uploaded into the store the request's hash entries are read from. The upload
   * targets the route names are signed for that scope already.
   */
  readonly readScope?: string | undefined;
}

/**
 * A map a crate request was given, or `undefined` when it selects or sends nothing: absent, `null`,
 * or a plain object holding no key, the empty-as-absent rule of the run options and of the Python
 * SDK. Any other value is kept as given, so the server refuses a `files` that is not a map as the
 * shape it is rather than reading it as absent.
 */
export function presentMap<T>(value: T | null | undefined): T | undefined {
  if (value === undefined || value === null) return undefined;
  const isEmptyObject =
    Object.prototype.toString.call(value) === "[object Object]" &&
    Object.keys(value as object).length === 0;
  return isEmptyObject ? undefined : value;
}

/** The refusal of a tree holding no file, `call` naming the caller's method. */
export function emptyTreeRefusal(
  call: string,
  what: string,
  sending: TreeSending,
): RequestArgumentError {
  const remedy = sending.emptyRemedy === undefined ? "." : `; ${sending.emptyRemedy}.`;
  return new RequestArgumentError(
    `${call}() got ${what} holding no file, and a method tree holds at least one${remedy}`,
  );
}

/** Whether a version handshake declares a blob store (`blob_store: true`). */
export function declaresBlobStore(version: object): boolean {
  return (version as Record<string, unknown>).blob_store === true;
}

/**
 * The tree limits a version handshake announces under `limits.method_tree`. A value that is not a
 * positive safe integer is left out rather than trusted, and a limit not announced is absent, so a
 * bare runner, which announces none, yields no limit.
 */
export function announcedTreeLimits(version: object): MethodTreeLimits {
  const limits = objectMember(version, "limits");
  const tree = limits === undefined ? undefined : objectMember(limits, "method_tree");
  if (tree === undefined) return {};
  const read = (name: string): number | undefined => {
    const value = tree[name];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  };
  const announced: { maxFileCount?: number; maxFileSize?: number; maxTotalSize?: number } = {};
  const maxFileCount = read("max_files");
  const maxFileSize = read("max_file_bytes");
  const maxTotalSize = read("max_total_bytes");
  if (maxFileCount !== undefined) announced.maxFileCount = maxFileCount;
  if (maxFileSize !== undefined) announced.maxFileSize = maxFileSize;
  if (maxTotalSize !== undefined) announced.maxTotalSize = maxTotalSize;
  return announced;
}

/** What an inline map spends in a request: its JSON serialization with no whitespace, in UTF-8. */
export function inlineMapBytes(files: MethodFiles): number {
  return UTF8_ENCODER.encode(JSON.stringify(files)).length;
}

/** The total of a tree's file sizes, in bytes. */
export function treeTotalSize(tree: MethodTreeSource): number {
  return tree.files.reduce((total, file) => total + file.size, 0);
}

/**
 * Every file's bytes, by tree path, each read and checked by the tree, one file at a time. `signal`
 * is read before each file: once it has aborted, no further file is read and the abort is thrown.
 */
export async function readTreeBytes(
  tree: MethodTreeSource,
  signal?: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  const bytes = new Map<string, Uint8Array>();
  for (const file of tree.files) {
    throwIfAborted(signal);
    bytes.set(file.path, await tree.readFile(file.path));
  }
  return bytes;
}

/** The whole tree as inline entries, from bytes already read by `readTreeBytes`. */
export function inlineFilesOf(
  tree: MethodTreeSource,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): MethodFiles {
  const files: MethodFiles = {};
  for (const file of tree.files) {
    const bytes = bytesByPath.get(file.path);
    if (bytes === undefined) throw new Error(`No bytes were read for '${file.path}'.`);
    defineFileEntry(files, file.path, inlineFileEntry(bytes));
  }
  return files;
}

/** The whole tree as hash entries, which the platform resolves in the organization's blobs. */
export function hashMethodFiles(tree: MethodTreeSource): MethodFiles {
  const files: MethodFiles = {};
  for (const file of tree.files) {
    defineFileEntry(files, file.path, { sha256: file.sha256, size: file.size });
  }
  return files;
}

/** Each blob of the tree once, in the tree's order: files with the same bytes share one blob. */
export function uniqueBlobs(tree: MethodTreeSource): BlobRef[] {
  const seen = new Set<string>();
  const blobs: BlobRef[] = [];
  for (const file of tree.files) {
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    blobs.push({ sha256: file.sha256, size: file.size });
  }
  return blobs;
}

/** A file of the tree holding each blob, so a missing blob's bytes can be read and uploaded. */
export function fileByBlob(tree: MethodTreeSource): Map<string, MethodTreeSourceFile> {
  const files = new Map<string, MethodTreeSourceFile>();
  for (const file of tree.files) {
    if (!files.has(file.sha256)) files.set(file.sha256, file);
  }
  return files;
}

/**
 * Run `task` over `items`, at most `limit` at a time. The first task to fail stops the run: no
 * queued item is handed out after it, `signal` is aborted so the tasks still in flight can stop
 * early, and once they have settled the first failure is thrown.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await task(item, controller.signal);
      } catch (error) {
        if (failure === undefined) {
          failure = { error };
          controller.abort(error);
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

// ── A tree from bytes in memory ──────────────────────────────────────

/**
 * The tree whose files are `contents`, each file's bytes or its text by tree path, a text encoded
 * in UTF-8. The keys are sent as they are, and the platform refuses one that is not a tree path,
 * with the `422` `invalid_method_files` naming it. `call` names the caller's method in a refusal.
 *
 * Throws `RequestArgumentError` for `contents` holding no file, for a value that is neither a
 * string nor bytes, and for a text holding a lone surrogate, which no file can hold. `sending` says
 * what the tree is for, which the refusal of an empty one names.
 */
export async function contentsTreeSource(
  contents: Readonly<Record<string, Uint8Array | string>>,
  call: string,
  sending: TreeSending,
): Promise<MethodTreeSource> {
  const bytesByPath = new Map<string, Uint8Array>();
  for (const [treePath, content] of Object.entries(contents)) {
    if (typeof content === "string") {
      if (LONE_SURROGATE.test(content)) {
        throw new RequestArgumentError(
          `${call}() got contents['${treePath}'] holding a lone surrogate, which is no text a file ` +
            "can hold: give its bytes instead.",
        );
      }
      bytesByPath.set(treePath, UTF8_ENCODER.encode(content));
    } else if (content instanceof Uint8Array) {
      bytesByPath.set(treePath, content);
    } else {
      throw new RequestArgumentError(
        `${call}() got contents['${treePath}'] that is neither a string nor a Uint8Array.`,
      );
    }
  }
  if (bytesByPath.size === 0) throw emptyTreeRefusal(call, "contents", sending);
  const files: MethodTreeSourceFile[] = [];
  for (const [treePath, bytes] of bytesByPath) {
    files.push({ path: treePath, size: bytes.length, sha256: await sha256Hex(bytes) });
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const digest = await treeDigestOf(files);
  return {
    files,
    digest,
    readFile: async (treePath) => {
      const bytes = bytesByPath.get(treePath);
      if (bytes === undefined) throw new Error(`The tree holds no file '${treePath}'.`);
      return bytes;
    },
  };
}

/**
 * The tree digest of a tree's files: `sha256:` and the SHA-256 of its listing, one line
 * `<sha256>  <path>` per file, in tree path order.
 */
export async function treeDigestOf(files: readonly MethodTreeSourceFile[]): Promise<string> {
  const sorted = [...files].sort((left, right) => compareUtf8(left.path, right.path));
  const listing = sorted.map((file) => `${file.sha256}  ${file.path}\n`).join("");
  return `sha256:${await sha256Hex(UTF8_ENCODER.encode(listing))}`;
}

/** The SHA-256 of `bytes`, in lowercase hexadecimal, by Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two strings byte for byte on their UTF-8 encoding, the order tree paths are sorted in.
 * JavaScript's own string order compares UTF-16 code units, which puts a character above U+FFFF
 * before one between U+E000 and U+FFFF, where UTF-8 puts it after.
 */
export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

// ── File entries ─────────────────────────────────────────────────────

/** The entry a file travels as inline: its text when its bytes are UTF-8, its Base64 otherwise. */
export function inlineFileEntry(bytes: Uint8Array): FileEntry {
  const text = utf8TextOf(bytes);
  return text ?? { base64: encodeBase64(bytes) };
}

/**
 * Add a file to a map of file entries as an own property, since assigning to a key such as
 * `__proto__`, a tree path like any other, would set the object's prototype instead of adding the
 * file.
 */
export function defineFileEntry(files: MethodFiles, treePath: string, entry: FileEntry): void {
  Object.defineProperty(files, treePath, {
    value: entry,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The bytes as text when they are UTF-8, or `null` when they are not. */
function utf8TextOf(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** Canonical padded standard Base64 (RFC 4648), with no line break and its pad bits zero. */
export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let line = "";
  const full = bytes.length - (bytes.length % 3);
  for (let index = 0; index < full; index += 3) {
    const triple = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    line +=
      BASE64_ALPHABET[(triple >> 18) & 63]! +
      BASE64_ALPHABET[(triple >> 12) & 63]! +
      BASE64_ALPHABET[(triple >> 6) & 63]! +
      BASE64_ALPHABET[triple & 63]!;
    // Flush now and then, so a file of many megabytes is not one string grown a character at a time.
    if (line.length >= 8192) {
      chunks.push(line);
      line = "";
    }
  }
  const rest = bytes.length - full;
  if (rest === 1) {
    const value = bytes[full]! << 16;
    line += BASE64_ALPHABET[(value >> 18) & 63]! + BASE64_ALPHABET[(value >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const value = (bytes[full]! << 16) | (bytes[full + 1]! << 8);
    line +=
      BASE64_ALPHABET[(value >> 18) & 63]! +
      BASE64_ALPHABET[(value >> 12) & 63]! +
      BASE64_ALPHABET[(value >> 6) & 63]! +
      "=";
  }
  chunks.push(line);
  return chunks.join("");
}

// ── Moving a file to and from storage ────────────────────────────────

/**
 * Upload one blob's bytes to the target `POST /v1/blobs/missing` named: the bytes as the whole body
 * of a request with the target's method to its URL, carrying exactly the target's headers and no
 * credential of the client, since the signed URL authorizes the upload itself. A `412` from a
 * target asking for a create-only write (`If-None-Match`) means the bytes are already stored, and
 * counts as uploaded.
 *
 * Throws `MethodFileTransferError` (`operation` `upload`) when storage gives no answer within
 * `timeoutMs` or answers any other non-2xx; neither its message nor any member carries the URL,
 * nor storage's error body, which can echo the signed request. Its message ends with what did not
 * happen because of it, `options.unsent`.
 */
export async function uploadBlob(
  blob: MissingBlob,
  bytes: Uint8Array,
  options: { timeoutMs: number; signal?: AbortSignal; unsent: string },
): Promise<void> {
  const { sha256, upload } = blob;
  const host = hostOf(upload.url);
  await storageExchange(
    upload.url,
    {
      method: upload.method,
      headers: { ...upload.headers },
      body: bytes as Uint8Array<ArrayBuffer>,
    },
    options,
    (code) =>
      new MethodFileTransferError(
        `Uploading the file with SHA-256 ${sha256} to ${host} failed: no answer came back ` +
          `(${code}), so ${options.unsent}.`,
        { operation: "upload", code: "unreachable", sha256 },
      ),
    async (response) => {
      // Storage's body is read and dropped: it can echo the signed request.
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok || (response.status === 412 && isCreateOnly(upload.headers))) return;
      throw new MethodFileTransferError(
        `Uploading the file with SHA-256 ${sha256} to ${host} failed (${statusLine(response)}), ` +
          `so ${options.unsent}.`,
        {
          operation: "upload",
          code: methodFileTransferCodeOfStatus(response.status),
          sha256,
          status: response.status,
        },
      );
    },
  );
}

/**
 * The code of a transfer storage answered with a non-2xx `status`: `storage_error` for one the
 * fallback table calls retryable (`408`, `429`, a `5xx` other than `501`), `refused` otherwise.
 */
export function methodFileTransferCodeOfStatus(status: number): MethodFileTransferCode {
  return fallbackVerdict(status, undefined, true).retryable ? "storage_error" : "refused";
}

/**
 * Write a saved tree to disk, each file of `files` at its tree path under `destination`; see
 * `PipelexApiClient.writeMethodTree`. Node only: the file system modules are loaded when it runs.
 */
export async function writeMethodTreeTo(
  files: readonly SavedMethodFile[],
  destination: string,
  options: { timeoutMs: number },
): Promise<void> {
  refuseUnwritableListing(files);
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const target = path.resolve(destination);
  await refuseOccupiedDestination(fs, target);
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(target)}.${randomHex(8)}.writing`);
  await fs.mkdir(staging);
  let inPlace = false;
  try {
    await forEachConcurrently(files, MAX_CONCURRENT_TRANSFERS, async (file, signal) => {
      const bytes = await downloadMethodFile(file, { timeoutMs: options.timeoutMs, signal });
      const filePath = path.join(staging, ...file.path.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, bytes, { flag: "wx" });
    });
    // `rmdir` removes only an empty directory, so a file written there meanwhile is never lost.
    if (await isDirectory(fs, target)) await fs.rmdir(target);
    await fs.rename(staging, target);
    inPlace = true;
  } finally {
    if (!inPlace) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Download one file of a listing and check its bytes against it, reading no more than its listed
 * size and one byte. Throws `MethodFileTransferError` (`operation` `download`) when storage gives no
 * answer, refuses the request, or serves bytes that are not the file listed.
 */
async function downloadMethodFile(
  file: SavedMethodFile,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Uint8Array> {
  const host = hostOf(file.url);
  const unreachable = (code: string): MethodFileTransferError =>
    new MethodFileTransferError(
      `Downloading '${file.path}' from ${host} failed: no answer came back (${code}).`,
      { operation: "download", code: "unreachable", sha256: file.sha256, path: file.path },
    );
  const received = await storageExchange(
    file.url,
    { method: "GET" },
    options,
    unreachable,
    async (response, failureCode) => {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new MethodFileTransferError(
          `Downloading '${file.path}' from ${host} failed (${statusLine(response)}). A refused ` +
            "link may have expired: read the method again for fresh links.",
          {
            operation: "download",
            code: methodFileTransferCodeOfStatus(response.status),
            sha256: file.sha256,
            path: file.path,
            status: response.status,
          },
        );
      }
      try {
        return await readAtMost(response, file.size + 1);
      } catch (cause) {
        throw unreachable(failureCode(cause));
      }
    },
  );
  const receivedSha256 = await sha256Hex(received);
  if (received.length !== file.size || receivedSha256 !== file.sha256) {
    const cameBack =
      received.length > file.size
        ? "more than that came back."
        : `${received.length} bytes came back, hashing to ${receivedSha256}.`;
    throw new MethodFileTransferError(
      `The bytes downloaded for '${file.path}' are not the file listed: the listing names ` +
        `${file.size} bytes hashing to ${file.sha256}, and ${cameBack}`,
      { operation: "download", code: "mismatch", sha256: file.sha256, path: file.path },
    );
  }
  return received;
}

/**
 * One exchange with storage: send the request with no credential of the client, then `consume` the
 * answer, the whole of it bounded by `timeoutMs` and stopped by `signal`, so a body that stalls
 * times out as a request with no answer does. A redirect is not followed, since a signed link names
 * its object, so it reads as a refusal. A request that gets no answer throws what `unreachable`
 * builds from the network code alone, with no cause: the failure fetch throws can quote the URL,
 * whose query is a credential. `consume` is handed the code that names a body read that failed:
 * `ABORT_TIMEOUT` once the exchange's own time limit ran out, whatever error the aborted read
 * raised, `stopped` once the caller stopped it, and the network code of the failure otherwise.
 */
async function storageExchange<T>(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal },
  unreachable: (code: string) => MethodFileTransferError,
  consume: (response: Response, failureCode: (cause: unknown) => string) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The transfer timed out.", "TimeoutError"));
  }, options.timeoutMs);
  const callerSignal = options.signal;
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted === true) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  // The time limit is read before the caller's signal: an abort the timer made is a timeout, and
  // the error the aborted request or read raises says nothing reliable about which abort it was.
  const failureCode = (cause: unknown): string => {
    if (timedOut) return "ABORT_TIMEOUT";
    if (callerSignal?.aborted === true) return "stopped";
    return networkCodeOf(cause);
  };
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (cause) {
      throw unreachable(failureCode(cause));
    }
    return await consume(response, failureCode);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/** A response's bytes, stopped once more than `limit` bytes came in. */
async function readAtMost(response: Response, limit: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
      if (length >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// ── A listing written to disk ────────────────────────────────────────

/**
 * Refuse a listing whose paths could not be written as a tree, before anything is downloaded. A
 * platform's listing holds tree paths that never collide; the check guards the disk against any
 * other listing a caller hands over, such as one built by hand, since a path such as `../x` would
 * be written outside the destination. Throws `RequestArgumentError`.
 */
export function refuseUnwritableListing(files: readonly SavedMethodFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const violation = treePathViolation(file.path);
    if (violation !== null) {
      throw new RequestArgumentError(
        `The listing holds '${file.path}', which is not a tree path (${violation}), so the tree ` +
          "cannot be written.",
      );
    }
    if (seen.has(file.path)) {
      throw new RequestArgumentError(
        `The listing holds '${file.path}' twice, so the tree cannot be written.`,
      );
    }
    seen.add(file.path);
  }
  const colliding = pathCollisions([...seen]);
  if (colliding.length > 0) {
    throw new RequestArgumentError(
      "The listing holds paths that collide once case-folded, or where one names a directory of " +
        `another: ${colliding.join(", ")}.`,
    );
  }
}

/**
 * Why `candidate` is not a tree path, or `null` when it is one (mthds/docs/spec/method-tree.md,
 * "Tree Paths"), the rule the `mthds` package's `treePathViolation` holds.
 */
export function treePathViolation(candidate: string): string | null {
  if (candidate === "") return "the path is empty";
  if (LONE_SURROGATE.test(candidate)) return "the path holds a code point UTF-8 cannot encode";
  if (candidate.startsWith("/") || candidate.endsWith("/")) {
    return "the path starts or ends with '/'";
  }
  for (const segment of candidate.split("/")) {
    if (segment === "") return "the path holds an empty segment";
    if (segment === "." || segment === "..") return `the path holds the segment '${segment}'`;
    if (segment.includes("\\")) return "the path holds a backslash";
    if (segment.includes(":")) return "the path holds a colon";
    if (CONTROL_CHARACTER.test(segment)) return "the path holds a control character";
    if (UTF8_ENCODER.encode(segment).length > MAX_SEGMENT_BYTES) {
      return `a segment is longer than ${MAX_SEGMENT_BYTES} bytes`;
    }
  }
  if (candidate.normalize("NFC") !== candidate) {
    return "the path is not in Unicode Normalization Form C";
  }
  if (UTF8_ENCODER.encode(candidate).length > MAX_TREE_PATH_BYTES) {
    return `the path is longer than ${MAX_TREE_PATH_BYTES} bytes`;
  }
  return null;
}

/**
 * The paths that collide: those equal to another once case-folded, and those naming, once
 * case-folded, a directory of another, with the paths under it, sorted byte for byte. The fold is
 * `toUpperCase().toLowerCase()`, which agrees with Unicode full case folding on the scripts a file
 * name uses; a pair it misses still fails the write, which never writes over a file.
 */
export function pathCollisions(treePaths: readonly string[]): string[] {
  const fold = (text: string): string => text.toUpperCase().toLowerCase();
  const byFolded = new Map<string, Set<string>>();
  const underFoldedDirectory = new Map<string, Set<string>>();
  for (const treePath of treePaths) {
    const folded = fold(treePath);
    const group = byFolded.get(folded) ?? new Set<string>();
    group.add(treePath);
    byFolded.set(folded, group);
    const segments = treePath.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = fold(segments.slice(0, depth).join("/"));
      const under = underFoldedDirectory.get(directory) ?? new Set<string>();
      under.add(treePath);
      underFoldedDirectory.set(directory, under);
    }
  }
  const colliding = new Set<string>();
  for (const group of byFolded.values()) {
    if (group.size > 1) for (const treePath of group) colliding.add(treePath);
  }
  for (const treePath of treePaths) {
    const under = underFoldedDirectory.get(fold(treePath));
    if (under !== undefined) {
      colliding.add(treePath);
      for (const other of under) colliding.add(other);
    }
  }
  return [...colliding].sort(compareUtf8);
}

type NodeFsPromises = typeof import("node:fs/promises");

/** Refuse a destination that exists and is not an empty directory. Throws `RequestArgumentError`. */
async function refuseOccupiedDestination(fs: NodeFsPromises, target: string): Promise<void> {
  let entries: string[];
  try {
    const found = await fs.lstat(target);
    if (!found.isDirectory()) throw occupied(target);
    entries = await fs.readdir(target);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return;
    throw err;
  }
  if (entries.length > 0) throw occupied(target);
}

function occupied(target: string): RequestArgumentError {
  return new RequestArgumentError(
    `Cannot write a method tree at '${target}': it already exists and is not an empty ` +
      "directory, and a written tree holds nothing but its files.",
  );
}

async function isDirectory(fs: NodeFsPromises, target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const UTF8_ENCODER = new TextEncoder();
// `ignoreBOM` keeps a leading byte order mark in the text, so the entry gives back every byte.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// With the `u` flag a surrogate pair is one code point, so only a lone surrogate matches.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MAX_SEGMENT_BYTES = 255;
const REDACTED = "[redacted]";
// A link up to its query, then its query, which a redaction replaces.
const LINK_QUERY = /(\bhttps?:\/\/[^\s"'<>?#]*)\?[^\s"'<>]*/gi;
const MAX_TREE_PATH_BYTES = 1024;

function objectMember(holder: object, name: string): Record<string, unknown> | undefined {
  const value = (holder as Record<string, unknown>)[name];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether an upload target asks for a create-only write, whose `412` means already stored. */
function isCreateOnly(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "if-none-match");
}

/** The host a link names, for a message: never the link itself, whose query is a credential. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || "storage";
  } catch {
    return "storage";
  }
}

/**
 * `text`, an answer that carries signed links, with every link hidden, for an error to hold: in a
 * JSON body every `url` member, at any depth, is replaced whole, and in any text, JSON or not, a
 * truncated body included, the query of every `http(s)` link is replaced, since a signed link's
 * signature rides its query. A link is a bearer credential, so no error, message or member may
 * carry one.
 */
export function redactSignedLinks(text: string): string {
  let redacted = text;
  try {
    redacted = JSON.stringify(withUrlMembersRedacted(JSON.parse(text)));
  } catch {
    // Not JSON: the pattern below still hides every link's query.
  }
  return redacted.replace(LINK_QUERY, "$1?[redacted]");
}

function withUrlMembersRedacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withUrlMembersRedacted);
  if (value !== null && typeof value === "object") {
    // `fromEntries` defines each member as an own property, so a `__proto__` member stays one.
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [
        name,
        name === "url" ? REDACTED : withUrlMembersRedacted(member),
      ]),
    );
  }
  return value;
}

function statusLine(response: Response): string {
  return `${response.status} ${response.statusText}`.trimEnd();
}

/** The network code of a failed fetch, as the client's own requests report it. */
function networkCodeOf(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") return "ABORT_TIMEOUT";
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== null && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    if (err.name === "TimeoutError") return "ABORT_TIMEOUT";
  }
  return "network error";
}

function randomHex(byteCount: number): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
