/**
 * `describeUpload` and `uploadWithGrant` — the two halves of an upload grant
 * (`PipelexApiClient.requestUploadGrant`, `POST /v1/upload/grant`) that the side
 * holding the bytes runs, typically a browser page. That side describes the file,
 * its SHA-256 included, with `describeUpload`; the side that holds the credential
 * requests the grant for that description; and the bytes go to storage with
 * `uploadWithGrant`, unless the grant says the organization already holds them. See
 * `docs/input-preparation.md`.
 *
 * **This module is the browser-safe entry, `@pipelex/sdk/upload`.** Its runtime
 * import graph must never reach a Node builtin, `undici` or the client: a page
 * bundles it as is, with nothing marked external. It imports the error classes,
 * the timer bound in `timers.ts` and the wire types only, hashes with Web Crypto,
 * and `tests/upload-grant.test.ts` bundles it for the browser with esbuild to hold
 * it to that.
 */

import { InputPreparationError, RejectedAssetError, UploadTransportError } from "./errors.js";
import type { RejectedAssetCode } from "./errors.js";
import type { UploadGrant } from "./product-models.js";
import { MAX_TIMER_DELAY_MS, isTimerDelay } from "./timers.js";

export type { UploadGrant, UploadGrantInput, UploadKind } from "./product-models.js";
// The classes `uploadWithGrant` raises, so a page can branch on them without the main entry.
export { InputPreparationError, RejectedAssetError, UploadTransportError } from "./errors.js";
export type { RejectedAssetCode, UploadTransportCode } from "./errors.js";

/**
 * The default time limit on the `PUT`: a minute to open the exchange and hear back,
 * plus a second for every started 128 KiB of the file, about 1 Mbit/s — 460 s at the
 * 50 MiB cap. The grant's expiry bounds nothing here: storage checks the signature
 * when the request starts, not when it ends.
 */
const DEFAULT_TIMEOUT_BASE_MS = 60_000;
const DEFAULT_TIMEOUT_BYTES_PER_SECOND = 128 * 1024;

/**
 * How much of storage's error body is read. S3 writes `<Code>` and `<Message>` first,
 * and the longest document this meets, a signature mismatch echoing the canonical
 * request, runs to a few kilobytes after them.
 */
const ERROR_BODY_MAX_BYTES = 16 * 1024;

/**
 * The pauses before each new `PUT` after storage's `409 ConditionalRequestConflict`,
 * which says another write of the key was in flight and documents a retry: four more
 * attempts, within the call's one time limit, the platform's own create-only write
 * pausing about as long in all.
 */
const CONFLICT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** The signed header that holds the body to the SHA-256 the grant was requested with. */
const CHECKSUM_HEADER = "x-amz-checksum-sha256";

/**
 * A file described for `requestUploadGrant`, as {@link describeUpload} reads it: every
 * field the grant request takes to describe a file, ready to send as is.
 */
export interface UploadDescription {
  /** The file's name: the `File`'s own, or the `filename` option for a nameless `Blob`. */
  filename: string;
  /** The type the runtime gives the file, `Blob.type`: empty when it knows none. */
  content_type: string;
  /** The file's exact size in bytes. */
  size: number;
  /**
   * The SHA-256 of the file's bytes, 64 lowercase hexadecimal digits. Absent only
   * where the runtime offers no Web Crypto digest, which a browser withholds from a
   * page served over plain `http` from any host but the local one: the grant then
   * names a new object and asks for the bytes, as it does for every request with no
   * hash.
   */
  sha256?: string;
}

/**
 * Describe a file for `requestUploadGrant`: its name, its type, its size and the
 * SHA-256 of its bytes, computed with Web Crypto. A grant asked for with the hash
 * names the object after the bytes, so a file the organization already holds is
 * answered `stored: true` and never sent again, and storage refuses a body whose
 * bytes differ from the ones described.
 *
 * The side holding the bytes runs this, so a page describes the file and hands the
 * description to the server that holds the key, which passes it to
 * `requestUploadGrant` unchanged; the bytes never cross that server. A nameless
 * `Blob` takes its name from `options.filename`, which also replaces a `File`'s own.
 * The whole file is read once to hash it. A file that cannot be read, such as one
 * changed on disk since it was picked, throws an `InputPreparationError` whose
 * `cause` is the runtime's error; a file with no name throws one before anything is
 * read.
 */
export async function describeUpload(
  file: Blob,
  options: { filename?: string } = {},
): Promise<UploadDescription> {
  const filename = options.filename ?? ownName(file);
  if (filename === undefined || filename.length === 0) {
    throw new InputPreparationError(
      "The file to describe has no name: pass a File, or give a Blob its name as the " +
        "filename option.",
    );
  }
  const description: UploadDescription = { filename, content_type: file.type, size: file.size };
  const digest = webCryptoDigest();
  if (digest === undefined) return description;
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (error) {
    throw new InputPreparationError(
      `"${filename}" could not be read to compute its SHA-256 (${describeFailureChain(error)}). ` +
        "Pick the file again.",
      { cause: error },
    );
  }
  return { ...description, sha256: hex(await digest("SHA-256", bytes)) };
}

/**
 * The runtime's Web Crypto digest, or undefined where it offers none: a browser gives
 * `crypto.subtle` to a secure context only, a page served over `https` or from the
 * local host.
 */
function webCryptoDigest(): SubtleCrypto["digest"] | undefined {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  return typeof subtle?.digest === "function" ? subtle.digest.bind(subtle) : undefined;
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A `File`'s own name, or undefined for a `Blob`, which has none. */
function ownName(file: Blob): string | undefined {
  const name = (file as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** Per-call options for {@link uploadWithGrant}. */
export interface UploadWithGrantOptions {
  /**
   * Cancels the upload. A caller's abort propagates as the signal's own reason,
   * never wrapped, so it stays distinguishable from a failure. It ends the upload
   * whenever it fires, so it can shorten the time limit but never lengthen it.
   */
  signal?: AbortSignal;
  /**
   * The time limit on the whole exchange with storage, in milliseconds, replacing
   * the default of 60 s plus 1 s for every started 128 KiB of the file — about
   * 1 Mbit/s, so 460 s for a 50 MiB file. Pass a longer one for a slower link. It
   * must be a positive number no larger than 2147483647, the longest delay a timer
   * honours.
   */
  timeoutMs?: number;
}

/** What a successful {@link uploadWithGrant} leaves in storage. */
export interface GrantedUpload {
  /** The grant's `pipelex-storage://` reference, which now names the stored file. */
  uri: string;
  /** The file's record, the grant's `file_id`. */
  file_id: string;
}

/**
 * Store a file with an upload grant, and return the reference it now carries.
 *
 * **A grant that says `stored: true` sends nothing**: the organization already holds
 * these bytes, so the call returns the grant's `uri` and `file_id` at once, without
 * reading the file or reaching storage. Otherwise the file goes to the grant's `url` as
 * the raw body of a `PUT`, with the grant's signed headers unchanged; the body sets
 * `Content-Length`, which the grant signed, so the file must be exactly the size the
 * grant was requested for, and when the grant was requested with the file's SHA-256,
 * storage holds the body to it.
 *
 * Two answers from storage are no failure. A `412` refuses the create-only `PUT`
 * because the object already exists: when the grant names the file by its bytes (it
 * signs `x-amz-checksum-sha256`), that object can only hold those bytes, stored
 * meanwhile by another request, so the call succeeds. A `409 ConditionalRequestConflict`
 * says another write of the object was in flight, so the `PUT` is sent again after a
 * short pause, a few times at most.
 *
 * Storage's refusals map onto the input-preparation errors, so a caller that
 * already handles `uploadFile` needs no new case:
 *
 * - `RejectedAssetError` (`status` is storage's, `code` says why) — a `412` for a
 *   grant that names no bytes, when the grant was already used (`grant_used`: such a
 *   grant writes one object, once); a `403` when the file's size, type or metadata
 *   differ from what the grant signed (`signature_mismatch`), when the request carried
 *   a header the grant did not sign (`unsigned_header`), or when the grant has expired
 *   (`grant_expired`); any other `4xx` but a `408` or a `429` (`store_refused`), a
 *   `400 BadDigest` among them, for bytes other than the ones whose SHA-256 the grant
 *   was requested with. Each asks for a new grant, or for the file the grant was
 *   requested for.
 * - `UploadTransportError` (`status` is storage's when it answered, `code` says
 *   which) — the time limit running out (`timeout`), storage unreachable
 *   (`unreachable`), a `5xx` (`server_error`), storage timing out on the body
 *   (`storage_timeout`, a `400 RequestTimeout`, which wrote nothing), another write of
 *   the object still in progress after every attempt (`conflict`, a `409
 *   ConditionalRequestConflict`), storage timing out or throttling the request
 *   (`unexpected`, a `408` or a `429`, refused for its timing rather than for the
 *   file), or a redirect, which is refused rather than followed (`redirected`). In a
 *   browser a refused cross-origin request looks like an unreachable host, so the
 *   message names that too. A grant that is not stored and whose `url` is not an
 *   absolute `http(s)` URL free of user info is refused the same way, before anything
 *   is sent (`invalid_grant_url`).
 *
 * The whole exchange runs under a time limit, the pauses after a conflict included:
 * `timeoutMs` when given, else 60 s plus 1 s for every started 128 KiB of the file. A
 * caller's `signal` can end it sooner, and its abort propagates as the signal's own
 * reason, unwrapped, even when the time limit ran out too. Only the first 16 KiB of
 * storage's error body are read, and when the limit runs out while that body is still
 * arriving, or during the pause after a conflict, storage has already answered: the
 * call settles as that answer, classified from its status and whatever part of the body
 * arrived.
 *
 * A timeout, a `5xx`, a conflict and a connection lost after the file went out leave
 * it unknown whether the object was written: retrying with the same grant before it
 * expires either stores it or finds it stored, and then the grant's `uri` names the
 * file. After a `408` or a `429` the same retry applies, later, since storage refused
 * the request for its timing. A `501` is the exception: storage does not implement the
 * request it was sent, stored nothing, and answers a retry the same way, so its error
 * is not retryable. The grant is a bearer capability: nothing here logs it, and no
 * error this throws carries its URL, storage's error body or a runtime error that
 * could hold either.
 */
export async function uploadWithGrant(
  grant: UploadGrant,
  file: Blob,
  options: UploadWithGrantOptions = {},
): Promise<GrantedUpload> {
  const label = fileLabel(grant, file);
  const { signal, timeoutMs } = options;
  // A caller's abort wins over a grant or an option this would refuse, as it does over a
  // failed request.
  if (signal?.aborted) throw signal.reason;
  if (timeoutMs !== undefined) requireTimeout(timeoutMs);
  // The organization already holds the bytes: the grant is the whole answer.
  if (grant.stored === true) return grantedUpload(grant);
  const limitMs = timeoutMs ?? defaultTimeoutMs(file.size);
  const target = storageTarget(grant, label);

  // The call's own controller carries both ways the exchange can be cut short: the
  // caller's signal, forwarded into it, and the time limit, which also covers reading
  // storage's error body and the pauses between attempts.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The upload timed out.", "TimeoutError"));
  }, limitMs);
  const onCallerAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(target.href, {
          method: "PUT",
          headers: grant.headers ?? undefined,
          body: file,
          // A presigned URL signs its host, so a redirect could never succeed; refusing
          // it keeps the file from being sent anywhere the grant did not name.
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        // The signals' outcome, not the runtime's error: some runtimes reject with a generic
        // AbortError instead of the reason. A caller's abort wins over the time limit, since
        // it is the one the caller can see and act on.
        if (signal?.aborted) throw signal.reason;
        if (timedOut) throw timeoutError(label, limitMs, grant);
        // Neither the runtime's message nor the error itself is kept: either can carry the
        // request URL, and with it the grant's credential (Bun puts it on the error's `path`).
        throw new UploadTransportError(
          `Upload of "${label}" could not reach storage at ${target.origin} ` +
            `(${describeFailureChain(error)}). In a browser, a refused cross-origin request ` +
            "looks the same: check that the page may connect to the storage origin (its CSP " +
            "connect-src). If the connection failed after the file went out, storage may have " +
            `stored it anyway. ${sameGrantRetry(grant)}`,
          { code: "unreachable" },
        );
      }

      // A body is cancelled, never awaited: a stream's cancel can outlive any time limit.
      if (response.status >= 200 && response.status < 300) {
        void response.body?.cancel().catch(() => undefined);
        return grantedUpload(grant);
      }
      // The create-only PUT found the object there. A grant that names its bytes signs the
      // key they are named by, which can hold no other bytes: they were stored meanwhile.
      if (response.status === 412 && namesItsBytes(grant)) {
        void response.body?.cancel().catch(() => undefined);
        return grantedUpload(grant);
      }
      // A browser reports a refused redirect as an opaque response with status 0.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => undefined);
        throw new UploadTransportError(
          `Upload of "${label}" was redirected by storage, and the redirect was refused: a ` +
            "presigned upload is valid only at the URL it was signed for.",
          // A refused redirect in a browser is opaque, with status 0: no status reached us.
          { status: response.status || undefined, code: "redirected" },
        );
      }

      // Only the error's code and message are kept, never the body: S3 echoes the
      // canonical request on a signature mismatch, and with it the grant's credential.
      const body = await readErrorPrefix(response, ERROR_BODY_MAX_BYTES, controller.signal);
      // A caller's abort while the body streams stays the caller's, unwrapped. The time limit
      // running out then is no timeout: storage has answered, and its status says what
      // happened, read with whatever part of the body arrived.
      if (signal?.aborted) throw signal.reason;
      const refusal = parseStorageError(body);
      const status = response.status;
      if (status === 400 && refusal.code === "RequestTimeout") {
        throw new UploadTransportError(
          `Upload of "${label}" timed out at storage (${describeStatus(response, refusal)}): ` +
            "storage stopped waiting for the file's bytes and wrote nothing. Retry with the " +
            `same grant${beforeExpiry(grant)}, or with a new one.`,
          { status, code: "storage_timeout" },
        );
      }
      // S3 answers this while another write or a delete of the key is in flight, and documents
      // it as retryable: it says nothing about this file, so it is no refusal of it, and the
      // same PUT is sent again once the other write has had a moment to finish. When the time
      // limit runs out first, the call settles as this answer, which is storage's last word.
      if (status === 409 && refusal.code === "ConditionalRequestConflict") {
        const delay = CONFLICT_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined && !timedOut) {
          try {
            await pause(delay, controller.signal);
            continue;
          } catch {
            if (signal?.aborted) throw signal.reason;
          }
        }
        const attempts = attempt + 1;
        throw new UploadTransportError(
          `Upload of "${label}" met another write of the same object still in progress at ` +
            `storage (${describeStatus(response, refusal)}) ` +
            (attempts === 1 ? "on its one attempt" : `on each of its ${attempts} attempts`) +
            (timedOut ? ` before the ${formatSeconds(limitMs)} s allowed ran out` : "") +
            `, so whether the file was stored is unknown. ${sameGrantRetry(grant)}`,
          { status, code: "conflict" },
        );
      }
      // A 408 or a 429 refuses the request for its timing, never the file: storage timed it out
      // or throttled it, so it falls through to the transport failure below, whose verdict reads
      // its status as retryable.
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        const { code, advice } = classifyRefusal(status, refusal, grant);
        throw new RejectedAssetError(
          `Storage refused the upload of "${label}" (${describeStatus(response, refusal)}): ${advice}`,
          label,
          status,
          { code },
        );
      }
      const failure =
        `Upload of "${label}" failed at storage (${describeStatus(response, refusal)})` +
        (refusal.message ? `: ${withoutFinalPeriod(refusal.message)}` : "");
      // Storage answers a 501 for a request it does not implement, such as a header it does
      // not support: it stored nothing, and the same request meets the same answer, so neither
      // the same grant nor a new one is worth a retry, and the error's verdict says so too.
      if (status === 501) {
        throw new UploadTransportError(
          `${failure}. Storage does not implement the request it was sent, so it stored ` +
            "nothing, and sending the file again will meet the same answer.",
          { status, code: "server_error" },
        );
      }
      if (status === 408 || status === 429) {
        throw new UploadTransportError(
          `${failure}. Storage ${status === 429 ? "throttled" : "timed out"} the request rather ` +
            `than refusing the file, so a later attempt can succeed. ${sameGrantRetry(grant)}`,
          { status, code: "unexpected" },
        );
      }
      throw new UploadTransportError(
        `${failure}. Whether the file was stored is unknown. ${sameGrantRetry(grant)}`,
        { status, code: status >= 500 ? "server_error" : "unexpected" },
      );
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

function grantedUpload(grant: UploadGrant): GrantedUpload {
  return { uri: grant.uri, file_id: grant.file_id };
}

/**
 * Whether the grant names its object by the file's bytes: it signs the SHA-256 they were
 * described with, so the object it creates can hold those bytes and no others.
 */
function namesItsBytes(grant: UploadGrant): boolean {
  return Object.keys(grant.headers ?? {}).some((name) => name.toLowerCase() === CHECKSUM_HEADER);
}

/** Wait `ms`, or reject with `abort`'s reason as soon as it fires. */
function pause(ms: number, abort: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abort.aborted) {
      reject(abort.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abort.reason);
    };
    const timer = setTimeout(() => {
      abort.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    abort.addEventListener("abort", onAbort, { once: true });
  });
}

/** The default time limit for a file of `size` bytes, capped at what a timer honours. */
function defaultTimeoutMs(size: number): number {
  const seconds = Math.ceil(size / DEFAULT_TIMEOUT_BYTES_PER_SECOND);
  return Math.min(DEFAULT_TIMEOUT_BASE_MS + seconds * 1_000, MAX_TIMER_DELAY_MS);
}

/** A caller's `timeoutMs`, refused before anything is sent when no timer could honour it. */
function requireTimeout(timeoutMs: number): void {
  if (!isTimerDelay(timeoutMs)) {
    throw new InputPreparationError(
      `"timeoutMs" must be a positive number no larger than ${MAX_TIMER_DELAY_MS}, got ` +
        `${String(timeoutMs)}.`,
    );
  }
}

function timeoutError(label: string, limitMs: number, grant: UploadGrant): UploadTransportError {
  return new UploadTransportError(
    `Upload of "${label}" did not finish within the ${formatSeconds(limitMs)} s allowed, so ` +
      "whether storage stored the file is unknown. On a slow link, pass a longer timeoutMs. " +
      sameGrantRetry(grant),
    { code: "timeout" },
  );
}

/**
 * What to do when the upload may have been stored: the grant itself tells, on a retry. A
 * grant that names its bytes finds them stored; any other reports itself used.
 */
function sameGrantRetry(grant: UploadGrant): string {
  return namesItsBytes(grant)
    ? `Retrying with the same grant${beforeExpiry(grant)} stores the file or finds it ` +
        "already stored, and either way the grant's uri then names the file."
    : `Retrying with the same grant${beforeExpiry(grant)} either stores the file or reports ` +
        "the grant as used, and then the grant's uri already names the file.";
}

/** " before it expires at …", or nothing for a grant that names no expiry. */
function beforeExpiry(grant: UploadGrant): string {
  return grant.expires_at ? ` before it expires at ${grant.expires_at}` : "";
}

function formatSeconds(ms: number): string {
  return String(Number((ms / 1_000).toFixed(3)));
}

/** A message whose own final period would double the one the sentence adds after it. */
function withoutFinalPeriod(message: string): string {
  return message.replace(/\.\s*$/, "");
}

/**
 * The first `maxBytes` of storage's error body as text: whatever arrived before the body
 * ended, failed, reached the cap or was cut short by `abort`, since even a partial body
 * may carry S3's code. The rest is cancelled unread, and the cancellation is never
 * awaited, since a stream's cancel can outlive any time limit.
 */
async function readErrorPrefix(
  response: Response,
  maxBytes: number,
  abort: AbortSignal,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  // Cancelled explicitly on abort, on top of the request's own abort, so a stalled body
  // never holds the read past the time limit: a cancel ends a pending read at once.
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (abort.aborted) {
    cancel();
    return "";
  }
  abort.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (received < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, maxBytes - received);
      received += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
    }
    if (received >= maxBytes) cancel();
  } catch {
    // The body failed mid-stream, or a runtime errored it on abort: what arrived stands.
  } finally {
    abort.removeEventListener("abort", cancel);
  }
  return text + decoder.decode();
}

/** Where a grant sends the file: its `url` exactly as given, and that URL's origin. */
interface StorageTarget {
  href: string;
  origin: string;
}

/**
 * The grant's URL, parsed before anything is sent. A runtime that cannot build a request
 * from a URL names the whole URL in its error — Node and Chrome both do, for one that does
 * not parse or that carries user info — and a browser resolves a relative one against the
 * page, which would send the credential to the page's own origin. So only an absolute
 * `http(s)` URL with no user info is sent, as the grant gave it, and the refusal names
 * none of it. A grant that is not stored and carries no `url` at all is refused the same
 * way.
 */
function storageTarget(grant: UploadGrant, label: string): StorageTarget {
  let target: URL | undefined;
  try {
    target = typeof grant.url === "string" ? new URL(grant.url) : undefined;
  } catch {
    target = undefined;
  }
  if (
    typeof grant.url !== "string" ||
    target === undefined ||
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    throw new UploadTransportError(
      `Upload of "${label}" was not sent: the grant says the file is not stored yet, and its ` +
        "url is not an absolute http(s) URL free of user info, so it is not the one " +
        "requestUploadGrant returned. Pass the grant on unchanged.",
      { code: "invalid_grant_url" },
    );
  }
  return { href: grant.url, origin: target.origin };
}

/**
 * A failure described by the names and codes along its cause chain, such as a network
 * failure's "TypeError, caused by Error ENOTFOUND". Both are mutable, so each is kept only when it
 * is a bare identifier, which cannot hold a URL.
 */
function describeFailureChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const name = isIdentifier(current.name) ? current.name : "Error";
    const code = (current as { code?: unknown }).code;
    parts.push(isIdentifier(code) ? `${name} ${code}` : name);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(", caused by ") : "a non-Error rejection";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
}

/** Storage's own error, read off the S3 XML body. Either field is absent on another body. */
interface StorageRefusal {
  code: string | undefined;
  message: string | undefined;
}

/** Read `<Code>` and `<Message>` off an S3 error document. No XML parser: Node has none. */
function parseStorageError(body: string): StorageRefusal {
  return {
    code: xmlElementText(body, "Code"),
    message: xmlElementText(body, "Message"),
  };
}

function xmlElementText(body: string, element: string): string | undefined {
  const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(body);
  if (!match?.[1]) return undefined;
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function describeStatus(response: Response, refusal: StorageRefusal): string {
  const reason = refusal.code ?? response.statusText;
  return reason ? `${response.status} ${reason}` : String(response.status);
}

/**
 * What a `4xx` from storage, a `408` and a `429` aside, means for the caller: the code
 * it branches on, and words it can act on. An expired grant and an unsigned header both
 * answer `403 AccessDenied`, so only S3's message tells them apart.
 */
function classifyRefusal(
  status: number,
  refusal: StorageRefusal,
  grant: UploadGrant,
): { code: RejectedAssetCode; advice: string } {
  // A grant that names its bytes never gets here with a 412: the object it names is the file.
  if (status === 412) {
    return {
      code: "grant_used",
      advice:
        "this grant was already used. A grant that does not name the file by its bytes " +
        "writes one object, once. If an earlier attempt with it failed at storage, that " +
        "attempt may have stored the file under the grant's URI; otherwise request a new grant.",
    };
  }
  if (refusal.code === "BadDigest") {
    return {
      code: "store_refused",
      advice:
        "the file's bytes differ from the ones whose SHA-256 the grant was requested with. " +
        "Send exactly the file the grant was requested for, or describe the file again and " +
        "request a new grant.",
    };
  }
  if (refusal.code === "SignatureDoesNotMatch") {
    return {
      code: "signature_mismatch",
      advice:
        "the file's size, content type or metadata differ from what the grant signed. Send " +
        "exactly the file the grant was requested for, with the grant's headers unchanged.",
    };
  }
  if (refusal.message && /expired/i.test(refusal.message)) {
    return {
      code: "grant_expired",
      advice: `the grant expired${grant.expires_at ? ` at ${grant.expires_at}` : ""}. Request a new grant.`,
    };
  }
  if (refusal.message && /not signed/i.test(refusal.message)) {
    return {
      code: "unsigned_header",
      advice:
        "the request carried a header the grant did not sign. Send the grant's headers and " +
        "no other storage header.",
    };
  }
  return {
    code: "store_refused",
    advice:
      refusal.message ??
      "request a new grant, or check the file against the one it was requested for.",
  };
}

/** The file's own name when it has one (`File`), else the object name the grant's URI ends in. */
function fileLabel(grant: UploadGrant, file: Blob): string {
  const name = (file as { name?: unknown }).name;
  if (typeof name === "string" && name.length > 0) return name;
  const tail = grant.uri.slice(grant.uri.lastIndexOf("/") + 1);
  return tail.length > 0 ? tail : grant.uri;
}
