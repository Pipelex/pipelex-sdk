/**
 * Pipelex SDK errors — the argument, transport, run-lifecycle, input-preparation and artifact
 * errors `PipelexApiClient` raises. Every one derives from `PipelexRequestError`, itself a
 * `PipelineRequestError` (the protocol base, re-exported from `mthds/protocol`), and so carries
 * a verdict: `retryable` and `errorDomain`, always decided. The one exported error outside the
 * family, `CodegenLockError`, declares the same two members itself.
 */

import { PipelineRequestError } from "mthds/protocol";
import { fallbackVerdict } from "./error-verdicts.js";
import type { ValidationErrorItem } from "./models.js";
import type { ArtifactScope, DownloadArtifactsResult } from "./artifacts.js";
import type {
  FieldError,
  MigrationErrorBlock,
  ProblemDetails,
  ProviderErrorMetadata,
  RunErrorReport,
  UserAction,
} from "./error-models.js";
import type { RunStatus } from "./runs.js";

export { PipelineRequestError };

// ── The verdict every error carries ──────────────────────────────────

/**
 * Who can fix a failure:
 *
 * - `input` — the caller, by changing the request: the inputs, the method, a reference, an
 *   argument.
 * - `config` — someone changing the environment: the base URL, the credential, the plan, the
 *   deployment.
 * - `runtime` — nobody beforehand: a fault during execution or in the service.
 *
 * The set is closed: the hosted envelope spec names these three, so a fourth would be a contract
 * change and would reach the SDK as one.
 */
export type ErrorDomain = "input" | "config" | "runtime";

const ERROR_DOMAINS: ReadonlySet<string> = new Set<ErrorDomain>(["input", "config", "runtime"]);

/** Whether a value is one of the three error domains. */
export function isErrorDomain(value: unknown): value is ErrorDomain {
  return typeof value === "string" && ERROR_DOMAINS.has(value);
}

/**
 * The verdict an error carries: whether asking again can plausibly succeed (`retryable`), and who
 * can fix the failure (`errorDomain`). Both are always decided.
 *
 * "Retryable" says a retry can succeed, never that it is safe: it says nothing about whether the
 * first attempt had an effect. A start answered with a `500` may already have created a run, so a
 * caller that must not start a run twice decides that for itself.
 */
export interface ErrorVerdict {
  readonly retryable: boolean;
  readonly errorDomain: ErrorDomain;
}

/** Build a verdict; each class below declares its own with it. */
function makeVerdict(errorDomain: ErrorDomain, retryable: boolean): ErrorVerdict {
  return Object.freeze({ errorDomain, retryable });
}

/**
 * The base of every error this SDK raises over a request, carrying the verdict as two readonly
 * own properties: `retryable` and `errorDomain`. Each subclass passes its verdict to this
 * constructor, so a class that forgets one does not compile, and every class says its verdict
 * where it is defined.
 *
 * It refines the standard's `PipelineRequestError`, so `instanceof PipelineRequestError` still
 * matches every SDK error. To read a verdict from anything a `catch` holds, use
 * `errorVerdictOf`, which also reads it off an error raised by another copy of this SDK.
 */
export abstract class PipelexRequestError extends PipelineRequestError implements ErrorVerdict {
  /** Whether asking again can plausibly succeed. Always decided. */
  public readonly retryable: boolean;
  /** Who can fix the failure: `input`, `config` or `runtime`. Always decided. */
  public readonly errorDomain: ErrorDomain;

  constructor(message: string, verdict: ErrorVerdict, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PipelexRequestError";
    this.retryable = verdict.retryable;
    this.errorDomain = verdict.errorDomain;
  }
}

/**
 * The verdict of anything a `catch` holds: the pair from an `Error` carrying a boolean
 * `retryable` and a known `errorDomain`, and `undefined` otherwise.
 *
 * The check is structural rather than `instanceof`, so it reads every error of this SDK, of
 * another copy of it installed beside this one, of a consumer's own subclass, and an `mthds`
 * `ApiResponseError` whose runner sent both members. `undefined` means the error carries no
 * verdict: the `RangeError` or `TypeError` the SDK raises for an argument of the wrong type or
 * range before any request is sent (a bug in the calling code), the caller's own abort, which the
 * client rethrows untouched, or anything else a `try` block threw. An argument the client refuses
 * for what it asks is a `RequestArgumentError`, which carries one.
 */
export function errorVerdictOf(err: unknown): ErrorVerdict | undefined {
  if (!(err instanceof Error)) return undefined;
  const { retryable, errorDomain } = err as { retryable?: unknown; errorDomain?: unknown };
  if (typeof retryable !== "boolean" || !isErrorDomain(errorDomain)) return undefined;
  return { retryable, errorDomain };
}

// ── Argument refusals ────────────────────────────────────────────────

/**
 * The SDK refused a call's arguments before sending any request: no run source given to
 * `execute()` or `start()`, run sources or method selectors that exclude each other, a selector
 * rule of `validate()`, an empty `validateFiles()`, a reserved key in `extra`, a `publishMethod()`
 * without its draft token, a `getMethodVersion()` version that is not a positive integer, a
 * selector `parseMethodSelector()` refuses, a method route given a suffixed id, an artifact
 * selection that is empty or names an unknown artifact, or a base URL that is not host-only. Nothing reached the API, so the message says what to change.
 *
 * Its verdict is `input`, not retryable — the caller must change the arguments — unless
 * `options.verdict` declares another: the client declares `config` for a base URL that is not
 * host-only, since it typically comes from `PIPELEX_BASE_URL`. A refusal the standard's own
 * check raises (`assertExclusiveRunSources`) is rethrown as this class with the same message, the
 * standard's error as `cause`.
 */
export class RequestArgumentError extends PipelexRequestError {
  constructor(message: string, options?: { cause?: unknown; verdict?: ErrorVerdict }) {
    super(message, options?.verdict ?? makeVerdict("input", false), options);
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
 * Its verdict is `input`, not retryable — the asset, the inputs or the method selector must
 * change — unless `options.verdict` declares another: the SDK's own subclasses do, and so can a
 * consumer's, such as a form reporting a missing input in its own words.
 */
export class InputPreparationError extends PipelexRequestError {
  constructor(message: string, options?: { cause?: unknown; verdict?: ErrorVerdict }) {
    super(message, options?.verdict ?? makeVerdict("input", false), options);
    this.name = "InputPreparationError";
  }
}

/**
 * The stored method resolved by `getMethodClosure` has no MTHDS source yet — its
 * `MethodData.mthds` parses to an empty closure (a blank string, a JSON `[]`, or
 * an all-blank file array). `getMethodClosure` is the only raiser: the operations
 * that take a `method_id` natively — `prepareInputs` among them — pass the id to
 * the server, which answers a sourceless method with a `422`.
 *
 * Distinct from a transport failure: the `getMethod` fetch succeeded (`200`) and
 * the id is real and in-org; the row simply carries no runnable source. A missing
 * or foreign-org id is a `getMethod` `404` (`ApiResponseError` `not_found`), not
 * this. `methodId` locates the empty method.
 */
export class EmptyMethodSourceError extends InputPreparationError {
  public readonly methodId: string;

  constructor(methodId: string, options?: { cause?: unknown }) {
    super(`Method "${methodId}" has no MTHDS source yet.`, options);
    this.name = "EmptyMethodSourceError";
    this.methodId = methodId;
  }
}

/**
 * A local asset could not be turned into bytes: a missing or unreadable path, or
 * a path string in a non-Node runtime (path strings are Node-only). `source` is
 * the offending path.
 */
export class InvalidLocalSourceError extends InputPreparationError {
  public readonly source: string;

  constructor(message: string, source: string, options?: { cause?: unknown }) {
    super(message, options);
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
 */
export class InvalidInputValueError extends InputPreparationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidInputValueError";
  }
}

/**
 * The pipe I/O answer said the method does not load (`is_valid: false`), so its signature cannot
 * be read and no input can be prepared: the method, not the inputs, must change.
 * `validationErrors` holds the answer's items, each kept when it carries a string `category` and
 * `message`, possibly none; `serverMessage` is the answer's own `message` when it is a string. The
 * error's message names the first item's message, else the answer's own.
 */
export class MethodLoadError extends InputPreparationError {
  public readonly validationErrors: ValidationErrorItem[];
  public readonly serverMessage: string | undefined;

  constructor(
    message: string,
    details: { validationErrors: ValidationErrorItem[]; serverMessage?: string | undefined },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MethodLoadError";
    this.validationErrors = details.validationErrors;
    this.serverMessage = details.serverMessage;
  }
}

/**
 * Why an asset was refused, in a closed vocabulary a caller branches on rather than
 * on the message: `too_large` — past the service-defined size cap (`uploadFile`'s
 * `413`); `grant_used` — the upload grant already wrote its object (`412`);
 * `grant_expired` — the grant's validity window has passed; `signature_mismatch` —
 * the file's size, content type or metadata differ from what the grant signed;
 * `unsigned_header` — the request carried a storage header the grant did not sign;
 * `store_refused` — any other refusal from storage. Storage's `408` and `429` are no
 * refusal of the asset: they refuse the request for its timing, and are an
 * `UploadTransportError`.
 */
export type RejectedAssetCode =
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
 * `status` locate it, and `code` says why: the SDK sets it on every one it raises,
 * so it is undefined only on one a caller constructs without it.
 */
export class RejectedAssetError extends InputPreparationError {
  public readonly filename: string;
  public readonly status: number;
  public readonly code: RejectedAssetCode | undefined;

  constructor(
    message: string,
    filename: string,
    status: number,
    options?: { cause?: unknown; code?: RejectedAssetCode },
  ) {
    super(message, options);
    this.name = "RejectedAssetError";
    this.filename = filename;
    this.status = status;
    this.code = options?.code;
  }
}

/**
 * The configured deployment does not support upload (no `/v1/upload` route, seen
 * as a `404`). Upload is a hosted Pipelex-product capability even though the SDK
 * can be pointed at other base URLs. Its verdict is `config`, not retryable: the base URL
 * must point at a deployment that serves upload. `filename` is the file whose upload met it, as
 * `uploadFile` sent it.
 */
export class UnsupportedUploadCapabilityError extends InputPreparationError {
  public readonly filename: string | undefined;

  constructor(message: string, options?: { cause?: unknown; filename?: string }) {
    super(message, { ...options, verdict: makeVerdict("config", false) });
    this.name = "UnsupportedUploadCapabilityError";
    this.filename = options?.filename;
  }
}

/**
 * Upload was not authorized — a `401`/`403` from the upload route. Its verdict is `config`, not
 * retryable: the credential must change. `filename` is the file whose upload was refused, as
 * `uploadFile` sent it.
 */
export class UploadAuthenticationError extends InputPreparationError {
  public readonly status: number;
  public readonly filename: string | undefined;

  constructor(message: string, status: number, options?: { cause?: unknown; filename?: string }) {
    super(message, { ...options, verdict: makeVerdict("config", false) });
    this.name = "UploadAuthenticationError";
    this.status = status;
    this.filename = options?.filename;
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
 * - `conflict` — storage's `409 ConditionalRequestConflict`: another `PUT` with the
 *   same grant was in flight.
 * - `redirected` — storage redirected the `PUT`, and the redirect was refused.
 * - `invalid_grant_url` — the grant's `url` is not an absolute `http(s)` URL free of
 *   user info, so nothing was sent.
 * - `unexpected` — a status or a failure the SDK has no specific mapping for. From
 *   `uploadWithGrant`, storage's `408` or `429`: it timed out or throttled the request,
 *   which a later attempt can pass.
 */
export type UploadTransportCode =
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
 * unexpected `upload()` failure. `code` says which: the SDK sets it on
 * every one it raises, so it is undefined only on one a caller constructs without
 * it. `status` is the HTTP status when a response produced it, and undefined when
 * none did. From `uploadFile` the wrapped `ApiResponseError` is also reachable via
 * `cause`, and `filename` is the file it was sending; `uploadWithGrant` wraps no response,
 * because storage's error body can echo the grant's credential, and leaves `filename` undefined.
 *
 * Its verdict is the wrapped error's when `cause` carries one: `uploadFile` wraps the
 * `ApiResponseError` or `ApiUnreachableError` the client's `upload()` threw, and `code` is too
 * coarse to judge it by (a `402` plan limit is `unexpected`, like a malformed answer). Otherwise
 * — always the case from `uploadWithGrant`, which wraps no response — `code` decides: `timeout`,
 * `storage_timeout` and `conflict` are `runtime` and retryable, `conflict` because storage
 * documents its `409 ConditionalRequestConflict` as retryable and the grant is not spent by it (a
 * spent grant is the `412` of a `RejectedAssetError` with code `grant_used`); `server_error` is
 * `runtime`, and retryable when the fallback table a refused API request reads would call its
 * `status` retryable — any `5xx` but a `501`, which storage answers for a request it does not
 * implement — or when it carries no status; `unexpected` is `runtime`, and retryable when that
 * table would call its `status` retryable — storage's `408` or `429`, refused for its timing —
 * and not retryable for any other status or none; `unreachable` is `config` and retryable, like
 * `ApiUnreachableError`; `redirected` is `config` and not retryable; `invalid_grant_url` and no
 * code at all are `runtime` and not retryable.
 */
export class UploadTransportError extends InputPreparationError {
  public readonly status: number | undefined;
  public readonly code: UploadTransportCode | undefined;
  public readonly filename: string | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; status?: number; code?: UploadTransportCode; filename?: string },
  ) {
    super(message, {
      ...options,
      verdict:
        errorVerdictOf(options?.cause) ?? uploadTransportVerdict(options?.code, options?.status),
    });
    this.name = "UploadTransportError";
    this.status = options?.status;
    this.code = options?.code;
    this.filename = options?.filename;
  }
}

/** The verdict of an upload transport failure that wraps no error carrying one. */
function uploadTransportVerdict(
  code: UploadTransportCode | undefined,
  status: number | undefined,
): ErrorVerdict {
  switch (code) {
    case "timeout":
    case "storage_timeout":
    case "conflict":
      return makeVerdict("runtime", true);
    case "server_error":
      // A fault in storage may pass, but a 501 says storage does not implement the request, and
      // sending it again will not change that. The status reads as an API's would.
      return makeVerdict(
        "runtime",
        status === undefined || fallbackVerdict(status, undefined, true).retryable,
      );
    case "unexpected":
      // Storage's 408 or 429 refused the request for its timing, which a later attempt can pass;
      // any other status, or none, says nothing of the kind.
      return makeVerdict(
        "runtime",
        status !== undefined && fallbackVerdict(status, undefined, true).retryable,
      );
    case "unreachable":
      return makeVerdict("config", true);
    case "redirected":
      return makeVerdict("config", false);
    default:
      // `invalid_grant_url`, no code, and a code this version does not know.
      return makeVerdict("runtime", false);
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
 * Its verdict is `runtime`, not retryable, unless `options.verdict` declares another: the SDK
 * declares `input` where it refuses an argument (a `scope`, a bound, a location) and `config`
 * where the environment refuses the download (a runtime with no filesystem, a directory that
 * cannot be created).
 */
export class ArtifactOperationError extends PipelexRequestError {
  constructor(message: string, options?: { cause?: unknown; verdict?: ErrorVerdict }) {
    super(message, options?.verdict ?? makeVerdict("runtime", false), options);
    this.name = "ArtifactOperationError";
  }
}

/**
 * The scope `downloadArtifacts` was asked to walk has no artifact on the run's
 * results: `main_stuff` or `working_memory` is `null`, or the key is missing
 * from the body altogether. Distinct from an empty walk over a present scope,
 * which is a produced verdict with no artifacts. `scope` names the scope,
 * `runId` the run.
 */
export class ScopeUnavailableError extends ArtifactOperationError {
  public readonly scope: ArtifactScope;
  public readonly runId: string;

  constructor(scope: ArtifactScope, runId: string, options?: { cause?: unknown }) {
    super(
      `Run "${runId}" carries no "${scope}" artifact to walk for produced files — ` +
        "it is null or absent from the results body.",
      options,
    );
    this.name = "ScopeUnavailableError";
    this.scope = scope;
    this.runId = runId;
  }
}

/**
 * One reference could not be turned into a bounded response by `fetchArtifact`.
 * `code` says why, in a closed vocabulary the download verdict shares for its
 * per-item errors: the resolve route's own per-reference codes
 * (`invalid_storage_uri`, `forbidden`), then the fetch boundary's —
 * `unsupported_url`, `plain_http_refused`, `redirect_refused`, `store_refused`
 * (a 401/403 from the object store), `not_found` (404/410), `store_error`
 * (any other non-2xx), `too_large`, `timeout`, `network`. `status` is the
 * store's HTTP status when one was received. `downloadArtifacts` never lets
 * this escape: it becomes the item's `error`.
 *
 * Its verdict follows `code`: `invalid_storage_uri`, `forbidden`, `unsupported_url`, `not_found`
 * and `too_large` are `input` and not retryable, since the reference or the bound must change;
 * `plain_http_refused` is `config` and not retryable; `redirect_refused` and `store_refused` are
 * `runtime` and not retryable; `timeout` and `network` are `runtime` and retryable; `store_error`
 * is `runtime`, and retryable when the fallback table a refused API request reads would call its
 * `status` retryable — a `408`, a `429` or a `5xx` other than `501` — and not retryable for any
 * other status or none. A code this version does not know is `runtime` and not retryable.
 */
export class ArtifactFetchError extends ArtifactOperationError {
  public readonly uri: string;
  public readonly code: string;
  public readonly status: number | undefined;

  constructor(
    message: string,
    uri: string,
    code: string,
    status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, { ...options, verdict: artifactFetchVerdict(code, status) });
    this.name = "ArtifactFetchError";
    this.uri = uri;
    this.code = code;
    this.status = status;
  }
}

/** The verdict of one reference's fetch failure, by its code and the store's status. */
function artifactFetchVerdict(code: string, status: number | undefined): ErrorVerdict {
  switch (code) {
    case "invalid_storage_uri":
    case "forbidden":
    case "unsupported_url":
    case "not_found":
    case "too_large":
      return makeVerdict("input", false);
    case "plain_http_refused":
      return makeVerdict("config", false);
    case "timeout":
    case "network":
      return makeVerdict("runtime", true);
    case "store_error":
      // The store's status reads as an API's would: refused for its timing (408, 429) or a fault
      // that may pass (a 5xx) can succeed on a retry, while a 501 or a 4xx will not.
      return makeVerdict(
        "runtime",
        status !== undefined && fallbackVerdict(status, undefined, true).retryable,
      );
    default:
      // `redirect_refused`, `store_refused`, and a code this version does not know.
      return makeVerdict("runtime", false);
  }
}

/**
 * The resolve route refused the caller's credential (`401` / `403`) during a
 * `downloadArtifacts` call. No further reference can be resolved with it, so
 * the download stops — but the files already saved are real, and `verdict`
 * carries the result as it stood: every item saved before the refusal, and
 * the rest marked `aborted`. `status` is the route's status; the wrapped
 * `ApiResponseError` is reachable via `cause`. (`verdict` is the download's result, not the
 * error's own: that is `retryable` and `errorDomain`, `config` and not retryable, since the
 * credential must change.)
 */
export class ArtifactAuthenticationError extends ArtifactOperationError {
  public readonly status: number;
  public readonly verdict: DownloadArtifactsResult;

  constructor(
    message: string,
    status: number,
    verdict: DownloadArtifactsResult,
    options?: { cause?: unknown },
  ) {
    super(message, { ...options, verdict: makeVerdict("config", false) });
    this.name = "ArtifactAuthenticationError";
    this.status = status;
    this.verdict = verdict;
  }
}

/**
 * Thrown when the Pipelex API host cannot be reached at all (DNS failure,
 * connection refused, TLS handshake failure, request timeout). The HTTP
 * exchange never produced a response — distinguish from `ApiResponseError`,
 * which represents a non-2xx response that did come back.
 *
 * `code` is the underlying network error code when available
 * (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `ABORT_TIMEOUT`).
 *
 * Its verdict is `config` and retryable: the address or the network must be checked, and a later
 * attempt can get through. With the code `ABORT_TIMEOUT`, the SDK's own request timeout, it is
 * `runtime` and retryable instead: the API took the request and did not answer in time, which is
 * no fault of the base URL.
 */
export class ApiUnreachableError extends PipelexRequestError {
  public readonly apiUrl: string;
  public readonly code: string | undefined;

  constructor(
    message: string,
    apiUrl: string,
    code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, makeVerdict(code === "ABORT_TIMEOUT" ? "runtime" : "config", true), options);
    this.name = "ApiUnreachableError";
    this.apiUrl = apiUrl;
    this.code = code;
  }
}

/**
 * Thrown when the blocking `execute` (`POST /v1/execute`) is killed by the
 * hosted gateway's ~30s synchronous-request limit. The blocking path cannot
 * run methods longer than 30s behind the hosted gateway — use the durable run
 * lifecycle (start + poll) instead.
 *
 * Its verdict is `input`, not retryable: asking again meets the same limit, and the caller fixes
 * it by starting the run and polling.
 */
export class PipelineExecuteTimeoutError extends PipelexRequestError {
  public readonly elapsedMs: number;

  constructor(elapsedMs: number, options?: { cause?: unknown }) {
    const seconds = Math.round(elapsedMs / 1000);
    super(
      `The Pipelex Hosted API times out synchronous requests after ~30s — this run took ${seconds}s. ` +
        "The blocking execute path can't run methods longer than 30s behind the gateway. " +
        "Start the run and poll for its result instead: `start()` then `waitForResult(runId)`.",
      makeVerdict("input", false),
      options,
    );
    this.name = "PipelineExecuteTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Thrown when a run reaches a terminal state that is not `COMPLETED` (`FAILED`, `CANCELLED`,
 * `TERMINATED`, `TIMED_OUT`) — by `waitForResult`, `startAndWaitForResult` and the artifact
 * download when the platform answers the results read with HTTP 409. (`getRunResult` returns
 * the same facts as its `failed` arm instead of throwing.)
 *
 * - `status` is the run's terminal status, read from the problem's `run_status` member, or from
 *   its `detail` sentence on a platform that predates the member.
 * - `error` is the run's stored error report, typed whole as `RunErrorReport`: the runner's
 *   `error_type`, `message`, `title`, `type_uri`, `error_domain`, `error_category`,
 *   `retryable`, `user_action`, `model`, `provider`, `provider_metadata`, `validation_errors`
 *   and anything newer through its index signature. Branch on `error.error_domain`,
 *   `error.type_uri` and `error.retryable`; show `error.user_action` as the next step. It is
 *   the runner's VERBOSE report, so `message` and `provider_metadata` can hold a provider's raw
 *   text — deciding what a person sees is the consumer's. `null` when the run ended with no
 *   stored report (a cancelled, terminated or timed-out run, or one the platform finalized
 *   itself).
 * - The error's own `message` is the problem's `detail`, which names the status and then the
 *   report's message (`Run finished with status FAILED: <message>`), so printing the error
 *   already tells the reason.
 * - `runId` locates the run, for a status read or a support request.
 *
 * Its verdict comes from the report. `errorDomain` is the report's `error_domain` when it is one
 * of the three domains, and `runtime` otherwise, including a run with no report. `retryable` is
 * true only when the report's `retryable` is `true`: a report that says nothing, and a run with
 * none, read as not retryable, since starting the run again spends credit and nothing says it
 * would succeed. The report keeps its own `retryable` as written, so a consumer that words the
 * unknown differently still can.
 */
export class RunFailedError extends PipelexRequestError {
  public readonly runId: string;
  public readonly status: RunStatus;
  public readonly error: RunErrorReport | null;

  constructor(
    message: string,
    runId: string,
    status: RunStatus,
    options?: { cause?: unknown; error?: RunErrorReport | null },
  ) {
    super(
      message,
      runFailureVerdict(options?.error ?? null),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RunFailedError";
    this.runId = runId;
    this.status = status;
    this.error = options?.error ?? null;
  }
}

/** The verdict of a failed run, read from its stored report. */
function runFailureVerdict(report: RunErrorReport | null): ErrorVerdict {
  const domain = report?.error_domain;
  return makeVerdict(isErrorDomain(domain) ? domain : "runtime", report?.retryable === true);
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
 * Its verdict is `runtime`, not retryable: the API broke its own contract on a completed run.
 */
export class MissingMainStuffError extends PipelexRequestError {
  public readonly runId: string;

  constructor(message: string, runId: string) {
    super(message, makeVerdict("runtime", false));
    this.name = "MissingMainStuffError";
    this.runId = runId;
  }
}

/**
 * Thrown when `waitForResult` exceeds its `timeoutMs` before the run reaches a
 * terminal state. The run is NOT cancelled — it keeps executing server-side and
 * can be resumed later by `runId` (the poll loop just stopped waiting).
 *
 * Its verdict is `runtime` and retryable: the run is still going, and waiting again can succeed.
 */
export class RunTimeoutError extends PipelexRequestError {
  public readonly runId: string;
  public readonly timeoutMs: number;

  constructor(message: string, runId: string, timeoutMs: number) {
    super(message, makeVerdict("runtime", true));
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
 * Its verdict is `runtime` and retryable: the run is still going, and is resumed by its id.
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
    super(message, makeVerdict("runtime", true), options);
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
 * (the Pipelex Hosted API) serves status/results. Distinguished from a genuine
 * run-not-found 404, which carries the server's structured error envelope.
 *
 * Its verdict is `config`, not retryable: the base URL points at a bare runner without the run
 * lifecycle.
 */
export class RunLifecycleUnavailableError extends PipelexRequestError {
  public readonly apiUrl: string;

  constructor(message: string, apiUrl: string, options?: { cause?: unknown }) {
    super(message, makeVerdict("config", false), options);
    this.name = "RunLifecycleUnavailableError";
    this.apiUrl = apiUrl;
  }
}

/**
 * Thrown when a paged-list iterator (`iterateMethods`) refuses to keep following cursors.
 *
 * The ceiling, `pageLimit` pages, sits far beyond any real catalog, so reaching it is a
 * server-side fault — an endpoint minting a fresh cursor forever — not a coverage limit the caller
 * can raise. Throwing beats returning, because a silently truncated list is exactly the bug
 * paging was introduced to remove. Its verdict is `runtime`, not retryable.
 */
export class PagingNotTerminatingError extends PipelexRequestError {
  public readonly pageLimit: number;

  constructor(message: string, pageLimit: number) {
    super(message, makeVerdict("runtime", false));
    this.name = "PagingNotTerminatingError";
    this.pageLimit = pageLimit;
  }
}

/**
 * The platform codes a refusal about a stored method or one of its versions carries in
 * `ApiResponseError.code`, beside the generic `not_found`, `conflict` and `validation_failed`:
 *
 * - `method_update_conflict` (`409`): the draft moved since the token a `writeDraft` or a
 *   `publishMethod` sent, so nothing was written or published. Read the method again and
 *   decide whether to keep its draft or overwrite it with the fresh token.
 * - `method_being_deleted` (`409`): the method's erasure has started, on every route that
 *   addresses it.
 * - `method_not_published` (`409`): a bare `method_id` names the latest published version and
 *   the method was never published. Publish it, or address its draft as `mt_…@draft`.
 * - `method_version_not_found` (`404`): `mt_…@<n>`, or `getMethodVersion`, names a version
 *   the method never published. An unknown method is `not_found` instead.
 *
 * `code` stays a `string`, since the platform adds codes; this type names the ones a method
 * caller branches on. Each is `input` and not retryable by the fallback verdict.
 */
export type MethodErrorCode =
  | "method_update_conflict"
  | "method_being_deleted"
  | "method_not_published"
  | "method_version_not_found";

/**
 * The last constructor argument of `ApiResponseError`: the error's `cause`, the problem
 * document's typed members, and the decoded document whole. The same shape as `mthds`'s
 * `ApiResponseErrorOptions`, plus `problemDocument`.
 */
export interface ApiResponseErrorOptions {
  cause?: unknown;
  problem?: ProblemDetails;
  problemDocument?: Record<string, unknown>;
}

/**
 * A response that DID come back from the API and that the SDK cannot hand back as a result: a
 * non-2xx refusal, with its problem document parsed, or a 2xx answer the SDK could not read —
 * a body that is not JSON, JSON that is not the object the route answers, or a stored method
 * whose `python` field is not the serialized file list. The second carries the answer's status
 * and raw text, no problem member, what made it unreadable as `cause` (the parse failure, or
 * `mthds`'s refusal of the `python` field), and the verdict the fallback gives a 2xx: `runtime`,
 * not retryable.
 *
 * Every error the hosted API answers is an RFC 9457 `application/problem+json` document, and
 * this error carries its members as typed fields, each `undefined` when the document did not
 * carry it (a member of the wrong type reads as absent rather than as a wrong value, and the
 * nested members `providerMetadata`, `migration`, `validationErrors` and `errors` are checked
 * field by field as a failed run's stored report is) — except the verdict, which is always
 * decided:
 *
 * - **The verdict.** `errorDomain` says who can fix the failure — `input` (the caller),
 *   `config` (a configuration change), `runtime` (nobody beforehand) — and `retryable` whether
 *   asking again can succeed. Each is the document's member when the server sent a valid one,
 *   and otherwise the SDK's fallback, read from the status, the platform `code` and whether the
 *   body names what it refused. A runner often sends `error_domain` without `retryable`, and
 *   then the domain it sent decides `retryable`: `input` and `config` are not retryable, as a
 *   stored report that says nothing is not, since the caller or the environment must change,
 *   while `runtime` takes the fallback's. Nothing on the error says which a value came from:
 *   `problemDocument` keeps what the server sent.
 * - **The branch fields.** `errorDomain`, and `type`, the stable URI naming the error class.
 *   Branch on these, never on the HTTP status or on the wording of a message; they are the
 *   fields that mean the same on both surfaces.
 * - **The native codes.** `code` is the platform's own closed code (`conflict`, `not_found`,
 *   `pipelex_api_key_limit_reached`, …; `MethodErrorCode` names the method ones) and
 *   `errorType` the runner's open exception class name. Each is finer than `errorDomain` and
 *   specific to the surface that emits it, and a client of that surface may branch on it: the
 *   platform's `type` is derived from its `code` one to one
 *   (`https://pipelex.com/errors/<code>`), so the two read the same answer. A problem the
 *   platform relays from the runner carries the runner's `type` and `errorType` and no `code`.
 * - **For a person.** `title` is the stable label of the error class, `serverMessage` the
 *   per-occurrence `detail`, `userAction` the advised next step, and `errorCategory`, `model`,
 *   `provider` and `providerMetadata` describe an inference failure.
 * - **For support.** `requestId` correlates the response with the server's logs; it is read
 *   from the body, or from the `X-Request-ID` response header when the body has none.
 *   `instance` is the occurrence's URN or request path.
 * - **Per-item failures.** `errors` is the platform's field-level list (`field`, `code`,
 *   `detail`), and `validationErrors` the structured diagnostics of a bundle that failed
 *   validation.
 *
 * `problemDocument` is the decoded document whole, so a member this SDK does not name stays
 * reachable without re-parsing `responseBody`, which is the raw text; it is `undefined` when
 * the body was not a JSON object. The members `mthds`'s own `ApiResponseError` carries have the
 * same names here, and the same types except the verdict, which this SDK narrows from optional
 * to decided; the rest (`code`, `errorCategory`, `model`, `provider`, `providerMetadata`,
 * `migration`, `errors`) are the Pipelex members the standard's client leaves to this SDK.
 */
export class ApiResponseError extends PipelexRequestError {
  public readonly apiUrl: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;
  public readonly errorType: string | undefined;
  public readonly serverMessage: string | undefined;
  /**
   * The platform's native code — a closed set (`conflict`, `not_found`, `run_not_found`,
   * `pipelex_api_key_limit_reached`, …), one-to-one with `type`; `MethodErrorCode` names the
   * ones about a stored method and its versions. Finer than `errorDomain` and specific to the
   * platform: a runner's problem carries `errorType` instead. `undefined` for a body that
   * carries no `code`.
   */
  public readonly code: string | undefined;
  /**
   * RFC 9457 `type`: the stable URI naming the error class. With `errorDomain`, the field a
   * machine consumer branches on — the same class carries the same URI on every occurrence.
   */
  public readonly type: string | undefined;
  /** RFC 9457 `title`: the short human label of the error class. */
  public readonly title: string | undefined;
  /** RFC 9457 `instance`: the occurrence — the request path, or a request URN. */
  public readonly instance: string | undefined;
  /**
   * The request's correlation id — the body's `request_id`, or the `X-Request-ID` response
   * header when the body carries none. The id to hand to support: it finds the server's log
   * lines for this request.
   */
  public readonly requestId: string | undefined;
  /**
   * The body's `error_category`: the finer classification of an inference failure — known
   * values `transient`, `configuration`, `content`, `capacity`, `ambiguous`, `unknown`.
   */
  public readonly errorCategory: string | undefined;
  /** The body's `user_action`: what the caller should do next, when the server can say. */
  public readonly userAction: UserAction | undefined;
  /** The body's `model`: the model an inference failure used. */
  public readonly model: string | undefined;
  /** The body's `provider`: the provider an inference failure reached. */
  public readonly provider: string | undefined;
  /** The body's `provider_metadata`: what the provider's SDK said, raw text included. */
  public readonly providerMetadata: ProviderErrorMetadata | undefined;
  /** The body's `migration`: a pending configuration migration that explains the failure. */
  public readonly migration: MigrationErrorBlock | undefined;
  /** The platform's field-level `errors[]` — one item per offending request field. */
  public readonly errors: FieldError[] | undefined;
  /**
   * The decoded problem document whole — every member, named or not, such as a failed run's
   * `run_status` and `error` or a member a newer server adds. `undefined` when the body was not
   * a JSON object.
   */
  public readonly problemDocument: Record<string, unknown> | undefined;
  /**
   * Structured per-error diagnostics on a problem body that carries a top-level
   * `validation_errors[]` — the 422 a **run route** (`execute`, `start`) answers when the
   * runner refuses the method for its validation errors.
   *
   * Everywhere else an invalid bundle is a produced verdict, not an `ApiResponseError`:
   * `POST /v1/validate` answers it with a **200** `PipelexInvalidReport`, and the crate
   * routes with a **200** `CrateInvalidReport`, whose `validation_errors[]` the caller
   * reads off the returned value. This field is `undefined` for any error that carries no
   * per-error list (auth, transport, a request-shape 422, the 422 `pipe-io` answers for a
   * pipe selection it refuses). A consumer must NOT assume a given `error_type` implies a
   * populated list — fall back to `serverMessage` when this is empty.
   */
  public readonly validationErrors: ValidationErrorItem[] | undefined;

  constructor(
    message: string,
    apiUrl: string,
    status: number,
    statusText: string,
    responseBody: string,
    errorType: string | undefined,
    serverMessage: string | undefined,
    validationErrors: ValidationErrorItem[] | undefined,
    code: string | undefined,
    options?: ApiResponseErrorOptions,
  ) {
    super(
      message,
      responseVerdict(status, errorType, code, options?.problem),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ApiResponseError";
    this.apiUrl = apiUrl;
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.errorType = errorType;
    this.serverMessage = serverMessage;
    this.validationErrors = validationErrors;
    this.code = code;
    const problem = options?.problem;
    this.type = problem?.type;
    this.title = problem?.title;
    this.instance = problem?.instance;
    this.requestId = problem?.requestId;
    this.errorCategory = problem?.errorCategory;
    this.userAction = problem?.userAction;
    this.model = problem?.model;
    this.provider = problem?.provider;
    this.providerMetadata = problem?.providerMetadata;
    this.migration = problem?.migration;
    this.errors = problem?.errors;
    this.problemDocument = options?.problemDocument;
  }
}

/**
 * The verdict of a refused request: each member the document's own when it is valid, and the
 * fallback's otherwise, except that a sent `input` or `config` domain with no sent `retryable` is
 * not retryable. A `404` is named when the body carries a platform `code` or a runner
 * `error_type`, read from the constructor's arguments, so an `ApiResponseError` a consumer builds
 * by hand gets the verdict the client would give it.
 */
function responseVerdict(
  status: number,
  errorType: string | undefined,
  code: string | undefined,
  problem: ProblemDetails | undefined,
): ErrorVerdict {
  const fallback = fallbackVerdict(status, code, code !== undefined || errorType !== undefined);
  const sentDomain = problem?.errorDomain;
  const sentRetryable = problem?.retryable;
  if (!isErrorDomain(sentDomain)) {
    return makeVerdict(
      fallback.errorDomain,
      typeof sentRetryable === "boolean" ? sentRetryable : fallback.retryable,
    );
  }
  if (typeof sentRetryable === "boolean") return makeVerdict(sentDomain, sentRetryable);
  // The server said who fixes the failure and nothing of a retry. When the caller or the
  // environment must change, asking again unchanged meets the same answer, whatever the status
  // would suggest; only a `runtime` fault keeps the status's reading.
  return makeVerdict(sentDomain, sentDomain === "runtime" ? fallback.retryable : false);
}
