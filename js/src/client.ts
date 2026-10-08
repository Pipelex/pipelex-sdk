import type {
  MTHDSProtocol,
  MethodFile,
  ModelCategory,
  ModelDeck,
  RunOptions,
  RunRequest,
  StartOptions,
  StartRequest,
  VersionInfo,
} from "mthds/protocol";
// Run-source predicates come from the standard, not a local restatement: which
// source combinations are legal is an invariant of `RunRequest` itself, so this
// client and the MTHDS runners cannot disagree about what they reject.
import {
  assertExclusiveRunSources,
  hasBundlePayload,
  parseMethodFiles,
  serializeMethodFiles,
} from "mthds/protocol";
import type {
  CodegenRequest,
  CodegenResponse,
  CrateRequestBase,
  DictPipeOutput,
  DictRunResultExecute,
  FormatResponse,
  LintResponse,
  MthdsFileItem,
  PipeIORequest,
  PipeIOResponse,
  PipelexRunResultStart,
  PipelexValidationResult,
  ResolveRequest,
  ResolveResponse,
  ValidateMethodSelector,
  ValidationErrorItem,
} from "./models.js";
import {
  assertArtifactSelection,
  assertWaitOptions,
  pollUntilResult,
  selectionIncludesMainStuff,
  throwIfAborted,
  type GetRunResultOptions,
  type RunRead,
  type RunResults,
  type RunResultState,
  type RunStatus,
  type StartAndWaitForResultOptions,
  type WaitForResultOptions,
} from "./runs.js";
import type {
  BillingPortalResponse,
  ChangePlanResponse,
  CheckoutResponse,
  InvoiceView,
  Membership,
  MembershipsResponse,
  ListMethodsQuery,
  ListMethodVersionsQuery,
  MethodData,
  MethodDeletionAccepted,
  MethodDraftInput,
  MethodPage,
  MethodPublishInput,
  MethodPublishResult,
  MethodRenameInput,
  MethodSummary,
  MethodVersion,
  MethodVersionPage,
  MethodVersionSummary,
  MethodWriteInput,
  OnboardingSubmission,
  PipelexApiKeyCreated,
  PipelexApiKeyList,
  ListRunsQuery,
  RunHistoryItem,
  RunDetail,
  RunPage,
  PlanView,
  ResolvedStorageUrl,
  SubscriptionResponse,
  UpdateRunInput,
  UploadGrant,
  UploadGrantInput,
  UploadInput,
  UploadedFile,
  UserProfile,
} from "./product-models.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  EmptyMethodSourceError,
  MissingMainStuffError,
  PagingNotTerminatingError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RequestArgumentError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
} from "./errors.js";
import {
  isPlainObject,
  isValidationItem,
  readFieldError,
  readMigration,
  readProviderMetadata,
  readRunErrorReport,
} from "./error-models.js";
import type { ProblemDetails, UserAction } from "./error-models.js";
import { methodSourceToContents } from "./method-source.js";
import { buildUserAgent } from "./user-agent.js";
import type { AppInfo } from "./user-agent.js";
import { uploadFile as uploadFileImpl } from "./upload.js";
import type { UploadableAsset, UploadFileOptions, UploadRecord } from "./upload.js";
import { prepareInputs as prepareInputsImpl } from "./prepare-inputs.js";
import type { PrepareInputsRequest, PreparedInputs } from "./prepare-inputs.js";
import {
  downloadArtifacts as downloadArtifactsImpl,
  fetchArtifact as fetchArtifactImpl,
  resolveArtifacts as resolveArtifactsImpl,
} from "./artifacts.js";
import type {
  BulkResolveStorageUrlsInput,
  BulkResolvedStorageUrls,
  DownloadArtifactsRequest,
  DownloadArtifactsResult,
  FetchArtifactOptions,
  ResolvedArtifact,
} from "./artifacts.js";
import { PipelexExecuteResult, resultsFromExecute } from "./execute-result.js";
import { MAX_TIMER_DELAY_MS, isTimerDelay } from "./timers.js";

// A pure RUNAWAY guard on `iterateMethods`, deliberately not a coverage limit.
//
// It counts TOTAL pages, not empty ones. An earlier version capped consecutive
// empty pages, which is the wrong axis: an empty page whose cursor ADVANCED is
// real progress through the index — the platform applies `q` as a post-read
// filter over a bounded slice per request, so a sparse match legitimately
// yields runs of empty pages — and capping them turns a valid sparse search
// into a thrown error. The stuck case is already caught by the no-progress
// check (the server handing back the cursor we sent).
//
// At the platform's 200-row maximum page size this is 2,000,000 methods, so it
// cannot fire on real data; it exists only so a server minting fresh cursors
// forever cannot hang a caller indefinitely.
const MAX_PAGES = 10_000;

export interface MthdsFile {
  /** File contents to validate. */
  content: string;
  /** Optional provenance URI threaded into validation diagnostics. */
  uri?: string;
}

/**
 * The Pipelex API's own run-source extension — the layer-2 argument the RUNNER
 * itself resolves, beside the protocol's inline sources (`mthds_contents` and
 * the bundle encodings). Served by any pipelex-api >= 0.21.0 deployment, bare
 * or hosted (on `api.pipelex.com`, once the platform deploy carrying it lands).
 *
 * Named options rather than `extra` entries, for the same reason as the hosted
 * extensions below: `extra` remains the escape hatch for an extension this
 * client does not know about, never the way to pass one it does.
 */
export interface PipelexApiRunExtensions {
  /**
   * A published method's address — `github.com/<owner>/<repo>[/<selector>][@<tag>]`
   * (e.g. `github.com/Pipelex/methods/documents@v0.1.0`). Resolved by the
   * server: the repository is fetched at the tag (a bare address means the
   * default branch at HEAD), the package is located by manifest identity, and
   * the resolved commit SHA comes back as `method_provenance` on the response.
   *
   * A complete run source of its own — the fetched package carries its `.mthds`
   * and its entry pipe — so it pairs with NOTHING: exclusive with inline
   * `mthds_contents`, with a method bundle (`files` / `bundle_b64`), and with
   * the hosted `method_id` (an address run has its own provenance and needs no
   * linkage id). `pipe_code` beside it is fine — it overrides the manifest's
   * `main_pipe` to pick which pipe in the fetched package to run. This client
   * rejects the illegal pairings before anything hits the wire, mirroring the
   * server's own 422s.
   *
   * An empty string is treated as absent and is not sent.
   */
  method_ref?: string | null;
}

/**
 * The hosted API's own run arguments — the layer-3 extensions this client adds
 * on top of the MTHDS Protocol's run-argument surface (`RunOptions` /
 * `StartOptions`, which stay pure).
 *
 * They are named options rather than `extra` entries because that is the one
 * job a hosted client exists to do: `extra` remains the escape hatch for an
 * extension this client does not know about, never the way to pass one it does.
 * That split is normative for every client in the layered stack — it is not a
 * preference of this one.
 */
export interface PipelexHostedRunExtensions {
  /**
   * A stored method's catalog id (`mt_…`) — a **pass-through to the hosted
   * API**, resolved server-side against the org's catalog. Nothing is expanded
   * client-side, and it is meaningless off-platform: an open-source runner has
   * no catalog, so it answers a `422` naming the key.
   *
   * Its meaning depends on what else the request carries:
   *
   * - **Alone** — the platform resolves the stored method's source (assembling
   *   its bundle when the method carries Python) and runs that.
   * - **Alongside an inline source** (`mthds_contents` / `files` / `bundle_b64`)
   *   — the inline source is what RUNS (precedence), and the id is recorded as
   *   **run-history linkage** on the Run row. That linkage is what writes the
   *   index key `GET /v1/runs?method_id=` queries, so a run started without it
   *   is absent from its method's history permanently.
   * - **Alongside `method_ref`** — rejected client-side (and a 422 on the
   *   hosted API): an address run carries its own provenance, so it takes no
   *   linkage id.
   *
   * An empty string is treated as absent and is not sent.
   */
  method_id?: string | null;
}

/** `execute()` options — the protocol's run arguments plus the Pipelex API and hosted extensions. */
export type PipelexRunOptions = RunOptions & PipelexApiRunExtensions & PipelexHostedRunExtensions;

/** `start()` / `startAndWaitForResult()` options — the same, for the durable path. */
export type PipelexStartOptions = StartOptions &
  PipelexApiRunExtensions &
  PipelexHostedRunExtensions;

/**
 * The method selector `validate()` takes in place of inline contents — declared
 * beside the other wire shapes in `./models.js` and re-exported here, the import
 * path consumers have always used.
 */
export type { ValidateMethodSelector };

export interface ValidateFilesOptions {
  /** Whether unresolved pipe signatures are accepted as pending instead of invalid. */
  allowSignatures?: boolean;
  /** Optional validate presentation hints, e.g. ["markdown"]. */
  render?: string[];
  /** Optional structured-view opt-in tokens, e.g. ["input_form", "output_form"]; sent only when given. */
  views?: string[];
  /**
   * Per-call request ceiling; defaults to the 20-min execute ceiling. A positive number
   * no larger than 2147483647, the longest delay a timer honours, else a `RangeError`.
   */
  timeoutMs?: number;
  /** Caller-driven cancellation; the abort reason propagates untouched. */
  signal?: AbortSignal;
}

export interface PipelexApiClientOptions {
  /** API key (Bearer). Falls back to `PIPELEX_API_KEY`. Optional for anonymous bare runners. */
  apiKey?: string;
  /**
   * API base URL — host only, NO version prefix (e.g. `https://api.pipelex.com`
   * or `http://localhost:8081`). Every endpoint composes as
   * `{baseUrl}/v1/{endpoint}`. Falls back to `PIPELEX_BASE_URL`, then the hosted
   * default.
   */
  baseUrl?: string;
  /**
   * The integrator's identity, placed before the SDK's own token in the
   * `User-Agent` every request to the API carries (Stripe-style), e.g.
   * `{ name: "acme-invoicer", version: "1.4.0" }` →
   * `acme-invoicer/1.4.0 pipelex-sdk-js/<v> node/<v> (<os>; <arch>)`. Validated at
   * construction: a field that is not an RFC 9110 token throws a `TypeError`. See
   * the spec `conformance/specs/client-identification.md`, in the `conformance` repository
   * beside the specs' tests.
   */
  appInfo?: AppInfo;
}

/** Low-level transport over a generic fetch, before status interpretation. */
/** Decoders of an answer's bytes: the strict one tells a body that is not UTF-8. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const LENIENT_UTF8 = new TextDecoder("utf-8");

interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  /** The body as text, a byte that is not UTF-8 read as U+FFFD, as `Response.text()` reads it. */
  body: string;
  /** Whether the body's bytes are UTF-8, which a JSON answer must be (RFC 8259). */
  utf8: boolean;
}

/** HTTP methods the client issues — the product routes add PUT/PATCH/DELETE. */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Hosted default — the client composes every endpoint as `{base}/v1/{endpoint}`. */
export const DEFAULT_API_BASE_URL = "https://api.pipelex.com";

// The client composes every endpoint from one origin (PIPELEX_BASE_URL): `{base}/v1/{endpoint}`.
// The same paths are served by the Pipelex Hosted API (api.pipelex.com) and by a bare
// OSS pipelex-api runner (localhost:8081) — the protocol surface is identical; only
// the hosted extensions (e.g. run polling) differ, detectable via GET /v1/version.
const API_PREFIX = "v1";
const RUNS = "runs";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single status/result GETs; the hosted gateway caps responses at ~30s.
const DEFAULT_DEGRADED_RETRY_SECONDS = 5; // matches the platform's `_DEGRADE_RETRY_AFTER_SECONDS`.
const VALIDATE_MARKDOWN_RENDER_FORMAT = "markdown";

/**
 * `VersionInfo.implementation` of the bare open-source runner (no run store).
 * Anything else — the hosted `pipelex-hosted` first — is assumed to serve the
 * durable run-lifecycle extension; a wrong guess still fails with the clear
 * `RunLifecycleUnavailableError` on the first poll.
 */
const BARE_RUNNER_IMPLEMENTATION = "pipelex-api";

/**
 * Client for the Pipelex hosted API — and any MTHDS-compliant runner.
 *
 * One base URL (`PIPELEX_BASE_URL`); every endpoint is `<base>/v1/<endpoint>`:
 * - **protocol** (`execute` / `start` / `validate` / `models` / `version`) — works
 *   against any MTHDS-compliant runner, hosted or bare.
 * - **crate extensions** (`/v1/resolve`, `/v1/codegen`, `/v1/pipe-io`) — the normalized
 *   library crate, the stamped typed artifacts projected from it, and a method's three
 *   I/O artifacts derived with no dry run.
 * - **tools extensions** (`lint` / `format`) — single-file static diagnostics and
 *   canonical formatting, served by any pipelex-api runner.
 * - **run lifecycle** (`getRunStatus` / `getRunResult` / `waitForResult`) — the
 *   durable polling extension that survives long runs and lets a caller resume by
 *   id. Served only by a deployment that includes the platform block (the Pipelex
 *   Hosted API); a bare `pipelex-api` runner 404s those routes, which the lifecycle
 *   methods translate into a clear `RunLifecycleUnavailableError`.
 *
 * Implements `MTHDSProtocol<DictPipeOutput>` so the protocol-execution methods
 * stay shaped like the standard's wire surface (`mthds/protocol`). The Pipelex
 * extensions (the crate and tools routes, the run lifecycle) ride on top.
 */

// ── Methods catalog: typed `python` ⇄ wire string ────────────────────────
// The catalog stores the `python` of a method's draft, and of each published version, as
// the serialized `[{ name, content }]` string; the public `MethodData`, `MethodVersion`,
// `MethodWriteInput` and `MethodDraftInput` type it as `MethodFile[]`. These wire shapes +
// converters are the one place the SDK (de)serializes it, via `mthds/protocol`'s canonical
// `parseMethodFiles`/`serializeMethodFiles`.

/** A model carrying stored sources, as it travels on the wire: `python` is the catalog string. */
type WithWirePython<T extends { python?: MethodFile[] }> = Omit<T, "python"> & { python?: string };
/** `MethodData` as it travels on the wire. */
type MethodDataWire = WithWirePython<MethodData>;
/** `MethodVersion` as it travels on the wire. */
type MethodVersionWire = WithWirePython<MethodVersion>;

/**
 * Parse a wire model's `python` into the public shape (`MethodFile[]`). A stored `python` that
 * is not the serialized `[{ name, content }]` list is server data the SDK cannot read, not a
 * caller's argument, so `mthds`'s refusal is handed to `unreadable`, which builds the error to
 * throw from the answer that carried it.
 */
function withParsedPython<T extends { python?: MethodFile[] }>(
  wire: WithWirePython<T>,
  unreadable: (cause: unknown) => Error,
): T {
  const { python, ...rest } = wire;
  if (python == null) return rest as T;
  try {
    return { ...rest, python: parseMethodFiles(python) } as T;
  } catch (err) {
    throw unreadable(err);
  }
}

/**
 * Serialize a write payload for the wire. `python` is three-way: OMITTED stays
 * omitted (preserve server-side); an array — including `[]` — is serialized (`[]`
 * → `""`, the clear sentinel; non-empty → the JSON array). It is never sent as an
 * array on the wire.
 */
function withWirePython<T extends { python?: MethodFile[] }>(input: T): WithWirePython<T> {
  const { python, ...rest } = input;
  return python === undefined ? rest : { ...rest, python: serializeMethodFiles(python) };
}

/**
 * The path of a method route, `methods/{id}`, for a bare catalog id. The method routes address
 * the method itself, never one of its versions, and the platform does not parse a suffix there:
 * `mt_x@3` would be looked up as an id of its own and answer `404 not_found`, which reads as a
 * method that does not exist. So a suffixed id is refused before anything is sent, saying how to
 * read what it names. Stripping it instead would answer the draft for a caller that named a
 * version.
 */
function methodPath(methodId: string): string {
  if (typeof methodId === "string" && methodId.includes("@")) {
    throw new RequestArgumentError(
      `"${methodId}" carries a version suffix, and the method routes take a bare catalog id: ` +
        "they address the method itself, never one of its versions. Strip the suffix with " +
        "parseMethodSelector, and read a published version with getMethodVersion.",
    );
  }
  return `methods/${encodeURIComponent(methodId)}`;
}

export class PipelexApiClient implements MTHDSProtocol<DictPipeOutput> {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Origin root derived from the base URL — `/health` lives here, not under `/v1`. */
  private readonly originUrl: string;
  /** Cached `/v1/version` handshake outcome — whether the durable lifecycle is served. */
  private lifecycleAvailable: boolean | undefined;
  /**
   * The `User-Agent` sent on every API request, computed once at construction;
   * `undefined` in a browser, where no header may be set.
   */
  private readonly userAgent: string | undefined;

  constructor(options: PipelexApiClientOptions = {}) {
    // First, so an invalid `appInfo` is refused before anything else is resolved.
    this.userAgent = buildUserAgent(options.appInfo);
    this.apiKey = options.apiKey ?? process.env.PIPELEX_API_KEY;
    const normalizedBaseUrl = (
      options.baseUrl ??
      process.env.PIPELEX_BASE_URL ??
      DEFAULT_API_BASE_URL
    ).replace(/\/+$/, "");
    // The base URL must be host-only: direct SDK usage and PIPELEX_BASE_URL reach
    // this constructor and must be held to that rule, or a path-prefixed value
    // (e.g. `.../v1`) composes as `/v1/v1/...` and fails with a misleading
    // endpoint error instead of a clear base-URL one. Trailing slashes are
    // stripped first; a remaining path/query/fragment/credentials is rejected. The
    // refusal is `config`: the value typically comes from PIPELEX_BASE_URL, the environment.
    // It never quotes the value whole: what the rule refuses is where a secret travels
    // (a password, a token in a query), so it names those parts without their text.
    if (!isValidBaseUrl(normalizedBaseUrl)) {
      throw new RequestArgumentError(
        `Invalid API base URL ${describeRefusedBaseUrl(normalizedBaseUrl)}: it must be host-only ` +
          `(http/https, no path, query, fragment, or credentials). Endpoints ` +
          `compose as {base}/v1/{endpoint}.`,
        { verdict: { errorDomain: "config", retryable: false } },
      );
    }
    this.baseUrl = normalizedBaseUrl;
    this.originUrl = new URL("/", this.baseUrl).origin;
  }

  // ── URL resolution ───────────────────────────────────────────────────

  /** Build an API URL: `<base>/v1/<endpoint>`. */
  private url(endpoint: string): string {
    return `${this.baseUrl}/${API_PREFIX}/${endpoint.replace(/^\/+/, "")}`;
  }

  // ── Transport ──────────────────────────────────────────────────────

  /**
   * The headers of every request to the API — the one place they are built, so
   * no request path can miss the `User-Agent` or the bearer. Requests to third
   * parties (presigned object-store URLs) never go through here.
   */
  private requestHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.userAgent !== undefined) {
      headers["User-Agent"] = this.userAgent;
    }
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Issue one HTTP request and return the raw status/headers/body. Wraps
   * DNS/connect/TLS/timeout failures as `ApiUnreachableError`; a caller-driven
   * abort (Ctrl-C / agent walk-away) propagates as-is so the poll loop can stop
   * cleanly. Non-2xx interpretation is left to the caller. `url` is a fully
   * resolved absolute URL.
   */
  private async requestRaw(
    method: HttpMethod,
    url: string,
    options: {
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<RawResponse> {
    const hasBody = options.body !== undefined;
    const headers = this.requestHeaders(hasBody);

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // A longer delay overflows the timer, which then fires at once as a false timeout.
    if (!isTimerDelay(timeoutMs)) {
      throw new RangeError(
        `"timeoutMs" must be a positive number no larger than ${MAX_TIMER_DELAY_MS}, got ` +
          `${String(timeoutMs)}.`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
      timeoutMs,
    );
    const userSignal = options.signal;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }

    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      // The body streams after the headers; keep the timer/abort armed until it
      // has fully arrived, or a stalled body would hang past the advertised
      // timeout with no way to cancel.
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      // A caller-initiated abort (not our timeout) propagates untouched so
      // `waitForResult` callers can distinguish "I stopped waiting" from a
      // network failure. It is the signal's reason rather than `err`: a browser
      // errors a body stream cut short by an abort with a generic AbortError.
      if (userSignal?.aborted) throw userSignal.reason;
      // undici (Node fetch) wraps DNS/connect/TLS failures as
      // `TypeError("fetch failed")` with the system error attached as `cause`.
      // Our timeout aborts the controller with a "TimeoutError" DOMException, which
      // is classified from the controller rather than from `err`: a browser errors a
      // body stream cut short by that abort with a generic AbortError instead.
      const code = extractNetworkErrorCode(
        controller.signal.aborted ? controller.signal.reason : err,
      );
      throw new ApiUnreachableError(
        `Could not reach Pipelex API at ${this.baseUrl} (${code ?? "network error"})`,
        this.baseUrl,
        code,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
    }

    let body: string;
    let utf8 = true;
    try {
      body = STRICT_UTF8.decode(bytes);
    } catch {
      utf8 = false;
      body = LENIENT_UTF8.decode(bytes);
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
      utf8,
    };
  }

  /**
   * Issue a Pipelex-product request (`/v1/me`, `/v1/methods`, `/v1/billing/*`,
   * …) and parse its JSON body, mapping a non-2xx response to the typed
   * `ApiResponseError` so callers branch on its `errorDomain` and `type`, not the
   * HTTP status. Empty-body tolerant — DELETE / onboarding / updateRun
   * answer 2xx with no body, returned as `undefined`. Uses the management-call
   * timeout, not the blocking-execute ceiling.
   */
  private async requestProduct<T>(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.requestProductAnswer(method, endpoint, body, options);
    return (res.body ? this.readAnswer<T>(method, endpoint, res) : undefined) as T;
  }

  /**
   * A product request whose answer is an object the SDK or its caller reads before anything else
   * — a bulk resolution's `items`, a run record's `error`, an upload grant's `url`. Unlike
   * `requestProduct`, an empty
   * 2xx is no answer here: it and a body that is not a JSON object throw the `ApiResponseError`
   * of an answer the SDK cannot read (see `readObjectAnswerAt`).
   */
  private async requestProductObject<T extends object>(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.requestProductAnswer(method, endpoint, body, options);
    return this.readObjectAnswer<T>(method, endpoint, res);
  }

  /**
   * A methods-catalog route answering one stored method (`getMethod`, `createMethod`,
   * `writeDraft`, `renameMethod`), parsed into the public shape by `readStoredSources`.
   */
  private async requestMethodData(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
  ): Promise<MethodData> {
    const res = await this.requestProductAnswer(method, endpoint, body);
    const wire = this.readObjectAnswer<MethodDataWire>(method, endpoint, res);
    return this.readStoredSources<MethodData>(method, endpoint, res, wire, "a stored method");
  }

  /**
   * The stored sources of a method or of a published version, read from the answer `res`
   * carried, into the public shape. A stored `mthds` that is neither a string nor absent (`null`
   * stays "no source", which `getMethodClosure` reports), and a stored `python` the SDK cannot
   * parse, are an answer it cannot read, so each throws an `ApiResponseError` built from that
   * answer, the latter with `mthds`'s refusal as `cause`: `runtime`, not retryable, since no
   * change to the call fixes it. `subject` names what carried them in the message.
   */
  private readStoredSources<T extends { python?: MethodFile[] }>(
    method: HttpMethod,
    endpoint: string,
    res: RawResponse,
    wire: WithWirePython<T>,
    subject: string,
  ): T {
    const source: unknown = (wire as { mthds?: unknown }).mthds;
    if (source != null && typeof source !== "string") {
      throw this.unreadableAnswer(
        method,
        `/${API_PREFIX}/${endpoint}`,
        res,
        `${subject} whose \`mthds\` field is not a string`,
      );
    }
    return withParsedPython<T>(wire, (cause) =>
      this.unreadableAnswer(
        method,
        `/${API_PREFIX}/${endpoint}`,
        res,
        `${subject} whose \`python\` field could not be read`,
        cause,
      ),
    );
  }

  /**
   * One page of a cursor-paged product route (`listMethods`, `listMethodVersions`, `listRuns`),
   * read as the platform always serializes it: `items` an array, `next_cursor` a string or
   * `null`. A page breaking either is an answer the SDK cannot read, so it throws the
   * `ApiResponseError` `unreadableAnswer` builds, `runtime` and not retryable, rather than
   * handing the iterators a page they cannot walk: `items` that is not iterable, or a missing
   * cursor that is neither the end nor a next page, which `iterateRuns` would follow forever.
   */
  private async requestPage<T>(
    endpoint: string,
  ): Promise<{ items: T[]; nextCursor: string | null }> {
    const res = await this.requestProductAnswer("GET", endpoint, undefined);
    const page = this.readObjectAnswer<Record<string, unknown>>("GET", endpoint, res);
    const { items, next_cursor: nextCursor } = page;
    if (!Array.isArray(items)) {
      throw this.unreadableAnswer(
        "GET",
        `/${API_PREFIX}/${endpoint}`,
        res,
        "a page whose `items` is not an array",
      );
    }
    if (nextCursor !== null && typeof nextCursor !== "string") {
      throw this.unreadableAnswer(
        "GET",
        `/${API_PREFIX}/${endpoint}`,
        res,
        "a page whose `next_cursor` is neither a string nor null",
      );
    }
    return { items: items as T[], nextCursor };
  }

  /** Issue a product request and return its 2xx answer, a non-2xx thrown as `ApiResponseError`. */
  private async requestProductAnswer(
    method: HttpMethod,
    endpoint: string,
    body: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<RawResponse> {
    const res = await this.requestRaw(method, this.url(endpoint), {
      body,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError(method, endpoint, res);
    }
    return res;
  }

  private throwApiResponseError(method: HttpMethod, endpoint: string, res: RawResponse): never {
    this.throwApiResponseErrorAt(method, `/${API_PREFIX}/${endpoint}`, res);
  }

  /** The JSON body of a `/v1` route's 2xx answer; see `readAnswerAt`. */
  private readAnswer<T>(method: HttpMethod, endpoint: string, res: RawResponse): T {
    return this.readAnswerAt<T>(method, `/${API_PREFIX}/${endpoint}`, res);
  }

  /** The JSON object body of a `/v1` route's 2xx answer; see `readObjectAnswerAt`. */
  private readObjectAnswer<T extends object>(
    method: HttpMethod,
    endpoint: string,
    res: RawResponse,
  ): T {
    return this.readObjectAnswerAt<T>(method, `/${API_PREFIX}/${endpoint}`, res);
  }

  /**
   * The JSON body of a 2xx answer, naming the route by its `path` from the origin as a refusal
   * does. A body that is not UTF-8, or not JSON, an empty one included, is an answer the SDK
   * cannot read, so it throws the `ApiResponseError` `unreadableAnswer` builds, with the parse
   * failure as `cause`.
   * The one place a success body is parsed.
   */
  private readAnswerAt<T>(method: HttpMethod, path: string, res: RawResponse): T {
    if (!res.utf8) throw this.unreadableAnswer(method, path, res, "a body that is not UTF-8");
    try {
      return JSON.parse(res.body) as T;
    } catch (err) {
      throw this.unreadableAnswer(
        method,
        path,
        res,
        res.body ? "a body that is not JSON" : "an empty body where JSON was expected",
        err,
      );
    }
  }

  /**
   * The JSON body of a 2xx answer from a route that answers an object, read as `readAnswerAt`
   * reads it. A body that is JSON but not an object — `null`, a number, a string, an array — is
   * an answer the SDK cannot read either, and throws the same `ApiResponseError`, with no `cause`.
   */
  private readObjectAnswerAt<T extends object>(
    method: HttpMethod,
    path: string,
    res: RawResponse,
  ): T {
    const answer = this.readAnswerAt<unknown>(method, path, res);
    if (!isPlainObject(answer)) {
      throw this.unreadableAnswer(method, path, res, "a body that is not an object");
    }
    return answer as T;
  }

  /**
   * The `ApiResponseError` of a 2xx answer the SDK cannot read, its message
   * `API <method> <path> answered <status> with <what>`: the answer's status, its raw text as
   * `responseBody`, no problem member but the `X-Request-ID` header, the failure that made it
   * unreadable as `cause`, and the verdict the fallback gives a 2xx, `runtime` and not retryable.
   */
  private unreadableAnswer(
    method: HttpMethod,
    path: string,
    res: RawResponse,
    what: string,
    cause?: unknown,
  ): ApiResponseError {
    return new ApiResponseError(
      `API ${method} ${path} answered ${res.status} with ${what}`,
      this.baseUrl,
      res.status,
      res.statusText,
      res.body,
      undefined,
      undefined,
      undefined,
      undefined,
      { cause, problem: { requestId: nonEmptyHeader(res.headers, REQUEST_ID_HEADER) } },
    );
  }

  /**
   * Throw the `ApiResponseError` of a non-2xx answer, naming the route by its `path` from the
   * origin (`/v1/...`, or `/health` for the liveness probe).
   */
  private throwApiResponseErrorAt(method: HttpMethod, path: string, res: RawResponse): never {
    const { errorType, serverMessage, validationErrors, code, problem, document } = parseErrorBody(
      res.body,
    );
    // The body's `request_id` wins; the header is the fallback for a response whose body
    // carries none (a gateway error page, a non-problem body).
    const requestId = problem.requestId ?? nonEmptyHeader(res.headers, REQUEST_ID_HEADER);
    throw new ApiResponseError(
      `API ${method} ${path} failed (${res.status}): ${serverMessage ?? (res.body || res.statusText)}`,
      this.baseUrl,
      res.status,
      res.statusText,
      res.body,
      errorType,
      serverMessage,
      validationErrors,
      code,
      { problem: { ...problem, requestId }, problemDocument: document },
    );
  }

  /**
   * Translate a "route absent" 404 (a bare pipelex-api with no platform block)
   * into a clear `RunLifecycleUnavailableError`. The platform's own 404s (run
   * not found / cross-org) carry a structured error envelope (a `code` field)
   * and are left for normal handling.
   */
  private throwIfLifecycleUnavailable(res: RawResponse, url: string): void {
    if (res.status !== 404) return;
    if (!isMissingRoute404(res.body)) return;
    throw new RunLifecycleUnavailableError(
      `The durable run lifecycle is not available: ${url} returned 404. Run polling is a ` +
        `hosted-API extension (/${API_PREFIX}/${RUNS}/*), not part of the MTHDS Protocol; ` +
        "PIPELEX_BASE_URL points at a bare runner that does not serve it.",
      this.baseUrl,
    );
  }

  /**
   * Map the protocol's optional 202 execute degrade to a typed
   * error. Hosted does not emit 202 today, but the protocol permits it;
   * raising a typed error (with the `pipeline_run_id` + `Location` + `Retry-After`
   * hints) beats a generic parse failure on an unexpected body shape.
   */
  private throwIfExecuteDegraded(res: RawResponse): void {
    if (res.status !== 202) return;
    let runId = "";
    try {
      const parsed: unknown = JSON.parse(res.body);
      if (parsed && typeof parsed === "object") {
        const candidate = (parsed as { pipeline_run_id?: unknown }).pipeline_run_id;
        if (typeof candidate === "string") runId = candidate;
      }
    } catch {
      // Non-JSON 202 body — keep runId empty; the error message covers it.
    }
    throw new RunStillRunningError(
      `execute() was accepted asynchronously (202): run ${runId || "<unknown>"} is still ` +
        "running server-side. Poll its results (hosted) or use start().",
      runId,
      parseRetryAfter(res.headers),
      res.headers.get("location"),
    );
  }

  // ── Health ────────────────────────────────────────────────────────

  /**
   * The origin-level liveness probe — `GET /health`, which sits at the origin, NOT under the
   * `/v1` prefix. A bare runner serves it; a hosted origin answers `/v1/health` instead, so
   * there this throws.
   *
   * It goes through the same transport as every route: an unreachable origin is an
   * `ApiUnreachableError`, and a non-2xx answer an `ApiResponseError` whose verdict the SDK's
   * fallback reads from the status, since the probe answers no problem document. So is a 2xx
   * whose body is not a JSON object, such as a gateway's HTML page: `runtime`, not retryable.
   */
  async health(): Promise<Record<string, unknown>> {
    const res = await this.requestRaw("GET", `${this.originUrl}/health`, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseErrorAt("GET", "/health", res);
    }
    return this.readObjectAnswerAt<Record<string, unknown>>("GET", "/health", res);
  }

  // ── Protocol surface ─────────────────────────────────────────────────

  /**
   * Execute a method synchronously and wait for its completion —
   * `POST /v1/execute`.
   *
   * Returns a `PipelexExecuteResult` — the protocol's raw execute response enriched with a
   * resolved `.main_stuff` accessor, so a blocking result reads its output the same way as a
   * durable one (`result.main_stuff`) instead of digging through `pipe_output`.
   *
   * Behind the hosted gateway, synchronous requests terminate at ~30s; a run
   * that exceeds that surfaces as `PipelineExecuteTimeoutError` pointing at the
   * durable start+poll path. Throws `RunStillRunningError` on the protocol's
   * optional 202 degrade.
   */
  async execute(options: PipelexRunOptions): Promise<PipelexExecuteResult> {
    const extensions = buildExtensions(options.extra);
    const api = buildApiRunExtensions(options);
    const hosted = buildHostedRunExtensions(options);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(api).length === 0 &&
      Object.keys(hosted).length === 0 &&
      Object.keys(extensions).length === 0
    ) {
      throw new RequestArgumentError(
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64), a method_ref, a hosted method_id or a server-specific extension arg (extra) must be provided to execute().",
      );
    }
    assertRunSourcesExclusive(options);
    assertMethodRefPairsWithNothing(options);

    const request: RunRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref,
      files: nonEmptyFiles(options.files),
      bundle_b64: nonEmptyString(options.bundle_b64),
      ...api,
      ...hosted,
      ...extensions,
    };

    const startedAt = Date.now();
    try {
      const res = await this.requestRaw("POST", this.url("execute"), {
        body: request,
      });
      this.throwIfExecuteDegraded(res);
      if (res.status < 200 || res.status >= 300) {
        this.throwApiResponseError("POST", "execute", res);
      }
      // Wrap the base result in the enriched subtype (adds the `.main_stuff` accessor; the
      // `main_stuff_name` extension + working memory ride `pipe_output`).
      return new PipelexExecuteResult(
        this.readObjectAnswer<DictRunResultExecute>("POST", "execute", res),
      );
    } catch (err) {
      if (err instanceof RunStillRunningError) throw err;
      // The hosted gateway terminates synchronous requests at ~30s. A run that
      // exceeds that comes back as a gateway 503/504 (or a client abort) —
      // translate it into a clear, actionable error pointing at start+poll.
      const elapsedMs = Date.now() - startedAt;
      if (isGatewayTimeout(err, elapsedMs)) {
        throw new PipelineExecuteTimeoutError(elapsedMs, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Start a method asynchronously — `POST /v1/start` (202, no output yet).
   *
   * The `method_ref` address and the hosted `method_id` are named options (see
   * `PipelexApiRunExtensions` / `PipelexHostedRunExtensions`); `options.extra`
   * stays the generic passthrough for extension args this client does not know
   * about — the server you call defines and handles them (including a
   * client-supplied run id where a server supports one). The returned
   * `pipeline_run_id` is always authoritative; on a hosted deployment it is
   * durable — poll `getRunStatus` / `getRunResult`. A `method_ref` run's ack
   * additionally carries `method_provenance` — the address, the tag, and the
   * commit SHA that was actually fetched.
   */
  async start(options: PipelexStartOptions): Promise<PipelexRunResultStart> {
    const extensions = buildExtensions(options.extra);
    const api = buildApiRunExtensions(options);
    const hosted = buildHostedRunExtensions(options);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(api).length === 0 &&
      Object.keys(hosted).length === 0 &&
      Object.keys(extensions).length === 0
    ) {
      throw new RequestArgumentError(
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64), a method_ref, a hosted method_id or a server-specific extension arg (extra) must be provided to start().",
      );
    }
    assertRunSourcesExclusive(options);
    assertMethodRefPairsWithNothing(options);

    // `?? undefined` so JSON.stringify drops absent fields from the wire body.
    const request: StartRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
      files: nonEmptyFiles(options.files),
      bundle_b64: nonEmptyString(options.bundle_b64),
      ...api,
      ...hosted,
      ...extensions,
    };

    const url = this.url("start");
    // `start` returns a 202 fast, so the poll timeout normally fits — with
    // exceptions that get the blocking-execute ceiling instead. A method bundle,
    // inline as `mthds_contents` or in `files`/`bundle_b64`, can make the
    // request *body* multi-megabyte, and the whole upload is
    // charged against this budget — the same payload must not time out on the
    // durable path yet succeed on the fallback. And a `method_ref` start makes
    // the server FETCH the package before the ack (provenance rides the 202),
    // whose clone timeout runs well past 30s on a cold cache — aborting it here
    // would surface as `ApiUnreachableError`, blaming the network for a healthy
    // server that is still cloning.
    const needsLongCeiling =
      hasBundlePayload(options) ||
      (options.mthds_contents?.length ?? 0) > 0 ||
      nonEmptyString(options.method_ref) !== undefined;
    const res = await this.requestRaw("POST", url, {
      body: request,
      timeoutMs: needsLongCeiling ? DEFAULT_REQUEST_TIMEOUT_MS : POLL_REQUEST_TIMEOUT_MS,
    });
    // A bare runner with no run store 404s here just as it does on the result
    // routes — surface the same clear `RunLifecycleUnavailableError` (and let
    // `startAndWaitForResult` fall back to the blocking `execute`).
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "start", res);
    }
    return this.readObjectAnswer<PipelexRunResultStart>("POST", "start", res);
  }

  /**
   * Parse, validate, and dry-run an MTHDS bundle — `POST /v1/validate`.
   *
   * `/validate` is a diagnostic endpoint: every produced verdict rides a **200**,
   * discriminated on `is_valid`. This returns the `PipelexValidationResult` union
   * verbatim — `is_valid: true` ⇒ the typed `PipelexValidationReport` (structural
   * artifacts), `is_valid: false` ⇒ a `PipelexInvalidReport` (`validation_errors[]`).
   * An invalid bundle is NOT thrown — the caller pattern-matches `is_valid`. Only a
   * *no-verdict* condition (a malformed request, an `mthds_sources` length mismatch,
   * auth, a server fault) is non-2xx and surfaces as `ApiResponseError`.
   *
   * `source` selects WHAT is validated, in exactly one of three forms — the
   * strict tooling XOR (the routes are stateless, so there is no linkage
   * exception; a second selector is a request-shape `422`):
   *
   * - **inline contents** (a `string[]`) — the protocol's own envelope;
   * - **`{ method_ref }`** — a published method's address, resolved by the
   *   server (pipelex-api >= 0.21.0) through the same fetch path as a
   *   `method_ref` run, the package's real file names feeding the diagnostics'
   *   source labels;
   * - **`{ method_id }`** — a stored method's catalog id, hosted-only: the
   *   platform resolves it and injects the stored source before the runner sees
   *   the request (a bare runner rejects the request as carrying no source it
   *   understands).
   *
   * A selector-resolution failure (fetch failure, no package at the address, an
   * unknown or foreign-org id) is a non-2xx `ApiResponseError` — never an
   * `is_valid: false` verdict, which is reserved for actual MTHDS content.
   *
   * `mthdsSources` (optional, parallel to inline contents) names each submitted
   * content — a Pipelex-API extension threaded onto `blueprint.source`, so
   * cross-file diagnostics name the owning file (an unnamed content yields
   * `source: null`). The server 422s a length mismatch; this client sends the
   * arrays verbatim and surfaces that as an `ApiResponseError`. It is an
   * inline-contents companion only: a `method_ref` / `method_id` validation gets
   * its source labels from the package's (or the stored method's) real file
   * names, so supplying it beside a selector is rejected client-side.
   *
   * `render` is the Pipelex-API presentation hint — a list of view-format tokens.
   * This client always asks for Markdown so both valid results and produced
   * validation-error verdicts carry `rendered_markdown`; callers may add more
   * tokens. Unknown tokens are server-side lenient-ignored (never a 422).
   *
   * `views` is the sibling opt-in for *structured* views where `render` carries
   * *rendered text*. The two lists are independent, each resolving its own tokens
   * against its own supported set, and each supported token adds a same-named
   * top-level field to the valid arm — `input_form` and `output_form`. Unlike `render`,
   * this client sends `views` ONLY when the caller asks: the point of an opt-in view
   * is that the default response stays byte-identical, and the highest-frequency
   * consumers (hook pipelines, CI gates, agent loops) never pay for bytes they
   * discard. `pipelex-api` gates `input_form` on this token as of 0.18.0; a 0.17.0
   * runner resolved no token (the key is silently ignored, never a 422) and emitted
   * the field regardless — which is why `PipelexValidationReport.input_form` is typed
   * optional rather than required.
   *
   * A `{ method_ref }` source makes the server clone a repository before it
   * validates anything, and it needs no special budget here: this route already
   * defaults to the 20-minute execute ceiling, which clears the internal
   * fetch-sized budget (`METHOD_REF_FETCH_TIMEOUT_MS`, three minutes) that
   * `crateRequestTimeoutMs` gives the crate routes several times over. That budget
   * exists to RAISE routes whose default is the ~30s poll ceiling; applying it here
   * would lower this one.
   */
  async validate(
    source: string[] | ValidateMethodSelector,
    allowSignatures = false,
    mthdsSources?: string[],
    render?: string[],
    views?: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PipelexValidationResult> {
    const body: Record<string, unknown> = {
      allow_signatures: allowSignatures,
    };
    if (Array.isArray(source)) {
      body.mthds_contents = source;
      if (mthdsSources !== undefined) {
        body.mthds_sources = mthdsSources;
      }
    } else {
      // A selector object. The illegal shapes are compile errors for typed
      // callers (`ValidateMethodSelector` pins the other key to `never`); the
      // runtime checks back them for untyped (JS) callers — a typed
      // `RequestArgumentError`, never a native TypeError off a null source —
      // mirroring the server's strict tooling XOR instead of silently picking.
      if (source === null || source === undefined || typeof source !== "object") {
        throw new RequestArgumentError(
          "validate() takes inline contents (a string[]) or a method selector object " +
            "({ method_ref } or { method_id }).",
        );
      }
      const methodRef = nonEmptyString(source.method_ref);
      const methodId = nonEmptyString(source.method_id);
      if ((methodRef === undefined) === (methodId === undefined)) {
        throw new RequestArgumentError(
          "validate() takes exactly one method selector: inline contents, { method_ref }, or { method_id }.",
        );
      }
      if (mthdsSources !== undefined) {
        throw new RequestArgumentError(
          "mthds_sources labels inline mthds_contents; a method_ref / method_id validation gets " +
            "its source labels from the package's (or the stored method's) real file names.",
        );
      }
      if (methodRef !== undefined) body.method_ref = methodRef;
      if (methodId !== undefined) body.method_id = methodId;
    }
    body.render = withValidateMarkdownRender(render);
    if (views !== undefined) {
      body.views = views;
    }
    const res = await this.requestRaw("POST", this.url("validate"), {
      body,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "validate", res);
    }
    return this.readObjectAnswer<PipelexValidationResult>("POST", "validate", res);
  }

  /**
   * Validate paired MTHDS files while preserving URI attribution for diagnostics.
   *
   * This adapter intentionally keeps the low-level `validate(...)` payload shape
   * intact for existing consumers. When any file has a URI, every content gets a
   * parallel source label; inline labels are deterministic so the server never
   * sees a length-mismatched `mthds_sources` array.
   */
  async validateFiles(
    files: MthdsFile[],
    options: ValidateFilesOptions = {},
  ): Promise<PipelexValidationResult> {
    if (files.length === 0) {
      throw new RequestArgumentError(
        "At least one MTHDS file must be provided to validateFiles().",
      );
    }

    const mthdsContents = files.map((file) => file.content);
    const hasAnyUri = files.some((file) => file.uri !== undefined);
    const mthdsSources = hasAnyUri
      ? files.map((file, index) => file.uri ?? `inline://file-${index + 1}.mthds`)
      : undefined;

    return this.validate(
      mthdsContents,
      options.allowSignatures ?? false,
      mthdsSources,
      options.render,
      options.views,
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
    );
  }

  // ── Tools extensions (Pipelex API — `/v1/lint`, `/v1/format`) ─────────
  //
  // NOT REACHABLE ON ANY HOSTED ENVIRONMENT. Both are served by any `pipelex-api`
  // runner, but neither the gateway's API-key allowlist nor the platform's tooling
  // proxy lists them, so every `*.pipelex.com` origin answers a gateway
  // `403 {"message":"Forbidden"}` — refused before any service sees the request.
  // Measured 2026-08-19 and re-measured 2026-08-23 on prod AND api-dev: on the same
  // origin, with the same key, `validate` succeeds while these two 403.
  //
  // That blocks nothing, because lint and format are toolchain capabilities rather
  // than hosted ones: `plxt` carries both, and the post-edit hook this repo builds
  // (`npm run build:hook`) runs them offline through `@pipelex/tools-wasm` with no
  // credentials (see `src/hooks/claude-mthds-check.ts`), with these two methods as the
  // published package's documented fallback against a runner. The crate
  // routes (`resolve`/`codegen`) shared this gap and are now exposed everywhere;
  // these two were not included, a known non-critical item on the platform's list.
  // Tracked in L-260929-b58f26.

  /**
   * Lint one `.mthds` file against the embedded MTHDS schema — `POST /v1/lint`.
   *
   * A diagnostic endpoint, like `validate`: malformed content is a produced verdict
   * on a 200 carrying `diagnostics[]` (empty when the file is clean), never a thrown
   * error. Only a no-verdict condition (a malformed request, auth, a server fault) is
   * non-2xx and surfaces as `ApiResponseError`.
   *
   * `source` is an optional logical filename accepted for parity with the local
   * tooling; today's diagnostics do not echo it back.
   *
   * Unlike `validate`, this is a static single-file check — no bundle load, no
   * dry-run, no cross-file resolution. Use `validate` for the full verdict.
   */
  async lint(content: string, source?: string): Promise<LintResponse> {
    const body: Record<string, unknown> = { content };
    if (source !== undefined) {
      body.source = source;
    }
    return this.requestExtension("lint", body);
  }

  /**
   * Format one `.mthds` file with the canonical MTHDS formatter — `POST /v1/format`.
   *
   * Returns the formatted content, a `changed` flag, and any `diagnostics[]`. A syntax
   * error is a produced verdict on a 200: the content comes back unchanged
   * (`changed: false`) with the diagnostics that explain why. Malformed formatter
   * `options` (e.g. a non-numeric `column_width`) ARE caller input errors and surface as
   * a 422 `ApiResponseError`.
   *
   * `options` passes formatter settings (e.g. `{ column_width: 100 }`) straight through
   * to the server-side formatter.
   */
  async format(content: string, options?: Record<string, unknown>): Promise<FormatResponse> {
    const body: Record<string, unknown> = { content };
    if (options !== undefined) {
      body.options = options;
    }
    return this.requestExtension("format", body);
  }

  /**
   * POST one of the Pipelex-API extension routes — the tools (`lint`, `format`) and the
   * crate routes (`resolve`, `codegen`, `pipe-io`). Their non-2xx bodies are RFC 7807
   * problems, mapped to the typed `ApiResponseError` like the product routes.
   *
   * The mapping is what makes their no-verdict arms usable: a crate route answers `422`
   * for a request it cannot act on (a pipe selection `pipe-io` refuses; an unknown
   * `kind`/`target`, or a `pipe_ref` on the concept-set-wide `types` kind, on `codegen`)
   * and `501` for the reserved registry-form `method_ref` (the address form is resolved
   * server-side as of pipelex-api 0.21.0). A caller branches on `ApiResponseError.status`,
   * never on a message.
   *
   * All of these are static and inference-free, so they default to the management-call
   * timeout. The one internal raise is the fetch-sized budget `crateRequestTimeoutMs`
   * gives a crate route whose closure is a `method_ref`, because the server may clone a
   * repository before it answers; it is matched to what the server does, not a
   * caller-facing parameter.
   *
   * **These routes deliberately expose no `timeoutMs` / `signal`, and that is not an
   * oversight to be "fixed" per route.** Automated reviewers have proposed adding them
   * to whichever route was newest more than once; the reasons they are absent are:
   *
   * 1. None of them runs a **dry-run sweep**, which is what makes a route legitimately
   *    slow. The sweeping route is `validate`, which already sits on the execute
   *    ceiling and takes caller transport options; every extension route rides the
   *    static core. Giving one static route an override while its siblings lack one is
   *    the inconsistency.
   * 2. The input is **bounded server-side** — the runner's `pipelex_api/limits.py` caps a request
   *    at 16 `.mthds` files of 1 MiB each — and none of these routes runs inference.
   * 3. On the hosted path an override would be **inert**: the gateway caps responses at
   *    ~30s (see `POLL_REQUEST_TIMEOUT_MS` above), so raising `timeoutMs` would still be
   *    cut off upstream, just with a less honest error.
   *
   * If a static route ever genuinely needs longer, give the WHOLE static family one
   * uniform transport-options parameter in a single pass — do not bolt it onto one
   * route.
   */
  private async requestExtension<T extends object>(
    endpoint: string,
    body: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const res = await this.requestRaw("POST", this.url(endpoint), {
      body,
      timeoutMs: options.timeoutMs ?? POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", endpoint, res);
    }
    return this.readObjectAnswer<T>("POST", endpoint, res);
  }

  /** The model deck the runner can route to — `GET /v1/models[?type=]`. */
  async models(category?: ModelCategory): Promise<ModelDeck> {
    const endpoint = category ? `models?type=${encodeURIComponent(category)}` : "models";
    const res = await this.requestRaw("GET", this.url(endpoint), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    return this.readObjectAnswer<ModelDeck>("GET", endpoint, res);
  }

  /**
   * Protocol + implementation versions — `GET /v1/version` (always public).
   * The handshake for feature detection (hosted extensions or not).
   */
  async version(): Promise<VersionInfo> {
    const res = await this.requestRaw("GET", this.url("version"), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", "version", res);
    }
    return this.readObjectAnswer<VersionInfo>("GET", "version", res);
  }

  // ── Crate extensions (Pipelex API — `/v1/resolve`, `/v1/codegen`, `/v1/pipe-io`) ──
  //
  // Served by any `pipelex-api` runner AND on every hosted origin. On the hosted
  // plane a route is reachable only when the gateway's API-key allowlist and the
  // platform's tooling proxy both list it — they each enumerate routes explicitly
  // (`validate`, `models`, …), and an unlisted path answers a gateway
  // `403 {"message":"Forbidden"}`, refused before any service sees it, so not even
  // an RFC 7807 problem body. Both list `resolve` and `codegen`.
  //
  // Measured 2026-08-23 with a real key: api.pipelex.com (pipelex-hosted@0.10.1)
  // serves both, verdict discipline intact (200 `is_valid:false`, 501, 422);
  // api-dev.pipelex.com has since 2026-08-13. `lint`/`format` are the two still
  // unexposed — see their section above for why that blocks nothing. `pipe-io` is
  // newer: a runner serves it from `pipelex-api` v0.33.0, and types its selection
  // refusals `EntryPipeNotFoundError` / `EntryPipeAmbiguousError` from v0.33.1
  // (v0.33.0 typed them `ValidationError`), and a hosted origin
  // serves it once the platform's proxy and the gateway list it (see
  // `docs/crate-routes.md`).
  //
  // All three are STATIC routes (no dry-run sweep), so like every static sibling they
  // take no `timeoutMs`/`signal` — see the policy note on `requestExtension` before
  // adding one here.

  /**
   * Resolve a closure into its normalized library crate — `POST /v1/resolve`.
   *
   * Resolution is a first-class language operation alongside validation: the closure is
   * loaded and statically validated, then emitted as the **normalized library crate**
   * (fully qualified refs, refinement flattened, natives materialized, fingerprint set)
   * — the MTHDS standard's Library Crate Format. It runs NO dry-run sweep, so a valid
   * verdict here says the library resolves, never that it runs; that is `validate`'s
   * vocabulary.
   *
   * Returns a **200 verdict**: pattern-match `is_valid` before reading the arm — a
   * closure that does not parse/load/validate comes back as `is_valid: false` with
   * `validation_errors[]`, not as a thrown error. Only a no-verdict condition throws
   * `ApiResponseError`: a malformed selector (none, or more than one, of
   * `files` / `method_ref` / `method_id`) is a 422; a selector-resolution failure
   * (fetch failure, no package at the address, an unknown or foreign-org id) is
   * non-2xx too — never an `is_valid: false` verdict.
   *
   * The closure arrives in exactly one of three forms: inline `files`, an
   * address-form `method_ref` (server-resolved, pipelex-api >= 0.21.0; the
   * registry form stays a `501`), or a hosted `method_id` (platform-resolved —
   * see {@link PipelexHostedToolingExtensions}).
   */
  async resolve(request: ResolveRequest): Promise<ResolveResponse> {
    return this.requestExtension("resolve", request, {
      timeoutMs: crateRequestTimeoutMs(request),
    });
  }

  /**
   * Project a closure's crate into stamped typed artifacts — `POST /v1/codegen`.
   *
   * Resolves the closure exactly like {@link resolve}, then projects the crate through
   * the two explicit axes — `kind` (`types` today) × `target` (`ts-zod` for TypeScript
   * consumers, `python-pydantic`, `python-structures`) — and returns the artifact set
   * plus its `codegen.lock`. Write both verbatim and the tree is byte-identical to a
   * local `pipelex codegen types` run, so the offline `pipelex codegen check` passes on
   * it; the SDK deliberately does not write files for you.
   *
   * Same 200-verdict discipline and same three-form closure selector as
   * {@link resolve}. Only a no-verdict condition throws `ApiResponseError`: an
   * unknown `kind`/`target`, a `pipe_ref` on the concept-set-wide `types` kind, or
   * a malformed selector is a 422; a registry-form `method_ref` is a `501`.
   */
  async codegen(request: CodegenRequest): Promise<CodegenResponse> {
    return this.requestExtension("codegen", request, {
      timeoutMs: crateRequestTimeoutMs(request),
    });
  }

  /**
   * Read a method's three I/O artifacts — `POST /v1/pipe-io`.
   *
   * Resolves the closure exactly like {@link resolve}, selects a pipe, and returns its
   * pipe I/O contracts, input form and output form — the MTHDS standard's artifacts,
   * typed from `mthds/protocol` — beside the resolved `pipe_ref`, the method's own
   * `default_pipe_ref`, and the runnability facts (`pending_signatures`, `is_runnable`).
   * It runs NO dry-run sweep, so it costs one load and one derivation where `validate`
   * dry-runs every pipe; a caller that shows a method, prepares its inputs or generates
   * types for it reads this, and one that needs the dry-run verdict stays on `validate`.
   *
   * Selection: the request's qualified `pipe_ref`, else a fetched package's manifest
   * `main_pipe`, else the closure's single `main_pipe` declaration. `all_pipes: true`
   * describes every pipe instead, and never refuses for want of an entry pipe.
   * `include_files: true` echoes the resolved closure's `.mthds` files as `files`.
   *
   * Same 200-verdict discipline and same three-form closure selector as {@link resolve}
   * (the request is posted verbatim, and the selector XOR is the server's to enforce).
   * Only a no-verdict condition throws `ApiResponseError`: a malformed selector and an
   * over-limit file are `ValidationError` `422`s; a selection the route refuses is a
   * `422` whose `errorType` is `EntryPipeNotFoundError` (an unknown `pipe_ref`, no entry
   * pipe) or `EntryPipeAmbiguousError` (an ambiguous code, several entry pipes), the
   * candidates in its `serverMessage`; a registry-form `method_ref` is a `501`; a pipe
   * whose artifacts cannot be derived is a `500`.
   *
   * A `method_ref` gets the fetch-sized budget, as on the other crate routes. On the
   * hosted API the gateway caps a request at about 30 seconds whatever the client
   * allows, so a cold `method_ref` clone can answer a `502` that a retry clears once the
   * runner has cached the clone.
   */
  async pipeIo(request: PipeIORequest): Promise<PipeIOResponse> {
    return this.requestExtension("pipe-io", request, {
      timeoutMs: crateRequestTimeoutMs(request),
    });
  }

  // ── Hosted extension: durable run lifecycle (NOT part of the protocol) ──

  /**
   * Fetch a run's status by bare id — `GET /v1/runs/{pipeline_run_id}/status`.
   *
   * Self-healing: a finished-but-unrecorded run resolves to its true terminal
   * status on read. `degraded: true` means Temporal was unreachable and
   * `status` is the last-known value; `retry_after_seconds` carries the
   * server's backoff hint when present. A failed run's stored report, `error`,
   * is checked field by field (see `RunErrorReport`). Throws
   * `RunLifecycleUnavailableError` when the lifecycle routes are absent (a bare
   * runner).
   */
  async getRunStatus(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunRead> {
    const endpoint = `${RUNS}/${encodeURIComponent(runId)}/status`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const run = withCheckedReport(this.readObjectAnswer<RunRead>("GET", endpoint, res));
    const retryAfter = parseRetryAfter(res.headers);
    return retryAfter !== null ? { ...run, retry_after_seconds: retryAfter } : run;
  }

  /**
   * Single-shot result lookup — `GET /v1/runs/{pipeline_run_id}/results`.
   * Maps the server's poll semantics to a discriminated union:
   * - HTTP 202 → `running` (with the `Retry-After` hint)
   * - HTTP 200 → `completed` (with the result artifacts)
   * - HTTP 409 → `failed` (terminal non-`COMPLETED`), carrying the problem's `detail` as
   *   `message`, its `run_status` member as `status` (recovered from `detail` on a platform
   *   that predates the member) and its `error` member, the run's stored error report, typed
   *   as `error`
   * - HTTP 503 → `running` (Temporal degraded — retry, never fail a poller)
   *
   * `options.artifacts` narrows the read to the named artifacts, sent as one
   * comma-separated `?artifacts=` parameter: only those are read, and an
   * unselected artifact is absent from the result (`undefined`) while a
   * selected one the run never wrote is `null`. Omitted, every artifact is
   * read. An empty selection or an unknown name throws a `RangeError` before
   * any request. `MissingMainStuffError` is thrown only for a read that asked
   * for `main_stuff` — no selection, or one naming it.
   *
   * Throws `RunLifecycleUnavailableError` when the lifecycle routes are absent
   * (a bare runner).
   */
  async getRunResult(runId: string, options: GetRunResultOptions = {}): Promise<RunResultState> {
    assertArtifactSelection(options.artifacts);
    const base = `${RUNS}/${encodeURIComponent(runId)}/results`;
    // Deduplicated, in the caller's order; the platform reads `a,b` as the set {a, b}. The names
    // are the validated vocabulary above, so they need no escaping and the comma stays literal.
    const endpoint =
      options.artifacts === undefined
        ? base
        : `${base}?artifacts=${[...new Set(options.artifacts)].join(",")}`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });

    if (res.status === 202 || res.status === 503) {
      return {
        state: "running",
        pipeline_run_id: runId,
        retry_after_seconds: parseRetryAfter(res.headers) ?? DEFAULT_DEGRADED_RETRY_SECONDS,
      };
    }
    if (res.status === 409) {
      return runResultFailed(runId, res.body);
    }
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const result = this.readObjectAnswer<RunResults>("GET", endpoint, res);
    if (selectionIncludesMainStuff(options.artifacts) && result.main_stuff == null) {
      throw new MissingMainStuffError(
        `Completed run '${runId}' returned no main stuff — a completed run always delivers a main stuff.`,
        runId,
      );
    }
    return { state: "completed", pipeline_run_id: runId, result };
  }

  /** Poll an already-started run (by id) until it reaches a terminal state. */
  async waitForResult(runId: string, options?: WaitForResultOptions): Promise<RunResults> {
    return pollUntilResult((id, opts) => this.getRunResult(id, opts), runId, options);
  }

  /**
   * Whether the configured server serves the durable run lifecycle, decided
   * via the `GET /v1/version` handshake and cached for the client's lifetime. A
   * bare `pipelex-api` runner has no run store; anything else is assumed hosted.
   * When the handshake gets an answer it cannot read as a version, assume hosted
   * (the SDK default) and let the start call surface the real error.
   *
   * @throws {ApiUnreachableError} The handshake got no answer. Nothing is cached,
   *   so the next call asks again, and no start is sent to a host that did not
   *   answer: sending it would wait a second time for the same silence.
   */
  private async supportsRunLifecycle(): Promise<boolean> {
    if (this.lifecycleAvailable === undefined) {
      try {
        const info = await this.version();
        const impl = info.implementation;
        this.lifecycleAvailable = !(
          typeof impl === "string" && impl === BARE_RUNNER_IMPLEMENTATION
        );
      } catch (error) {
        if (error instanceof ApiUnreachableError) throw error;
        this.lifecycleAvailable = true;
      }
    }
    return this.lifecycleAvailable;
  }

  /**
   * Start a run and wait for its result.
   *
   * - **Hosted** (per the `/v1/version` handshake): durable start + poll, the
   *   path that survives the gateway's ~30s synchronous ceiling.
   * - **Bare runner** (no run store): the blocking `POST /v1/execute`, which
   *   has no gateway cap off-platform and returns the native `pipe_output`.
   *
   * `pollOptions` are the wait's options, plus `onStarted`, called once with the
   * start acknowledgement as soon as the durable run exists, so the caller holds
   * the run's id while it waits; never on the blocking path, which has none to
   * give; and `onStarting`, called right before each request that may create a
   * run, so the caller knows until then that none exists (see
   * `StartAndWaitForResultOptions`).
   *
   * `pollOptions.signal` is also read before the run is created: a caller that aborts while the
   * version handshake is in flight gets its abort, and neither the start nor the blocking execute
   * is sent. Once one of them is sent, the abort stops only the wait.
   */
  async startAndWaitForResult(
    options: PipelexStartOptions,
    pollOptions?: StartAndWaitForResultOptions,
  ): Promise<RunResults> {
    // Before the run starts: a RangeError after it would carry no run id to re-poll by.
    assertWaitOptions(pollOptions);
    const { onStarted, onStarting, ...waitOptions } = pollOptions ?? {};
    const hosted = await this.supportsRunLifecycle();
    // The handshake may have outlasted the caller's patience: an abort that landed during it
    // creates no run.
    throwIfAborted(waitOptions.signal);
    if (hosted) {
      // A runner can look hosted yet lack the durable routes — `implementation`
      // is an extension field, so a compliant bare runner that omits it is
      // misdetected here. Such a runner raises `RunLifecycleUnavailableError`
      // from `start()`, BEFORE any run is created, so falling back to the
      // blocking path cannot double-run. Cache the negative so later calls skip
      // the durable attempt.
      let ack: PipelexRunResultStart;
      try {
        onStarting?.();
        ack = await this.start(options);
      } catch (err) {
        if (!(err instanceof RunLifecycleUnavailableError)) throw err;
        this.lifecycleAvailable = false;
        throwIfAborted(waitOptions.signal);
        onStarting?.();
        return this.executeBlocking(options);
      }
      onStarted?.(ack);
      return this.waitForResult(ack.pipeline_run_id, waitOptions);
    }

    onStarting?.();
    return this.executeBlocking(options);
  }

  // ── Pipelex product surface (hosted management routes) ─────────────────
  //
  // The hosted catalog/account routes the webapp drives. Every one rides the
  // same `{base}/v1/*` surface, `Authorization: Bearer`, org-from-JWT contract
  // as the protocol routes, and maps a non-2xx `problem+json` to a typed
  // `ApiResponseError` (branch on `.errorDomain` and `.type`, not the status).

  /** The authenticated user's profile — `GET /v1/me`. */
  async getMe(): Promise<UserProfile> {
    return this.requestProduct("GET", "me");
  }

  /**
   * One page of the org's method catalog, newest first — `GET /v1/methods`.
   *
   * **This returns a page, not an array.** It used to be
   * `Promise<MethodData[]>` — the whole catalog, every method carrying its full
   * `.mthds` bundle. That response hit DynamoDB's 1 MB page cap at a couple
   * hundred methods and came back TRUNCATED, with no error and no flag, so
   * methods simply disappeared from the UI. Code that rendered that array
   * directly should now either read `page.items` (accepting the first page) or
   * follow the cursor — `iterateMethods` does the latter for you.
   *
   * Rows are `MethodSummary`: no `mthds`, no `python`, no `updated_at`. Reach
   * for `getMethod(id)` when you need a method's source.
   *
   * `q` is applied server-side over the whole catalog, not over the page.
   */
  async listMethods(query: ListMethodsQuery = {}): Promise<MethodPage> {
    const params = new URLSearchParams();
    // `!== undefined`, not truthiness — mirroring `listRuns`. Omission means
    // "the caller did not ask"; an explicit empty string is bad input and the
    // API should say so, rather than being silently dropped into an unfiltered
    // query that returns everything and reads as working.
    if (query.q !== undefined) params.set("q", query.q);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const suffix = params.toString();
    return this.requestPage<MethodSummary>(suffix ? `methods?${suffix}` : "methods");
  }

  /**
   * Every method in the catalog, streamed — follows the cursor for you.
   *
   * ```ts
   * for await (const method of client.iterateMethods()) {
   *   if (isTheOne(method)) break;   // stop whenever you like
   * }
   * ```
   *
   * **Prefer `listMethods`** for anything user-facing: this is O(catalog) by
   * construction and makes as many round trips as the data demands.
   *
   * An iterator rather than a `listAllMethods(): Promise<MethodSummary[]>`, for
   * the same reason `iterateRuns` is one: an all-at-once helper needs a page cap
   * so a misbehaving server cannot spin it forever, and a cap means it returns a
   * TRUNCATED list with no error — precisely the bug paging was introduced to
   * remove. If you truly want an array, `Array.fromAsync` makes that your
   * explicit choice.
   */
  async *iterateMethods(
    query: Omit<ListMethodsQuery, "cursor"> = {},
  ): AsyncGenerator<MethodSummary, void, undefined> {
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page: MethodPage = await this.listMethods({ ...query, cursor });

      // Checked BEFORE yielding: a server handing back the very cursor we sent
      // has not advanced, so this page repeats rows already emitted. Cannot
      // fire on the first request, where `cursor` is undefined.
      if (cursor !== undefined && page.nextCursor === cursor) return;

      for (const method of page.items) yield method;

      // `nextCursor === null` is the NORMAL end of the catalog, and that page
      // is real data, so it has to be emitted before this fires.
      if (page.nextCursor === null) return;

      // An EMPTY page is NOT the end, and treating it as one was a bug. The
      // platform applies `q` as a post-read filter over a bounded number of
      // index pages per request, so a sparse match legitimately returns
      // `{items: [], nextCursor: "…"}` — "nothing matched in the slice I just
      // read, keep going". Returning here dropped every later match silently,
      // which is the exact truncation this pagination work exists to remove.
      // (`iterateRuns` can stop on an empty page because its date bounds are
      // index KEY conditions, so a run page is never empty-with-a-cursor. The
      // difference is the server, not the client.)
      pages += 1;
      if (pages >= MAX_PAGES) {
        // THROW, do not return. A caller that asked for every method and got a
        // partial answer with no error is back to the original bug one layer
        // up; an error is the only honest response to a server that will not
        // finish. Unreachable on real data — see MAX_PAGES.
        throw new PagingNotTerminatingError(
          `listMethods did not terminate after ${MAX_PAGES} pages; refusing to keep paging. ` +
            `This is a server-side fault, not a coverage limit.`,
          MAX_PAGES,
        );
      }
      cursor = page.nextCursor;
    }
  }

  /**
   * Read one method — `GET /v1/methods/{id}`: its identity, its draft (`mthds`, `python`,
   * `input_data`) with the draft's token (`updated_at`) and digest (`draft_digest`), and its
   * latest published version's summary (`latest_version`, `latest_published`), whatever the
   * publish state. A method never published reads with both `null`, never as an error.
   *
   * Takes a bare catalog id: the method routes address the method itself, never a version of
   * it. A caller holding `mt_…@3` strips the suffix with `parseMethodSelector` and reads that
   * version with `getMethodVersion`. Every method route throws `RequestArgumentError` for a
   * suffixed id, before any request, rather than read back the `404` the platform would answer.
   */
  async getMethod(methodId: string): Promise<MethodData> {
    return this.requestMethodData("GET", methodPath(methodId));
  }

  /**
   * Resolve a stored method's id into the runnable MTHDS closure of its DRAFT — a
   * client-side semantic layer over `getMethod` (the platform has no route that
   * returns a parsed closure). Fetches the method, parses its draft's polymorphic
   * `mthds` source with `methodSourceToContents`, and labels each resulting file
   * with the `method_id` as its `source` provenance.
   *
   * **This is the draft, not what a bare id runs.** A run, a validation or a pipe I/O
   * read by a bare `method_id` resolves to the latest PUBLISHED version, which the
   * draft may be ahead of. For the closure of a version, read it with
   * `getMethodVersion` and parse its `mthds` with `methodSourceToContents`.
   *
   * This is the LOCAL expansion utility — for callers that want the files in
   * hand (to edit, to diff, or to send to a bare runner, which has no catalog to
   * resolve an id against). The operations that accept `method_id`
   * natively (`execute`/`start`, `validate`/`resolve`/`codegen`/`pipeIo`, and
   * `prepareInputs`, which composes a `pipeIo` of its own) take the id as a
   * pass-through instead; nothing in this client expands an id behind your back.
   *
   * Takes a bare catalog id, as `getMethod` does. Requires an API key: the methods
   * catalog is org-scoped to the key's org, so an unknown OR foreign-org id is a
   * `getMethod` `404` (`ApiResponseError` `not_found`), which propagates unchanged. A
   * real, in-org method whose draft parses to nothing throws `EmptyMethodSourceError`
   * (distinct from the 404) — the row exists but has no runnable source yet.
   */
  async getMethodClosure(methodId: string): Promise<MthdsFileItem[]> {
    const method = await this.getMethod(methodId);
    const contents = methodSourceToContents(method.mthds);
    if (contents.length === 0) {
      throw new EmptyMethodSourceError(methodId);
    }
    return contents.map((content) => ({ content, source: methodId }));
  }

  /**
   * Create a method — `POST /v1/methods`. The new method holds the input as its draft and has
   * no published version, so its bare id answers `409 method_not_published` on the run and
   * tooling routes until its first `publishMethod`; its draft runs as `mt_…@draft` at once.
   */
  async createMethod(input: MethodWriteInput): Promise<MethodData> {
    return this.requestMethodData("POST", "methods", withWirePython(input));
  }

  /**
   * Replace a method's draft — `PUT /v1/methods/{id}/draft` — and return the method with the
   * draft's new token (`updated_at`) and digest (`draft_digest`).
   *
   * The draft is never validated on write, and writing it changes nothing for the callers of
   * the method's bare id, who run the latest published version until the next `publishMethod`.
   * `python` and `input_data` are three-way (see `MethodDraftInput`). With
   * `expected_updated_at`, the write is a compare-and-swap on the draft token: a draft that
   * moved since is refused with a `409` whose `code` is `method_update_conflict`, and nothing is
   * written. Without it, last writer wins.
   *
   * Takes a bare catalog id, as `getMethod` does. Throws `ApiResponseError`: `404` `not_found`
   * for an unknown or foreign-org method, `409` `method_being_deleted` while its erasure runs,
   * `413` `payload_too_large` for a draft over the store's item limit, `403` for a read-only
   * key.
   */
  async writeDraft(methodId: string, input: MethodDraftInput): Promise<MethodData> {
    return this.requestMethodData("PUT", `${methodPath(methodId)}/draft`, withWirePython(input));
  }

  /**
   * Rename a method — `PATCH /v1/methods/{id}` — and return it. The name belongs to the method,
   * not to a version: a rename changes nothing else, moves no token, and never commits the
   * draft, so the `updated_at` a caller holds stays valid for its next `writeDraft` or
   * `publishMethod`.
   *
   * Takes a bare catalog id, as `getMethod` does. Throws `ApiResponseError`: `404` `not_found`,
   * `409` `method_being_deleted`, `403` for a read-only key, `422` for an empty name, and `413`
   * `payload_too_large` for a name so long it would leave the method too large to publish.
   */
  async renameMethod(methodId: string, input: MethodRenameInput): Promise<MethodData> {
    return this.requestMethodData("PATCH", methodPath(methodId), {
      name: input.name,
    });
  }

  /**
   * Publish a method's draft as its next version — `POST /v1/methods/{id}/publish`.
   *
   * `expected_draft_updated_at` is the draft token the caller last saw, and it is required: a
   * publish never takes a draft its caller has not seen. The platform checks the token, answers
   * `unchanged` without asking the runner when the draft's digest equals the latest version's,
   * and otherwise validates the draft and, when it validates and runs, writes version N+1.
   *
   * The answer is a `MethodPublishResult` discriminated on `outcome` — branch on it:
   * `published` with the new `version`; `unchanged` with the existing latest `version`;
   * `refused` with a `reason` (`invalid`, or `not_runnable` for a draft that validates with
   * pending signatures), a `message` and the runner's `validation` verdict. Every arm carries the
   * `method`. A publish moves no token.
   *
   * Takes a bare catalog id, as `getMethod` does. Throws `RequestArgumentError` when
   * `expected_draft_updated_at` is not a string, before any request. Throws `ApiResponseError`
   * when no verdict was produced: `409` `method_update_conflict` for a draft that moved since
   * the token, `409` `method_being_deleted`, `404` `not_found`, `422` for a draft with no
   * `.mthds` file or whose file names a run could not assemble (one name used by a `.mthds` and
   * a Python file), `413` `payload_too_large` for a draft too large to publish, and `403` for a
   * read-only key.
   *
   * Only a draft that differs from the latest version reaches the runner, and a runner that
   * cannot be reached, answers unusably or does not finish within the platform's deadline is a
   * `502` or a `503` with nothing written, so a retry is safe; a runner that refuses the request
   * itself is relayed under its own status. A retry of a publish that landed while its answer was
   * lost, as on a client timeout, answers `unchanged` with the version it wrote.
   *
   * An answer whose `outcome` is not one of the outcomes above, or that carries no `method`
   * object, is an answer the SDK cannot read, thrown as an `ApiResponseError` too.
   */
  async publishMethod(methodId: string, input: MethodPublishInput): Promise<MethodPublishResult> {
    const token: unknown = (input as Partial<MethodPublishInput> | undefined)
      ?.expected_draft_updated_at;
    if (typeof token !== "string") {
      throw new RequestArgumentError(
        "publishMethod() needs expected_draft_updated_at: the draft token (the method's " +
          "updated_at) the caller last saw, so a publish never takes a draft it has not seen.",
      );
    }
    const endpoint = `${methodPath(methodId)}/publish`;
    const res = await this.requestProductAnswer("POST", endpoint, {
      expected_draft_updated_at: token,
    });
    const answer = this.readObjectAnswer<Record<string, unknown>>("POST", endpoint, res);
    const { outcome, method: stored } = answer;
    if (outcome !== "published" && outcome !== "unchanged" && outcome !== "refused") {
      throw this.unreadableAnswer(
        "POST",
        `/${API_PREFIX}/${endpoint}`,
        res,
        "a publish result whose `outcome` is not `published`, `unchanged` or `refused`",
      );
    }
    if (!isPlainObject(stored)) {
      throw this.unreadableAnswer(
        "POST",
        `/${API_PREFIX}/${endpoint}`,
        res,
        "a publish result whose `method` is not an object",
      );
    }
    const method = this.readStoredSources<MethodData>(
      "POST",
      endpoint,
      res,
      stored as MethodDataWire,
      "a stored method",
    );
    return { ...answer, outcome, method } as MethodPublishResult;
  }

  /**
   * One page of a method's published versions, newest first, without their sources —
   * `GET /v1/methods/{id}/versions`.
   *
   * Pass the page's `nextCursor` back as `cursor` to continue; `null` is the last page. A page
   * may be short while `nextCursor` is set, because the platform reads versions whole. A method
   * never published answers an empty page.
   *
   * Takes a bare catalog id, as `getMethod` does. Throws `ApiResponseError`: `404` `not_found`
   * for an unknown method, `409` `method_being_deleted`, `400` for a cursor from another method.
   * A page whose `items` is not an array or whose `next_cursor` is neither a string nor `null`
   * is an answer the SDK cannot read, thrown as an `ApiResponseError` too.
   */
  async listMethodVersions(
    methodId: string,
    query: ListMethodVersionsQuery = {},
  ): Promise<MethodVersionPage> {
    const params = new URLSearchParams();
    // `!== undefined`, not truthiness — mirroring `listMethods`: an explicit empty cursor is bad
    // input the API should refuse, not an omission.
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const suffix = params.toString();
    const endpoint = `${methodPath(methodId)}/versions`;
    return this.requestPage<MethodVersionSummary>(suffix ? `${endpoint}?${suffix}` : endpoint);
  }

  /**
   * One published version of a method, with its sources —
   * `GET /v1/methods/{id}/versions/{n}`. Its `python` is parsed into `MethodFile[]` as a
   * method's is.
   *
   * Takes a bare catalog id, as `getMethod` does, and the version number. Throws
   * `RequestArgumentError` for a `version` that is not a positive integer, before any request.
   * Throws `ApiResponseError`: `404` `method_version_not_found` for a version the method never
   * published, `404` `not_found` for an unknown method, `409` `method_being_deleted`.
   */
  async getMethodVersion(methodId: string, version: number): Promise<MethodVersion> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new RequestArgumentError(
        `getMethodVersion() takes a version number, a positive integer; got ${String(version)}.`,
      );
    }
    const endpoint = `${methodPath(methodId)}/versions/${version}`;
    const res = await this.requestProductAnswer("GET", endpoint, undefined);
    const wire = this.readObjectAnswer<MethodVersionWire>("GET", endpoint, res);
    return this.readStoredSources<MethodVersion>("GET", endpoint, res, wire, "a published version");
  }

  /**
   * Erase a method and everything it produced — `DELETE /v1/methods/{id}`.
   *
   * **Asynchronous, and the return value says so.** The platform answers `202`
   * the moment it has claimed the method and terminated its in-flight
   * workflows; the rest of the cascade (runs, events, S3 objects) is enqueued.
   * So a resolved promise means "accepted", never "gone" — completion is the
   * method's row disappearing from `listMethods`, not any field of the
   * acceptance body. Until then the row stays listed with a `deletion_state`,
   * which is what lets a UI render it as "Deleting…", while `getMethod` refuses
   * it with a `409`.
   *
   * A double-clicked delete is safe: the claim is a conditional write, so the
   * second call is an `ApiResponseError` (`409 method_being_deleted`) rather than a
   * second cascade over the same runs. An unknown or foreign-org id is a `404`. The
   * erasure deletes the method's published versions with the rest. Takes a bare catalog id,
   * as `getMethod` does: the whole method is erased, never one of its versions.
   */
  async deleteMethod(methodId: string): Promise<MethodDeletionAccepted> {
    return this.requestProduct("DELETE", methodPath(methodId));
  }

  /** The caller's org memberships + active-org feature flags — `GET /v1/organizations/memberships`. */
  async listMemberships(): Promise<MembershipsResponse> {
    return this.requestProduct("GET", "organizations/memberships");
  }

  /** Create an organization — `POST /v1/organizations`. */
  async createOrganization(input: { name: string }): Promise<Membership> {
    return this.requestProduct("POST", "organizations", input);
  }

  /** Rename an organization — `PATCH /v1/organizations/{org_id}`. */
  async renameOrganization(orgId: string, input: { name: string }): Promise<Membership> {
    return this.requestProduct("PATCH", `organizations/${encodeURIComponent(orgId)}`, input);
  }

  /** The active org's subscription state — `GET /v1/billing/subscription`. */
  async getSubscription(): Promise<SubscriptionResponse> {
    return this.requestProduct("GET", "billing/subscription");
  }

  /** Available plans (with `is_current`) — `GET /v1/billing/plans`. */
  async listPlans(): Promise<PlanView[]> {
    return this.requestProduct("GET", "billing/plans");
  }

  /** Past invoices — `GET /v1/billing/invoices`. */
  async listInvoices(): Promise<InvoiceView[]> {
    return this.requestProduct("GET", "billing/invoices");
  }

  /** Open a Stripe checkout for a plan — `POST /v1/billing/checkout`. */
  async createCheckout(input: { plan: string }): Promise<CheckoutResponse> {
    return this.requestProduct("POST", "billing/checkout", input);
  }

  /**
   * Switch the existing subscription's plan — `POST /v1/billing/change-plan`.
   * A 409 `conflict` (`ApiResponseError.code`) means there is no subscription
   * to change — start one via `createCheckout` first.
   */
  async changePlan(input: { plan: string }): Promise<ChangePlanResponse> {
    return this.requestProduct("POST", "billing/change-plan", input);
  }

  /**
   * A Stripe billing-portal session URL — `GET /v1/billing/portal`. A 409
   * `conflict` (`ApiResponseError.code`) means there is no subscription yet.
   */
  async getBillingPortal(): Promise<BillingPortalResponse> {
    return this.requestProduct("GET", "billing/portal");
  }

  /** List the caller's Pipelex API keys — `GET /v1/pipelex-api-keys`. */
  async listPipelexApiKeys(): Promise<PipelexApiKeyList> {
    return this.requestProduct("GET", "pipelex-api-keys");
  }

  /**
   * Mint a Pipelex API key — `POST /v1/pipelex-api-keys`. The plaintext
   * `api_key` is returned ONCE. A 409 `pipelex_api_key_limit_reached`
   * (`ApiResponseError.code`) means the per-account key limit is hit.
   */
  async createPipelexApiKey(input: { label: string }): Promise<PipelexApiKeyCreated> {
    return this.requestProduct("POST", "pipelex-api-keys", input);
  }

  /** Revoke a Pipelex API key — `DELETE /v1/pipelex-api-keys/{id}`. */
  async revokePipelexApiKey(id: string): Promise<void> {
    await this.requestProduct("DELETE", `pipelex-api-keys/${encodeURIComponent(id)}`);
  }

  /**
   * Rotate a Pipelex API key — `POST /v1/pipelex-api-keys/{id}/rotate` (no
   * body). Returns the new plaintext `api_key` once; the old key stops working.
   */
  async rotatePipelexApiKey(id: string): Promise<PipelexApiKeyCreated> {
    return this.requestProduct("POST", `pipelex-api-keys/${encodeURIComponent(id)}/rotate`);
  }

  /** Submit the onboarding questionnaire — `POST /v1/onboarding/submit`. */
  async submitOnboarding(input: OnboardingSubmission): Promise<void> {
    await this.requestProduct("POST", "onboarding/submit", input);
  }

  /** Resolve a storage URI to a presigned URL — `POST /v1/resolve-storage-url`. */
  async resolveStorageUrl(input: { uri: string }): Promise<ResolvedStorageUrl> {
    return this.requestProduct("POST", "resolve-storage-url", input);
  }

  /**
   * Resolve a list of storage URIs in one request — `POST /v1/resolve-storage-url/bulk`,
   * the single route applied to a list. One item per reference, in request order,
   * duplicates included; a refused reference is a value on its item (`error`),
   * and the request is a `200` whenever every reference got a verdict. At most
   * `BULK_RESOLVE_MAX_URIS` references per call (a longer list is a `422`) —
   * {@link resolveArtifacts} chunks a longer set. Served by the hosted platform
   * only: a deployment without the route answers a `404` `ApiResponseError`.
   */
  async resolveStorageUrls(
    input: BulkResolveStorageUrlsInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<BulkResolvedStorageUrls> {
    return this.requestProductObject("POST", "resolve-storage-url/bulk", input, options);
  }

  /**
   * Resolve a whole list of `pipelex-storage://` references through the bulk
   * route, chunked at its bound, answering one `ResolvedArtifact` per reference
   * in request order with per-reference failure as a value. The reading layer of
   * the artifact stack: pair it with `collectArtifacts` to mint fresh links for
   * everything a run produced. See `docs/artifact-download.md`.
   */
  async resolveArtifacts(
    uris: string[],
    options?: { signal?: AbortSignal },
  ): Promise<ResolvedArtifact[]> {
    return resolveArtifactsImpl(this, uris, options);
  }

  /**
   * A bounded `Response` for one `pipelex-storage://` reference: resolved fresh,
   * a timeout, redirects refused, the byte cap enforced mid-stream, no credentials
   * forwarded, the store's headers untouched. What `downloadArtifacts` and a
   * same-origin proxy share. See `docs/artifact-download.md`.
   */
  async fetchArtifact(uri: string, options?: FetchArtifactOptions): Promise<Response> {
    return fetchArtifactImpl(this, uri, options);
  }

  /**
   * Save a run's produced files under a directory — the download twin of
   * {@link prepareInputs}, Node-only. Keyed on a `run_id` (the results are
   * re-read, so it works days after the run) or a `RunResults` in hand; walks the
   * `main_stuff` scope by default, `working_memory` on request; resolves every
   * link fresh (never the embedded `public_url`); names each file after the field
   * it fills; and returns a produced verdict, one entry per reference with the
   * paths it sits at, errors as values. See `docs/artifact-download.md`.
   */
  async downloadArtifacts(request: DownloadArtifactsRequest): Promise<DownloadArtifactsResult> {
    return downloadArtifactsImpl(this, request);
  }

  /**
   * Upload a base64 file — `POST /v1/upload`. An answer with no non-empty string `uri` names no
   * stored file, so it is an answer the SDK cannot read: an `ApiResponseError`, `runtime` and
   * not retryable, which `uploadFile` wraps as an `UploadTransportError` with code `unexpected`.
   */
  async upload(input: UploadInput): Promise<UploadedFile> {
    const res = await this.requestProductAnswer("POST", "upload", input);
    const uploaded = this.readObjectAnswer<Partial<Record<keyof UploadedFile, unknown>>>(
      "POST",
      "upload",
      res,
    );
    if (typeof uploaded.uri !== "string" || uploaded.uri === "") {
      throw this.unreadableAnswer(
        "POST",
        `/${API_PREFIX}/upload`,
        res,
        "an answer with no string `uri`",
      );
    }
    return uploaded as UploadedFile;
  }

  /**
   * Request a grant to upload one file straight to storage — `POST /v1/upload/grant`.
   * `upload` for a caller that holds the bytes but not this client's credential, such
   * as a browser page: the credential-holding side asks for the grant, hands it over,
   * and the holder of the bytes sends them with `uploadWithGrant`, from the
   * browser-safe `@pipelex/sdk/upload` entry. The bytes cross neither this client nor
   * the API gateway, so the gateway's request quota does not cap the file below the
   * service's own limit (`max_bytes`).
   *
   * The grant describes one new object: its `uri` exists once the `PUT` succeeds, and
   * not before. It is create-only and short-lived, and it is a bearer capability, so
   * keep it out of logs. The route never replays a grant: ask again for a new one
   * rather than retrying. A declared `size` over the cap is a `413` `ApiResponseError`
   * (`code` `payload_too_large`); a deployment without the route answers a `404`. See
   * `docs/input-preparation.md`.
   */
  async requestUploadGrant(
    input: UploadGrantInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<UploadGrant> {
    return this.requestProductObject("POST", "upload/grant", input, options);
  }

  /**
   * Upload one local asset and return its {@link UploadRecord} — the single-asset
   * convenience over {@link upload}. Accepts `Blob`/`File`/`ArrayBuffer`/`Uint8Array`
   * in every runtime; a path string is Node-only (it fails instructively elsewhere).
   * The record guarantees `uri`, `contentType`, `size`, and `filename`. Transport
   * failures surface as the semantic input-preparation errors (rejected asset, auth,
   * unsupported capability, transport). See `docs/input-preparation.md`.
   */
  async uploadFile(asset: UploadableAsset, options?: UploadFileOptions): Promise<UploadRecord> {
    return uploadFileImpl(this, asset, options);
  }

  /**
   * Prepare a pipe's inputs — resolve the declared signature, upload the
   * file-bearing assets, and return copy-on-write rewritten inputs (canonical
   * content carrying `pipelex-storage://` in `url`) plus one upload record per
   * prepared asset. HTTP(S) URLs and existing `pipelex-storage://` URIs pass
   * through unchanged; all failures are raised before any run is created.
   *
   * Name the method exactly one of three ways, all server-resolved through the
   * one `pipeIo` call this composes:
   *
   * - `files` — the inline MTHDS closure;
   * - `method_ref` — a published method's address, fetched by the runner;
   * - `method_id` — a stored method's catalog id, resolved by the platform
   *   (hosted only; requires an API key).
   *
   * The route also selects the pipe — the caller's qualified `pipe_ref`, else the
   * method's own entry pipe — and the signature is the input-form descriptor it
   * answers with, which states the kind of every input at every depth, so a file
   * position is a fact of the method, never a guess from the value's shape. It
   * needs an API serving `POST /v1/pipe-io`. See `docs/input-preparation.md`.
   */
  async prepareInputs(request: PrepareInputsRequest): Promise<PreparedInputs> {
    return prepareInputsImpl(this, request);
  }

  /**
   * One PAGE of a method's runs, newest first — `GET /v1/runs?method_id=`.
   *
   * **This returns a page, not the whole history.** The API serves it from a
   * time-ordered index, so its cost is the page size rather than the size of
   * the history; a method with 100k runs answers as fast as one with 50. To
   * read further, pass the previous response's `nextCursor` back as
   * `query.cursor` until it comes back `null`.
   *
   * Breaking in v0.10.0: this used to return `PipelineRun[]` — the complete
   * history in one array. Code that rendered that array directly should now
   * either read `page.items` (accepting the first page) or follow the cursor.
   * `iterateRuns` does the latter for you.
   *
   * Each item is a `RunHistoryItem` — the id, status, timestamps, pipe and,
   * for a failed run, its error report. The run's organization, creator,
   * method and workflow id are not on the list; `getRunDetail` returns them.
   *
   * `createdFrom` / `createdTo` are applied server-side as index key
   * conditions, so a bounded page genuinely reads less. They are INSTANTS,
   * not days — see `ListRunsQuery`.
   *
   * Takes a bare catalog id: the history files the runs of every version and
   * of the draft together under it, so `mt_…@3` names no history of its own
   * and the platform refuses it with a `400`. Strip a suffix with
   * `parseMethodSelector`, and read which version a run ran from its
   * `method_version`.
   */
  async listRuns(methodId: string, query: ListRunsQuery = {}): Promise<RunPage> {
    const params = new URLSearchParams({ method_id: methodId });
    // `!== undefined`, not truthiness: omission means "the caller did not ask
    // for this bound". An explicitly supplied empty string is not omission, it
    // is bad input — dropping it turned a broken date into a silently
    // UNFILTERED query returning every run, which reads as working. Forwarded,
    // it reaches the API's instant parse and comes back a 400 saying so.
    if (query.createdFrom !== undefined) params.set("created_from", query.createdFrom);
    if (query.createdTo !== undefined) params.set("created_to", query.createdTo);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const page = await this.requestPage<RunHistoryItem>(`runs?${params.toString()}`);
    return { items: page.items.map(withCheckedReport), nextCursor: page.nextCursor };
  }

  /**
   * Every run of a method, streamed — follows the cursor for you.
   *
   * ```ts
   * for await (const run of client.iterateRuns(methodId)) {
   *   if (isTheOne(run)) break;   // stop whenever you like
   * }
   * ```
   *
   * **Prefer `listRuns`** for anything user-facing: this is O(history) by
   * construction and makes as many round trips as the data demands.
   *
   * An iterator rather than a `listAllRuns(): Promise<RunHistoryItem[]>`, and that
   * is not stylistic. An all-at-once helper needs a page cap so a misbehaving
   * server cannot spin it forever — and a cap means it returns a TRUNCATED list
   * with no error and no flag, a method with 6,000 runs quietly yielding 5,000.
   * Silently returning less than everything, from a method called "all", is the
   * exact failure mode paging was introduced to remove. Streaming has no such
   * cliff: it yields until the server says there is no more, the caller decides
   * when to stop, and only one page is ever in memory. If you truly want an
   * array, `Array.fromAsync` makes that your explicit choice.
   *
   * Takes a bare catalog id, as `listRuns` does.
   */
  async *iterateRuns(
    methodId: string,
    query: Omit<ListRunsQuery, "cursor"> = {},
  ): AsyncGenerator<RunHistoryItem, void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page: RunPage = await this.listRuns(methodId, { ...query, cursor });

      // Checked BEFORE yielding. A server handing back the very cursor we sent
      // has not advanced, so this page repeats rows already emitted — yielding
      // first and stopping after would silently double-count them for anyone
      // aggregating the stream (summing cost, counting runs). Cannot fire on
      // the first request, where `cursor` is undefined.
      if (cursor !== undefined && page.nextCursor === cursor) return;

      for (const run of page.items) yield run;

      // Checked AFTER: `nextCursor === null` is the NORMAL end of the history
      // and that page is real data, so it has to be emitted first. The empty
      // page catches a server that keeps minting fresh cursors while returning
      // nothing, which would otherwise spin forever yielding nothing.
      //
      // Neither of these is a page cap. Both fire only on a server that is not
      // making progress, so neither can truncate a healthy stream the way a
      // `maxPages` limit silently did.
      if (page.nextCursor === null || page.items.length === 0) return;
      cursor = page.nextCursor;
    }
  }

  /**
   * The whole record for one run — `GET /v1/runs/{id}`.
   *
   * The ONLY call that returns `mthds_contents` (what the run actually
   * executed) and `inputs`. Kept off the status read, which pollers hit every
   * few seconds. A failed run's stored report, `error`, is checked field by
   * field (see `RunErrorReport`).
   */
  async getRunDetail(runId: string): Promise<RunDetail> {
    return withCheckedReport(
      await this.requestProductObject<RunDetail>("GET", `runs/${encodeURIComponent(runId)}`),
    );
  }

  /** Patch a run's status (admin/manual) — `PUT /v1/runs/{id}`. */
  async updateRun(runId: string, input: UpdateRunInput): Promise<void> {
    await this.requestProduct("PUT", `runs/${encodeURIComponent(runId)}`, input);
  }

  /**
   * Blocking `POST /v1/execute` adapted onto `RunResults` — the bare-runner
   * path. Forwards every protocol field PLUS every extension surface: the
   * runner-resolved `method_ref`, the hosted `method_id`, and the generic
   * `extra` passthrough. An extension-only call (`{ extra }` with no
   * pipe_code/bundle) or a vendor selector riding `extra` must survive this
   * path, not just the durable one — a `method_ref` run must run the same
   * fetched package here, and a hosted `method_id` must reach the server too,
   * so a runner that cannot resolve it says so (Rule 4) instead of the client
   * silently dropping it.
   */
  private async executeBlocking(options: PipelexStartOptions): Promise<RunResults> {
    const response = await this.execute({
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
      // The bundle must survive the fallback too — a bare runner reached through
      // this path runs the same method as the durable one, or it runs nothing.
      files: options.files ?? undefined,
      bundle_b64: options.bundle_b64 ?? undefined,
      method_ref: options.method_ref ?? undefined,
      method_id: options.method_id ?? undefined,
      extra: options.extra ?? undefined,
    });
    return resultsFromExecute(response);
  }
}

// ── Module helpers ────────────────────────────────────────────────────

/**
 * Whether a base URL is host-only — http/https, no path, query, fragment, or
 * embedded credentials (auth travels in the Authorization header, never the URL).
 * Endpoints compose as `{base}/v1/{endpoint}`, so a path-prefixed base would
 * double the prefix.
 */
function isValidBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
  if (parsed.username || parsed.password) return false;
  return !parsed.search && !parsed.hash;
}

/**
 * A refused base URL as its refusal may show it: the scheme and the host, then the names of the
 * parts beyond them that the URL carried, never their text. Credentials, a query and a path are
 * exactly where a secret travels in a URL, and the refusal reaches logs and, through an app that
 * relays an error's message, a browser. A value that is not an http or https URL is not shown at
 * all, since nothing says which of its characters are a secret: `localhost:8081`, with no scheme,
 * parses as a URL whose scheme is `localhost:`.
 */
function describeRefusedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "(not shown: it is not an absolute URL)";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "(not shown: it is not an http or https URL)";
  }
  const parts: string[] = [];
  if (parsed.username || parsed.password) parts.push("credentials");
  if (parsed.pathname !== "/" && parsed.pathname !== "") parts.push("a path");
  if (parsed.search) parts.push("a query");
  if (parsed.hash) parts.push("a fragment");
  const shown = `"${parsed.protocol}//${parsed.host}"`;
  if (parts.length === 0) return shown;
  const named =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${shown} with ${named} (not shown)`;
}

// The protocol's own request fields — `extra` is for extension args only.
// `files` / `bundle_b64` are reserved too: they are named run-source options,
// so smuggling them through `extra` (which merges last into the body) would
// overwrite the validated fields and bypass the run-source exclusivity check.
const PROTOCOL_REQUEST_KEYS: readonly string[] = [
  "pipe_code",
  "mthds_contents",
  "inputs",
  "output_name",
  "output_multiplicity",
  "dynamic_output_concept_ref",
  "files",
  "bundle_b64",
];

// The PIPELEX API's own request fields — the layer-2 extension the runner
// resolves itself (`method_ref`, a run source in its own right). Reserved on
// `extra` for the same reason the protocol fields are: `extra` merges last, so
// a smuggled copy would overwrite the validated named option and bypass the
// selector-exclusivity checks.
const PIPELEX_API_REQUEST_KEYS: readonly string[] = ["method_ref"];

// The HOSTED API's own request fields — the layer-3 extensions this client
// names itself. Reserved on `extra` for the same reason the protocol fields
// are: `extra` merges last, so a smuggled copy would overwrite the validated
// named option and arrive by a second path with different validation.
//
// The guard is deliberately PER LAYER. It lives here, in the hosted client,
// and must never be pushed down into the protocol clients (`mthds` /
// `mthds-python`): a layer that does not own an argument has no business
// rejecting it — a protocol client talking to some other vendor's server must
// keep passing that vendor's `method_id` straight through. That per-layer
// split is normative for the whole layered client stack.
const HOSTED_REQUEST_KEYS: readonly string[] = ["method_id"];

// Keys that must never ride `extra`: the named request options above (which
// `extra` would overwrite — it merges last into the body) plus the client-only
// `bundleMain` hint, which is documented as never-serialized and so must not
// reach the wire through the passthrough either.
const RESERVED_EXTRA_KEYS: ReadonlySet<string> = new Set([
  ...PROTOCOL_REQUEST_KEYS,
  ...PIPELEX_API_REQUEST_KEYS,
  ...HOSTED_REQUEST_KEYS,
  "bundleMain",
]);

// Prototype-pollution vectors. An own `__proto__` (exactly what `JSON.parse`
// yields, and `extra` is the field most likely populated from untrusted JSON),
// `constructor`, or `prototype` copied onto the body would make this client a
// pollution carrier for any JS hop that later deep-merges the parsed request —
// so they are stripped, never forwarded.
const POLLUTION_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate and copy the generic `extra` passthrough. Extension args ride the
 * request body as top-level properties; reserved request options (protocol
 * args, run sources, the client-only `bundleMain` hint) must be passed as named
 * options, never smuggled through `extra`.
 */
function buildExtensions(
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  // Snapshot once, then validate and copy the snapshot — reading `extra` twice
  // (e.g. a `Proxy` whose `ownKeys` trap answers differently per call) could
  // otherwise let a reserved key pass the check yet reach the copy.
  const snapshot = { ...extra };
  const reserved = Object.keys(snapshot).filter((key) => RESERVED_EXTRA_KEYS.has(key));
  if (reserved.length > 0) {
    throw new RequestArgumentError(
      `extra carries reserved request args [${reserved.sort().join(", ")}] — pass them as named options instead.`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!POLLUTION_KEYS.has(key)) result[key] = value;
  }
  return result;
}

// `method_ref` resolution can make the server CLONE a repository before it
// answers, and the server-side clone timeout runs well past the 30s static-route
// budget on a cold cache. This budget covers that without touching the static
// routes' no-transport-options policy (see the note on `requestExtension`): it
// is an internal budget matched to what the server actually does, not a new
// caller-facing parameter — and inert on the hosted path, where the gateway
// caps responses regardless.
const METHOD_REF_FETCH_TIMEOUT_MS = 180_000; // 3 min — covers the server's clone + resolve

/**
 * The internal request budget for a crate route's `CrateRequestBase` closure
 * (`resolve`, `codegen`, `pipeIo`): the static-route default, unless the closure
 * is a `method_ref` the server may have to fetch first.
 */
function crateRequestTimeoutMs(request: CrateRequestBase): number | undefined {
  return nonEmptyString(request.method_ref) !== undefined ? METHOD_REF_FETCH_TIMEOUT_MS : undefined;
}

/**
 * Copy the Pipelex API's own run arguments onto the wire body. Named options,
 * not `extra` entries — see `PipelexApiRunExtensions`. Same emptiness rule as
 * the hosted builder below: an absent or empty `method_ref` yields an empty
 * object, so the key is not sent and does not count towards the "something to
 * run" precondition.
 */
function buildApiRunExtensions(options: PipelexApiRunExtensions): Record<string, unknown> {
  const methodRef = nonEmptyString(options.method_ref);
  return methodRef === undefined ? {} : { method_ref: methodRef };
}

/**
 * Copy the hosted API's own run arguments onto the wire body. Named options,
 * not `extra` entries — see `PipelexHostedRunExtensions`.
 *
 * An absent or empty `method_id` yields an empty object, so the key is simply
 * not sent: `method_id: ""` selects no method and carries no linkage, and
 * putting it on the wire would only make the server reject a request the client
 * already knows is empty. That emptiness also means it does not count towards
 * the "something to run" precondition, which reads this object's size.
 */
function buildHostedRunExtensions(options: PipelexHostedRunExtensions): Record<string, unknown> {
  const methodId = nonEmptyString(options.method_id);
  return methodId === undefined ? {} : { method_id: methodId };
}

/**
 * The standard's run-source exclusivity check (`assertExclusiveRunSources`: the two bundle
 * encodings together, or a bundle beside inline contents), its refusal rethrown as a
 * `RequestArgumentError` with the same message and the standard's error as `cause`, so it carries
 * a verdict like every other argument the client refuses.
 */
function assertRunSourcesExclusive(options: RunRequest): void {
  try {
    assertExclusiveRunSources(options);
  } catch (err) {
    if (err instanceof PipelineRequestError) {
      throw new RequestArgumentError(err.message, { cause: err });
    }
    throw err;
  }
}

/**
 * Enforce the run routes' `method_ref` exclusivity, mirroring the server's own
 * 422s so an illegal pairing fails before anything hits the wire. A
 * `method_ref` is a complete run source (the fetched package carries its
 * `.mthds` and its entry pipe), so it pairs with NOTHING: not with inline
 * `mthds_contents`, not with a method bundle, and not with the hosted
 * `method_id` — an address run has its own provenance and needs no linkage id.
 *
 * The one documented run-route exception is deliberately NOT here: inline
 * source + `method_id` stays legal (the inline source runs; the id demotes to
 * run-history linkage). `pipe_code` beside a `method_ref` is legal too — it
 * overrides the manifest's `main_pipe`. The wording of the first two errors
 * mirrors the server's validator; presence semantics match it as well
 * (`mthds_contents` counts when non-empty, a bundle encoding counts when the
 * key is present, the selectors count when non-empty).
 */
function assertMethodRefPairsWithNothing(
  options: PipelexApiRunExtensions & PipelexHostedRunExtensions & RunRequest,
): void {
  if (nonEmptyString(options.method_ref) === undefined) return;
  if (options.mthds_contents != null && options.mthds_contents.length > 0) {
    throw new RequestArgumentError(
      "method_ref and inline mthds_contents are mutually exclusive; send one or the other.",
    );
  }
  if (options.files != null || options.bundle_b64 != null) {
    throw new RequestArgumentError(
      "method_ref and a method bundle (bundle_b64 / files) are mutually exclusive; send one or the other.",
    );
  }
  if (nonEmptyString(options.method_id) !== undefined) {
    throw new RequestArgumentError(
      "method_ref and method_id are mutually exclusive: an address run carries its own provenance " +
        "and takes no run-history linkage id. Send exactly one method selector.",
    );
  }
}

/**
 * Normalize a bundle encoding for the wire: an empty map / string is NOT a
 * runnable bundle, so it must not be sent (the runner rejects a zero-file
 * bundle). Exclusivity is still checked on presence upstream, so an empty
 * encoding supplied alongside another source has already been rejected.
 */
function nonEmptyFiles(
  files: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  return files != null && Object.keys(files).length > 0 ? files : undefined;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined;
}

function withValidateMarkdownRender(render: string[] | undefined): string[] {
  const formats = new Set(render ?? []);
  formats.add(VALIDATE_MARKDOWN_RENDER_FORMAT);
  return [...formats];
}

// The hosted gateway caps synchronous requests at 30s. A failure at/after this
// threshold on the blocking execute is the timeout, not a transient outage —
// the threshold guards against mislabelling a fast 503 (runner genuinely down)
// as a timeout.
const GATEWAY_TIMEOUT_THRESHOLD_MS = 28_000;

function isGatewayTimeout(err: unknown, elapsedMs: number): boolean {
  if (elapsedMs < GATEWAY_TIMEOUT_THRESHOLD_MS) return false;
  if (err instanceof ApiResponseError) return err.status === 503 || err.status === 504;
  if (err instanceof ApiUnreachableError) return err.code === "ABORT_TIMEOUT";
  return false;
}

function extractNetworkErrorCode(err: unknown): string | undefined {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "ABORT_TIMEOUT";
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

/**
 * Whether a 404 is an unmatched-route 404 (no platform deployed) rather than
 * the platform's structured run-not-found 404. The platform wraps its 404s in
 * a structured envelope with a stable `code`; a bare runner returns
 * Starlette's default `{"detail": "Not Found"}` (no `code`).
 */
function isMissingRoute404(body: string): boolean {
  if (!body) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  return !("code" in parsed);
}

/** Parse the `Retry-After` header (seconds form, which the platform uses). */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const KNOWN_RUN_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "STARTED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
];

/** The response header the platform and the runner stamp the request's correlation id on. */
const REQUEST_ID_HEADER = "x-request-id";

/**
 * Build the failed arm from the results read's `409` problem document.
 *
 * The platform's document carries `detail` (`Run finished with status <STATUS>: <message>`,
 * or `...; no result available` when the run has no report) and two extension members:
 * `run_status`, the run's terminal status — named so because a problem's own `status` is the
 * HTTP status — and `error`, the run's stored error report or `null`. The status is read from
 * `run_status`. A platform that predates the member sends only `detail`, whose leading
 * `Run finished with status <STATUS>` the platform keeps for exactly this reader, so the status
 * word is recovered from it then; a `409` that yields no known status either way (the one this
 * route answers for a stored result it refuses to read) reads as `FAILED`, and its `detail`
 * still says what happened. The report is checked field by field by `readRunErrorReport`: an
 * object is taken as the report, each named field kept when it has its declared type, and
 * anything that is not an object reads as no report.
 */
function runResultFailed(runId: string, body: string): RunResultState {
  const { serverMessage, document } = parseErrorBody(body);
  const message = serverMessage ?? "Run finished without a result.";
  return {
    state: "failed",
    pipeline_run_id: runId,
    status: knownRunStatus(document?.run_status) ?? statusFromDetail(message) ?? "FAILED",
    message,
    error: readRunErrorReport(document?.error),
  };
}

/**
 * A run record with its stored report checked by `readRunErrorReport`. Only when the record
 * carries the `error` key, so a server that does not serve it still leaves it absent; a record
 * that is not an object is returned as it came.
 */
function withCheckedReport<T>(record: T): T {
  if (!isPlainObject(record) || !Object.hasOwn(record, "error")) return record;
  return { ...record, error: readRunErrorReport(record.error) } as T;
}

function knownRunStatus(value: unknown): RunStatus | undefined {
  return typeof value === "string" && (KNOWN_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as RunStatus)
    : undefined;
}

/** The status word of a `detail` reading `Run finished with status <STATUS>…`, for a platform without `run_status`. */
function statusFromDetail(detail: string): RunStatus | undefined {
  return knownRunStatus(/status\s+([A-Z_]+)/.exec(detail)?.[1]);
}

/**
 * Extract the members of an error body.
 *
 * The API serializes errors as RFC 9457 problem documents — the platform's (`type`, `title`,
 * `status`, `code`, `detail`, `instance`, `request_id`, `errors[]`, plus an extension member
 * such as a failed run's `run_status` and `error`) and the runner's (the same standard slots
 * plus `error_type`, `error_domain`, `error_category`, `retryable`, `user_action`, `model`,
 * `provider`, `provider_metadata`, `validation_errors`, `migration`) — and, on older routes, as
 * `{"detail": {"error_type": ..., "message": ...}}` (HTTPException with dict detail). Both
 * shapes are handled, with top-level `error_type` / `message` fallbacks. Falls through to empty
 * on a non-JSON or non-object body.
 *
 * Each typed member is kept only when it has the type the problem document gives it, so a
 * malformed member reads as absent rather than as a wrong value, and the nested members
 * (`provider_metadata`, `migration`, `validation_errors`, `errors`) are checked field by field as a
 * stored report's are; `document` keeps the decoded object whole, members named or not.
 */
function parseErrorBody(body: string): {
  errorType: string | undefined;
  serverMessage: string | undefined;
  validationErrors: ValidationErrorItem[] | undefined;
  code: string | undefined;
  problem: ProblemDetails;
  document: Record<string, unknown> | undefined;
} {
  const empty = {
    errorType: undefined,
    serverMessage: undefined,
    validationErrors: undefined,
    code: undefined,
    problem: {},
    document: undefined,
  };
  if (!body) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!isPlainObject(parsed)) {
    return empty;
  }
  const root = parsed;
  const detail = root.detail;
  let errorType: string | undefined;
  let serverMessage: string | undefined;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.error_type === "string") errorType = d.error_type;
    if (typeof d.message === "string") serverMessage = d.message;
  } else if (typeof detail === "string") {
    serverMessage = detail;
  }
  if (errorType === undefined && typeof root.error_type === "string") errorType = root.error_type;
  if (serverMessage === undefined && typeof root.message === "string") serverMessage = root.message;
  // `validation_errors` rides the problem envelope as a top-level array (the
  // VERBOSE projection of `ErrorReport.validation_errors`, retained under STRICT
  // too — it describes the caller's own bundle, not server internals). Each item is
  // kept when it is an object with a string `category` and `message`, as on a stored report.
  const validationErrors = Array.isArray(root.validation_errors)
    ? root.validation_errors.filter(isValidationItem)
    : undefined;
  // The platform's closed native code (`conflict`, `not_found`, …), one-to-one with `type`.
  const code = typeof root.code === "string" ? root.code : undefined;
  const problem: ProblemDetails = {
    type: stringMember(root.type),
    title: stringMember(root.title),
    instance: stringMember(root.instance),
    requestId: stringMember(root.request_id),
    errorDomain: stringMember(root.error_domain),
    errorCategory: stringMember(root.error_category),
    retryable: typeof root.retryable === "boolean" ? root.retryable : undefined,
    userAction: parseUserAction(root.user_action),
    model: stringMember(root.model),
    provider: stringMember(root.provider),
    // The nested members are checked one level down by the readers a stored report goes
    // through, so a misfit field reads as absent here exactly as it does there.
    providerMetadata: isPlainObject(root.provider_metadata)
      ? readProviderMetadata(root.provider_metadata)
      : undefined,
    migration: isPlainObject(root.migration) ? readMigration(root.migration) : undefined,
    errors: Array.isArray(root.errors)
      ? root.errors.filter(isPlainObject).map(readFieldError)
      : undefined,
  };
  return { errorType, serverMessage, validationErrors, code, problem, document: root };
}

/** A problem member kept only when it is a non-empty string. */
function stringMember(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A `user_action` member is kept only whole: an object with a string `kind` and a non-empty `detail`. */
function parseUserAction(value: unknown): UserAction | undefined {
  if (!isPlainObject(value)) return undefined;
  const { kind, detail } = value;
  if (typeof kind !== "string" || typeof detail !== "string" || detail.length === 0) {
    return undefined;
  }
  return { kind, detail };
}

function nonEmptyHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value ? value : undefined;
}
