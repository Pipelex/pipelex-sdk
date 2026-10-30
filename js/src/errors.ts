/**
 * Pipelex SDK errors — the argument, transport, run-lifecycle, input-preparation and artifact
 * errors `PipelexApiClient` raises. Every one derives from `PipelexRequestError`, itself the MTHDS
 * standard's `ProblemError` (re-exported from `mthds/protocol`), and so carries its failure as a
 * problem document: the runtime's own when it answered with one, and otherwise the problem the SDK
 * builds for a failure it detects itself, under a registered code. A program branches on `code`,
 * and on `domain`, `retry` and `nextStep` when it handles several codes alike; the rest of the
 * problem (`params`, `location`, `errors`, `pipeline_run_id`, `request_id` and any member the
 * runtime added) is read off `problem`. The Python twin, `pipelex-sdk`, builds the same code for
 * every failure, which the shared case file `tests/fixtures/sdk-problems.json` pins in both suites.
 *
 * The exported errors outside the family, `CodegenLockError`, `ExactJsonUnsupportedError` and the
 * caller-webhook receiver's `WebhookVerificationError` and `WebhookEventUnreadableError`
 * (`webhooks.ts`), are `ProblemError`s too.
 */

import { ProblemError, buildProblem, isProblem, readAnswer, readProblemBody } from "mthds/protocol";
import type { AnswerHeaders, Problem, ProblemItem } from "mthds/protocol";
import { outcomeUnknownProblem, readHostedAnswer } from "./answer-reading.js";
import { requestMayHaveLeft } from "./transport-reading.js";
import type { ArtifactScope, DownloadArtifactsResult } from "./artifacts.js";
import type { RunStatus } from "./runs.js";

export { ProblemError };

/** The `cause` option of an error, given only when there is one, so `cause` stays absent otherwise. */
function causeOption(cause: unknown): { cause?: unknown } | undefined {
  return cause === undefined ? undefined : { cause };
}

// ── The problems this module builds ──────────────────────────────────

/**
 * The problem of an argument refused before any request left: `client.argument_invalid`, naming
 * the argument and why it was refused, as an identifier (`not_a_string`, `mutually_exclusive`, …).
 */
export function argumentInvalidProblem(argument: string, reason: string): Problem {
  return buildProblem("client.argument_invalid", { argument, reason });
}

/**
 * The problem of an answer the SDK cannot use as the route's answer: `client.response_unreadable`,
 * naming its status, and the run it is about as its member when there is one.
 */
export function responseUnreadableProblem(status: number, runId?: string): Problem {
  return buildProblem(
    "client.response_unreadable",
    { status },
    runId === undefined ? {} : { pipeline_run_id: runId },
  );
}

/** The problem the standard reads from an answer's status alone, as for a body that is no problem document. */
export function statusProblem(status: number): Problem {
  return readAnswer({ status, headers: {}, body: "" }, { createsRun: false }).problem;
}

/**
 * Whether a storage answer's `status` refuses the request for its timing or fails in a way a later
 * attempt can pass: a `408`, a `429`, or a `5xx` other than `501`.
 */
export function isTransientStorageStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 501);
}

/**
 * The problem of a storage answer the SDK reads by its status, storage answering no problem
 * document: `runtime.unavailable` for a transient status ({@link isTransientStorageStatus}), so
 * that asking again can succeed; `runtime.unsupported` for a `501`, storage not implementing the
 * request it was sent; and `client.response_unreadable` naming the status otherwise, an answer the
 * SDK has no reading for.
 */
export function storageStatusProblem(status: number): Problem {
  if (isTransientStorageStatus(status)) return buildProblem("runtime.unavailable", {});
  if (status === 501)
    return buildProblem("runtime.unsupported", { capability: "this storage request" });
  return responseUnreadableProblem(status);
}

/** The problem of a request refused for its credential: `auth.invalid_credential`, or `auth.missing_credential` when it carried none. */
function credentialRefusedProblem(credentialSent: boolean): Problem {
  return credentialSent
    ? buildProblem("auth.invalid_credential", {})
    : buildProblem("auth.missing_credential", {});
}

/** The problem an error wrapping another carries: the wrapped error's, when it carries one. */
function wrappedProblem(cause: unknown): Problem | undefined {
  return cause instanceof ProblemError ? cause.problem : undefined;
}

/**
 * The problem of a refused credential, in this order: the server's own, when the wrapped
 * `ApiResponseError` answered a problem document; then what the caller knows of its own request,
 * when it says whether the request carried a credential, which the edge's bare `401` or `403` does
 * not say; then the wrapped error's problem, its reading of that status; and otherwise
 * `auth.invalid_credential`.
 */
function credentialProblem(cause: unknown, credentialSent: boolean | undefined): Problem {
  if (cause instanceof ApiResponseError && readProblemBody(cause.responseBody) !== undefined) {
    return cause.problem;
  }
  if (credentialSent !== undefined) return credentialRefusedProblem(credentialSent);
  return wrappedProblem(cause) ?? credentialRefusedProblem(true);
}

// ── The base every request error derives from ────────────────────────

/**
 * The base of every error this SDK raises over a request, carrying the failure as `problem`.
 *
 * It refines the standard's `ProblemError`, so every getter that reads the problem is there:
 * `code`, the member a program branches on; `domain`, who must act (`input`, `method`,
 * `account`, `operator` or `runtime`); `retry`, whether sending the same request again can succeed
 * (`yes`, `no`, or `outcome_unknown` where a run may already exist and must be read, never started
 * again); `nextStep`, what to do; `retryAfter`, the seconds to wait before a repeat when the
 * problem gives them; and `requestId`, the id to hand to support. `instanceof ProblemError` and
 * `instanceof PipelineRequestError` match every SDK error, as does `mthds`'s `isProblemError`.
 *
 * The message is the SDK's own sentence, as it always was, rather than the problem's: the problem's
 * `detail` and `next_step.detail` are on `problem` for whoever renders them. Its subclasses are
 * meant to be raised, never this class itself.
 */
export abstract class PipelexRequestError extends ProblemError {
  constructor(message: string, problem: Problem, options?: { cause?: unknown }) {
    super(problem, options);
    this.name = "PipelexRequestError";
    this.message = message;
  }
}

// ── Argument refusals ────────────────────────────────────────────────

/**
 * The SDK refused a call's arguments before sending any request: no run source given to
 * `execute()` or `start()`, run sources or method selectors that exclude each other, a selector
 * rule of `validate()`, a method's tree given in two forms or holding no file, a directory the
 * tree lister refuses, a reserved key in `extra`, a `publishMethod()`
 * without its draft token, a `getMethodVersion()` version that is not a positive integer, a
 * selector `parseMethodSelector()` refuses, a method route given a suffixed id, an artifact
 * selection that is empty or names an unknown artifact, an `idempotencyKey` that is not 1 to 255
 * visible ASCII characters, or a base URL that is not host-only. Nothing reached the API,
 * so the message says what to change.
 *
 * Its problem is `client.argument_invalid`, unless `options.problem` gives another: the client
 * gives `client.not_configured` naming `base_url` for a base URL that is not host-only, since it
 * typically comes from `PIPELEX_BASE_URL`. One built from a message alone names the argument
 * `arguments`, for the reason `unspecified`. A refusal the standard's own check raises
 * (`assertExclusiveRunSources`) is rethrown as this class with the same message, the standard's
 * error as `cause`.
 */
export class RequestArgumentError extends PipelexRequestError {
  constructor(message: string, options?: { cause?: unknown; problem?: Problem }) {
    super(
      message,
      options?.problem ?? argumentInvalidProblem("arguments", "unspecified"),
      causeOption(options?.cause),
    );
    this.name = "RequestArgumentError";
  }
}

// ── Input preparation ────────────────────────────────────────────────

/**
 * Base class for every failure raised by input preparation (`uploadFile` /
 * `prepareInputs`). Catch this to handle any preparation failure; catch a
 * subclass to branch on the semantic category. All preparation failures are
 * raised BEFORE any run is created — a run never triggers a hidden upload.
 *
 * Its problem is the one `options.problem` gives: the SDK's own subclasses state theirs, a direct
 * raise gives `client.argument_invalid` for an argument refused or the wrapped error's for a
 * refusal the API answered, and a consumer's subclass, such as a form reporting a missing input in
 * its own words, may give any. One built with none, from a message alone, carries
 * `client.argument_invalid` naming `inputs`, for the reason `unspecified`.
 */
export class InputPreparationError extends PipelexRequestError {
  constructor(message: string, options?: { cause?: unknown; problem?: Problem }) {
    super(
      message,
      options?.problem ?? argumentInvalidProblem("inputs", "unspecified"),
      causeOption(options?.cause),
    );
    this.name = "InputPreparationError";
  }
}

/**
 * A local asset could not be turned into bytes: a missing or unreadable path, or
 * a path string in a non-Node runtime (path strings are Node-only). `source` is
 * the offending path. Its problem is `input.file_unreadable`, naming the path.
 */
export class InvalidLocalSourceError extends InputPreparationError {
  public readonly source: string;

  constructor(message: string, source: string, options?: { cause?: unknown }) {
    super(message, {
      ...options,
      problem: buildProblem("input.file_unreadable", {
        input: source,
        file_type: "file",
        reason: "unreadable",
      }),
    });
    this.name = "InvalidLocalSourceError";
    this.source = source;
  }
}

/**
 * A value the caller gave at a file input cannot be turned into a file to upload: a `data:` URL
 * that does not decode (no comma, bad base64, bad percent-encoding), or a value of a type no file
 * input takes, neither a path or URL string, nor bytes, nor `{url}` content. `prepareInputs`
 * raises it while it reads the inputs, before anything is uploaded. As with
 * `InvalidLocalSourceError`, the inputs are what must change, which is how a consumer tells it
 * apart from `MethodLoadError`, a method that does not load, raised by the same preparation.
 *
 * As on `UploadNotAllowedError`, `inputName` is the input the value belongs to and `inputPath`
 * where it sits inside that input (`report.attachments[1]`, or the name alone for a top-level
 * file). The message names that path and describes the value by its kind, never by its content,
 * since the value is the caller's data. Its problem is `input.invalid`, naming the input and the
 * path inside it.
 */
export class InvalidInputValueError extends InputPreparationError {
  public readonly inputName: string;
  public readonly inputPath: string;

  constructor(
    message: string,
    details: { inputName: string; inputPath: string },
    options?: { cause?: unknown },
  ) {
    super(message, {
      ...options,
      problem: buildProblem("input.invalid", {
        input: details.inputName,
        field: details.inputPath,
      }),
    });
    this.name = "InvalidInputValueError";
    this.inputName = details.inputName;
    this.inputPath = details.inputPath;
  }
}

/**
 * What a value refused under `allowUploads: false` is, in a closed vocabulary a caller branches on
 * rather than on the message: `local_path` — a string that is neither an `http(s)` URL nor a
 * `pipelex-storage://` reference, which preparation would read from disk; `data_url` — a `data:`
 * URL, which it would decode and upload; `bytes` — a `Blob`, `File`, `ArrayBuffer` or `Uint8Array`.
 */
export type UploadNotAllowedKind = "local_path" | "data_url" | "bytes";

const UPLOAD_NOT_ALLOWED_KIND_WORDS: Record<UploadNotAllowedKind, string> = {
  local_path: "a local file path",
  data_url: "a data: URL",
  bytes: "inline bytes",
};

/**
 * `prepareInputs` was called with `allowUploads: false`, and a value at a file input would need an
 * upload: a local path, a `data:` URL or bytes. It is raised before anything is read from disk,
 * decoded or sent to the upload route, so a server preparing inputs on a caller's behalf never
 * reads a file of its own because the caller named it. `inputName` is the input the value belongs
 * to, `inputPath` where it sits inside that input (`report.attachments[1]`, or the name alone for a
 * top-level file), and `valueKind` what it is. The value itself is neither in the message nor on
 * the error, since it is the caller's data. Its problem is `client.argument_invalid`, naming the
 * input's path and the value's kind as the reason: the caller must pass an `http(s)` URL or a
 * `pipelex-storage://` reference instead.
 */
export class UploadNotAllowedError extends InputPreparationError {
  public readonly inputName: string;
  public readonly inputPath: string;
  public readonly valueKind: UploadNotAllowedKind;

  constructor(
    details: { inputName: string; inputPath: string; valueKind: UploadNotAllowedKind },
    options?: { cause?: unknown },
  ) {
    super(
      `Input "${details.inputPath}" is ${UPLOAD_NOT_ALLOWED_KIND_WORDS[details.valueKind]}, which ` +
        "would need an upload, and this preparation uploads nothing: pass an http(s) URL or a " +
        "pipelex-storage:// reference instead.",
      { ...options, problem: argumentInvalidProblem(details.inputPath, details.valueKind) },
    );
    this.name = "UploadNotAllowedError";
    this.inputName = details.inputName;
    this.inputPath = details.inputPath;
    this.valueKind = details.valueKind;
  }
}

/**
 * The pipe I/O answer said the method does not load (`is_valid: false`), so its signature cannot
 * be read and no input can be prepared: the method, not the inputs, must change. Its problem is
 * `method.invalid`, whose `errors` are the answer's problem items, each read member by member
 * (see `readProblemItems`), possibly none; `serverMessage` is the answer's own `message` when it is
 * a string. The error's message names the first item's `detail`, else the answer's own message.
 */
export class MethodLoadError extends InputPreparationError {
  public readonly serverMessage: string | undefined;

  constructor(
    message: string,
    details: { errors: ProblemItem[]; serverMessage?: string | undefined },
    options?: { cause?: unknown },
  ) {
    super(message, {
      ...options,
      problem: buildProblem("method.invalid", {}, { errors: details.errors }),
    });
    this.name = "MethodLoadError";
    this.serverMessage = details.serverMessage;
  }
}

/**
 * Why an asset was refused, in a closed vocabulary a caller branches on rather than
 * on the message: `too_large` — past the service-defined size cap (`uploadFile`'s
 * `413`); `grant_used` — an upload grant asked for without the file's hash already
 * wrote its object (`412`; for a grant that names its bytes, a `412` means they are
 * stored, and is no refusal);
 * `grant_expired` — the grant's validity window has passed; `signature_mismatch` —
 * the file's size, content type or metadata differ from what the grant signed;
 * `unsigned_header` — the request carried a storage header the grant did not sign;
 * `store_refused` — any other refusal from storage, such as the `400 BadDigest` of bytes
 * other than the ones whose SHA-256 the grant was asked with. Storage's `408` and `429` are no
 * refusal of the asset: they refuse the request for its timing, and are an
 * `UploadTransportError`.
 */
export type RejectedAssetReason =
  | "too_large"
  | "grant_used"
  | "grant_expired"
  | "signature_mismatch"
  | "unsigned_header"
  | "store_refused";

/**
 * The server or storage refused the asset — most commonly a `413` past the
 * service-defined size cap, or storage refusing an upload with a grant. A storage
 * `4xx` that says nothing about the file is not among them: a `408` or a `429`, which
 * time out or throttle the request, a `400 RequestTimeout` and a `409
 * ConditionalRequestConflict` are an `UploadTransportError`. The SDK
 * does not impose a client-side cap; it surfaces the refusal. `filename` and
 * `status` locate it, and `reason` says why: the SDK sets it on every one it raises,
 * so it is undefined only on one a caller constructs without it.
 *
 * Its problem is the refusal's as the API answered it, which `uploadFile` passes, and otherwise
 * the one the standard reads from `status` alone, storage answering no problem document.
 */
export class RejectedAssetError extends InputPreparationError {
  public readonly filename: string;
  public readonly status: number;
  public readonly reason: RejectedAssetReason | undefined;

  constructor(
    message: string,
    filename: string,
    status: number,
    options?: { cause?: unknown; reason?: RejectedAssetReason; problem?: Problem },
  ) {
    super(message, {
      cause: options?.cause,
      problem: options?.problem ?? statusProblem(status),
    });
    this.name = "RejectedAssetError";
    this.filename = filename;
    this.status = status;
    this.reason = options?.reason;
  }
}

/**
 * The configured deployment does not support upload (no `/v1/upload` route, seen
 * as a `404` other than a test file's unknown method, which is a {@link TestFileRefusedError}).
 * Upload is a hosted Pipelex-product capability even though the SDK
 * can be pointed at other base URLs. Its problem is `runtime.unsupported`, naming file upload as
 * the capability the deployment lacks: the base URL must point at a deployment that serves
 * upload. `filename` is the file whose upload met it, as `uploadFile` sent it.
 */
export class UnsupportedUploadCapabilityError extends InputPreparationError {
  public readonly filename: string | undefined;

  constructor(message: string, options?: { cause?: unknown; filename?: string }) {
    super(message, {
      cause: options?.cause,
      problem: buildProblem("runtime.unsupported", { capability: "file upload" }),
    });
    this.name = "UnsupportedUploadCapabilityError";
    this.filename = options?.filename;
  }
}

/**
 * Upload was not authorized — a `401`, or a `403` from the upload route other than a test file's
 * refused role, which is a {@link TestFileRefusedError}. Its problem is the server's own when the
 * wrapped error, which `uploadFile` passes as `cause`, answered a problem document. Otherwise it is
 * `auth.invalid_credential` when the request carried a credential and `auth.missing_credential`
 * when it carried none, as `options.credentialSent` says, and the wrapped error's reading of the
 * status when the caller does not say. `filename` is the file whose upload was refused, as
 * `uploadFile` sent it.
 */
export class UploadAuthenticationError extends InputPreparationError {
  public readonly status: number;
  public readonly filename: string | undefined;

  constructor(
    message: string,
    status: number,
    options?: { cause?: unknown; filename?: string; credentialSent?: boolean },
  ) {
    super(message, {
      cause: options?.cause,
      problem: credentialProblem(options?.cause, options?.credentialSent),
    });
    this.name = "UploadAuthenticationError";
    this.status = status;
    this.filename = options?.filename;
  }
}

/**
 * Why the upload route refused a test file, in a closed vocabulary a caller branches on rather
 * than on the message. A test file is a statement about a method, so the route holds it to what
 * changing that method takes:
 *
 * - `role_not_permitted` — the caller's role in the organization may not change methods, as a
 *   runner's may not (the route's `auth.forbidden`). Upload the file as `uploaded`, or with the
 *   credential of a member who may change methods.
 * - `method_not_found` — the method the test file names is not one of the organization's (the
 *   route's `pipelex.catalog.not_found`).
 * - `method_being_deleted` — the method the test file names is being erased (the route's
 *   `pipelex.catalog.being_deleted`).
 */
export type TestFileRefusalReason =
  "role_not_permitted" | "method_not_found" | "method_being_deleted";

/**
 * The upload route refused a test file (`kind: "test"`) for what it claims, never for its bytes:
 * the caller's role may not change methods, or the method it names is unknown or being erased.
 * `reason` says which; the SDK sets it on every one it raises, so it is undefined only on one a
 * caller constructs without it. `status` is the HTTP status, `filename` the file `uploadFile` was
 * sending and `methodId` the method it named, and the wrapped `ApiResponseError` is reachable via
 * `cause`.
 *
 * Its problem is the wrapped error's when `cause` carries one, the server's own. Otherwise it is
 * `auth.forbidden` for `role_not_permitted`, naming a role that may change methods as the
 * requirement, and `client.argument_invalid` naming `method_id` for the other two, the reason as
 * the reason.
 */
export class TestFileRefusedError extends InputPreparationError {
  public readonly status: number | undefined;
  public readonly reason: TestFileRefusalReason | undefined;
  public readonly filename: string | undefined;
  public readonly methodId: string | undefined;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      status?: number;
      reason?: TestFileRefusalReason;
      filename?: string;
      methodId?: string;
    },
  ) {
    super(message, {
      cause: options?.cause,
      problem: wrappedProblem(options?.cause) ?? testFileRefusalProblem(options?.reason),
    });
    this.name = "TestFileRefusedError";
    this.status = options?.status;
    this.reason = options?.reason;
    this.filename = options?.filename;
    this.methodId = options?.methodId;
  }
}

/** The problem of a test file's refusal that wraps no error carrying one; `undefined` leaves the family's own. */
function testFileRefusalProblem(reason: TestFileRefusalReason | undefined): Problem | undefined {
  switch (reason) {
    case "role_not_permitted":
      return buildProblem("auth.forbidden", { requirement: "a role that may change methods" });
    case "method_not_found":
    case "method_being_deleted":
      return argumentInvalidProblem("method_id", reason);
    case undefined:
      return undefined;
  }
}

/**
 * Which transport failure an upload met, in a closed vocabulary a caller branches on
 * rather than on the message or the error's name. The first three come from both
 * `uploadFile` and `uploadWithGrant`, the next four from `uploadWithGrant` only:
 *
 * - `timeout` — the SDK's own time limit ran out before an answer came back:
 *   `uploadWithGrant`'s bound on its `PUT`, or the client's request timeout under
 *   `uploadFile`. Whether the file was stored is unknown.
 * - `unreachable` — no response reached the SDK. In a browser, a refused cross-origin
 *   request looks like this.
 * - `server_error` — a `5xx`. Whether the file was stored is unknown, except after a `501`:
 *   storage does not implement the request it was sent, and stored nothing.
 * - `storage_timeout` — storage's `400 RequestTimeout`: it stopped waiting for the
 *   file's bytes and stored nothing.
 * - `conflict` — storage's `409 ConditionalRequestConflict` on every one of
 *   `uploadWithGrant`'s few attempts: another write of the same object was in flight.
 * - `redirected` — storage redirected the `PUT`, and the redirect was refused.
 * - `invalid_grant_url` — the grant is not stored and its `url` is not an absolute `http(s)` URL free of
 *   user info, so nothing was sent.
 * - `unexpected` — a status or a failure the SDK has no specific mapping for. From
 *   `uploadWithGrant`, storage's `408` or `429`: it timed out or throttled the request,
 *   which a later attempt can pass.
 */
export type UploadTransportReason =
  | "timeout"
  | "unreachable"
  | "server_error"
  | "storage_timeout"
  | "conflict"
  | "redirected"
  | "invalid_grant_url"
  | "unexpected";

/**
 * A network or server fault reaching the upload route or storage — an unreachable
 * host, a timeout, a `5xx`, a refused redirect, storage timing out on the body,
 * storage timing out or throttling the request (a `408` or a `429`), or any other
 * unexpected `upload()` failure. `reason` says which: the SDK sets it on
 * every one it raises, so it is undefined only on one a caller constructs without
 * it. `status` is the HTTP status when a response produced it, and undefined when
 * none did. From `uploadFile` the wrapped `ApiResponseError` is also reachable via
 * `cause`, and `filename` is the file it was sending; `uploadWithGrant` wraps no response,
 * because storage's error body can echo the grant's credential, and leaves `filename` undefined.
 *
 * Its problem is `options.problem` when given, else the wrapped error's when `cause` carries one:
 * `uploadFile` wraps the `ApiResponseError` or `ApiUnreachableError` the client's `upload()`
 * threw. Otherwise — always the case from `uploadWithGrant`, which wraps no response — `reason`
 * decides (`uploadTransportProblem`).
 */
export class UploadTransportError extends InputPreparationError {
  public readonly status: number | undefined;
  public readonly reason: UploadTransportReason | undefined;
  public readonly filename: string | undefined;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      status?: number;
      reason?: UploadTransportReason;
      filename?: string;
      problem?: Problem;
    },
  ) {
    super(message, {
      cause: options?.cause,
      problem:
        options?.problem ??
        wrappedProblem(options?.cause) ??
        uploadTransportProblem(options?.reason, options?.status),
    });
    this.name = "UploadTransportError";
    this.status = options?.status;
    this.reason = options?.reason;
    this.filename = options?.filename;
  }
}

/**
 * The problem of an upload transport failure that wraps no error carrying one, by its reason and
 * the status storage answered:
 *
 * - `timeout`, `unreachable`, `storage_timeout` and `conflict` are `runtime.unavailable`: storage,
 *   a service the upload depends on, did not take the file, and a later attempt can (the SDK's
 *   own raise sites give `client.timeout` and `client.unreachable` instead, naming the limit and
 *   the host);
 * - `server_error`, `unexpected` and no reason at all are `storageStatusProblem`'s reading of the
 *   status: `runtime.unavailable` for a `408`, a `429` or a `5xx` other than `501`,
 *   `runtime.unsupported` for a `501`, `client.response_unreadable` for any other status; a
 *   `server_error` with no status is `runtime.unavailable`, and the others `runtime.unexpected`;
 * - `redirected` is `runtime.misconfigured`: storage redirecting a signed upload is a fault of the
 *   deployment;
 * - `invalid_grant_url` is `client.response_unreadable`: the grant the API answered is unusable.
 */
export function uploadTransportProblem(
  reason: UploadTransportReason | undefined,
  status: number | undefined,
): Problem {
  switch (reason) {
    case "timeout":
    case "unreachable":
    case "storage_timeout":
    case "conflict":
      return buildProblem("runtime.unavailable", {});
    case "server_error":
      return status === undefined
        ? buildProblem("runtime.unavailable", {})
        : storageStatusProblem(status);
    case "unexpected":
    case undefined:
      return status === undefined
        ? buildProblem("runtime.unexpected", {})
        : storageStatusProblem(status);
    case "redirected":
      return buildProblem("runtime.misconfigured", {});
    case "invalid_grant_url":
      return responseUnreadableProblem(200);
  }
}

/**
 * Base class for the failures the artifact operations raise on their own
 * (`fetchArtifact` / `downloadArtifacts`) — the download twin of
 * `InputPreparationError`. Catch this to handle any artifact failure; catch a
 * subclass to branch on the category. A per-reference failure inside a
 * `downloadArtifacts` verdict is a value on the item, never one of these: the
 * operation throws only when it can produce no verdict at all. Transport
 * failures on the resolve route (`ApiResponseError`, `ApiUnreachableError`)
 * and the run-lifecycle errors propagate unchanged, so they are not subclasses.
 *
 * Its problem is `options.problem`, else `runtime.unexpected`: the SDK gives
 * `client.argument_invalid` where it refuses an argument (a `scope`, a bound, a location),
 * `runtime.unsupported` for a runtime with no filesystem, `client.write_failed` for a directory
 * that cannot be created, and `client.response_unreadable` for a resolution that answered the
 * wrong count of items.
 */
export class ArtifactOperationError extends PipelexRequestError {
  constructor(message: string, options?: { cause?: unknown; problem?: Problem }) {
    super(
      message,
      options?.problem ?? buildProblem("runtime.unexpected", {}),
      causeOption(options?.cause),
    );
    this.name = "ArtifactOperationError";
  }
}

/**
 * The scope `downloadArtifacts` was asked to walk has no artifact on the run's
 * results: `main_stuff` or `working_memory` is `null`, or the key is missing
 * from the body altogether. Distinct from an empty walk over a present scope,
 * which is a produced verdict with no artifacts. `scope` names the scope,
 * `runId` the run. Its problem is `client.response_unreadable`, naming the run.
 */
export class ScopeUnavailableError extends ArtifactOperationError {
  public readonly scope: ArtifactScope;
  public readonly runId: string;

  constructor(scope: ArtifactScope, runId: string, options?: { cause?: unknown }) {
    super(
      `Run "${runId}" carries no "${scope}" artifact to walk for produced files — ` +
        "it is null or absent from the results body.",
      { cause: options?.cause, problem: responseUnreadableProblem(200, runId) },
    );
    this.name = "ScopeUnavailableError";
    this.scope = scope;
    this.runId = runId;
  }
}

/**
 * One reference could not be turned into a bounded response by `fetchArtifact`.
 * `reason` says why, in a closed vocabulary the download verdict shares for its
 * per-item errors: the resolve route's own per-reference reasons
 * (`invalid_storage_uri`, `forbidden`), then the fetch boundary's —
 * `unsupported_url`, `plain_http_refused`, `redirect_refused`, `store_refused`
 * (a 401/403 from the object store), `not_found` (404/410), `store_error`
 * (any other non-2xx), `too_large`, `timeout`, `network`, and `unknown` for a failure the SDK
 * cannot place. `status` is the store's HTTP status when one was received. `downloadArtifacts`
 * never lets this escape: it becomes the item's `error`.
 *
 * Its problem is `options.problem` when given, else follows `reason` and `status`
 * (`artifactFetchProblem`). The SDK gives `client.download_limit_exceeded` naming the cap for
 * `too_large`, `client.timeout` naming the budget for `timeout`, and `client.unreachable` naming
 * the store's origin for `network`.
 */
export class ArtifactFetchError extends ArtifactOperationError {
  public readonly uri: string;
  public readonly reason: string;
  public readonly status: number | undefined;

  constructor(
    message: string,
    uri: string,
    reason: string,
    status?: number,
    options?: { cause?: unknown; problem?: Problem },
  ) {
    super(message, {
      cause: options?.cause,
      problem: options?.problem ?? artifactFetchProblem(reason, uri, status),
    });
    this.name = "ArtifactFetchError";
    this.uri = uri;
    this.reason = reason;
    this.status = status;
  }
}

/**
 * The problem of one reference's fetch failure that its raise site states none for, by its reason
 * and the store's status: `input.reference_not_found` naming the reference for
 * `invalid_storage_uri`, `forbidden` and `not_found`; `client.link_refused` for
 * `unsupported_url`, `plain_http_refused` and `redirect_refused`; for `store_error` and
 * `store_refused`, the object store failing or refusing a link the platform has just signed,
 * `storageStatusProblem`'s reading of the store's status (`runtime.unavailable` for a `408`, a
 * `429` or a `5xx` other than `501`, `runtime.unsupported` for a `501`, and
 * `client.response_unreadable` naming any other status, a `401` or a `403` included), and
 * `runtime.unavailable` when no status is known; `runtime.unavailable` for `timeout` and
 * `network`; and `runtime.unexpected` otherwise, `unknown` and a reason this version does not know
 * included.
 */
export function artifactFetchProblem(reason: string, uri: string, status?: number): Problem {
  switch (reason) {
    case "invalid_storage_uri":
    case "forbidden":
    case "not_found":
      return buildProblem("input.reference_not_found", { input: uri });
    case "unsupported_url":
      return buildProblem("client.link_refused", { reason: "unsupported_scheme" });
    case "plain_http_refused":
      return buildProblem("client.link_refused", { reason: "plain_http" });
    case "redirect_refused":
      return buildProblem("client.link_refused", { reason: "redirect" });
    case "store_error":
    case "store_refused":
      return status === undefined
        ? buildProblem("runtime.unavailable", {})
        : storageStatusProblem(status);
    case "timeout":
    case "network":
      return buildProblem("runtime.unavailable", {});
    default:
      return buildProblem("runtime.unexpected", {});
  }
}

/**
 * The resolve route refused the caller's credential (`401` / `403`) during a
 * `downloadArtifacts` call. No further reference can be resolved with it, so
 * the download stops — but the files already saved are real, and `verdict`
 * carries the result as it stood: every item saved before the refusal, and
 * the rest marked `aborted`. `status` is the route's status; the wrapped
 * `ApiResponseError` is reachable via `cause`. (`verdict` is the download's result, not the
 * error's own problem.) Its problem is the server's own when the wrapped error answered a problem
 * document; otherwise `auth.invalid_credential`, or `auth.missing_credential` when
 * `options.credentialSent` says the request carried no credential, and the wrapped error's reading
 * of the status when the caller does not say.
 */
export class ArtifactAuthenticationError extends ArtifactOperationError {
  public readonly status: number;
  public readonly verdict: DownloadArtifactsResult;

  constructor(
    message: string,
    status: number,
    verdict: DownloadArtifactsResult,
    options?: { cause?: unknown; credentialSent?: boolean },
  ) {
    super(message, {
      cause: options?.cause,
      problem: credentialProblem(options?.cause, options?.credentialSent),
    });
    this.name = "ArtifactAuthenticationError";
    this.status = status;
    this.verdict = verdict;
  }
}

// ── A saved method's tree ────────────────────────────────────────────

/** Which way a file of a method's tree was moving when its transfer failed. */
export type MethodFileTransferOperation = "upload" | "download";

/**
 * Why a file of a method's tree could not be moved, the same vocabulary as the Python SDK's:
 *
 * - `unreachable`: storage gave no answer, the connection failing or the time limit running out.
 * - `storage_error`: storage timed out or throttled the request (`408`, `429`), or failed (a `5xx`
 *   other than `501`).
 * - `refused`: storage refused the request with any other status, an expired link among them.
 * - `mismatch`: a download's bytes are not the file the listing names, another size or another
 *   SHA-256.
 */
export type MethodFileTransferReason = "unreachable" | "storage_error" | "refused" | "mismatch";

/**
 * A file of a method's tree that could not be moved between this machine and the platform's
 * storage: thrown by `createMethod` and `writeDraft` when a file the organization lacks could not
 * be uploaded to the target `POST /v1/blobs/missing` named, so the method was not saved, by
 * `resolve`, `codegen`, `pipeIo` and `prepareInputs` for the same failure, so the request was not
 * sent, and by
 * `writeMethodTree` when a saved file could not be downloaded through its link, or its bytes are
 * not the file the listing names.
 *
 * `operation` says which way the file was moving, `reason` why it failed, `sha256` which bytes,
 * `path` the tree path when one is known, and `status` storage's HTTP status when it answered.
 * Neither the message nor any member carries the link, whose query is a bearer credential, nor
 * storage's error body, which can echo the signed request, and it keeps no `cause`, since the
 * failure fetch throws can quote the URL.
 *
 * Its problem follows `reason` (`methodFileTransferProblem`): `unreachable` and `storage_error`
 * are `runtime.unavailable`, since the same transfer can succeed later; `refused` is
 * `storageStatusProblem`'s reading of storage's status (`client.response_unreadable` naming it, or
 * `runtime.unsupported` for a `501`), a download refused for an expired link succeeding once the
 * method is read again, which serves fresh links; and `mismatch` is `client.response_unreadable`.
 */
export class MethodFileTransferError extends PipelexRequestError {
  public readonly operation: MethodFileTransferOperation;
  public readonly reason: MethodFileTransferReason;
  public readonly sha256: string | undefined;
  public readonly path: string | undefined;
  public readonly status: number | undefined;

  constructor(
    message: string,
    details: {
      operation: MethodFileTransferOperation;
      reason: MethodFileTransferReason;
      sha256?: string;
      path?: string;
      status?: number;
    },
  ) {
    super(message, methodFileTransferProblem(details.reason, details.status));
    this.name = "MethodFileTransferError";
    this.operation = details.operation;
    this.reason = details.reason;
    this.sha256 = details.sha256;
    this.path = details.path;
    this.status = details.status;
  }
}

/** The problem of a failed transfer of a method's file, by its reason and storage's status. */
export function methodFileTransferProblem(
  reason: MethodFileTransferReason,
  status: number | undefined,
): Problem {
  switch (reason) {
    case "unreachable":
    case "storage_error":
      return buildProblem("runtime.unavailable", {});
    case "refused":
      return status === undefined
        ? buildProblem("runtime.unexpected", {})
        : storageStatusProblem(status);
    case "mismatch":
      return responseUnreadableProblem(200);
  }
}

// ── Transport ────────────────────────────────────────────────────────

/**
 * Thrown when the Pipelex API host cannot be reached at all (DNS failure,
 * connection refused, TLS handshake failure, request timeout). The HTTP
 * exchange never produced a response — distinguish from `ApiResponseError`,
 * which represents a response that did come back, a body that arrived and could not be decoded
 * included.
 *
 * `networkCode` is the underlying network error code when available
 * (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `ABORT_TIMEOUT`).
 *
 * Its problem is the transport's: `client.timeout`, naming the time limit, for the SDK's own time
 * limit (`ABORT_TIMEOUT`) when the client gives it as `options.timeoutMs`, and
 * `client.unreachable`, naming the base URL, otherwise. Both have `retry` `yes`. On a request that
 * may create a run (`options.mayStartRun`, which the client sets on `start` and `execute`), it is
 * `client.outcome_unknown` instead, whose `retry` is `outcome_unknown`, unless `cause`, the failure
 * fetch threw, proves the request never left: the name lookup, the connection or the TLS handshake
 * failed. A reset or a time limit proves nothing, so the run may have started.
 */
export class ApiUnreachableError extends PipelexRequestError {
  public readonly apiUrl: string;
  public readonly networkCode: string | undefined;

  constructor(
    message: string,
    apiUrl: string,
    networkCode: string | undefined,
    options?: { cause?: unknown; mayStartRun?: boolean; timeoutMs?: number },
  ) {
    super(message, transportProblem(apiUrl, networkCode, options), causeOption(options?.cause));
    this.name = "ApiUnreachableError";
    this.apiUrl = apiUrl;
    this.networkCode = networkCode;
  }
}

/** The SDK's own time limit ran out while the request was sent or answered. */
export const ABORT_TIMEOUT = "ABORT_TIMEOUT";

/** The problem of a request that got no answer, agreeing with whether it may have left. */
function transportProblem(
  apiUrl: string,
  networkCode: string | undefined,
  options: { cause?: unknown; mayStartRun?: boolean; timeoutMs?: number } | undefined,
): Problem {
  if (options?.mayStartRun === true && requestMayHaveLeft(options.cause)) {
    return outcomeUnknownProblem();
  }
  if (networkCode === ABORT_TIMEOUT && options?.timeoutMs !== undefined) {
    return buildProblem("client.timeout", { seconds: options.timeoutMs / 1000 });
  }
  return buildProblem("client.unreachable", { base_url: apiUrl });
}

/**
 * Thrown when the blocking `execute` (`POST /v1/execute`) is killed by the
 * hosted gateway's ~30s synchronous-request limit. The blocking path cannot
 * run methods longer than 30s behind the hosted gateway — use the durable run
 * lifecycle (start + poll) instead.
 *
 * Its problem is `client.outcome_unknown`: the gateway gave up on the request, and the run it
 * carried may go on without its id reaching the caller, so it is looked up in the run history
 * rather than sent again, and the next one is started and polled.
 */
export class PipelineExecuteTimeoutError extends PipelexRequestError {
  public readonly elapsedMs: number;

  constructor(elapsedMs: number, options?: { cause?: unknown }) {
    const seconds = Math.round(elapsedMs / 1000);
    super(
      `The Pipelex Hosted API times out synchronous requests after ~30s — this run took ${seconds}s. ` +
        "The blocking execute path can't run methods longer than 30s behind the gateway. " +
        "Start the run and poll for its result instead: `start()` then `waitForResult(runId)`.",
      outcomeUnknownProblem(),
      causeOption(options?.cause),
    );
    this.name = "PipelineExecuteTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

// ── The run lifecycle ────────────────────────────────────────────────

/**
 * The problem of a run that ended without success, `run.failed`, naming the run and its terminal
 * status, with the run's own problem nested as `run_error` when there is one.
 */
export function runFailedProblem(
  runId: string,
  status: RunStatus,
  runError?: Problem | null,
): Problem {
  return buildProblem(
    "run.failed",
    { pipeline_run_id: runId, run_status: status },
    { pipeline_run_id: runId, extra: { run_error: runError ?? undefined } },
  );
}

/**
 * Thrown when a run reaches a terminal state that is not `COMPLETED` (`FAILED`, `CANCELLED`,
 * `TERMINATED`, `TIMED_OUT`) — by `waitForResult`, `startAndWaitForResult` and the artifact
 * download when the platform answers the results read with HTTP 409. (`getRunResult` returns
 * the same facts as its `failed` arm instead of throwing.)
 *
 * - `problem` is `run.failed`, the results read's own problem document as the platform answered
 *   it, or the one the SDK builds for a failed run it learned of otherwise. Its `retry` is `no`:
 *   the run is over, and starting it again spends credit.
 * - `runError` is the run's own problem, which `run.failed` nests as `run_error`: why the run did
 *   not succeed, under its own code (`run.cancelled`, `run.timed_out`, a model's or a method's
 *   code), with its own `domain`, `retry` and `next_step`. Branch on it to tell a run worth
 *   starting again from one whose method or inputs must change. `undefined` when the run ended
 *   with no problem stored.
 * - `status` is the run's terminal status, `runId` the run.
 */
export class RunFailedError extends PipelexRequestError {
  public readonly runId: string;
  public readonly status: RunStatus;

  constructor(
    message: string,
    runId: string,
    status: RunStatus,
    options?: { cause?: unknown; problem?: Problem },
  ) {
    super(
      message,
      options?.problem ?? runFailedProblem(runId, status),
      causeOption(options?.cause),
    );
    this.name = "RunFailedError";
    this.runId = runId;
    this.status = status;
  }

  /** The run's own problem, nested as `run_error`, when the run ended with one. */
  get runError(): Problem | undefined {
    const nested = this.problem.run_error;
    return isProblem(nested) ? nested : undefined;
  }
}

/**
 * Thrown when a completed run cannot deliver its main stuff.
 *
 * Every completed run delivers a main stuff (the pipelex >= 0.37 wire invariant), so the SDK
 * hands consumers a non-null `RunResults.main_stuff`. This surfaces the contract violation when it
 * cannot: the hosted results endpoint answered a `200` with a null `main_stuff`, or a blocking
 * `execute` response named a `main_stuff_name` whose stuff is absent from the returned working
 * memory. `runId` locates the run. (An empty-but-present main stuff — `{ items: [] }`, `{ text:
 * "" }` — is a valid output and does NOT throw; only a genuinely absent one does.)
 *
 * Its problem is `client.response_unreadable`, naming the run: the API broke its own contract on a
 * completed run.
 */
export class MissingMainStuffError extends PipelexRequestError {
  public readonly runId: string;

  constructor(message: string, runId: string) {
    super(message, responseUnreadableProblem(200, runId));
    this.name = "MissingMainStuffError";
    this.runId = runId;
  }
}

/** `client.follow_failed`: the client stopped following a run that may still be going. */
function followFailedProblem(runId: string): Problem {
  return buildProblem(
    "client.follow_failed",
    { pipeline_run_id: runId },
    { pipeline_run_id: runId },
  );
}

/**
 * Thrown when `waitForResult` exceeds its `timeoutMs` before the run reaches a
 * terminal state. The run is NOT cancelled — it keeps executing server-side and
 * can be resumed later by `runId` (the poll loop just stopped waiting).
 *
 * Its problem is `client.follow_failed`, naming the run: its `retry` is `outcome_unknown` and its
 * step `read_run`, since the run goes on and is read by its id, never started again.
 */
export class RunTimeoutError extends PipelexRequestError {
  public readonly runId: string;
  public readonly timeoutMs: number;

  constructor(message: string, runId: string, timeoutMs: number) {
    super(message, followFailedProblem(runId));
    this.name = "RunTimeoutError";
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when `execute()` receives a 202 instead of a final result.
 *
 * The MTHDS Protocol permits an implementation to degrade a synchronous
 * `/execute` into an accepted-async response (202 with a `Location` header)
 * when it cannot hold the connection open. The run keeps executing
 * server-side — resume by `runId` (`getRunResult` / `waitForResult` on a
 * hosted deployment, or the `location` status resource when provided).
 *
 * Its problem is `client.follow_failed`, naming the run: its `retry` is `outcome_unknown`, since
 * the run exists and executing again would pay for a second one, and its step `read_run`.
 */
export class RunStillRunningError extends PipelexRequestError {
  public readonly runId: string;
  public readonly retryAfterSeconds: number | null;
  public readonly location: string | null;

  constructor(
    message: string,
    runId: string,
    retryAfterSeconds: number | null = null,
    location: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, followFailedProblem(runId), causeOption(options?.cause));
    this.name = "RunStillRunningError";
    this.runId = runId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.location = location;
  }
}

/**
 * Thrown when the durable run lifecycle (`/v1/runs/*`) is not served by the
 * configured `PIPELEX_BASE_URL`.
 *
 * Run polling is a hosted-API extension, not part of the MTHDS Protocol: the
 * open-source `pipelex-api` runner executes methods but has no run store, so
 * it 404s those routes; only a deployment that includes the platform block
 * (the Pipelex Hosted API) serves status/results. A route the deployment lacks answers a `404`
 * whose body is no problem document; a run the platform does not know answers a `404` problem
 * document, `run.not_found`, which is an `ApiResponseError`.
 *
 * Its problem is `runtime.unsupported`, naming the durable run lifecycle as the capability the
 * deployment lacks: the base URL points at a bare runner without it.
 */
export class RunLifecycleUnavailableError extends PipelexRequestError {
  public readonly apiUrl: string;

  constructor(message: string, apiUrl: string, options?: { cause?: unknown }) {
    super(
      message,
      buildProblem("runtime.unsupported", { capability: "the durable run lifecycle" }),
      causeOption(options?.cause),
    );
    this.name = "RunLifecycleUnavailableError";
    this.apiUrl = apiUrl;
  }
}

/**
 * Thrown when a paged-list iterator (`iterateMethods`, `iterateRuns`, `iterateMethodExamples`,
 * `iterateFiles`) refuses to keep following cursors.
 *
 * The ceiling, `pageLimit` pages, sits far beyond any real catalog, run history or file list, so reaching it
 * is a server-side fault — an endpoint minting a fresh cursor forever — not a coverage limit the
 * caller can raise. Throwing beats returning, because a silently truncated list is exactly the bug
 * paging was introduced to remove. Its problem is `client.response_unreadable`.
 */
export class PagingNotTerminatingError extends PipelexRequestError {
  public readonly pageLimit: number;

  constructor(message: string, pageLimit: number) {
    super(message, responseUnreadableProblem(200));
    this.name = "PagingNotTerminatingError";
    this.pageLimit = pageLimit;
  }
}

// ── Refusals the API answered ────────────────────────────────────────

/**
 * The registry codes a refusal about a stored method or one of its versions carries, beside the
 * core codes every route may answer:
 *
 * - `pipelex.catalog.update_conflict` (`409`): the draft moved since the token a `writeDraft` or a
 *   `publishMethod` sent, so nothing was written or published. Read the method again and decide
 *   whether to keep its draft or overwrite it with the fresh token.
 * - `pipelex.catalog.being_deleted` (`409`): the method's erasure has started, on every route that
 *   addresses it.
 * - `pipelex.catalog.not_published` (`409`): a bare `method_id` names the latest published version
 *   and the method was never published. Publish it, or address its draft as `mt_…@draft`.
 * - `pipelex.catalog.not_found` (`404`): the method is not one of the organization's, or
 *   `mt_…@<n>`, or `getMethodVersion`, names a version the method never published.
 * - `pipelex.org.not_found` (`404`): the destination of a `copyMethod` is one the caller does not
 *   belong to, one still being set up, or one that does not exist, answered alike so the platform
 *   never says whether an organization exists. An unknown method is `pipelex.catalog.not_found`.
 * - `pipelex.catalog.copy_too_large` (`422`): a `copyMethod` past one of the copy's bounds on the
 *   stored files it copies, which the problem's `limit` member names (`MethodCopyLimit`).
 *
 * `code` stays a `string`, since the registry adds codes; this type names the ones a method caller
 * branches on. Each has `domain` `input` and `retry` `no`.
 */
export type MethodErrorCode =
  | "pipelex.catalog.update_conflict"
  | "pipelex.catalog.being_deleted"
  | "pipelex.catalog.not_published"
  | "pipelex.catalog.not_found"
  | "pipelex.org.not_found"
  | "pipelex.catalog.copy_too_large";

/**
 * The registry codes a refusal about a request's `Idempotency-Key` carries:
 *
 * - `request.idempotency_key_in_use` (`409`): an earlier request under the same key and the same
 *   body is still being handled, so nothing ran for this one. Its `retry` is `yes`: wait the
 *   problem's `retry_after` seconds (`ApiResponseError.retryAfter`) and send the same request
 *   again under the **same** key, which is answered with the earlier request's outcome once it is
 *   stored. A new key would run it a second time.
 * - `request.idempotency_conflict` (`409`): the key was used before with a different body, or is
 *   bound to a run that has since been deleted. Its `retry` is `no`: the request is sent again
 *   under a new key, with the original body for the first.
 */
export type IdempotencyErrorCode =
  "request.idempotency_key_in_use" | "request.idempotency_conflict";

/**
 * The reason the platform gives a refused logo when `updateOrganizationBranding` refuses one. The
 * refusal is one problem naming both slots' failures at once, one item of its `errors` per broken
 * rule, and writes nothing:
 *
 * - `logo_not_an_upload`: the URI is neither a new upload of the organization nor the `uri` the
 *   slot already holds: a run's or a method's file, a stale `branding/` copy, or the other slot's
 *   logo, since a logo cannot move between slots by its URI.
 * - `logo_not_found`: no such upload in the organization.
 * - `logo_too_large`: the file is over 1 MiB.
 * - `logo_type_not_accepted`: its bytes are not a PNG, JPEG, WebP or SVG image, whatever type
 *   the upload declared, or they are an animated PNG (an APNG) or an animated WebP, since a logo
 *   is a still image.
 * - `logo_unreadable`: a raster that is damaged or cut short, its one frame being decoded whole,
 *   or that has more than 4096 × 4096 pixels; or an SVG that is not well-formed, whose shape
 *   cannot be read, that declares XML entities or external references, or one of whose sides
 *   lies outside 0.001 to 1,000,000, in pixels for its `width` and `height` or in its own units
 *   for its `viewBox`.
 * - `logo_active_content`: an SVG that carries a `script` or a `foreignObject` element, any
 *   element in the XHTML namespace, an `on…` event handler attribute, a `set` or an `animate`
 *   that rewrites a link, an `xml-stylesheet` processing instruction, or a link that is neither
 *   a reference inside the file (`#…`) nor an embedded PNG, JPEG, GIF or WebP image
 *   (`data:image/…`), whether an `href`, an `xlink:href`, or a CSS `url()` or `src()`. Wherever
 *   a browser reads CSS, a `<style>` element's text or an attribute such as `style` or `fill`, an
 *   `@import`, an `image()` or `image-set()` and any CSS escape (a backslash) are refused too. A
 *   `<style>` element itself is allowed, holding only references inside the file, such as
 *   `fill:url(#grad)`.
 * - `logo_not_square`: a square logo whose longer side is more than 10% longer than its shorter.
 * - `logo_too_small`: a raster square logo under 128 px on a side.
 * - `logo_not_wide`: a wide logo less than one and a half times as wide as it is tall.
 * - `logo_too_short`: a raster wide logo under 64 px tall.
 */
export type LogoRefusalCode =
  | "logo_not_an_upload"
  | "logo_not_found"
  | "logo_too_large"
  | "logo_type_not_accepted"
  | "logo_unreadable"
  | "logo_active_content"
  | "logo_not_square"
  | "logo_too_small"
  | "logo_not_wide"
  | "logo_too_short";

/** What an `ApiResponseError` is built from beside its message and the answer's facts. */
export interface ApiResponseErrorOptions {
  cause?: unknown;
  /**
   * The answer read as its problem. The client passes the one it read (`readHostedAnswer`); a
   * consumer building the error by hand may leave it out, and the error then reads the answer
   * itself, as the client would.
   */
  problem?: Problem;
  /**
   * The answer's headers, which a `Retry-After` and an `X-Request-ID` are read from. The client
   * passes them; a consumer building the error by hand may leave them out.
   */
  headers?: AnswerHeaders;
  /**
   * The request was a `start` or an `execute`, which creates a run, so an answer that is no
   * problem document is read for whether the run may exist (`readHostedAnswer`). The client sets
   * it on those two routes alone; it only matters when `problem` is left out.
   */
  mayStartRun?: boolean;
}

/** The response header carrying the request's correlation id. */
const REQUEST_ID_HEADER = "x-request-id";

/** A header's value, as fetch gives the headers or as a plain map of names. */
function headerValue(headers: AnswerHeaders | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name);
    return value === null || value === "" ? undefined : value;
  }
  const map = headers as Readonly<Record<string, string>>;
  const found = Object.keys(map).find((key) => key.toLowerCase() === name);
  const value = found === undefined ? undefined : map[found];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * A response that DID come back from the API and that the SDK cannot hand back as a result: a
 * non-2xx refusal, a body that arrived and could not be decoded, or a 2xx answer the SDK could not
 * read — a body that is not JSON, JSON that is not the object the route answers, or a stored
 * method whose `python` field is not the serialized file list.
 *
 * Its `problem` is the answer read as a problem (`readHostedAnswer`): the body itself when it is a
 * problem document, as the hosted API answers every refusal, its `pipelex.*` code and any member
 * the standard does not name kept; and otherwise the reading of the edge's bare answers by its
 * status, `client.outcome_unknown` among them for a start or an execute the gateway cut off. Every
 * getter of `ProblemError` reads it: branch on `code`, never on the HTTP status or the wording of
 * a message. `retryAfter` is the problem's `retry_after`, which the `Retry-After` header fills when
 * the problem invites a retry and gives none, and `requestId` the problem's `request_id`, else the
 * answer's `X-Request-ID` header, the id to hand to support.
 *
 * `status` is the answer's HTTP status whatever the problem's own `status` says, `statusText` its
 * reason phrase and `responseBody` its raw text, so a member this SDK does not name stays
 * reachable without re-reading the body.
 */
export class ApiResponseError extends PipelexRequestError {
  public readonly apiUrl: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;
  private readonly requestIdHeader: string | undefined;

  constructor(
    message: string,
    apiUrl: string,
    status: number,
    statusText: string,
    responseBody: string,
    options?: ApiResponseErrorOptions,
  ) {
    super(
      message,
      options?.problem ??
        readHostedAnswer(
          { status, headers: options?.headers ?? {}, body: responseBody },
          { createsRun: options?.mayStartRun === true },
        ).problem,
      causeOption(options?.cause),
    );
    this.name = "ApiResponseError";
    this.apiUrl = apiUrl;
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.requestIdHeader = headerValue(options?.headers, REQUEST_ID_HEADER);
  }

  /** The request's id: the problem's `request_id`, else the answer's `X-Request-ID` header. */
  override get requestId(): string | undefined {
    return super.requestId ?? this.requestIdHeader;
  }
}
