import type {
  MTHDSProtocol,
  MethodFiles,
  ModelCategory,
  ModelDeck,
  RunOptions,
  RunRequest,
  StartOptions,
  VersionInfo,
} from "mthds/protocol";
// Method-source predicates come from the standard, not a local restatement: which
// source combinations are legal is an invariant of `RunRequest` itself, so this
// client and the MTHDS runners cannot disagree about what they reject.
import { assertOneMethodSource, parseJsonBody } from "mthds/protocol";
import type {
  CodegenRequest,
  CodegenResponse,
  CrateRequestBase,
  CrateRouteOptions,
  DictPipeOutput,
  DictRunResultExecute,
  FormatResponse,
  LintResponse,
  ModelCheckCategory,
  ModelReferenceVerdict,
  PipeIORequest,
  PipeIOResponse,
  PipelexRunResultStart,
  PipelexValidateSource,
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
  readRunDegradation,
  RUN_STATUSES,
  runProgressFault,
  runStatusFilter,
  selectionIncludesMainStuff,
  throwIfAborted,
  withCheckedProgressDegradations,
  type GetRunResultOptions,
  type RunProgress,
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
  ListMethodExamplesQuery,
  ListMethodsQuery,
  ListMethodVersionsQuery,
  MethodData,
  MethodDeletionAccepted,
  MethodDetail,
  MethodDraftInput,
  MethodExample,
  MethodExampleCreateInput,
  MethodExampleLatestRunInput,
  MethodExampleLatestRunResult,
  MethodExamplePage,
  MethodExampleUpdateInput,
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
  SavedMethodFile,
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
import {
  HANDSHAKE_TTL_MS,
  INLINE_TREE_MAX_BYTES,
  MAX_CONCURRENT_TRANSFERS,
  REQUEST_SENDING,
  SAVE_SENDING,
  announcedTreeLimits,
  contentsTreeSource,
  declaresBlobStore,
  eitherSignal,
  emptyTreeRefusal,
  fileByBlob,
  forEachConcurrently,
  hashMethodFiles,
  inlineFilesOf,
  inlineMapBytes,
  inlineThreshold,
  isMethodTreeTooLarge,
  listDirectoryTree,
  listerLimitsOf,
  missingBlobsOf,
  presentMap,
  readTreeBytesInto,
  redactSignedLinks,
  sha256Hex,
  treeShapeFault,
  treeTotalSize,
  uniqueBlobs,
  uploadBlob,
  writeMethodTreeTo,
} from "./method-trees.js";
import type {
  MethodTreeForms,
  MethodTreeLimits,
  TreeSending,
  TreeSendOptions,
} from "./method-trees.js";
import type {
  MethodTreeSource,
  MethodTreeSourceFile,
  MissingBlob,
  MissingBlobsRequest,
  MissingBlobsResult,
} from "mthds/protocol";
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
import { ExactJsonUnsupportedError, parseExactJson, stringifyExactJson } from "./exact-json.js";
import { MAX_TIMER_DELAY_MS, isTimerDelay } from "./timers.js";

// A pure RUNAWAY guard on the paged-list iterators (`iterateMethods`,
// `iterateRuns`, `iterateMethodExamples`), deliberately not a coverage limit.
//
// It counts TOTAL pages, not empty ones. An earlier version capped consecutive
// empty pages, which is the wrong axis: an empty page whose cursor ADVANCED is
// real progress through the index — the platform applies the list filters
// (`q` and `published` on methods, `createdBy` and `status` on runs) after a
// bounded read per request, so a sparse match legitimately yields runs of
// empty pages — and capping them turns a valid sparse search into a thrown
// error. The stuck case is already caught by the no-progress check (the
// server handing back the cursor we sent).
//
// At the platform's 200-row maximum page size this is 2,000,000 rows, so it
// cannot fire on real data; it exists only so a server minting fresh cursors
// forever cannot hang a caller indefinitely.
const MAX_PAGES = 10_000;

/**
 * Follow a paged list's cursor until the server says there is no more, yielding every row —
 * the one loop behind `iterateMethods`, `iterateRuns` and `iterateMethodExamples`, so they cannot
 * drift apart.
 *
 * It yields lazily: a caller that breaks early stops the requests. It stops when `nextCursor`
 * is `null`, the normal end, and when the server hands back the cursor it was just sent, which
 * is no progress and would repeat rows already yielded. It keeps going through an EMPTY page
 * that carries a cursor, since a filtered page can hold no row and still not be the end; past
 * `MAX_PAGES` pages it throws `PagingNotTerminatingError` rather than return a truncated list.
 */
async function* followCursor<T>(
  route: string,
  readPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await readPage(cursor);

    // Checked BEFORE yielding: a server handing back the very cursor we sent
    // has not advanced, so this page repeats rows already emitted — yielding
    // first and stopping after would silently double-count them for anyone
    // aggregating the stream (summing cost, counting runs). Cannot fire on the
    // first request, where `cursor` is undefined.
    if (cursor !== undefined && page.nextCursor === cursor) return;

    for (const item of page.items) yield item;

    // `nextCursor === null` is the NORMAL end of the list, and that page is
    // real data, so it has to be emitted before this fires.
    if (page.nextCursor === null) return;

    // An EMPTY page is NOT the end, and treating it as one was a bug. The
    // platform filters after a bounded index read per request, so a sparse
    // match legitimately returns `{items: [], nextCursor: "…"}` — "nothing
    // matched in the slice I just read, keep going". Returning here dropped
    // every later match silently, which is the exact truncation this
    // pagination work exists to remove.
    pages += 1;
    if (pages >= MAX_PAGES) {
      // THROW, do not return. A caller that asked for every row and got a
      // partial answer with no error is back to the original bug one layer
      // up; an error is the only honest response to a server that will not
      // finish. Unreachable on real data — see MAX_PAGES. It also bounds a
      // cursor that CYCLES (`c1 → c2 → c1`), which the adjacent check misses.
      throw new PagingNotTerminatingError(
        `${route} did not terminate after ${MAX_PAGES} pages; refusing to keep paging. ` +
          `This is a server-side fault, not a coverage limit.`,
        MAX_PAGES,
      );
    }
    cursor = page.nextCursor;
  }
}

/**
 * The Pipelex API's own run argument — the layer-2 argument the RUNNER itself
 * reads, beside the protocol's `files` map: the `method_ref` run source, served by
 * any pipelex-api >= 0.21.0 deployment, bare or hosted.
 *
 * A named option rather than an `extra` entry, for the same reason as the hosted
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
   * A complete run source of its own — the fetched package carries its whole
   * tree and its entry pipe — so it pairs with NOTHING: exclusive with the
   * method's tree in any of its forms (`directory`, `contents`, `tree`, `files`)
   * and with the hosted `method_id` (an address run has its own provenance and
   * needs no linkage id). `pipe_code` beside it is fine — it overrides the
   * manifest's `main_pipe` to pick which pipe in the fetched package to run. This
   * client rejects the illegal pairings before anything hits the wire, mirroring
   * the server's own 422s.
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
   * A stored method's catalog id (`mt_…`), optionally naming a version — a
   * **pass-through to the hosted API**, resolved server-side against the org's
   * catalog. Nothing is expanded client-side, and it is meaningless off-platform:
   * an open-source runner has no catalog, so it answers a `422` naming the key.
   *
   * Its meaning depends on what else the request carries:
   *
   * - **Alone** — the platform resolves the version the id names and runs its
   *   files, with the method's Python files beside them. A bare `mt_…` runs the
   *   latest published version, a `409` `method_not_published` for a method never
   *   published; `mt_…@<n>` runs version `n`, a `404` `method_version_not_found`
   *   for a version never published; `mt_…@draft` runs the draft. The suffix
   *   rides the string untouched, any other suffix is a `422`, and the answer's
   *   `method_version` says which version runs.
   * - **Alongside the method's tree** (`directory`, `contents`, `tree` or `files`)
   *   — the tree is what RUNS (precedence), and the id is recorded as
   *   **run-history linkage** on the Run row. That linkage is what writes the
   *   index key `GET /v1/runs?method_id=` queries, so a run started without it
   *   is absent from its method's history permanently. The id must be bare
   *   there: the tree is what runs, so a suffix would claim a version that did
   *   not, and a suffixed id is rejected client-side (a `422` on the hosted
   *   API).
   * - **Alongside `method_ref`** — rejected client-side (and a 422 on the
   *   hosted API): an address run carries its own provenance, so it takes no
   *   linkage id.
   *
   * An empty string is treated as absent and is not sent.
   */
  method_id?: string | null;
}

/**
 * `execute()` options — the protocol's run arguments, the method's tree in any of the four forms
 * of `MethodTreeForms` (the protocol's `files` and `tree`, and this client's `directory` and
 * `contents`), and the Pipelex API and hosted extensions.
 *
 * The tree is given in at most one form. `files` is sent as given; a `directory`, `contents` or
 * `tree` is sent as the `files` map, inline when its inline map weighs 256 KiB or less and no more
 * than the inline limit the API announces, or whatever its weight when the API keeps no blob store,
 * and otherwise every file by hash, after uploading the files the API lacks (see
 * `docs/method-trees.md`). A `directory` is listed by the `mthds` package's lister under the
 * MTHDS standard's membership rule, so a run's inputs file (`inputs.json`, `inputs.toml`) never
 * travels with the method. A `files` map, a `tree` or `contents` holding no file is refused, as
 * the standard refuses a tree holding no file; an empty `directory` is absent.
 */
export type PipelexRunOptions = RunOptions &
  MethodTreeForms &
  PipelexApiRunExtensions &
  PipelexHostedRunExtensions;

/**
 * What a run start sends beside its body: the request's own headers, which no run argument
 * reaches. Each is camelCase, since none of them is a wire field of the run request.
 */
export interface PipelexStartRequestOptions {
  /**
   * The start's idempotency key, sent as the `Idempotency-Key` header of `POST /v1/start`, and
   * not sent at all when absent or `null`. Generate one per run the caller means to start (a
   * `crypto.randomUUID()` is a good key), and keep it, with every other option unchanged, across
   * that start's retries.
   *
   * The hosted API binds the key to the run the first request starts, before it dispatches it, so
   * the same start sent again under the same key is answered with that run's acknowledgement and
   * starts nothing, whatever became of the first attempt, for 24 hours. A failed start whose
   * `runMayHaveStarted` is true can therefore be sent again unchanged, and recovers the run instead
   * of paying for a second one. The same key with a different body is refused (`409` `conflict`),
   * as is a key whose earlier request is still being handled (`409` `idempotency_key_in_use`,
   * retryable: send it again under the same key in a few seconds); see `docs/errors.md`. A bare
   * runner ignores the header.
   *
   * A key is 1 to 255 visible ASCII characters (`!` to `~`, so no space); anything else, an empty
   * string included, is a `RequestArgumentError` before any request is sent, since a start sent
   * without the key the caller asked for would lose the protection silently.
   */
  idempotencyKey?: string | null;
}

/**
 * `start()` / `startAndWaitForResult()` options — the same, for the durable path, plus the start
 * request's own `idempotencyKey`.
 */
export type PipelexStartOptions = StartOptions &
  MethodTreeForms &
  PipelexApiRunExtensions &
  PipelexHostedRunExtensions &
  PipelexStartRequestOptions;

/**
 * The method selector `validate()` takes in place of the method's tree, and the whole of what it
 * takes — declared beside the other wire shapes in `./models.js` and re-exported here, the import
 * path consumers have always used.
 */
export type { PipelexValidateSource, ValidateMethodSelector };

/** `validate()`'s last argument: the presentation it asks for, and the call's own transport. */
export interface ValidateOptions {
  /**
   * Validate presentation hints, a list of view-format tokens. The client always adds
   * `"markdown"`, so both arms carry `rendered_markdown`.
   */
  render?: string[];
  /** Structured-view opt-in tokens, e.g. `["input_form", "output_form"]`; sent only when given. */
  views?: string[];
  /**
   * Per-call request ceiling; defaults to the 20-min execute ceiling. A positive number
   * no larger than 2147483647, the longest delay a timer honours, else a `RangeError`.
   */
  timeoutMs?: number;
  /**
   * Caller-driven cancellation; the abort reason propagates untouched. It is also read between
   * the steps a `directory`, `contents` or `tree` costs before the request (the listing, each
   * read, the version handshake, the blob route and each upload).
   */
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
  /**
   * The client's request ceiling, in milliseconds: the time limit of a request given no
   * `timeoutMs` of its own, the blocking `execute`, a `start` carrying its method and a save
   * carrying a method's tree (`createMethod`, `writeDraft`) among them, and of each transfer of a method's file to or from storage, an upload before a save or a
   * download by `writeMethodTree`. Defaults to 20 minutes, the runner's blocking execute ceiling.
   * A positive number no larger than 2147483647, the longest delay a timer honours, else a
   * `RangeError` at construction.
   */
  requestTimeoutMs?: number;
}

/** Decoders of an answer's bytes: the strict one tells a body that is not UTF-8. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const LENIENT_UTF8 = new TextDecoder("utf-8");

/** Low-level transport over a generic fetch, before status interpretation. */
interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  /** The body as text, a byte that is not UTF-8 read as U+FFFD, as `Response.text()` reads it. */
  body: string;
  /** Whether the body's bytes are UTF-8, which a JSON answer must be (RFC 8259). */
  utf8: boolean;
  /**
   * Whether the body carries signed links, each a bearer credential: an error built from such an
   * answer holds its body with every link hidden (`redactSignedLinks`) and no `cause`, since a
   * parse failure can quote the text it failed on.
   */
  carriesLinks?: boolean;
}

/**
 * How a 2xx answer's JSON text becomes a value: `readJson` for every answer but one carrying a
 * person's data, which is read with `parseExactJson`, since an integer in it may be one a double
 * cannot hold: a method example (its inputs), a run's record (its inputs), a run's results and the
 * blocking execute's answer (its outputs and working memory).
 */
type JsonReader = (text: string) => unknown;

/**
 * `JSON.parse`, the `JsonReader` an answer is read with unless its route names another; the
 * answer's text is held to the protocol's rules first (`readAnswerAt`), so `parseJsonBody`'s
 * reading is the one returned.
 */
const readJson: JsonReader = (text) => JSON.parse(text) as unknown;

/**
 * What `JSON.parse` throws for a text, `undefined` when it reads it: the `cause` of an answer
 * whose body is not JSON the protocol reads, which is `JSON.parse`'s own `SyntaxError` for a body
 * that is not JSON at all, and none for JSON the protocol refuses, nested too deeply or holding a
 * number past the range of a double.
 */
function jsonParseFailure(text: string): unknown {
  try {
    JSON.parse(text);
  } catch (err) {
    return err;
  }
  return undefined;
}

/** HTTP methods the client issues — the product routes add PUT/PATCH/DELETE. */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Whether a request may create a run, which the transport hands to the errors it builds so that
 * they say whether the run may have started (`runMayHaveStarted`). Only `start` and `execute` set
 * it, with `STARTS_RUN`; every other request leaves it unset.
 */
interface RunCreation {
  mayStartRun?: boolean;
}

const STARTS_RUN: RunCreation = Object.freeze({ mayStartRun: true });

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
 * - **run lifecycle** (`getRunStatus` / `getRunProgress` / `getRunResult` /
 *   `waitForResult`) — the durable polling extension that survives long runs and
 *   lets a caller resume by id. Served only by a deployment that includes the
 *   platform block (the Pipelex Hosted API); a bare `pipelex-api` runner 404s those
 *   routes, which the lifecycle methods translate into a clear
 *   `RunLifecycleUnavailableError`.
 *
 * Implements `MTHDSProtocol<DictPipeOutput>` so the protocol-execution methods
 * stay shaped like the standard's wire surface (`mthds/protocol`), all but
 * `validate`, whose verdict is the one the hosted plane answers: since protocol
 * `2.0.0` the protocol's verdict lists its faults as problem items, which the
 * hosted plane does not send yet (see `PipelexValidationResult`). The Pipelex
 * extensions (the crate and tools routes, the run lifecycle) ride on top.
 */

/**
 * A request's body as the JSON text it is sent as, written by `stringifyExactJson` in one pass,
 * so a `bigint` read from an answer carrying a person's data goes back as its exact digits, and
 * every getter and `toJSON` in the body runs once. A body JSON cannot carry, one holding a cycle
 * or whose own `toJSON` throws for instance, is the caller's argument: it is refused with
 * `RequestArgumentError`, the failure as its `cause`, before anything is sent, and `method` and
 * `url` name the request in the message.
 */
function requestBodyText(method: HttpMethod, url: string, body: unknown): string {
  try {
    return stringifyExactJson(body);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RequestArgumentError(
      `The body of ${method} ${new URL(url).pathname} cannot be written as JSON, so nothing was ` +
        `sent: ${reason}`,
      { cause: err },
    );
  }
}

/** A query parameter of a product list route; an array is sent as one repeated parameter per value. */
type ProductQueryValue = string | number | boolean | readonly string[] | undefined;

/**
 * The query string of a product list route, `?` and its parameters in the order given, or `""`
 * when none is kept, as the Python SDK's `_product_query` builds it. Each entry is kept on
 * presence (`!== undefined`), never truthiness: omission means the caller did not ask, while an
 * explicit empty `q`, cursor or date is bad input the API should refuse, not something to drop
 * into an unfiltered query that returns everything and reads as working. `false` is a filter of
 * its own, sent as `false`, and an array is sent as one repeated parameter per value.
 */
function productQuery(params: Readonly<Record<string, ProductQueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === "object") for (const item of value) search.append(key, item);
    else search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** `items` joined as a sentence names them, the last after `conjunction`: `a`, `a or b`, `a, b or c`. */
function inWords(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** What each id a route puts in its path is, as a refusal of it names it. */
const METHOD_ID_ARGUMENT = "a method id, the method's non-empty bare catalog id";
const EXAMPLE_ID_ARGUMENT = "an example id, the example's non-empty `example_id`";
const RUN_ID_ARGUMENT = "a run id, the run's non-empty `pipeline_run_id`";
const ORG_ID_ARGUMENT = "an organization id, the organization's non-empty `org_id`";
const API_KEY_ID_ARGUMENT = "an API key id, the key's non-empty `id`";

/** What the run id of each example write is, as a refusal of it names it. */
const CREATE_RUN_ID_ARGUMENT =
  "a run_id naming a run of this method that used these inputs, a non-empty string, or none";
const RECORD_RUN_ID_ARGUMENT =
  "a run_id naming a run of this method that used the example's inputs, a non-empty string";

/**
 * The refusal of an argument a call cannot take, worded as every such refusal is:
 * `<call>() takes <what>; got <got>.`, with what made it unusable as `cause` when there is one.
 */
function argumentRefusal(
  call: string,
  what: string,
  got: string,
  cause?: unknown,
): RequestArgumentError {
  const message = `${call}() takes ${what}; got ${got}.`;
  return new RequestArgumentError(message, cause === undefined ? undefined : { cause });
}

/**
 * A caller's id, checked to be a non-empty string: the one check every id a call takes goes
 * through, whether it enters a path (`idPathSegment`) or a body (a run id an example write
 * records). Anything else is refused with `RequestArgumentError` before anything is sent, `call`
 * naming the method in the message and `what` the id it takes.
 */
function requireNonEmptyId(value: unknown, call: string, what: string): string {
  if (typeof value === "string" && value !== "") return value;
  let got: string;
  if (typeof value === "string") got = "an empty string";
  else got = value === null ? "null" : typeof value;
  throw argumentRefusal(call, what, got);
}

/**
 * A caller's value as the refusal of a number argument names it: a number by its value, anything
 * else by its type, as `requireNonEmptyId` names a value, and `null` as itself. Never by `String`,
 * which throws for an object with no prototype and would replace the refusal with a `TypeError`.
 */
function describeNumberArgument(value: unknown): string {
  if (typeof value === "number") return String(value);
  return value === null ? "null" : typeof value;
}

/**
 * A caller's id as one segment of a route's path, percent-encoded: the one place an id enters a
 * path. `encodeURIComponent` escapes every character a path gives meaning to but the dot, so an id
 * of `.` or `..` would reach the URL as a dot segment, which the URL resolves before the request
 * leaves: `methods/mt_x/examples/..` is sent as `methods/mt_x/`, and deleting that "example"
 * would erase the method. An empty id addresses the route above it the same way, `runs/` for a
 * run. So a value that is not a non-empty string (`requireNonEmptyId`) and a dot segment are each
 * refused before anything is sent, and so is a string holding a lone surrogate, which has no
 * UTF-8 spelling and so no percent-encoding: `encodeURIComponent` throws a `URIError` for it.
 * `call` names the method in the message and `what` the id it takes. An id spelling a dot in
 * percent-encoding (`%2e`) is no dot segment once its `%` is escaped.
 */
function idPathSegment(value: unknown, call: string, what: string): string {
  const id = requireNonEmptyId(value, call, what);
  if (id === "." || id === "..") {
    throw argumentRefusal(
      call,
      what,
      `"${id}", a dot segment, which the URL would resolve into another route's path`,
    );
  }
  try {
    return encodeURIComponent(id);
  } catch (err) {
    const got = "a string holding a lone surrogate, which a URL cannot carry";
    throw argumentRefusal(call, what, got, err);
  }
}

/**
 * The path of a method route, `methods/{id}`, for a bare catalog id, its segment refused as
 * `idPathSegment` refuses one; `call` names the method in the message. The method routes address
 * the method itself, never one of its versions, and the platform does not parse a suffix there:
 * `mt_x@3` would be looked up as an id of its own and answer `404 not_found`, which reads as a
 * method that does not exist. So a suffixed id is refused before anything is sent, saying how to
 * read what it names. Stripping it instead would answer the draft for a caller that named a
 * version.
 */
function methodPath(methodId: string, call: string): string {
  const segment = idPathSegment(methodId, call, METHOD_ID_ARGUMENT);
  if (methodId.includes("@")) {
    throw new RequestArgumentError(
      `"${methodId}" carries a version suffix, and the method routes take a bare catalog id: ` +
        "they address the method itself, never one of its versions. Strip the suffix with " +
        "parseMethodSelector, and read a published version with getMethodVersion.",
    );
  }
  return `methods/${segment}`;
}

/**
 * The path of one saved example, `methods/{id}/examples/{example_id}`, for a bare catalog id and
 * an example id, each refused as `methodPath` and `idPathSegment` refuse one: an empty example id
 * would address the examples list rather than an example, and `..` the method itself. `call`
 * names the method in the message.
 */
function methodExamplePath(methodId: string, exampleId: string, call: string): string {
  const path = methodPath(methodId, call);
  return `${path}/examples/${idPathSegment(exampleId, call, EXAMPLE_ID_ARGUMENT)}`;
}

const isString = (value: unknown): boolean => typeof value === "string";

/**
 * Each field of a `MethodExample`, what it must be, and the check it must pass: every field the
 * Python SDK's model requires, held to the same strict types it holds them to, so both SDKs refuse
 * the same answers, the ones a caller acts on (`example_id`, `inputs`, `input_revision`,
 * `latest_run_id`) among them. `latest_run_id` must be present, `null` saying there is no latest
 * run, and `input_revision` must be a safe integer, so a string, a boolean, a fraction and an
 * integer past the safe range, which `parseExactJson` reads as a `bigint`, are each refused by
 * both. The one spelling they read apart is a revision of `2.0`: JavaScript reads it as the number
 * `2` and cannot tell it from `2`, while the Python SDK refuses the float.
 *
 * Keyed by the fields of `MethodExample` and checked against them by `satisfies`, so a field
 * added to the interface without its row here, or a row naming no field of it, fails to compile.
 * The rows are checked in the order written.
 */
const METHOD_EXAMPLE_FIELDS = {
  example_id: ["a string", isString],
  method_id: ["a string", isString],
  name: ["a string", isString],
  inputs: ["an object", isPlainObject],
  input_revision: ["an integer", (value) => Number.isSafeInteger(value)],
  latest_run_id: ["a string or null", (value) => value === null || isString(value)],
  created_by_user_id: ["a string", isString],
  created_at: ["a string", isString],
  updated_at: ["a string", isString],
} satisfies Record<
  keyof MethodExample,
  readonly [expected: string, fits: (value: unknown) => boolean]
>;

/**
 * The protocol surface `PipelexApiClient` implements as the standard types it: every route but
 * `validate`, whose verdict is Pipelex's own (`PipelexValidationResult`) while the hosted plane
 * answers the verdict that predates the protocol's problem items.
 */
type HostedProtocolSurface = Omit<MTHDSProtocol<DictPipeOutput>, "validate">;

export class PipelexApiClient implements HostedProtocolSurface {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Origin root derived from the base URL — `/health` lives here, not under `/v1`. */
  private readonly originUrl: string;
  /** Cached `/v1/version` handshake outcome — whether the durable lifecycle is served. */
  private lifecycleAvailable: boolean | undefined;
  /**
   * The last `/v1/version` handshake that answered and when it was asked, kept for
   * `HANDSHAKE_TTL_MS` as `mthds`'s `MthdsApiClient` keeps it: what sending a tree reads from it
   * (`blob_store`, the tree limits) changes only with a deploy. A handshake that failed is not
   * kept, so the next call asks again, and a refusal showing it stale drops it sooner
   * (`forgetHandshake`).
   */
  private versionCache: { info: VersionInfo; askedAt: number } | undefined;
  /** The client's request ceiling (`PipelexApiClientOptions.requestTimeoutMs`). */
  private readonly requestTimeoutMs: number;
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
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // A longer delay overflows the timer, which then fires at once as a false timeout.
    if (!isTimerDelay(requestTimeoutMs)) {
      throw new RangeError(
        `"requestTimeoutMs" must be a positive number no larger than ${MAX_TIMER_DELAY_MS}, got ` +
          `${String(requestTimeoutMs)}.`,
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;
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
  private requestHeaders(hasBody: boolean, idempotencyKey?: string): Record<string, string> {
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
    if (idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
    }
    return headers;
  }

  /**
   * Issue one HTTP request and return the raw status/headers/body. Wraps
   * DNS/connect/TLS/timeout failures as `ApiUnreachableError`; a caller-driven
   * abort (Ctrl-C / agent walk-away) propagates as-is so the poll loop can stop
   * cleanly. Non-2xx interpretation is left to the caller. `url` is a fully
   * resolved absolute URL. `mayStartRun` marks a request that may create a run,
   * whose `ApiUnreachableError` then says whether it may have (see `RunCreation`).
   * `idempotencyKey`, already checked by `idempotencyKeyOf`, is sent as the
   * `Idempotency-Key` header; only `start` passes one.
   */
  private async requestRaw(
    method: HttpMethod,
    url: string,
    options: {
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
      idempotencyKey?: string;
    } & RunCreation = {},
  ): Promise<RawResponse> {
    const hasBody = options.body !== undefined;
    // Written before the request is made, so a body JSON cannot carry is refused as the caller's
    // argument rather than caught below and reported as a network failure.
    const bodyText = hasBody ? requestBodyText(method, url, options.body) : undefined;
    const headers = this.requestHeaders(hasBody, options.idempotencyKey);

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
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
        body: bodyText,
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
        { cause: err, mayStartRun: options.mayStartRun === true },
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
   * A methods-catalog route answering one stored method (`createMethod`, `writeDraft`,
   * `renameMethod`), read as `readObjectAnswer` reads it.
   */
  private async requestMethodData(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<MethodData> {
    const res = await this.requestProductAnswer(method, endpoint, body, options);
    return this.readObjectAnswer<MethodData>(method, endpoint, res);
  }

  /**
   * A route answering a saved tree's listing beside what names it (`getMethod`,
   * `getMethodVersion`), read as `readObjectAnswer` reads it, then its `files` checked: a listing
   * that is not an array of `{ path, sha256, size, url, expires_at }`, each a string but `size`, a
   * non-negative integer, is an answer the SDK cannot read, since `writeMethodTree` would write
   * from it. Throws the `ApiResponseError` `unreadableAnswer` builds, `subject` naming the answer.
   */
  private readSavedTree<T extends { files: SavedMethodFile[] }>(
    method: HttpMethod,
    endpoint: string,
    res: RawResponse,
    subject: string,
  ): T {
    const answer = this.readObjectAnswer<Record<string, unknown>>(method, endpoint, res);
    const fault = savedFilesFault(answer.files);
    if (fault !== null) {
      throw this.unreadableAnswer(
        method,
        `/${API_PREFIX}/${endpoint}`,
        res,
        `${subject} whose \`files\` ${fault}`,
      );
    }
    return answer as unknown as T;
  }

  /**
   * A verdict, the `200` a route answers discriminated on `outcome` with the object the verdict
   * is about as one `member`: `publishMethod`'s `method`, `recordMethodExampleLatestRun`'s
   * `example`. The answer is read as `readObjectAnswer` reads it, then an `outcome` that is none
   * of `outcomes` is an answer the SDK cannot read, and so is a `member` that is not an object,
   * the check `readObjectAnswerAt` holds a route's whole answer to: each throws the
   * `ApiResponseError` `unreadableAnswer` builds, `verdict` naming the answer in the message.
   * A route whose member has a reader of its own passes it as `readMember`, which then checks the
   * member in place of that object check, so the member is checked once. `parse` reads the
   * answer's text, `readJson` unless the route names another. Returns the answer, its `outcome`
   * and the member as `subject`, for the route to read further.
   */
  private readVerdict<O extends string, S = Record<string, unknown>>(
    method: HttpMethod,
    endpoint: string,
    res: RawResponse,
    shape: {
      verdict: string;
      outcomes: readonly O[];
      member: string;
      parse?: JsonReader;
      readMember?: (value: unknown) => S;
    },
  ): { answer: Record<string, unknown>; outcome: O; subject: S } {
    const answer = this.readObjectAnswer<Record<string, unknown>>(
      method,
      endpoint,
      res,
      {},
      shape.parse,
    );
    const outcome = answer.outcome as O;
    const subject = answer[shape.member];
    if (!shape.outcomes.includes(outcome)) {
      const expected = inWords(
        shape.outcomes.map((name) => `\`${name}\``),
        "or",
      );
      throw this.unreadableAnswer(
        method,
        `/${API_PREFIX}/${endpoint}`,
        res,
        `${shape.verdict} whose \`outcome\` is not ${expected}`,
      );
    }
    if (shape.readMember !== undefined) {
      return { answer, outcome, subject: shape.readMember(subject) };
    }
    if (!isPlainObject(subject)) {
      throw this.unreadableAnswer(
        method,
        `/${API_PREFIX}/${endpoint}`,
        res,
        `${shape.verdict} whose \`${shape.member}\` is not an object`,
      );
    }
    return { answer, outcome, subject: subject as S };
  }

  /**
   * One page of a cursor-paged product route (`listMethods`, `listMethodVersions`,
   * `listMethodExamples`, `listRuns`), read as the platform always serializes it: `items` an
   * array, `next_cursor` a string or `null`. A page breaking either is an answer the SDK cannot
   * read, so it throws the `ApiResponseError` `unreadableAnswer` builds, `runtime` and not
   * retryable, rather than handing the iterators a page they cannot walk: `items` that is not
   * iterable, or a missing cursor that is neither the end nor a next page, which `iterateRuns`
   * would follow forever. A route reading its rows itself passes `rows`: `parse` reads the page's
   * text, and `item` reads each row, throwing as `unreadableAnswer` does for one it cannot read.
   */
  private async requestPage<T>(
    endpoint: string,
    rows?: { parse: JsonReader; item: (row: unknown, res: RawResponse) => T },
  ): Promise<{ items: T[]; nextCursor: string | null }> {
    const res = await this.requestProductAnswer("GET", endpoint, undefined);
    const page = this.readObjectAnswer<Record<string, unknown>>(
      "GET",
      endpoint,
      res,
      {},
      rows?.parse,
    );
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
    if (rows === undefined) return { items: items as T[], nextCursor };
    return { items: items.map((row: unknown) => rows.item(row, res)), nextCursor };
  }

  /**
   * A route answering one method example (`createMethodExample`, `getMethodExample`,
   * `updateMethodExample`), its answer read with `parseExactJson`, so an integer past the safe
   * range in the inputs is a `bigint` holding its exact digits, and checked by
   * `readMethodExample`.
   */
  private async requestMethodExample(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
  ): Promise<MethodExample> {
    const res = await this.requestProductAnswer(method, endpoint, body);
    const answer = this.readObjectAnswer<Record<string, unknown>>(
      method,
      endpoint,
      res,
      {},
      parseExactJson,
    );
    return this.readMethodExample(method, endpoint, res, answer, "an example");
  }

  /**
   * A method example as `res` carried it, checked against `METHOD_EXAMPLE_FIELDS`: a value that
   * is not an object, or that misses a field the Python SDK's model requires or holds one of
   * another type, is an answer the SDK cannot read, thrown as the `ApiResponseError`
   * `unreadableAnswer` builds, `where` naming the example's place in the answer in the message.
   * Every route answering an example reads it here, the page rows and the latest-run verdict's
   * member included.
   */
  private readMethodExample(
    method: HttpMethod,
    endpoint: string,
    res: RawResponse,
    value: unknown,
    where: string,
  ): MethodExample {
    const path = `/${API_PREFIX}/${endpoint}`;
    if (!isPlainObject(value)) {
      throw this.unreadableAnswer(method, path, res, `${where} that is not an object`);
    }
    for (const [field, [expected, fits]] of Object.entries(METHOD_EXAMPLE_FIELDS)) {
      if (!fits(value[field])) {
        throw this.unreadableAnswer(
          method,
          path,
          res,
          `${where} whose \`${field}\` is not ${expected}`,
        );
      }
    }
    return value as unknown as MethodExample;
  }

  /**
   * Issue a product request and return its 2xx answer, a non-2xx thrown as `ApiResponseError`.
   * The request takes the poll timeout unless `options.timeoutMs` gives another.
   */
  private async requestProductAnswer(
    method: HttpMethod,
    endpoint: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<RawResponse> {
    const res = await this.requestRaw(method, this.url(endpoint), {
      body,
      timeoutMs: options.timeoutMs ?? POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError(method, endpoint, res);
    }
    return res;
  }

  private throwApiResponseError(
    method: HttpMethod,
    endpoint: string,
    res: RawResponse,
    run: RunCreation = {},
  ): never {
    this.throwApiResponseErrorAt(method, `/${API_PREFIX}/${endpoint}`, res, run);
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
    run: RunCreation = {},
    parse: JsonReader = readJson,
  ): T {
    return this.readObjectAnswerAt<T>(method, `/${API_PREFIX}/${endpoint}`, res, run, parse);
  }

  /**
   * The JSON body of a 2xx answer, naming the route by its `path` from the origin as a refusal
   * does, its text read by `parse`: `JSON.parse`, or `parseExactJson` for an answer carrying a
   * person's data. A body that is not UTF-8, or not JSON, an empty one included, is an answer the
   * SDK cannot read, so it throws the `ApiResponseError` `unreadableAnswer` builds, with the parse
   * failure as `cause`; so is a body holding a number `parseExactJson` cannot read exactly on this
   * runtime (`ExactJsonUnsupportedError`), rather than read rounded.
   *
   * Every body is first held to the rules the protocol reads a problem body by (`parseJsonBody`,
   * as `pipelex-sdk` does with `decode_json_as_written`): JSON nested deeper
   * than `MAX_BODY_NESTING`, or holding a number past the range of a double, such as `1e999`, which
   * `JSON.parse` would read as `Infinity`, is not JSON the protocol reads, and is an answer the SDK
   * cannot read too, with `JSON.parse`'s own failure as `cause` when it has one.
   * The one place a success body is parsed.
   */
  private readAnswerAt<T>(
    method: HttpMethod,
    path: string,
    res: RawResponse,
    run: RunCreation = {},
    parse: JsonReader = readJson,
  ): T {
    if (!res.utf8) {
      throw this.unreadableAnswer(method, path, res, "a body that is not UTF-8", undefined, run);
    }
    const reading = parseJsonBody(res.body);
    if (!reading.ok) {
      const what = res.body ? "a body that is not JSON" : "an empty body where JSON was expected";
      throw this.unreadableAnswer(method, path, res, what, jsonParseFailure(res.body), run);
    }
    if (parse === readJson) return reading.value as T;
    try {
      return parse(res.body) as T;
    } catch (err) {
      let what: string;
      if (err instanceof ExactJsonUnsupportedError) {
        what =
          "a body holding a number past Number.MAX_SAFE_INTEGER, which this runtime cannot read " +
          "exactly";
      } else what = res.body ? "a body that is not JSON" : "an empty body where JSON was expected";
      throw this.unreadableAnswer(method, path, res, what, err, run);
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
    run: RunCreation = {},
    parse: JsonReader = readJson,
  ): T {
    const answer = this.readAnswerAt<unknown>(method, path, res, run, parse);
    if (!isPlainObject(answer)) {
      throw this.unreadableAnswer(
        method,
        path,
        res,
        "a body that is not an object",
        undefined,
        run,
      );
    }
    return answer as T;
  }

  /**
   * The `ApiResponseError` of a 2xx answer the SDK cannot read, its message
   * `API <method> <path> answered <status> with <what>`: the answer's status, its raw text as
   * `responseBody`, no hosted problem member but the `X-Request-ID` header, the failure that made it
   * unreadable as `cause`, and the verdict the fallback gives a 2xx, `runtime` and not retryable.
   * An answer that carries signed links (`RawResponse.carriesLinks`) is held with every link
   * hidden, and with no `cause`, which could quote one. On a request that may create a run, the run may have started: the server accepted it.
   */
  private unreadableAnswer(
    method: HttpMethod,
    path: string,
    res: RawResponse,
    what: string,
    cause?: unknown,
    run: RunCreation = {},
  ): ApiResponseError {
    const carriesLinks = res.carriesLinks === true;
    return new ApiResponseError(
      `API ${method} ${path} answered ${res.status} with ${what}`,
      this.baseUrl,
      res.status,
      res.statusText,
      carriesLinks ? redactSignedLinks(res.body) : res.body,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        cause: carriesLinks ? undefined : cause,
        details: { requestId: nonEmptyHeader(res.headers, REQUEST_ID_HEADER) },
        headers: res.headers,
        mayStartRun: run.mayStartRun === true,
      },
    );
  }

  /**
   * Throw the `ApiResponseError` of a non-2xx answer, naming the route by its `path` from the
   * origin (`/v1/...`, or `/health` for the liveness probe).
   */
  private throwApiResponseErrorAt(
    method: HttpMethod,
    path: string,
    res: RawResponse,
    run: RunCreation = {},
  ): never {
    const { errorType, serverMessage, validationErrors, code, details, document } = parseErrorBody(
      res.body,
    );
    // The body's `request_id` wins; the header is the fallback for a response whose body
    // carries none (a gateway error page, a non-problem body).
    const requestId = details.requestId ?? nonEmptyHeader(res.headers, REQUEST_ID_HEADER);
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
      {
        details: { ...details, requestId },
        problemDocument: document,
        headers: res.headers,
        mayStartRun: run.mayStartRun === true,
      },
    );
  }

  /**
   * Translate a "route absent" 404 (a bare pipelex-api with no platform block)
   * into a clear `RunLifecycleUnavailableError`. The platform's own 404s (run
   * not found / cross-org) carry a structured error envelope (a `code` field)
   * and are left for normal handling. `explanation` replaces the sentence saying
   * why the route is missing, for a route a hosted API may also lack.
   */
  private throwIfLifecycleUnavailable(
    res: RawResponse,
    url: string,
    explanation = "PIPELEX_BASE_URL points at a bare runner that does not serve it.",
  ): void {
    if (res.status !== 404) return;
    if (!isMissingRoute404(res.body)) return;
    throw new RunLifecycleUnavailableError(
      `The durable run lifecycle is not available: ${url} returned 404. Run polling is a ` +
        `hosted-API extension (/${API_PREFIX}/${RUNS}/*), not part of the MTHDS Protocol; ` +
        explanation,
      this.baseUrl,
    );
  }

  /**
   * Map the protocol's optional 202 execute degrade to a typed
   * error. Hosted does not emit 202 today, but the protocol permits it;
   * raising a typed error (with the `pipeline_run_id` + `Location` + `Retry-After`
   * hints) beats a generic parse failure on an unexpected body shape.
   *
   * The 202 must name the run it accepted, as `start`'s acknowledgement must: one whose body is
   * not JSON, or names no run (an empty id included), leaves the caller a run it cannot follow, so it is an answer the
   * SDK cannot read, which may have started a run, never a `RunStillRunningError` without an id.
   * The Python SDK reads the same answers the same way.
   */
  private throwIfExecuteDegraded(res: RawResponse): void {
    if (res.status !== 202) return;
    const ack = this.readObjectAnswer<{ pipeline_run_id?: unknown }>(
      "POST",
      "execute",
      res,
      STARTS_RUN,
    );
    const runId = ack.pipeline_run_id;
    if (typeof runId !== "string" || runId === "") {
      throw this.unreadableAnswer(
        "POST",
        `/${API_PREFIX}/execute`,
        res,
        "a body that is not the answer the route returns",
        undefined,
        STARTS_RUN,
      );
    }
    throw new RunStillRunningError(
      `execute() was accepted asynchronously (202): run ${runId} is still ` +
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
   *
   * The answer is read with `parseExactJson`, so an integer past `Number.MAX_SAFE_INTEGER` in the
   * working memory, the main output included, is a `bigint` holding its exact digits.
   *
   * The method's tree, given as a `directory`, `contents` or `tree`, is prepared before the
   * request: listed, read, and sent inline or by hash after uploading the files the API lacks (see
   * `PipelexRunOptions`). A tree this client refuses (two forms, no file, a directory it cannot
   * list) is a `RequestArgumentError`, and a file that fails to upload a `MethodFileTransferError`,
   * each before the run is asked.
   */
  async execute(options: PipelexRunOptions): Promise<PipelexExecuteResult> {
    return this.executeRun(options);
  }

  /**
   * `execute`, stopped by `signal` before each step of the tree's preparation and right before the
   * request is sent, never during it, since a request sent may have started a run. `sending` is
   * the tree already prepared, which the blocking fallback of `startAndWaitForResult` sends as the
   * start sent it rather than preparing it again.
   */
  private async executeRun(
    options: PipelexRunOptions,
    signal?: AbortSignal,
    sending?: PreparedRunTree,
  ): Promise<PipelexExecuteResult> {
    const parts = this.runParts("execute", options);
    const source =
      sending?.source ?? (await this.treeToSend("execute", parts.forms, REQUEST_SENDING, signal));
    // Timed on the monotonic clock, which a change of the system's time does not move, from the
    // request itself: the tree's preparation, uploads included, is no part of the gateway's cut-off.
    // Set when the request is sent, which the answer read below always follows.
    let sentAt = 0;
    const res = await this.postMethodRequest(
      source,
      "execute",
      REQUEST_SENDING,
      { signal },
      async (files) => {
        const request = runRequestBody("execute", options, files, parts);
        throwIfAborted(signal);
        sentAt = performance.now();
        try {
          return await this.requestRaw("POST", this.url("execute"), {
            body: request,
            ...STARTS_RUN,
          });
        } catch (err) {
          throw executeCutOff(err, sentAt);
        }
      },
      sending?.initial,
    );
    try {
      this.throwIfExecuteDegraded(res);
      if (res.status < 200 || res.status >= 300) {
        this.throwApiResponseError("POST", "execute", res, STARTS_RUN);
      }
      // Wrap the base result in the enriched subtype (adds the `.main_stuff` accessor; the
      // `main_stuff_name` extension + working memory ride `pipe_output`). Read exactly: the working
      // memory holds the run's inputs and outputs.
      const answer = this.readObjectAnswer<DictRunResultExecute>(
        "POST",
        "execute",
        res,
        STARTS_RUN,
        parseExactJson,
      );
      if (!isCompletedRunAnswer(answer)) {
        throw this.unreadableAnswer(
          "POST",
          `/${API_PREFIX}/execute`,
          res,
          "a body that is not the answer the route returns",
          undefined,
          STARTS_RUN,
        );
      }
      return new PipelexExecuteResult(answer);
    } catch (err) {
      // The hosted gateway terminates synchronous requests at ~30s. A run that exceeds that comes
      // back as a gateway 503/504 (or a client abort) — translated into a clear, actionable error
      // pointing at start+poll.
      throw executeCutOff(err, sentAt);
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
   *
   * `options.idempotencyKey` is sent as the `Idempotency-Key` header, and nothing
   * is sent without it: the hosted API answers the same start sent again under the
   * same key with the run the first one started, so a failure whose
   * `runMayHaveStarted` is true can be retried unchanged (see
   * `PipelexStartRequestOptions`). A malformed key is a `RequestArgumentError`
   * before anything is sent.
   *
   * The method's tree is prepared before the request as `execute` prepares it. The prepared body
   * is the same for the same tree, so a start retried under its idempotency key sends the body the
   * key was bound to. A start whose hash entries name a blob the API does not hold yet is refused
   * with a `422` `missing_blobs`, which releases its key: send it again unchanged, which asks the
   * blob route and uploads what is missing first.
   */
  async start(options: PipelexStartOptions): Promise<PipelexRunResultStart> {
    return this.startRun(options);
  }

  /**
   * `start`, stopped by `signal` as `executeRun` is, `sending` being the tree already prepared.
   */
  private async startRun(
    options: PipelexStartOptions,
    signal?: AbortSignal,
    sending?: PreparedRunTree,
  ): Promise<PipelexRunResultStart> {
    const idempotencyKey = idempotencyKeyOf(options);
    const parts = this.runParts("start", options);
    const source =
      sending?.source ?? (await this.treeToSend("start", parts.forms, REQUEST_SENDING, signal));
    const url = this.url("start");
    const res = await this.postMethodRequest(
      source,
      "start",
      REQUEST_SENDING,
      // A start under a key is bound to the refusal the platform stores, so it is not sent again.
      { signal, retryTooLarge: idempotencyKey === undefined },
      async (files) => {
        const request = runRequestBody("start", options, files, parts);
        // `start` returns a 202 fast, so the poll timeout normally fits — with exceptions that get
        // the blocking-execute ceiling instead. A method's tree sent inline can make the request
        // *body* multi-megabyte when the API keeps no blob store, and so can a bundle riding
        // `extra` as a runner's `mthds_contents` or `bundle_b64`, as the CLI sends one; the whole
        // upload is charged against this budget — the same payload must not time out on the
        // durable path yet succeed on the fallback. And a `method_ref` start makes the server FETCH
        // the package before the ack (provenance rides the 202), whose clone timeout runs well past
        // 30s on a cold cache — aborting it here would surface as `ApiUnreachableError`, blaming
        // the network for a healthy server that is still cloning.
        const needsLongCeiling =
          files !== undefined ||
          parts.api.method_ref !== undefined ||
          carriesExtraBundle(parts.extensions);
        throwIfAborted(signal);
        return this.requestRaw("POST", url, {
          body: request,
          timeoutMs: needsLongCeiling ? this.requestTimeoutMs : POLL_REQUEST_TIMEOUT_MS,
          idempotencyKey,
          ...STARTS_RUN,
        });
      },
      sending?.initial,
    );
    // A bare runner with no run store 404s here just as it does on the result
    // routes — surface the same clear `RunLifecycleUnavailableError` (and let
    // `startAndWaitForResult` fall back to the blocking `execute`).
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "start", res, STARTS_RUN);
    }
    const ack = this.readObjectAnswer<PipelexRunResultStart>("POST", "start", res, STARTS_RUN);
    // The acknowledgement's one job is to name the run: without its id, the run the server
    // accepted is lost to the caller, as surely as behind a body that is not JSON, and an empty id
    // names no run either. Worded as the Python SDK words an answer its model refuses.
    if (typeof ack.pipeline_run_id !== "string" || ack.pipeline_run_id === "") {
      throw this.unreadableAnswer(
        "POST",
        `/${API_PREFIX}/start`,
        res,
        "a body that is not the answer the route returns",
        undefined,
        STARTS_RUN,
      );
    }
    return ack;
  }

  /**
   * Parse, validate, and dry-run a method — `POST /v1/validate`.
   *
   * `/validate` is a diagnostic endpoint: every produced verdict rides a **200**,
   * discriminated on `is_valid`. This returns the `PipelexValidationResult` union
   * verbatim — `is_valid: true` ⇒ the typed `PipelexValidationReport` (structural
   * artifacts), `is_valid: false` ⇒ a `PipelexInvalidReport` (`validation_errors[]`).
   * An invalid method is NOT thrown — the caller pattern-matches `is_valid`. Only a
   * *no-verdict* condition (a malformed request, a tree the route refuses, auth, a
   * server fault) is non-2xx and surfaces as `ApiResponseError`.
   *
   * `source` names WHAT is validated, in exactly one form — the strict tooling XOR
   * (the routes are stateless, so there is no linkage exception; a second selector
   * is a request-shape `422`, refused here first with a `RequestArgumentError`):
   *
   * - **the method's tree**, in one of the four forms of `MethodTreeForms`: a
   *   `directory` the `mthds` package's lister lists under the standard's
   *   membership rule (Node only), `contents` by tree path, a listed `tree`, or the
   *   protocol's `files` map, sent as given. A `directory`, `contents` or `tree` is
   *   sent as the `files` map, inline or by hash, exactly as a run sends it (see
   *   `PipelexRunOptions`). Every `.mthds` file of the tree is judged, named by its
   *   tree path in the diagnostics' `source`, and every other file is one a step may
   *   read, such as a `PipeDocGen` step's template file, whose template check's
   *   findings ride the valid arm's `warnings`;
   * - **`{ method_ref }`** — a published method's address, resolved by the
   *   server (pipelex-api >= 0.21.0) through the same fetch path as a
   *   `method_ref` run, the package's real tree paths feeding the diagnostics'
   *   source labels;
   * - **`{ method_id }`** — a stored method's catalog id, hosted-only: the
   *   platform resolves the version it names and sends that version's tree to the
   *   runner (a bare runner rejects the request as carrying no source it
   *   understands). A bare `mt_…` validates the latest published version,
   *   `mt_…@<n>` version `n` and `mt_…@draft` the draft.
   *
   * A selector-resolution failure (fetch failure, no package at the address, an
   * unknown or foreign-org id, a bare id of a method never published, `409`
   * `method_not_published`, a version never published, `404`
   * `method_version_not_found`, or a malformed suffix, `422`) is a non-2xx
   * `ApiResponseError` — never an `is_valid: false` verdict, which is reserved
   * for actual MTHDS content.
   *
   * `allowSignatures` tolerates unimplemented pipe signatures, as the protocol's
   * `validate(source, allowSignatures)` does: they surface as `pending_signatures`
   * and `is_runnable`, never as an error.
   *
   * `options.render` is the Pipelex-API presentation hint — a list of view-format
   * tokens. This client always asks for Markdown so both valid results and produced
   * validation-error verdicts carry `rendered_markdown`; callers may add more tokens.
   * Unknown tokens are server-side lenient-ignored (never a 422).
   *
   * `options.views` is the sibling opt-in for *structured* views where `render`
   * carries *rendered text*. The two lists are independent, each resolving its own
   * tokens against its own supported set, and each supported token adds a same-named
   * top-level field to the valid arm — `input_form` and `output_form`. Unlike
   * `render`, this client sends `views` ONLY when the caller asks: the point of an
   * opt-in view is that the default response stays byte-identical, and the
   * highest-frequency consumers (hook pipelines, CI gates, agent loops) never pay for
   * bytes they discard.
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
    source: PipelexValidateSource,
    allowSignatures = false,
    options: ValidateOptions = {},
  ): Promise<PipelexValidationResult> {
    // The illegal shapes are partly compile errors for typed callers; the runtime checks back them
    // for untyped (JS) callers — a typed `RequestArgumentError`, never a native TypeError off a
    // null source — mirroring the server's strict tooling XOR instead of silently picking.
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
      throw new RequestArgumentError(
        "validate() takes the method as an object naming exactly one of directory, contents, " +
          "tree, files, method_ref or method_id.",
      );
    }
    const forms = protocolTreeForms("validate", source);
    const methodRef = nonEmptyString(source.method_ref);
    const methodId = nonEmptyString(source.method_id);
    const given: string[] = treeFormsGiven(forms);
    if (methodRef !== undefined) given.push("method_ref");
    if (methodId !== undefined) given.push("method_id");
    if (given.length !== 1) {
      throw new RequestArgumentError(
        "validate() takes exactly one of the method's tree (directory, contents, tree or files), " +
          `method_ref or method_id; got ${given.length === 0 ? "none" : given.join(" and ")}.`,
      );
    }
    const signal = options.signal;
    const sent = await this.treeToSend("validate", forms, REQUEST_SENDING, signal);
    const res = await this.postMethodRequest(
      sent,
      "validate",
      REQUEST_SENDING,
      { signal },
      (files) => {
        const body: Record<string, unknown> = { allow_signatures: allowSignatures };
        if (files != null) body.files = files;
        if (methodRef !== undefined) body.method_ref = methodRef;
        if (methodId !== undefined) body.method_id = methodId;
        body.render = withValidateMarkdownRender(options.render);
        if (options.views !== undefined) {
          body.views = options.views;
        }
        throwIfAborted(signal);
        return this.requestRaw("POST", this.url("validate"), {
          body,
          timeoutMs: options.timeoutMs,
          signal,
        });
      },
    );
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "validate", res);
    }
    return this.readObjectAnswer<PipelexValidationResult>("POST", "validate", res);
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
   * timeout. The internal raise is `crateRequestTimeoutMs`'s: the fetch-sized budget a
   * crate route gets when its closure is a `method_ref`, because the server may clone a
   * repository before it answers. It is matched to what the request costs, not a
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
   * 2. The input is **bounded server-side** — the deployment caps a request's tree by its
   *    count of files, a size per file, a total and the bytes it carries inline, all
   *    announced by its `/v1/version` handshake — and none of these routes runs inference.
   *    The upload those limits allow is what `crateRequestTimeoutMs` budgets for, not the
   *    server's work.
   * 3. On the hosted path an override would be **inert**: the gateway caps responses at
   *    ~30s (see `POLL_REQUEST_TIMEOUT_MS` above), so raising `timeoutMs` would still be
   *    cut off upstream, just with a less honest error.
   *
   * If a static route ever genuinely needs longer, give the WHOLE static family one
   * uniform transport-options parameter in a single pass — do not bolt it onto one
   * route.
   *
   * The one exception is the crate family's `signal` (`CrateRouteOptions`), given to all three
   * crate routes at once: a `directory`, `tree` or `contents` can cost the listing, the version
   * handshake, the blob route and uploads before the request, client-side work a caller such as
   * `prepareInputs` must be able to stop. It is read between those steps and stops nothing in flight, so it is no
   * transport option and the reasons above still hold.
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
   * Check one model reference — `GET /v1/models/check?reference=<ref>[&type=<category>]`, a
   * Pipelex API extension served by any `pipelex-api` runner from pipelex 0.78.0 and on the
   * hosted API.
   *
   * Answers whether `reference` resolves on the runner, as what kind and to which model, from
   * the parser and the deck lookups a validation runs. `reference` is written as a method's
   * `model` field writes it — `$preset`, `@alias`, `~waterfall`, a bare handle, or a
   * spelled-out namespace (`handle:gpt-4o`) — and is sent percent-encoded. `category` checks
   * in that category alone; without it, the check covers every one.
   *
   * Returns a **200 verdict** whatever the resolution: a reference that resolves nowhere is
   * `resolution: "not_found"` with the names it may have meant, never a thrown error. Narrow
   * on `kind` to read the shape of `matches`. A request that cannot produce a verdict throws
   * the typed `ApiResponseError`, a `422` whose `errorType` says why: `InvalidModelReference`
   * (a blank reference, a sigil or a namespace alone, or one past the runner's length limit),
   * `InvalidModelCategory` (an unknown `type`) or `ValidationError`. None of that is checked
   * here, so the runner's rule is the only one.
   */
  async checkModelReference(
    reference: string,
    category?: ModelCheckCategory,
  ): Promise<ModelReferenceVerdict> {
    const query = new URLSearchParams({ reference });
    if (category !== undefined) {
      query.set("type", category);
    }
    const endpoint = `models/check?${query.toString()}`;
    const res = await this.requestRaw("GET", this.url(endpoint), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    return this.readObjectAnswer<ModelReferenceVerdict>("GET", endpoint, res);
  }

  /**
   * Protocol + implementation versions — `GET /v1/version` (always public).
   * The handshake for feature detection (hosted extensions or not).
   */
  async version(): Promise<VersionInfo> {
    return this.requestVersion();
  }

  /** `GET /v1/version`, as `version` asks it, stopped by `signal`. */
  private async requestVersion(signal?: AbortSignal): Promise<VersionInfo> {
    const res = await this.requestRaw("GET", this.url("version"), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal,
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
  // take no `timeoutMs` — see the policy note on `requestExtension` before adding one
  // here. Their `signal` (`CrateRouteOptions`) is that note's one exception: it is read
  // between the steps that prepare a `directory`, `tree` or `contents`, and stops nothing in
  // flight.

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
   * The closure arrives in exactly one of three forms: the method's tree, as the
   * protocol's `files` map or as a `directory`, `tree` or `contents` the client sends
   * inline when small and by hash otherwise (see {@link CrateRequestBase}); an
   * address-form `method_ref` (server-resolved, pipelex-api >= 0.21.0; the registry form
   * stays a `501`); or a hosted `method_id` (platform-resolved — see
   * {@link PipelexHostedToolingExtensions}). An empty map or string is absent.
   *
   * `options.signal` stops the call between the steps a `directory`, `tree` or `contents`
   * costs before the request — the listing, the version handshake, the blob route, each
   * read and upload of a missing blob — and before the request itself, throwing the
   * abort; a request already sent runs to its end. A blob that fails to upload throws
   * `MethodFileTransferError`, and a tree this client refuses to send (no file, two
   * forms, a directory it cannot list, a `contents` value that is neither text nor
   * bytes) `RequestArgumentError`, each before the route is asked.
   */
  async resolve(
    request: ResolveRequest,
    options: CrateRouteOptions = {},
  ): Promise<ResolveResponse> {
    return this.crateRequest<ResolveResponse>("resolve", "resolve", request, options);
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
  async codegen(
    request: CodegenRequest,
    options: CrateRouteOptions = {},
  ): Promise<CodegenResponse> {
    return this.crateRequest<CodegenResponse>("codegen", "codegen", request, options);
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
   * Selection: the request's qualified `pipe_ref`, else the `main_pipe` of the
   * `METHODS.toml` at the tree's root, sent in the tree or fetched with a package, else the
   * closure's single `main_pipe` declaration. `all_pipes: true` describes every pipe
   * instead, and never refuses for want of an entry pipe. `include_files: true` echoes the
   * method's own `.mthds` bundles as `files`, a map from tree path to each bundle's text,
   * in the shape of the request's `files` map.
   *
   * The files the closure's steps read, such as a `PipeDocGen` step's `template_file`, are
   * files of the method's tree like any other; a step whose template file is not in the tree
   * makes the closure invalid (see {@link CrateRequestBase}).
   *
   * Same 200-verdict discipline, same three-form closure selector and same `options` as
   * {@link resolve} (the request's members are posted as given, its `directory`, `tree` or
   * `contents` as the `files` map, and the selector XOR is the server's to enforce).
   * Only a no-verdict condition throws `ApiResponseError`: a malformed selector and an
   * over-limit file are `ValidationError` `422`s; a selection the route refuses is a
   * `422` whose `errorType` is `EntryPipeNotFoundError` (an unknown `pipe_ref`, no entry
   * pipe) or `EntryPipeAmbiguousError` (an ambiguous code, several entry pipes), the
   * candidates in its `serverMessage`; a registry-form `method_ref` is a `501`; a pipe
   * whose artifacts cannot be derived is a `500`.
   *
   * A `method_ref` gets the fetch-sized budget, as on the other crate routes. On the
   * hosted API the gateway caps a request at about 30 seconds whatever the client allows,
   * so a cold `method_ref` clone can answer a `502` that a retry clears once the runner
   * has cached the clone.
   */
  async pipeIo(request: PipeIORequest, options: CrateRouteOptions = {}): Promise<PipeIOResponse> {
    return this.crateRequest<PipeIOResponse>("pipe-io", "pipeIo", request, options);
  }

  /**
   * Post a crate request: its members as given, and its tree as the `files` map a save would
   * send, each key left off when there is nothing to send. An empty map or string is absent, as in
   * the Python SDK: `files: {}` or `null`, `contents: {}`, `directory: ""` and `dependencies: {}`
   * are not sent, so an empty one never reaches the wire as a second selector; a `directory` that
   * is not a string is refused, as on a run. A `directory`, `tree` or `contents` is prepared
   * through the path every request and save sends a tree by (`postMethodRequest`), inline when
   * small and by hash otherwise, uploading the files the API lacks first; the blob route is asked
   * under the request's `read_scope`, the scope its hash entries are read in. `signal` is read
   * before each step and right before the request (see `TreeSendOptions`). The request gets the
   * budget `crateRequestTimeoutMs` gives it for the `files` it carries.
   */
  private async crateRequest<T extends object>(
    endpoint: string,
    call: string,
    request: CrateRequestBase,
    options: CrateRouteOptions,
  ): Promise<T> {
    const signal = options.signal;
    throwIfAborted(signal);
    if (typeof request !== "object" || request === null) {
      return this.requestExtension<T>(endpoint, request);
    }
    const { directory, contents, tree, files, dependencies, ...rest } = request;
    const source = await this.treeToSend(
      call,
      {
        directory: typeof directory === "string" ? nonEmptyString(directory) : directory,
        contents: presentMap(contents),
        tree: tree ?? undefined,
        files: presentMap(files),
      },
      REQUEST_SENDING,
      signal,
    );
    const packages = presentMap(dependencies);
    const res = await this.postMethodRequest(
      source,
      call,
      REQUEST_SENDING,
      { signal, readScope: nonEmptyString(request.read_scope) },
      (sent) => {
        const body: Record<string, unknown> = { ...rest };
        if (sent != null) body.files = sent;
        if (packages !== undefined) body.dependencies = packages;
        throwIfAborted(signal);
        return this.requestRaw("POST", this.url(endpoint), {
          body,
          timeoutMs: this.crateRequestTimeoutMs(request, sent),
        });
      },
    );
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", endpoint, res);
    }
    return this.readObjectAnswer<T>("POST", endpoint, res);
  }

  /**
   * The request budget for a crate route's closure (`resolve`, `codegen`, `pipeIo`): the
   * static-route default, unless the closure is a `method_ref`, which may make the server clone a
   * repository first and gets the fetch-sized budget, or its `files` carry more inline than
   * `INLINE_TREE_MAX_BYTES`, which gets the client's request ceiling (`requestTimeoutMs`): a tree
   * sent to an API keeping no blob store travels inline whatever its weight, and so does a `files`
   * map given as is, and the upload of the body is charged against the budget. A tree sent by
   * hash keeps the default, its files uploaded before the request under the client's own ceiling.
   */
  private crateRequestTimeoutMs(
    request: CrateRequestBase,
    files: MethodFiles | null | undefined,
  ): number {
    if (nonEmptyString(request.method_ref) !== undefined) return METHOD_REF_FETCH_TIMEOUT_MS;
    return carriesLargeInlineTree(files) ? this.requestTimeoutMs : POLL_REQUEST_TIMEOUT_MS;
  }

  // ── Hosted extension: durable run lifecycle (NOT part of the protocol) ──

  /**
   * Fetch a run's status by bare id — `GET /v1/runs/{pipeline_run_id}/status`.
   *
   * Self-healing: a finished-but-unrecorded run resolves to its true terminal
   * status on read. `degraded: true` means the read is not a plain fresh reading,
   * and `degradation.reason` says why (see `DegradationReason`):
   * `status_unavailable` when the platform could not reach the workflow engine
   * and `status` is the last one recorded, `workflow_task_failing` when `status`
   * is live and the run is stuck, its workflow task failing until the platform
   * ends it at `degradation.ends_at`. `retry_after_seconds` carries the server's
   * `Retry-After` hint when present, and `request_id` the id to quote to support.
   * A failed run's stored report, `error`, and the `degradation` are each
   * checked field by field (see `RunErrorReport` and `RunDegradation`), so
   * neither ever fails the read. Throws `RunLifecycleUnavailableError` when the
   * lifecycle routes are absent (a bare runner).
   */
  async getRunStatus(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunRead> {
    const endpoint = `${RUNS}/${idPathSegment(runId, "getRunStatus", RUN_ID_ARGUMENT)}/status`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const run = withCheckedDegradation(
      withCheckedReport(this.readObjectAnswer<RunRead>("GET", endpoint, res)),
    );
    const retryAfter = parseRetryAfter(res.headers);
    return retryAfter !== null ? { ...run, retry_after_seconds: retryAfter } : run;
  }

  /**
   * Read a run's progress snapshot by bare id — `GET /v1/runs/{pipeline_run_id}/progress`.
   *
   * The platform projects the snapshot at each read from the run's live progress events, through
   * the status read's self-healing path: which invocations of which pipes have started, ended or
   * been skipped, how far each batch has got, which outcome each condition took, where the run is
   * retrying or stuck, and a one-line `summary`. A pending run, and a run that has written no
   * progress event, answer with no invocation. When the workflow engine cannot be reached the read
   * still answers, its `degradation` reading `status_unavailable` and its `status` the last one
   * recorded. Two reads can answer out of order: keep the fresher by `isFresherRunProgress`, as
   * `waitForResult`'s `onProgress` does.
   *
   * The members the freshness rule and a timeline lean on are checked, and an answer missing one
   * or holding one of another type is an `ApiResponseError` for an answer the SDK cannot read; the
   * snapshot's `degradation` and each invocation's are checked field by field, as the status
   * read's, and dropped when unreadable, so neither fails the read. A run that does not exist or
   * is another organization's is the platform's `404`, an `ApiResponseError`. Throws
   * `RunLifecycleUnavailableError` when the route is absent: a bare runner, or a hosted API older
   * than the route.
   */
  async getRunProgress(
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunProgress> {
    const endpoint = `${RUNS}/${idPathSegment(runId, "getRunProgress", RUN_ID_ARGUMENT)}/progress`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    this.throwIfLifecycleUnavailable(
      res,
      url,
      "the server is a bare runner, or a hosted API older than the progress route.",
    );
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const answer = this.readObjectAnswer<Record<string, unknown>>("GET", endpoint, res);
    const fault = runProgressFault(answer);
    if (fault !== undefined) {
      throw this.unreadableAnswer(
        "GET",
        `/${API_PREFIX}/${endpoint}`,
        res,
        `a snapshot whose ${fault}`,
      );
    }
    return withCheckedProgressDegradations(answer as RunProgress);
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
   * read. An empty selection or an unknown name throws a `RequestArgumentError`
   * before any request. `MissingMainStuffError` is thrown only for a read that asked
   * for `main_stuff` — no selection, or one naming it.
   *
   * A completed result is read with `parseExactJson`, so an integer past
   * `Number.MAX_SAFE_INTEGER` anywhere in it, the main output, the working memory and the graph
   * included, is a `bigint` holding its exact digits, and an output passed back to `start` goes
   * back as the run produced it.
   *
   * Throws `RunLifecycleUnavailableError` when the lifecycle routes are absent
   * (a bare runner).
   */
  async getRunResult(runId: string, options: GetRunResultOptions = {}): Promise<RunResultState> {
    assertArtifactSelection(options.artifacts);
    const base = `${RUNS}/${idPathSegment(runId, "getRunResult", RUN_ID_ARGUMENT)}/results`;
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
    // Read exactly: the output, the working memory and the graph hold the run's data.
    const result = this.readObjectAnswer<RunResults>("GET", endpoint, res, {}, parseExactJson);
    if (selectionIncludesMainStuff(options.artifacts) && result.main_stuff == null) {
      throw new MissingMainStuffError(
        `Completed run '${runId}' returned no main stuff — a completed run always delivers a main stuff.`,
        runId,
      );
    }
    return { state: "completed", pipeline_run_id: runId, result };
  }

  /**
   * Poll an already-started run (by id) until it reaches a terminal state. With `onProgress`,
   * each poll that finds the run still running also reads `getRunProgress` and hands the callback
   * every snapshot fresher than the last it delivered; a failed progress read never fails the wait
   * (see `WaitForResultOptions.onProgress`).
   */
  async waitForResult(runId: string, options?: WaitForResultOptions): Promise<RunResults> {
    return pollUntilResult(
      (id, opts) => this.getRunResult(id, opts),
      runId,
      options,
      (id, opts) => this.getRunProgress(id, opts),
    );
  }

  /**
   * Whether the configured server serves the durable run lifecycle, decided
   * via the `GET /v1/version` handshake and cached for the client's lifetime. A
   * bare `pipelex-api` runner has no run store; anything else is assumed hosted.
   *
   * The rule, the one the Python SDK follows: an answer that is not a usable
   * version means assume hosted (the SDK default), and let the start surface the
   * real error; no answer at all propagates, uncached. An answer is anything the
   * server sent back: a non-2xx status, a body that is not JSON, not UTF-8 or no
   * version, and a body that arrived but could not be decoded, such as a broken
   * gzip stream, which `requestRaw` reports as an `ApiUnreachableError` carrying
   * the decompressor's code (see `isUndecodableBody`).
   *
   * `signal` stops the handshake: its abort is thrown as is and nothing is cached.
   *
   * @throws {ApiUnreachableError} The handshake got no answer. Nothing is cached,
   *   so the next call asks again, and no start is sent to a host that did not
   *   answer: sending it would wait a second time for the same silence.
   */
  private async supportsRunLifecycle(signal?: AbortSignal): Promise<boolean> {
    if (this.lifecycleAvailable === undefined) {
      try {
        const askedAt = Date.now();
        const info = await this.requestVersion(signal);
        this.versionCache = { info, askedAt };
        const impl = info.implementation;
        this.lifecycleAvailable = !(
          typeof impl === "string" && impl === BARE_RUNNER_IMPLEMENTATION
        );
      } catch (error) {
        // The caller's abort is no answer: it propagates, and nothing is cached.
        if (signal?.aborted === true) throw signal.reason;
        // No answer at all propagates. A body that arrived and could not be decoded is an answer,
        // and so is every other failure here: a non-2xx status, or a body that is no version.
        if (error instanceof ApiUnreachableError && !isUndecodableBody(error)) throw error;
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
   * `pollOptions.signal` also stops everything before the run is created: the version handshake,
   * the listing of a `directory`, and the reads, the blob route and the uploads of a tree sent by
   * hash, each of them stopped in flight. It is read again right before the start and before the
   * blocking execute, so a caller that aborts before then gets its abort and no run is created.
   * Once one of them is sent, the abort stops only the wait.
   *
   * The method's tree is prepared once, before the start: when a runner turns out to lack the
   * durable routes, the blocking execute sends the same `files` map, its blobs already uploaded,
   * rather than listing, reading and hashing the tree again.
   *
   * An error from the start, or from the blocking execute, says whether that request may still
   * have started a run whose id never reached the caller (`runMayHaveStarted`); when it may have,
   * it is not retryable, since calling this method again could pay for the run twice: look the run
   * up in the run history first. An error from the wait, once `onStarted` has named the run,
   * started nothing, so its `runMayHaveStarted` is false, and its `retryable` is about waiting
   * again on that id with `waitForResult`, never about calling this method again.
   *
   * `options.idempotencyKey` rides the durable start, so a call that failed while its start may
   * have created a run can be made again with the same options and the same key: the hosted API
   * answers the start with the run the first call started, and the wait follows it. The blocking
   * execute of a bare runner carries no key, a bare runner having no idempotency to honour it. A
   * malformed key is refused before the version handshake.
   */
  async startAndWaitForResult(
    options: PipelexStartOptions,
    pollOptions?: StartAndWaitForResultOptions,
  ): Promise<RunResults> {
    // Before the run starts: a refusal after it would carry no run id to re-poll by.
    assertWaitOptions(pollOptions);
    // Before the handshake too: a key the start would refuse is the caller's to fix, whatever runs.
    idempotencyKeyOf(options);
    const { onStarted, onStarting, ...waitOptions } = pollOptions ?? {};
    const signal = waitOptions.signal;
    const hosted = await this.supportsRunLifecycle(signal);
    // The handshake may have outlasted the caller's patience: an abort that landed during it
    // creates no run.
    throwIfAborted(signal);
    const sending = await this.prepareRunTree(hosted ? "start" : "execute", options, signal);
    if (hosted) {
      // A runner can look hosted yet lack the durable routes — `implementation`
      // is an extension field, so a compliant bare runner that omits it is
      // misdetected here. Such a runner raises `RunLifecycleUnavailableError`
      // from `start()`, BEFORE any run is created, so falling back to the
      // blocking path cannot double-run. Cache the negative so later calls skip
      // the durable attempt.
      let ack: PipelexRunResultStart;
      try {
        throwIfAborted(signal);
        onStarting?.();
        ack = await this.startRun(options, signal, sending);
      } catch (err) {
        if (!(err instanceof RunLifecycleUnavailableError)) throw err;
        this.lifecycleAvailable = false;
        throwIfAborted(signal);
        onStarting?.();
        return this.executeBlocking(options, signal, sending);
      }
      onStarted?.(ack);
      return this.waitForResult(ack.pipeline_run_id, waitOptions);
    }

    throwIfAborted(signal);
    onStarting?.();
    return this.executeBlocking(options, signal, sending);
  }

  /**
   * A run's tree prepared once for `startAndWaitForResult`, under `call`'s refusals: the run's
   * arguments checked, the tree listed or read, and its `files` prepared, uploads included, under
   * `signal`. A `files` map given as is, or no tree, needs no preparation.
   */
  private async prepareRunTree(
    call: "execute" | "start",
    options: PipelexStartOptions,
    signal: AbortSignal | undefined,
  ): Promise<PreparedRunTree> {
    const parts = this.runParts(call, options);
    const source = await this.treeToSend(call, parts.forms, REQUEST_SENDING, signal);
    if (source === undefined || !("tree" in source)) return { source, initial: undefined };
    const read = new Map<string, Uint8Array>();
    const prepared = await this.prepareFiles(source, call, REQUEST_SENDING, { signal }, read);
    return { source, initial: { prepared, read } };
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
   * `q` is applied server-side over the whole catalog, not over the page, and so is
   * `published` (`true` for the methods with a published version, `false` for those never
   * published). Each row carries the method's publish state (`latest_version`,
   * `latest_published`, `draft_digest`). Both filters run after the index read, so a page can
   * come back empty and still carry a `nextCursor`: keep following it until it is `null`.
   */
  async listMethods(query: ListMethodsQuery = {}): Promise<MethodPage> {
    const search = productQuery({
      q: query.q,
      published: query.published,
      limit: query.limit,
      cursor: query.cursor,
    });
    return this.requestPage<MethodSummary>(`methods${search}`);
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
   *
   * It keeps going **through an empty page that carries a cursor**: under `q` or `published`
   * such a page means "nothing matched in the slice just read", not "done". It stops on a
   * `null` cursor or on a cursor the server failed to advance, and throws
   * `PagingNotTerminatingError` past a page ceiling no real catalog reaches.
   */
  async *iterateMethods(
    query: Omit<ListMethodsQuery, "cursor"> = {},
  ): AsyncGenerator<MethodSummary, void, undefined> {
    yield* followCursor("listMethods", (cursor) => this.listMethods({ ...query, cursor }));
  }

  /**
   * Read one method with its draft's files — `GET /v1/methods/{id}`: its identity, its draft
   * (`files`, `input_data`) with the draft's token (`updated_at`) and digest (`draft_digest`),
   * and its latest published version's summary (`latest_version`, `latest_published`), whatever
   * the publish state. A method never published reads with both `null`, never as an error.
   * `files` lists the draft's tree in tree path order, each file with its SHA-256, its size and a
   * link to its bytes valid for about fifteen minutes, and is empty for an empty draft;
   * `writeMethodTree` brings the tree to disk.
   *
   * Takes a bare catalog id: the method routes address the method itself, never a version of
   * it. A caller holding `mt_…@3` strips the suffix with `parseMethodSelector` and reads that
   * version with `getMethodVersion`. Every method route throws `RequestArgumentError` for a
   * suffixed id, before any request, rather than read back the `404` the platform would answer,
   * and for an id that is empty, `.` or `..`, which the URL would resolve into another route's
   * path.
   *
   * Throws `ApiResponseError`: `404` `not_found` for an unknown or foreign-org method, `409`
   * `method_being_deleted` while its erasure runs, and a `409` whose verdict is `runtime` for a
   * method whose draft names a tree the platform holds no record of. An answer whose `files` is
   * not a listing is an answer the SDK cannot read, thrown as an `ApiResponseError` too.
   */
  async getMethod(methodId: string): Promise<MethodDetail> {
    const endpoint = methodPath(methodId, "getMethod");
    const res = await this.requestProductAnswer("GET", endpoint, undefined);
    return this.readSavedTree<MethodDetail>("GET", endpoint, withLinks(res), "a stored method");
  }

  /**
   * Create a method — `POST /v1/methods`. The new method holds its tree as its draft and has no
   * published version, so its bare id answers `409 method_not_published` on the run and tooling
   * routes until its first `publishMethod`; its draft runs as `mt_…@draft` at once.
   *
   * The tree is `files`, sent as given, or `tree` or `contents`, which the client sends inline
   * when its inline map weighs 256 KiB or less, or when the platform keeps no blob store, and
   * otherwise every file by hash, after asking `POST /v1/blobs/missing` which files the
   * organization lacks and uploading those: a file uploaded once is never uploaded again. With
   * none of the three, the draft is empty (see `docs/method-trees.md`).
   *
   * Throws `RequestArgumentError` for two forms of the tree, or `contents` holding no file, before
   * any request; `MethodFileTransferError` when a file the organization lacks could not be
   * uploaded, and nothing is saved. Throws `ApiResponseError`: `422` `invalid_method_files` for a
   * map the standard refuses, with its `tree_refusal`; `422` `method_tree_too_large` for a tree
   * past one of the deployment's limits, named in its `limit`; `422` `blob_mismatch` for a hash
   * stated at another size than the one held; `422` `missing_blobs` for a hash entry whose bytes
   * the organization does not hold; `413` `payload_too_large` for a method that would leave no
   * room for a publish.
   */
  async createMethod(input: MethodWriteInput): Promise<MethodData> {
    const source = await this.treeToSend("createMethod", input, SAVE_SENDING);
    return this.saveMethodTree("POST", "methods", "createMethod", source, (files) => {
      const body: Record<string, unknown> = { name: input.name };
      if (files != null) body.files = files;
      if (input.input_data !== undefined) body.input_data = input.input_data;
      return body;
    });
  }

  /**
   * Replace a method's draft — `PUT /v1/methods/{id}/draft` — and return the method with the
   * draft's new token (`updated_at`) and digest (`draft_digest`).
   *
   * The draft is never validated on write, and writing it changes nothing for the callers of
   * the method's bare id, who run the latest published version until the next `publishMethod`.
   * The write replaces the draft's whole tree, given in exactly one form: `files`, sent as given,
   * `files: null` emptying the draft, or `tree` or `contents`, sent inline or by hash as
   * `createMethod` sends them. `input_data` is three-way (see `MethodDraftInput`). With
   * `expected_updated_at`, the write is a compare-and-swap on the draft token: a draft that
   * moved since is refused with a `409` whose `code` is `method_update_conflict`, and nothing is
   * written. Without it, last writer wins.
   *
   * Takes a bare catalog id, as `getMethod` does. Throws `RequestArgumentError` for a draft that
   * gives its tree in no form or in two, or `contents` holding no file, before any request;
   * `MethodFileTransferError` when a file the organization lacks could not be uploaded. Throws
   * `ApiResponseError`: `404` `not_found` for an unknown or foreign-org method, `409`
   * `method_being_deleted` while its erasure runs, the `422` refusals of a tree `createMethod`
   * lists, `413` `payload_too_large` for a draft that would grow the method past the room a
   * publish needs, `403` for a read-only key, and a `503` that wrote nothing, safe to retry,
   * when the method kept changing under the write.
   */
  async writeDraft(methodId: string, input: MethodDraftInput): Promise<MethodData> {
    const endpoint = `${methodPath(methodId, "writeDraft")}/draft`;
    if (treeFormsGiven(input).length === 0) {
      throw new RequestArgumentError(
        "writeDraft() replaces the draft's whole tree: give it as directory, contents, tree or " +
          "files (files: null empties the draft).",
      );
    }
    const source = await this.treeToSend("writeDraft", input, SAVE_SENDING);
    return this.saveMethodTree("PUT", endpoint, "writeDraft", source, (files) => {
      const body: Record<string, unknown> = { files: files ?? null };
      if (input.input_data !== undefined) body.input_data = input.input_data;
      if (input.expected_updated_at !== undefined) {
        body.expected_updated_at = input.expected_updated_at;
      }
      return body;
    });
  }

  /**
   * Send a save carrying a method's tree (`createMethod`, `writeDraft`) through the path every
   * request sends a tree by (`postMethodRequest`), its body built by `bodyOf` from the `files`
   * prepared, under `saveTimeoutMs`, and read the stored method it answers as
   * `requestMethodData` reads it.
   */
  private async saveMethodTree(
    method: HttpMethod,
    endpoint: string,
    call: string,
    source: TreeToSend,
    bodyOf: (files: MethodFiles | null | undefined) => Record<string, unknown>,
  ): Promise<MethodData> {
    const res = await this.postMethodRequest(source, call, SAVE_SENDING, {}, (files) =>
      this.requestRaw(method, this.url(endpoint), {
        body: bodyOf(files),
        timeoutMs: this.saveTimeoutMs(files),
      }),
    );
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError(method, endpoint, res);
    }
    return this.readObjectAnswer<MethodData>(method, endpoint, res);
  }

  /**
   * The time limit of a save carrying `files`: the client's request ceiling, as for a `start`
   * carrying its method, since a tree sent inline to a deployment with no blob store weighs up to
   * its `max_inline_bytes`, a `files` map given as is whatever it weighs, and the whole upload is
   * charged against the limit; the poll timeout for a save sending no tree.
   */
  private saveTimeoutMs(files: MethodFiles | null | undefined): number {
    return files != null && Object.keys(files).length > 0
      ? this.requestTimeoutMs
      : POLL_REQUEST_TIMEOUT_MS;
  }

  /**
   * The limits the deployment holds a method's tree to — `GET /v1/version`, read from
   * `limits.method_tree` of the public handshake — in the shape the `mthds` package's
   * `listMethodTree` takes as its `limits` option, so a tree the platform would refuse is refused
   * while it is listed, before any file is hashed. A `directory` given to any route is listed under
   * them already; they serve a caller listing a tree of its own:
   *
   * ```ts
   * import { listMethodTree } from "mthds";
   * const tree = await listMethodTree("methods/receipts", { limits: await client.methodTreeLimits() });
   * await client.createMethod({ name: "Receipts", tree });
   * ```
   *
   * A limit the server does not announce is absent, so a bare runner, which announces none,
   * yields no limit, and none is ever assumed. A value that is not a positive integer is left out
   * rather than trusted. The inline limit, `max_inline_bytes`, is no listing limit: the client
   * applies it itself when it chooses how a tree travels.
   */
  async methodTreeLimits(): Promise<MethodTreeLimits> {
    return listerLimitsOf(announcedTreeLimits(await this.cachedVersion()));
  }

  /**
   * The version handshake, asked once per `HANDSHAKE_TTL_MS`: an answer is kept that long (see
   * `versionCache`), and a failure is thrown and not kept, so the next call asks again. `signal`
   * stops the ask, its abort thrown as is.
   */
  private async cachedVersion(signal?: AbortSignal): Promise<VersionInfo> {
    const cached = this.versionCache;
    if (cached !== undefined && Date.now() - cached.askedAt < HANDSHAKE_TTL_MS) return cached.info;
    const askedAt = Date.now();
    const info = await this.requestVersion(signal);
    this.versionCache = { info, askedAt };
    return info;
  }

  /** Drop the kept handshake, which a refusal has shown to be stale. */
  private forgetHandshake(): void {
    this.versionCache = undefined;
  }

  /**
   * Write a saved method's tree to disk: each file of a listing `getMethod` or `getMethodVersion`
   * served, at its tree path under `options.destination`. **Node only.**
   *
   * Each file is downloaded through its link, at most eight at a time, with no credential of this
   * client, and checked against the listing: its size and its SHA-256 must be the ones listed, so
   * what lands on disk is the tree the method's digest names. The files are written into a fresh
   * hidden directory beside the destination, which takes its name only once every file is
   * written: an interrupted or failed write never leaves a partial tree under that name. The
   * destination must not exist, or be an empty directory; one holding anything is refused rather
   * than written into or replaced. An empty listing writes an empty directory.
   *
   * The links expire about fifteen minutes after the read that served them: write the tree soon
   * after reading the method, and read it again for fresh links when a download is refused.
   *
   * Throws `RequestArgumentError` before any download when it runs outside Node, when the
   * destination exists and is not an empty directory, or when the listing holds a path that is not
   * a tree path, the same path twice, or paths that collide once case-folded or where one names a
   * directory of another;
   * `MethodFileTransferError` when a file could not be downloaded, or its bytes are not the file
   * listed, and nothing is left under the destination.
   */
  async writeMethodTree(
    files: readonly SavedMethodFile[],
    options: { destination: string },
  ): Promise<void> {
    await writeMethodTreeTo(files, options.destination, { timeoutMs: this.requestTimeoutMs });
  }

  /**
   * The method's tree a call was given, made ready to prepare: a `directory` listed, `contents`
   * turned into a tree, a `tree` checked, `files` kept as given; `undefined` when the input gives
   * none. Two forms are refused with `RequestArgumentError` before any request, naming `call`, and
   * so are a `directory` that is not a string and a `tree` that is not a listed tree. A
   * `directory` is listed by the `mthds` package's lister under the limits the deployment
   * announces, so a tree past one is refused while it is listed, before any file is hashed; the
   * handshake that announces them is asked under `signal`. It is listed once per call: a request
   * sent again sends the tree this listing read.
   */
  private async treeToSend(
    call: string,
    input: MethodTreeForms,
    sending: TreeSending,
    signal?: AbortSignal,
  ): Promise<TreeToSend> {
    const given = treeFormsGiven(input);
    if (given.length > 1) {
      throw new RequestArgumentError(
        `${call}() takes the method's tree in one form, directory, contents, tree or files; got ` +
          `${given.join(" and ")}.`,
      );
    }
    if (given[0] === "directory") {
      const directory: unknown = input.directory;
      if (typeof directory !== "string") throw directoryRefusal(call);
      throwIfAborted(signal);
      const limits = listerLimitsOf(announcedTreeLimits(await this.cachedVersion(signal)));
      throwIfAborted(signal);
      return { tree: await listDirectoryTree(directory, limits, call) };
    }
    if (input.tree != null) return { tree: checkedTreeSource(call, input.tree) };
    if (input.contents != null) {
      return { tree: await contentsTreeSource(input.contents, call, sending) };
    }
    return input.files === undefined ? undefined : { files: input.files };
  }

  /**
   * Post a request carrying a method's tree, by `mthds`'s `MthdsApiClient` rule: prepare the
   * tree's `files` (`prepareFiles`), hand them to `post`, which builds the body and sends it, and
   * answer the two refusals that call for sending the same request once more, as `mthds` does.
   *
   * - A `422` coded `request.blobs_missing` whose `missing_blobs` the tree sent by hash holds, such
   *   as a blob dropped since the check: the blob route is asked again for those, they are
   *   uploaded, and the request is sent once more (`postWithBlobRetry`).
   * - A `422` refusing a tree the client prepared as past one of the receiver's limits
   *   (`isMethodTreeTooLarge`): the handshake that announced the limits may be stale, so it is
   *   forgotten, and the tree prepared again on a fresh one and sent once more. A `files` map
   *   given as is was not prepared, so it is never sent again; nor is a request whose
   *   `options.retryTooLarge` is `false`, a start under an idempotency key, which the platform
   *   binds to the refusal it stores.
   *
   * A `422` created nothing, so the request sent again is no repeat of one whose outcome is
   * unknown. `initial`, when given, is the tree already prepared for the first send, with the
   * bytes it read, so a caller sending one tree on two routes prepares it once. `options.signal`
   * is read before each step of the preparation and before each send. Answers the last answer
   * whole, its status unread, with the `files` it carried.
   */
  private async postMethodRequest(
    source: TreeToSend,
    call: string,
    sending: TreeSending,
    options: TreeSendOptions & { readonly retryTooLarge?: boolean },
    post: (files: MethodFiles | null | undefined) => Promise<RawResponse>,
    initial?: PreparedTreeSend,
  ): Promise<RawResponse> {
    const read = initial?.read ?? new Map<string, Uint8Array>();
    let ready = initial?.prepared;
    const send = async (): Promise<RawResponse> => {
      const prepared = ready ?? (await this.prepareFiles(source, call, sending, options, read));
      ready = undefined;
      throwIfAborted(options.signal);
      return this.postWithBlobRetry(prepared, read, post, sending, options);
    };
    const res = await send();
    if (
      source === undefined ||
      !("tree" in source) ||
      options.retryTooLarge === false ||
      !isMethodTreeTooLarge(res.status, res.body)
    ) {
      return res;
    }
    this.forgetHandshake();
    return send();
  }

  /**
   * Send a request whose tree may have travelled by hash. When it did and the receiver answers a
   * `422` coded `request.blobs_missing` whose `missing_blobs` the tree holds, the client asks the
   * blob route where to upload them, uploads them and sends the same request once more, which the
   * refusal left uncreated; any other answer, or a list naming a blob the tree does not hold, is
   * answered as it came.
   */
  private async postWithBlobRetry(
    prepared: PreparedFiles,
    read: Map<string, Uint8Array>,
    post: (files: MethodFiles | null | undefined) => Promise<RawResponse>,
    sending: TreeSending,
    options: TreeSendOptions,
  ): Promise<RawResponse> {
    const res = await post(prepared.files);
    const tree = prepared.byHashTree;
    if (tree === undefined) return res;
    const missing = missingBlobsOf(res.status, res.body);
    if (missing === undefined || missing.length === 0) return res;
    const byBlob = fileByBlob(tree);
    const files = missing.map((sha256) => byBlob.get(sha256));
    if (files.some((file) => file === undefined)) return res;
    throwIfAborted(options.signal);
    const asked = await this.findMissingBlobs(
      { blobs: files.map((file) => ({ sha256: file!.sha256, size: file!.size })) },
      options.readScope,
      options.signal,
    );
    await this.uploadMissing(tree, asked, read, sending, options.signal);
    throwIfAborted(options.signal);
    return post(prepared.files);
  }

  /**
   * The `files` a request or a save sends for `source`: a `files` map as given, a tree prepared
   * (`prepareTree`), or none.
   */
  private async prepareFiles(
    source: TreeToSend,
    call: string,
    sending: TreeSending,
    options: TreeSendOptions,
    read: Map<string, Uint8Array>,
  ): Promise<PreparedFiles> {
    if (source === undefined) return { files: undefined, byHashTree: undefined };
    if ("files" in source) return { files: source.files, byHashTree: undefined };
    return this.prepareTree(source.tree, call, sending, options, read);
  }

  /**
   * The `files` map that sends `tree`: inline, or by hash once the receiver holds every file —
   * `mthds`'s `MthdsApiClient` rule, read from the version handshake the client keeps.
   *
   * When the handshake declares a blob store, a tree whose inline map weighs no more than the
   * inline threshold travels inline, measured as the request spends it, its JSON with no
   * whitespace in UTF-8; the threshold is the lower of 256 KiB (`INLINE_TREE_MAX_BYTES`) and the
   * `max_inline_bytes` the handshake announces, and a tree whose files alone pass it is not read
   * to be weighed. A heavier tree travels by hash: `POST /v1/blobs/missing` is asked which files
   * the receiver lacks, naming the tree's digest, each one it lacks is uploaded once, and every
   * file travels by hash. A `404` from the blob route says the handshake that declared the store
   * is stale, so it is forgotten and the tree prepared once more on a fresh one. When the
   * handshake declares no blob store, the whole tree travels inline whatever its weight, held to
   * the announced `max_inline_bytes` (`inlineWithin`). Each file is read at most once into `read`,
   * so a file read to be weighed is uploaded from memory. A tree holding no file is refused with
   * `RequestArgumentError` before any request, `call` naming the caller's method.
   * `options.readScope` is the scope the blob route is asked under, and `options.signal` is read
   * before each read, the handshake, the blob route and each upload, and is passed to each of
   * them, so an abort also stops a request or an upload under way.
   */
  private async prepareTree(
    tree: MethodTreeSource,
    call: string,
    sending: TreeSending,
    options: TreeSendOptions,
    read: Map<string, Uint8Array>,
    retried = false,
  ): Promise<PreparedFiles> {
    const { signal, readScope } = options;
    if (tree.files.length === 0) throw emptyTreeRefusal(call, "a tree", sending);
    throwIfAborted(signal);
    const version = await this.cachedVersion(signal);
    throwIfAborted(signal);
    const announced = announcedTreeLimits(version);
    if (!declaresBlobStore(version)) {
      const files = await inlineWithin(tree, call, sending, announced.maxInlineBytes, read, signal);
      return { files, byHashTree: undefined };
    }
    const threshold = inlineThreshold(announced);
    // An inline map is never smaller than the bytes it carries, so a tree whose bytes alone pass
    // the threshold is not read in full just to be measured.
    if (treeTotalSize(tree) <= threshold) {
      const inline = inlineFilesOf(tree, await readTreeBytesInto(tree, read, signal));
      if (inlineMapBytes(inline) <= threshold) return { files: inline, byHashTree: undefined };
    }
    throwIfAborted(signal);
    let asked: { result: MissingBlobsResult; res: RawResponse };
    try {
      asked = await this.findMissingBlobs(
        { blobs: uniqueBlobs(tree), digest: tree.digest },
        readScope,
        signal,
      );
    } catch (err) {
      if (!retried && err instanceof ApiResponseError && err.status === 404) {
        this.forgetHandshake();
        return this.prepareTree(tree, call, sending, options, read, true);
      }
      throw err;
    }
    await this.uploadMissing(tree, asked, read, sending, signal);
    return { files: hashMethodFiles(tree), byHashTree: tree };
  }

  /**
   * Which of these blobs the organization lacks, and where to upload each —
   * `POST /v1/blobs/missing` — with the answer it was read from, which carries signed links. A
   * blob held is left out, and an empty `missing` means nothing to upload. An answer whose
   * `missing` is not a list of blobs, each with its upload target, is an answer the SDK cannot
   * read, thrown as an `ApiResponseError` holding the answer with its links hidden.
   *
   * `readScope`, a crate request's `read_scope`, is sent as the route's `read_scope` query, the
   * Pipelex API's extension naming the blob store asked, so the blobs are uploaded into the store
   * the request's hash entries are read from; each upload target is signed for that scope. The
   * hosted platform's own route reads the caller's organization instead. `signal` stops the
   * request, its abort thrown as is.
   */
  private async findMissingBlobs(
    request: MissingBlobsRequest,
    readScope?: string,
    signal?: AbortSignal,
  ): Promise<{ result: MissingBlobsResult; res: RawResponse }> {
    const endpoint =
      readScope === undefined
        ? "blobs/missing"
        : `blobs/missing?${new URLSearchParams({ read_scope: readScope }).toString()}`;
    const res = withLinks(await this.requestProductAnswer("POST", endpoint, request, { signal }));
    const answer = this.readObjectAnswer<Record<string, unknown>>("POST", endpoint, res);
    const missing = answer.missing;
    if (!Array.isArray(missing) || !missing.every(isMissingBlob)) {
      throw this.unreadableAnswer(
        "POST",
        `/${API_PREFIX}/${endpoint}`,
        res,
        "a body whose `missing` is not a list of blobs, each with its upload target",
      );
    }
    return { result: answer as MissingBlobsResult, res };
  }

  /**
   * Upload each missing blob from the tree's bytes, a few at a time, stopping at the first
   * failure. A blob the platform asks for that the tree does not hold, or holds at another size,
   * is the platform's fault, thrown before anything is sent as the `ApiResponseError` of an answer
   * the SDK cannot read. The bytes the tree reads for a blob are checked against it before they
   * are sent, since storage keeps a blob under the hash it is named by: bytes of another hash or
   * size are refused with `RequestArgumentError`, and nothing more is uploaded. `userSignal` is
   * read before each blob's read and before its upload, and reaches each upload under way: once it
   * has aborted, no further blob is read or sent, the uploads in flight are stopped, and the abort
   * is thrown rather than a transfer failure.
   */
  private async uploadMissing(
    tree: MethodTreeSource,
    asked: { result: MissingBlobsResult; res: RawResponse },
    read: ReadonlyMap<string, Uint8Array> | undefined,
    sending: TreeSending,
    userSignal?: AbortSignal,
  ): Promise<void> {
    const missing = asked.result.missing;
    const byBlob = fileByBlob(tree);
    const strangers = missing
      .filter((blob) => byBlob.get(blob.sha256)?.size !== blob.size)
      .map((blob) => blob.sha256);
    if (strangers.length > 0) {
      throw this.unreadableAnswer(
        "POST",
        `/${API_PREFIX}/blobs/missing`,
        asked.res,
        `a body asking for blobs this tree does not hold: ${[...new Set(strangers)].sort().join(", ")}`,
      );
    }
    // The tasks share the one signal the run of uploads aborts on a failure, linked here once to
    // the caller's and detached when the uploads are over.
    let linked: { signal: AbortSignal; dispose: () => void } | undefined;
    try {
      await forEachConcurrently(missing, MAX_CONCURRENT_TRANSFERS, async (blob, signal) => {
        linked ??= eitherSignal(signal, userSignal);
        await this.uploadOne(tree, blob, byBlob, read, sending, linked.signal, userSignal);
      });
    } catch (err) {
      if (userSignal?.aborted === true) throw userSignal.reason;
      throw err;
    } finally {
      linked?.dispose();
    }
  }

  /** Read, check and upload one missing blob (see `uploadMissing`). */
  private async uploadOne(
    tree: MethodTreeSource,
    blob: MissingBlob,
    byBlob: ReadonlyMap<string, MethodTreeSourceFile>,
    read: ReadonlyMap<string, Uint8Array> | undefined,
    sending: TreeSending,
    signal: AbortSignal,
    userSignal: AbortSignal | undefined,
  ): Promise<void> {
    const file = byBlob.get(blob.sha256)!;
    throwIfAborted(userSignal);
    const bytes = read?.get(file.path) ?? (await tree.readFile(file.path));
    const bytesSha256 = await sha256Hex(bytes);
    if (bytes.length !== blob.size || bytesSha256 !== blob.sha256) {
      throw new RequestArgumentError(
        `The tree read ${bytes.length} bytes hashing to ${bytesSha256} for '${file.path}', which ` +
          `its listing names as ${blob.size} bytes hashing to ${blob.sha256}, so they were not ` +
          `uploaded and ${sending.unsent}.`,
      );
    }
    throwIfAborted(userSignal);
    await uploadBlob(blob, bytes, {
      timeoutMs: this.requestTimeoutMs,
      signal,
      unsent: sending.unsent,
    });
  }

  /**
   * Rename a method — `PATCH /v1/methods/{id}` — and return it. The name belongs to the method,
   * not to a version: a rename changes nothing else, moves no token, and never commits the
   * draft, so the `updated_at` a caller holds stays valid for its next `writeDraft` or
   * `publishMethod`.
   *
   * Takes a bare catalog id, as `getMethod` does. Throws `ApiResponseError`: `404` `not_found`,
   * `409` `method_being_deleted`, `403` for a read-only key, `422` for an empty name or one
   * holding a lone surrogate, `413` `payload_too_large` for a name so long it would leave the
   * method too large to publish, and a `503` that wrote nothing, safe to retry, when draft
   * writes kept landing under the rename.
   */
  async renameMethod(methodId: string, input: MethodRenameInput): Promise<MethodData> {
    return this.requestMethodData("PATCH", methodPath(methodId, "renameMethod"), {
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
    const endpoint = `${methodPath(methodId, "publishMethod")}/publish`;
    const res = await this.requestProductAnswer("POST", endpoint, {
      expected_draft_updated_at: token,
    });
    const { answer, outcome, subject } = this.readVerdict("POST", endpoint, res, {
      verdict: "a publish result",
      outcomes: ["published", "unchanged", "refused"],
      member: "method",
    });
    return { ...answer, outcome, method: subject as unknown as MethodData } as MethodPublishResult;
  }

  /**
   * One page of a method's published versions, newest first, without their files —
   * `GET /v1/methods/{id}/versions`.
   *
   * Pass the page's `nextCursor` back as `cursor` to continue; `null` is the last page. A page
   * may be short while `nextCursor` is set, because the platform reads versions whole. A method
   * never published answers an empty page.
   *
   * Takes a bare catalog id, as `getMethod` does. Throws `ApiResponseError`: `404` `not_found`
   * for an unknown method, `409` `method_being_deleted`, `400` `malformed_request` for a cursor
   * the listing did not issue for this method, `422` for a `limit` outside 1 to 100. A page whose `items` is not an array or whose `next_cursor` is neither a string nor `null`
   * is an answer the SDK cannot read, thrown as an `ApiResponseError` too.
   */
  async listMethodVersions(
    methodId: string,
    query: ListMethodVersionsQuery = {},
  ): Promise<MethodVersionPage> {
    const search = productQuery({ limit: query.limit, cursor: query.cursor });
    const endpoint = `${methodPath(methodId, "listMethodVersions")}/versions`;
    return this.requestPage<MethodVersionSummary>(`${endpoint}${search}`);
  }

  /**
   * One published version of a method, with its files — `GET /v1/methods/{id}/versions/{n}`.
   * `files` lists the version's tree as `getMethod` lists the draft's, each file with a link to
   * its bytes valid for about fifteen minutes, which `writeMethodTree` writes to disk.
   *
   * Takes a bare catalog id, as `getMethod` does, and the version number. Throws
   * `RequestArgumentError` for a `version` that is not a positive integer, before any request.
   * Throws `ApiResponseError`: `404` `method_version_not_found` for a version the method never
   * published, `404` `not_found` for an unknown method, `409` `method_being_deleted`, and `409`
   * `conflict`, whose verdict is `runtime`, for a version stored before methods were trees and
   * never rewritten as one, which names no tree to serve.
   */
  async getMethodVersion(methodId: string, version: number): Promise<MethodVersion> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw argumentRefusal(
        "getMethodVersion",
        "a version number, a positive integer",
        describeNumberArgument(version),
      );
    }
    const endpoint = `${methodPath(methodId, "getMethodVersion")}/versions/${version}`;
    const res = await this.requestProductAnswer("GET", endpoint, undefined);
    return this.readSavedTree<MethodVersion>(
      "GET",
      endpoint,
      withLinks(res),
      "a published version",
    );
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
    return this.requestProduct("DELETE", methodPath(methodId, "deleteMethod"));
  }

  // ── Method examples (`/v1/methods/{id}/examples`) ──────────────────────
  //
  // Every example route takes a bare catalog id, as `getMethod` does, and answers `404`
  // `not_found` for an unknown method or example and `409` `method_being_deleted` while the
  // method's erasure runs. The writes are `403` to a read-only key, which may still read.
  //
  // Every answer carrying an example is read with `parseExactJson`, so an integer past
  // `Number.MAX_SAFE_INTEGER` in its inputs, which another client may have saved, is a `bigint`
  // holding its exact digits, and every request body is written with `stringifyExactJson`, so
  // such inputs go back digit for digit, to `updateMethodExample` or as a run's inputs. Each
  // example is checked by `readMethodExample`: one missing a field the Python SDK's model
  // requires, or holding one of another type, is an answer the SDK cannot read.

  /**
   * Save an example on a method — `POST /v1/methods/{id}/examples`: a named set of inputs, and
   * with `run_id`, a run of this method that used exactly those inputs, recorded as its latest
   * run. Answers the example as stored, at `input_revision` 1.
   *
   * Sends `name`, `inputs` and, when given, `run_id`, and nothing else: the route's body is
   * closed, and a `null` `run_id` reads as not given. Throws `RequestArgumentError` before any
   * request when `name` or `inputs` is not given (`null` counting as not given), and for a
   * `run_id` that is given but is not a non-empty string. Throws `ApiResponseError`: `404`
   * `run_not_found` for a `run_id` that is not one of this method's runs in the caller's
   * organization, with nothing written; `413` `payload_too_large` for an example larger than one
   * stored item holds; `422` for a name that is empty, blank or over 200 characters, or inputs
   * that are not a JSON object; and the codes every example route answers.
   */
  async createMethodExample(
    methodId: string,
    input: MethodExampleCreateInput,
  ): Promise<MethodExample> {
    const endpoint = `${methodPath(methodId, "createMethodExample")}/examples`;
    const {
      name,
      inputs,
      run_id: runId,
    } = (input as Partial<MethodExampleCreateInput> | undefined) ?? {};
    if (name == null || inputs == null) {
      let got: string;
      if (name == null && inputs == null) got = "neither";
      else got = name == null ? "no name" : "no inputs";
      throw new RequestArgumentError(
        `createMethodExample() needs the example's name and its inputs; got ${got}.`,
      );
    }
    const body: Record<string, unknown> = { name, inputs };
    if (runId != null) {
      body.run_id = requireNonEmptyId(runId, "createMethodExample", CREATE_RUN_ID_ARGUMENT);
    }
    return this.requestMethodExample("POST", endpoint, body);
  }

  /**
   * One page of a method's examples, oldest first, inputs included —
   * `GET /v1/methods/{id}/examples`.
   *
   * Pass the page's `nextCursor` back as `cursor` to continue; `null` is the last page. A page
   * may be short while `nextCursor` is set, because the platform reads examples whole and stops
   * a read at 1 MB; `iterateMethodExamples` follows the cursor for a caller that wants them all.
   *
   * Throws `ApiResponseError`: `400` `malformed_request` for a cursor the listing did not issue
   * for this method, `422` for a `limit` outside 1 to 100, and the codes every example route
   * answers. A page whose `items` is not an array, whose `next_cursor` is neither a string nor
   * `null`, or one of whose items is not an example `readMethodExample` can read, is an answer
   * the SDK cannot read, thrown as an `ApiResponseError` too. An example whose inputs hold an
   * integer past the safe range is read like any other, that integer as a `bigint`.
   */
  async listMethodExamples(
    methodId: string,
    query: ListMethodExamplesQuery = {},
  ): Promise<MethodExamplePage> {
    const search = productQuery({ limit: query.limit, cursor: query.cursor });
    const endpoint = `${methodPath(methodId, "listMethodExamples")}/examples${search}`;
    return this.requestPage<MethodExample>(endpoint, {
      parse: parseExactJson,
      item: (row, res) => this.readMethodExample("GET", endpoint, res, row, "a page item"),
    });
  }

  /**
   * Every example of a method, oldest first, streamed — follows the cursor of
   * `listMethodExamples` for you.
   *
   * ```ts
   * for await (const example of client.iterateMethodExamples(methodId)) {
   *   rerun(example); // stop whenever you like
   * }
   * ```
   *
   * An iterator rather than an all-at-once list, for the reason `iterateMethods` is one: a
   * helper returning an array needs a page cap, and a cap returns a truncated list with no
   * error. It runs the same loop as `iterateMethods` and `iterateRuns`, so it keeps going through
   * a short or empty page that carries a cursor, stops on a `null` cursor or on a cursor the
   * server failed to advance, and throws `PagingNotTerminatingError` past the same page ceiling.
   *
   * Throws `RequestArgumentError` at the call, before the iterator is pulled or anything is sent,
   * for a method id `listMethodExamples` refuses: a suffixed one, or one that is empty, `.` or `..`
   * or holds a lone surrogate.
   */
  iterateMethodExamples(
    methodId: string,
    query: Omit<ListMethodExamplesQuery, "cursor"> = {},
  ): AsyncGenerator<MethodExample, void, undefined> {
    // Checked here rather than in a generator's body, which runs only once the iterator is pulled
    // and would refuse the id at the first pull, away from the call that passed it.
    methodPath(methodId, "iterateMethodExamples");
    return followCursor("listMethodExamples", (cursor) =>
      this.listMethodExamples(methodId, { ...query, cursor }),
    );
  }

  /**
   * One example of a method — `GET /v1/methods/{id}/examples/{example_id}`, read consistently,
   * so an example saved a moment ago is found.
   *
   * Throws `RequestArgumentError` for an example id that is empty, `.` or `..`, or holds a lone
   * surrogate, before any request. Throws `ApiResponseError`: `422` for an example id longer
   * than one can be (64 characters), and the codes every example route answers.
   */
  async getMethodExample(methodId: string, exampleId: string): Promise<MethodExample> {
    const endpoint = methodExamplePath(methodId, exampleId, "getMethodExample");
    return this.requestMethodExample("GET", endpoint);
  }

  /**
   * Rename an example, give it new inputs, or both —
   * `PATCH /v1/methods/{id}/examples/{example_id}` — and return it as it now stands.
   *
   * **New inputs raise `input_revision` by one and clear `latest_run_id`**, since the run no
   * longer shows what the inputs produce; inputs that are the same as the stored ones, their
   * keys in another order included, change nothing, while `3` becoming `3.0` is a change. A
   * rename alone keeps both. The edit takes no revision or token: the latest-run write is what
   * the revision guards. Sends `name` and `inputs` when given, and nothing else; `null` reads as
   * not given, as the platform reads it.
   *
   * **Send `inputs` only when they changed.** Inputs read from an example and sent back unchanged
   * are a change for the platform when they hold a float with no fractional part, `3.0`, which
   * JavaScript reads as `3` (see `MethodExample.inputs`): they raise the revision and clear the
   * latest run. A rename sent alone never does. An integer past `Number.MAX_SAFE_INTEGER` is no
   * such case: it reads as a `bigint` and is sent back as its exact digits.
   *
   * Throws `RequestArgumentError` before any request for an example id that is empty, `.` or
   * `..`, or when neither `name` nor `inputs` is given. Throws `ApiResponseError`: `413`
   * `payload_too_large` for inputs larger than one stored item holds, `422` for a name that is
   * empty, blank or over 200 characters, or inputs that are not a JSON object, a `503` that wrote
   * nothing, safe to retry, when concurrent edits kept landing under the write, and the codes
   * every example route answers.
   */
  async updateMethodExample(
    methodId: string,
    exampleId: string,
    input: MethodExampleUpdateInput,
  ): Promise<MethodExample> {
    const endpoint = methodExamplePath(methodId, exampleId, "updateMethodExample");
    const { name, inputs } = (input as Partial<MethodExampleUpdateInput> | undefined) ?? {};
    const body: Record<string, unknown> = {};
    if (name != null) body.name = name;
    if (inputs != null) body.inputs = inputs;
    if (Object.keys(body).length === 0) {
      throw new RequestArgumentError(
        "updateMethodExample() needs a new name, new inputs, or both; got neither.",
      );
    }
    return this.requestMethodExample("PATCH", endpoint, body);
  }

  /**
   * Record a run as an example's latest —
   * `PUT /v1/methods/{id}/examples/{example_id}/latest-run` — **only while the example still
   * holds the revision whose inputs the run used**.
   *
   * `input_revision` is the example's `input_revision` the caller read when it started the run
   * with the example's inputs; the platform trusts it and does not compare the run's own inputs.
   * The answer is a `MethodExampleLatestRunResult` discriminated on `outcome` — branch on it:
   * `recorded`, the run is now the example's latest; `stale`, the example's inputs were edited
   * since and nothing was written. A stale run is the expected end of a run that outlasted an
   * edit, so it is answered, never thrown. Both arms carry the `example` as it stands.
   *
   * Throws `RequestArgumentError` before any request, checking in this order: an example id that
   * is empty, `.` or `..`, or holds a lone surrogate, a `run_id` that is not a non-empty string,
   * and an `input_revision` that is not a positive integer. Throws `ApiResponseError` when no
   * verdict was produced: `404` `not_found` for an example deleted since, `404` `run_not_found`
   * for a run that is not one of this method's, with nothing written, and the codes every example
   * route answers. An answer whose `outcome` is neither arm's, or whose `example` is not an
   * example `readMethodExample` can read, is an answer the SDK cannot read, thrown as an
   * `ApiResponseError` too, read as `publishMethod` reads its verdict.
   */
  async recordMethodExampleLatestRun(
    methodId: string,
    exampleId: string,
    input: MethodExampleLatestRunInput,
  ): Promise<MethodExampleLatestRunResult> {
    const call = "recordMethodExampleLatestRun";
    const endpoint = `${methodExamplePath(methodId, exampleId, call)}/latest-run`;
    const { run_id: runId, input_revision: revision } =
      (input as Partial<MethodExampleLatestRunInput> | undefined) ?? {};
    const run = requireNonEmptyId(runId, call, RECORD_RUN_ID_ARGUMENT);
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
      throw argumentRefusal(
        call,
        "an input_revision, the example's revision whose inputs the run used, a positive integer",
        describeNumberArgument(revision),
      );
    }
    const res = await this.requestProductAnswer("PUT", endpoint, {
      run_id: run,
      input_revision: revision,
    });
    const { answer, outcome, subject } = this.readVerdict("PUT", endpoint, res, {
      verdict: "a latest-run result",
      outcomes: ["recorded", "stale"],
      member: "example",
      parse: parseExactJson,
      // Checked once, by the check every example the client hands back goes through.
      readMember: (value) =>
        this.readMethodExample("PUT", endpoint, res, value, "a latest-run result's `example`"),
    });
    return { ...answer, outcome, example: subject } as MethodExampleLatestRunResult;
  }

  /**
   * Delete an example — `DELETE /v1/methods/{id}/examples/{example_id}`. The platform answers
   * `204`. Deleting the example leaves its latest run in the method's history.
   *
   * Throws `RequestArgumentError` for an example id that is empty, `.` or `..`, before any
   * request: `..` would address the method, and its erasure would answer the delete. Throws
   * `ApiResponseError`: `404` `not_found` when there is no such example, one already deleted
   * included, and the codes every example route answers.
   */
  async deleteMethodExample(methodId: string, exampleId: string): Promise<void> {
    await this.requestProduct(
      "DELETE",
      methodExamplePath(methodId, exampleId, "deleteMethodExample"),
    );
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
    const segment = idPathSegment(orgId, "renameOrganization", ORG_ID_ARGUMENT);
    return this.requestProduct("PATCH", `organizations/${segment}`, input);
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
    const segment = idPathSegment(id, "revokePipelexApiKey", API_KEY_ID_ARGUMENT);
    await this.requestProduct("DELETE", `pipelex-api-keys/${segment}`);
  }

  /**
   * Rotate a Pipelex API key — `POST /v1/pipelex-api-keys/{id}/rotate` (no
   * body). Returns the new plaintext `api_key` once; the old key stops working.
   */
  async rotatePipelexApiKey(id: string): Promise<PipelexApiKeyCreated> {
    const segment = idPathSegment(id, "rotatePipelexApiKey", API_KEY_ID_ARGUMENT);
    return this.requestProduct("POST", `pipelex-api-keys/${segment}/rotate`);
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
   * - the method's tree — a `directory`, `contents`, a listed `tree` or the `files`
   *   map, sent as `pipeIo` sends it, with the files its steps read (a `PipeDocGen`
   *   step's `template_file`) among its files;
   * - `method_ref` — a published method's address, fetched by the runner;
   * - `method_id` — a stored method's catalog id, resolved by the platform
   *   (hosted only; requires an API key).
   *
   * The route also selects the pipe — the caller's qualified `pipe_ref`, else the
   * method's own entry pipe — and the signature is the input-form descriptor it
   * answers with, which states the kind of every input at every depth, so a file
   * position is a fact of the method, never a guess from the value's shape. It
   * needs an API serving `POST /v1/pipe-io`. See `docs/input-preparation.md`.
   *
   * A value at a file input that cannot be a file, such as a number or a
   * `data:` URL that does not decode, throws `InvalidInputValueError`, naming the
   * input. With `allowUploads: false` it uploads nothing and reads no file: a
   * value that would need an upload throws `UploadNotAllowedError`, naming the
   * input too.
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
   * `createdBy: "me"` keeps the caller's own runs and `status` the runs in any of the given
   * statuses, sent as `created_by=me` and one repeated `status=` parameter per status. Both are
   * filters applied after the index read, so a filtered page can hold fewer runs than `limit`,
   * or none, and still carry a `nextCursor`: an empty page is not the end, a `null` cursor is.
   * An empty `status` list, or a name that is no `RunStatus`, is a `RequestArgumentError`
   * before any request.
   *
   * Takes a bare catalog id: the history files the runs of every version and
   * of the draft together under it, so `mt_…@3` names no history of its own
   * and the platform refuses it with a `400`. Strip a suffix with
   * `parseMethodSelector`, and read which version a run ran from its
   * `method_version`.
   */
  async listRuns(methodId: string, query: ListRunsQuery = {}): Promise<RunPage> {
    // An empty date is sent, not dropped: it reaches the API's instant parse and comes back a
    // `400` saying so, where dropping it would return every run (`productQuery`).
    const search = productQuery({
      method_id: methodId,
      created_from: query.createdFrom,
      created_to: query.createdTo,
      created_by: query.createdBy,
      status: runStatusFilter(query.status),
      limit: query.limit,
      cursor: query.cursor,
    });
    const page = await this.requestPage<RunHistoryItem>(`runs${search}`);
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
   * It keeps going **through an empty page that carries a cursor**: under `createdBy` or
   * `status` such a page means "nothing matched in the slice just read", not "done". It stops on
   * a `null` cursor or on a cursor the server failed to advance, and throws
   * `PagingNotTerminatingError` past a page ceiling no real history reaches.
   *
   * Takes a bare catalog id, as `listRuns` does.
   */
  async *iterateRuns(
    methodId: string,
    query: Omit<ListRunsQuery, "cursor"> = {},
  ): AsyncGenerator<RunHistoryItem, void, undefined> {
    yield* followCursor("listRuns", (cursor) => this.listRuns(methodId, { ...query, cursor }));
  }

  /**
   * The whole record for one run — `GET /v1/runs/{id}`.
   *
   * The ONLY call that returns what the run actually executed and its
   * `inputs`. Kept off the status read, which pollers hit every few seconds. A failed run's stored report, `error`, is checked field by
   * field (see `RunErrorReport`).
   *
   * Read with `parseExactJson`, so an integer past `Number.MAX_SAFE_INTEGER` in the inputs is a
   * `bigint` holding its exact digits, and the inputs passed back to `start` or saved as an
   * example's go back as the run used them.
   */
  async getRunDetail(runId: string): Promise<RunDetail> {
    const endpoint = `runs/${idPathSegment(runId, "getRunDetail", RUN_ID_ARGUMENT)}`;
    const res = await this.requestProductAnswer("GET", endpoint, undefined);
    return withCheckedReport(
      this.readObjectAnswer<RunDetail>("GET", endpoint, res, {}, parseExactJson),
    );
  }

  /** Patch a run's status (admin/manual) — `PUT /v1/runs/{id}`. */
  async updateRun(runId: string, input: UpdateRunInput): Promise<void> {
    const segment = idPathSegment(runId, "updateRun", RUN_ID_ARGUMENT);
    await this.requestProduct("PUT", `runs/${segment}`, input);
  }

  /**
   * A run's arguments checked before anything is listed, read or sent, `call` naming the caller's
   * method in each refusal: the generic `extra` passthrough, the Pipelex API's and the hosted
   * API's own selectors, and the method's tree in its forms as the standard checks them; then the
   * "something to run" precondition, the `method_ref` pairings and the linkage form's bare
   * `method_id`.
   */
  private runParts(call: "execute" | "start", options: PipelexRunOptions): RunParts {
    const extensions = buildExtensions(options.extra);
    const api = buildApiRunExtensions(options);
    const hosted = buildHostedRunExtensions(options);
    const forms = protocolTreeForms(call, options);
    const treeForms = treeFormsGiven(forms);
    if (
      !options.pipe_code &&
      treeForms.length === 0 &&
      Object.keys(api).length === 0 &&
      Object.keys(hosted).length === 0 &&
      Object.keys(extensions).length === 0
    ) {
      throw new RequestArgumentError(
        `Either pipe_code, the method's tree (directory, contents, tree or files), a method_ref, a hosted method_id or a server-specific extension arg (extra) must be provided to ${call}().`,
      );
    }
    assertMethodRefPairsWithNothing(options, treeForms);
    assertLinkageMethodIdIsBare(options, treeForms);
    return { forms, extensions, api, hosted };
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
  private async executeBlocking(
    options: PipelexStartOptions,
    signal: AbortSignal | undefined,
    sending: PreparedRunTree,
  ): Promise<RunResults> {
    const response = await this.executeRun(
      {
        pipe_code: options.pipe_code ?? undefined,
        inputs: options.inputs ?? undefined,
        output_name: options.output_name ?? undefined,
        output_multiplicity: options.output_multiplicity ?? undefined,
        dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
        // The method's tree must survive the fallback too — a bare runner reached through this path
        // runs the same method as the durable one, or it runs nothing. Its forms are checked here as
        // the start checked them, and `sending` carries the tree the start prepared, sent as is.
        directory: options.directory ?? undefined,
        contents: options.contents ?? undefined,
        tree: options.tree ?? undefined,
        files: options.files ?? undefined,
        method_ref: options.method_ref ?? undefined,
        method_id: options.method_id ?? undefined,
        extra: options.extra ?? undefined,
      },
      signal,
      sending,
    );
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
  return `${shown} with ${inWords(parts, "and")} (not shown)`;
}

// The protocol's own request fields — `extra` is for extension args only.
// `files` is reserved too: it is the method's tree, a named option, so smuggling
// it through `extra` (which merges last into the body) would overwrite the
// prepared tree and bypass the one-form check.
const PROTOCOL_REQUEST_KEYS: readonly string[] = [
  "pipe_code",
  "inputs",
  "output_name",
  "output_multiplicity",
  "dynamic_output_concept_ref",
  "files",
];

// The PIPELEX API's own request field — the layer-2 extension the runner reads
// itself (`method_ref`, a run source in its own right). Reserved on `extra` for
// the same reason the protocol fields are: `extra` merges last, so a smuggled
// copy would overwrite the validated named option and bypass the
// selector-exclusivity check.
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

// The client-only options, which are never serialized as such: the three forms of
// the method's tree the client turns into `files` (`directory`, `contents`, `tree`)
// and the `bundleMain` hint. Reserved on `extra` so none of them reaches the wire
// through the passthrough under its own name.
const CLIENT_ONLY_KEYS: readonly string[] = ["directory", "contents", "tree", "bundleMain"];

// Keys that must never ride `extra`: the named request options above (which
// `extra` would overwrite — it merges last into the body) plus the client-only
// options. A field the client no longer names, such as the runner's legacy
// `mthds_contents`, is NOT reserved: `extra` is the passthrough for exactly that.
const RESERVED_EXTRA_KEYS: ReadonlySet<string> = new Set([
  ...PROTOCOL_REQUEST_KEYS,
  ...PIPELEX_API_REQUEST_KEYS,
  ...HOSTED_REQUEST_KEYS,
  ...CLIENT_ONLY_KEYS,
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
 * Whether a crate request's `files` carry more inline than `INLINE_TREE_MAX_BYTES`, weighed as the
 * request spends them: a tree sent inline to an API keeping no blob store, whatever its weight, or
 * a `files` map given as is. A map of hash entries weighs little, and a value that is not a map
 * is not weighed.
 */
function carriesLargeInlineTree(files: MethodFiles | null | undefined): boolean {
  if (files === null || files === undefined || !isPlainObject(files)) return false;
  try {
    return inlineMapBytes(files) > INLINE_TREE_MAX_BYTES;
  } catch {
    // A map JSON cannot carry is refused as the caller's argument when the request is written.
    return false;
  }
}

/**
 * A method's tree as a call gave it, ready to send: a tree to prepare (listed from a `directory`,
 * built from `contents`, or given), a `files` map sent as given (`null` emptying a draft), or
 * `undefined` for a call that gives none.
 */
type TreeToSend =
  { readonly tree: MethodTreeSource } | { readonly files: MethodFiles | null } | undefined;

/** A tree prepared for one send: the `files` map it carries, and the tree when it went by hash. */
interface PreparedFiles {
  readonly files: MethodFiles | null | undefined;
  readonly byHashTree: MethodTreeSource | undefined;
}

/** A tree already prepared for a first send, with the bytes read while preparing it. */
interface PreparedTreeSend {
  readonly prepared: PreparedFiles;
  readonly read: Map<string, Uint8Array>;
}

/**
 * The tree `startAndWaitForResult` prepares once and hands to the start and to the blocking
 * execute: what the call gave, and, for a tree to prepare, its first preparation.
 */
interface PreparedRunTree {
  readonly source: TreeToSend;
  readonly initial: PreparedTreeSend | undefined;
}

/** A run's arguments as `runParts` checked them. */
interface RunParts {
  readonly forms: MethodTreeForms;
  readonly extensions: Record<string, unknown>;
  readonly api: Record<string, unknown>;
  readonly hosted: Record<string, unknown>;
}

/**
 * A run's wire body: the protocol's arguments, the method's `files`, then the Pipelex API's and
 * the hosted API's selectors and the `extra` passthrough. A start drops a `null` argument, as it
 * always has; `execute` sends its arguments as given. `?? undefined` so `JSON.stringify` drops an
 * absent field from the wire body.
 */
function runRequestBody(
  call: "execute" | "start",
  options: PipelexRunOptions,
  files: MethodFiles | null | undefined,
  parts: RunParts,
): RunRequest & Record<string, unknown> {
  const dropNull = call === "start";
  return {
    pipe_code: dropNull ? (options.pipe_code ?? undefined) : options.pipe_code,
    inputs: dropNull ? (options.inputs ?? undefined) : options.inputs,
    output_name: dropNull ? (options.output_name ?? undefined) : options.output_name,
    output_multiplicity: dropNull
      ? (options.output_multiplicity ?? undefined)
      : options.output_multiplicity,
    dynamic_output_concept_ref: dropNull
      ? (options.dynamic_output_concept_ref ?? undefined)
      : options.dynamic_output_concept_ref,
    files: files ?? undefined,
    ...parts.api,
    ...parts.hosted,
    ...parts.extensions,
  };
}

/**
 * The error a blocking execute throws for `err`: a `PipelineExecuteTimeoutError` when the hosted
 * gateway cut the request off (see `isGatewayCutOff`), timed from `sentAt`, and `err` otherwise.
 */
function executeCutOff(err: unknown, sentAt: number): unknown {
  if (err instanceof RunStillRunningError) return err;
  const elapsedMs = performance.now() - sentAt;
  return isGatewayCutOff(err, elapsedMs)
    ? new PipelineExecuteTimeoutError(elapsedMs, { cause: err })
    : err;
}

/**
 * Whether a run's `extra` carries a method bundle a runner reads, `mthds_contents` or
 * `bundle_b64`, as the `pipelex-sdk` command sends one: a start carrying one gets the request
 * ceiling, as the Python SDK gives it, since the bundle can make the body large.
 */
function carriesExtraBundle(extensions: Record<string, unknown>): boolean {
  const contents = extensions["mthds_contents"];
  const carriesContents = Array.isArray(contents) ? contents.length > 0 : Boolean(contents);
  return carriesContents || Boolean(extensions["bundle_b64"]);
}

/** The refusal of a `directory` that is not a path, `call` naming the caller's method. */
function directoryRefusal(call: string): RequestArgumentError {
  return new RequestArgumentError(
    `${call}() got a directory that is not a path: give the method's directory as a string.`,
  );
}

/**
 * `value` as a listed tree, or the refusal of one that is not, `call` naming the caller's method:
 * a `tree` must have its `files`, its `digest` and a `readFile`, as the `MethodTree` the `mthds`
 * package's `listMethodTree` returns has, which the shape check `prepareInputs` applies too.
 */
function checkedTreeSource(call: string, value: unknown): MethodTreeSource {
  const fault = treeShapeFault(value);
  if (fault !== undefined) {
    throw new RequestArgumentError(
      `${call}() got a tree that is not a listed method tree — its files, its digest and a ` +
        `readFile — such as the MethodTree listMethodTree returns; got ${fault}.`,
    );
  }
  return value as MethodTreeSource;
}

/**
 * The whole tree inline, for a receiver keeping no blob store, held to the inline limit it
 * announces as `mthds`'s `MthdsApiClient` holds it: its files' declared sizes are checked before
 * anything is read, since the inline map weighs at least that much, then the encoded map, so a
 * tree the receiver would refuse is refused here with `RequestArgumentError`, naming the limit,
 * without being sent. Each file is read into `read`, under `signal`.
 */
async function inlineWithin(
  tree: MethodTreeSource,
  call: string,
  sending: TreeSending,
  maxInlineBytes: number | undefined,
  read: Map<string, Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<MethodFiles> {
  if (maxInlineBytes !== undefined && treeTotalSize(tree) > maxInlineBytes) {
    throw inlineLimitRefusal(
      call,
      sending,
      "its files alone weigh",
      treeTotalSize(tree),
      maxInlineBytes,
    );
  }
  const inline = inlineFilesOf(tree, await readTreeBytesInto(tree, read, signal));
  if (maxInlineBytes !== undefined) {
    const weight = inlineMapBytes(inline);
    if (weight > maxInlineBytes) {
      throw inlineLimitRefusal(call, sending, "its inline map weighs", weight, maxInlineBytes);
    }
  }
  return inline;
}

/** The refusal of a tree past the inline limit of a receiver keeping no blob store. */
function inlineLimitRefusal(
  call: string,
  sending: TreeSending,
  measured: string,
  weight: number,
  limit: number,
): RequestArgumentError {
  return new RequestArgumentError(
    `${call}() cannot send the method's tree: the API keeps no blob store, so the tree travels ` +
      `inline, and ${measured} ${weight} bytes, past the ${limit} bytes it takes inline (its ` +
      `max_inline_bytes), so ${sending.unsent}.`,
  );
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
 * The forms of the method's tree a protocol route (a run, `validate`) was given, checked as the
 * MTHDS standard checks them: its `assertOneMethodSource` on `files` and `tree` (both at once, or
 * either holding no file, refused whatever else the request carries), its refusal rethrown as a
 * `RequestArgumentError` with the same message and the standard's error as `cause`, so it carries
 * a verdict like every other argument the client refuses; and `contents` holding no file refused
 * the same way. A `null` member and an empty `directory` are absent.
 */
function protocolTreeForms(call: string, options: MethodTreeForms): MethodTreeForms {
  // A `tree` the standard's check would read as a tree is checked as one first, so a value that
  // is not one is refused as the caller's argument rather than failing as a native TypeError.
  if (options.tree != null) checkedTreeSource(call, options.tree);
  try {
    assertOneMethodSource({ files: options.files ?? null, tree: options.tree ?? null });
  } catch (err) {
    if (err instanceof PipelineRequestError) {
      throw new RequestArgumentError(err.message, { cause: err });
    }
    throw err;
  }
  const contents = options.contents ?? undefined;
  if (
    contents !== undefined &&
    typeof contents === "object" &&
    Object.keys(contents).length === 0
  ) {
    throw emptyTreeRefusal(call, "contents", REQUEST_SENDING);
  }
  return {
    directory:
      typeof options.directory === "string"
        ? nonEmptyString(options.directory)
        : (options.directory ?? undefined),
    contents,
    tree: options.tree ?? undefined,
    files: options.files ?? undefined,
  };
}

/**
 * The names of the forms of the method's tree `input` gives, in the order the refusals name them.
 * `files` counts when it is not `undefined`, since a save's `files: null` empties a draft; the
 * other forms count when they are neither `undefined` nor `null`, and `directory` when it is not
 * empty either. A route that reads `files: null` as absent normalizes it before asking.
 */
function treeFormsGiven(input: MethodTreeForms): string[] {
  const given: string[] = [];
  if (input.directory != null && input.directory !== "") given.push("directory");
  if (input.contents != null) given.push("contents");
  if (input.tree != null) given.push("tree");
  if (input.files !== undefined) given.push("files");
  return given;
}

/**
 * Enforce the run routes' `method_ref` exclusivity, mirroring the server's own
 * 422s so an illegal pairing fails before anything is listed, read or sent. A
 * `method_ref` is a complete run source (the fetched package carries its whole
 * tree and its entry pipe), so it pairs with NOTHING: not with the method's tree
 * in any form, and not with the hosted `method_id` — an address run has its own
 * provenance and needs no linkage id.
 *
 * The one documented run-route exception is deliberately NOT here: a tree +
 * `method_id` stays legal (the tree runs; the id demotes to run-history linkage),
 * its one condition, a bare id, held by `assertLinkageMethodIdIsBare` below.
 * `pipe_code` beside a `method_ref` is legal too — it overrides the manifest's
 * `main_pipe`. The selectors count when non-empty.
 */
function assertMethodRefPairsWithNothing(
  options: PipelexApiRunExtensions & PipelexHostedRunExtensions,
  treeForms: readonly string[],
): void {
  if (nonEmptyString(options.method_ref) === undefined) return;
  if (treeForms.length > 0) {
    throw new RequestArgumentError(
      `method_ref and the method's tree (${treeForms.join(", ")}) are mutually exclusive: a ` +
        "published method's tree is its package's own. Send one or the other.",
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
 * Enforce the run routes' linkage clause, mirroring the platform's own `422` so a
 * suffixed linkage id fails before anything is listed, read or sent. Beside the
 * method's tree, in any form, the `method_id` is run-history linkage and must be a
 * bare catalog id: the tree is what runs, so a version suffix (`mt_…@3`,
 * `mt_…@draft`) would claim a version that did not. A `method_id` alone keeps its
 * suffix, which names the version to run. Only the suffix is checked, by its `@`,
 * since the catalog id's alphabet has none: the id itself stays a pass-through the
 * platform resolves.
 */
function assertLinkageMethodIdIsBare(
  options: PipelexHostedRunExtensions,
  treeForms: readonly string[],
): void {
  const methodId = nonEmptyString(options.method_id);
  if (methodId === undefined || !methodId.includes("@")) return;
  if (treeForms.length === 0) return;
  throw new RequestArgumentError(
    `method_id "${methodId}" beside the method's tree is run-history linkage and must be a bare ` +
      "catalog id: the tree is what runs, so a version suffix would claim a version that did " +
      "not. Send the bare id (parseMethodSelector(...).method_id), or drop the tree to run the " +
      "version the selector names.",
  );
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined;
}

/** The request header the hosted API reads a run start's idempotency key from. */
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * The longest idempotency key a start sends. It is room for any generated key, and keeps the
 * hosted API's stored record of the key far inside its store's limit, which a longer key could
 * exceed, so that the start would run without the protection the key was sent for.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Visible ASCII, `!` to `~`: what a header value carries unchanged through every proxy and both
 * SDKs' transports, where fetch refuses a line break, httpx a character outside ASCII, and a space
 * at either end is trimmed on the way.
 */
const VISIBLE_ASCII = /^[\x21-\x7E]+$/;

/**
 * The idempotency key a start sends, or `undefined` when the options carry none (absent or
 * `null`). A key that is not a string of 1 to 255 visible ASCII characters is refused with a
 * `RequestArgumentError` rather than dropped, an empty one included, since a start sent without
 * the key its caller gave would lose the protection the caller asked for without a word. The
 * message never quotes the key, which a caller may derive from something private. The Python SDK
 * holds a key to the same rule, in the same words.
 */
function idempotencyKeyOf(options: PipelexStartRequestOptions): string | undefined {
  const key: unknown = options.idempotencyKey;
  if (key == null) return undefined;
  const fault = idempotencyKeyFault(key);
  if (fault !== undefined) {
    throw new RequestArgumentError(
      `The idempotency key must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} visible ASCII characters ` +
        `(\`!\` to \`~\`), and this one ${fault}. Leave it out to start the run without one.`,
    );
  }
  return key as string;
}

/**
 * What is wrong with an idempotency key, or `undefined` when it is a valid one. The characters are
 * checked before the length, which then counts ASCII characters alone, so the two SDKs, which
 * count a character outside ASCII differently, word every refusal alike.
 */
function idempotencyKeyFault(key: unknown): string | undefined {
  if (typeof key !== "string") return "is not a string";
  if (key.length === 0) return "is empty";
  if (!VISIBLE_ASCII.test(key)) return "holds a character outside visible ASCII";
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return `is ${key.length} characters long`;
  return undefined;
}

function withValidateMarkdownRender(render: string[] | undefined): string[] {
  const formats = new Set(render ?? []);
  formats.add(VALIDATE_MARKDOWN_RENDER_FORMAT);
  return [...formats];
}

// The hosted gateway caps synchronous requests at 30s. A failure at/after this
// threshold is the gateway's cut-off, not a transient outage — the threshold
// guards against mislabelling a fast 503 (runner genuinely down) as a timeout.
// The one source of the threshold in this SDK: `isGatewayCutOff` reads it.
const GATEWAY_TIMEOUT_THRESHOLD_MS = 28_000;

/**
 * Whether a request that failed `elapsedMs` after it was sent was cut off by the hosted gateway's
 * ~30-second limit on a request it waits on, rather than refused.
 *
 * It is when, after at least ~28 seconds, the failure is a `503` or `504` answer, or the client's
 * own time limit (`ApiUnreachableError` with the code `ABORT_TIMEOUT`). A fast `503` is the API
 * saying the request was not handled, and any other unreachable host is never the gateway's
 * cut-off, however long it took. The fetch API cannot say whether `ABORT_TIMEOUT` ran out before
 * the connection was made, so it is read as the gateway's; with Node's own dispatcher it never
 * does past the threshold, since undici gives up a connection that does not come after ten
 * seconds (`UND_ERR_CONNECT_TIMEOUT`), the TLS handshake included. The Python SDK's
 * `is_gateway_cut_off` reads the same failures, its `ABORT_TIMEOUT` being httpx's read or write
 * timeout.
 *
 * The blocking `execute` turns such a failure into a `PipelineExecuteTimeoutError`. Whether a
 * failed `start` or `execute` may have started a run needs no timing: the error says it as
 * `runMayHaveStarted`, which reads every `503` but the platform's coded one as a run that may
 * have started, however quickly it came back.
 */
export function isGatewayCutOff(error: unknown, elapsedMs: number): boolean {
  if (elapsedMs < GATEWAY_TIMEOUT_THRESHOLD_MS) return false;
  if (error instanceof ApiResponseError) return error.status === 503 || error.status === 504;
  if (error instanceof ApiUnreachableError) return error.code === "ABORT_TIMEOUT";
  return false;
}

/**
 * The codes Node's fetch gives a body that arrived and could not be decoded. It decodes a
 * `Content-Encoding` while it reads the body, after the status and the headers, and a body that
 * does not decode fails the read with the decompressor's own code: zlib's `Z_…` for `gzip` and
 * `deflate`, brotli's `ERR__ERROR_…` for `br`, zstd's `ZSTD_error_…` for `zstd`.
 */
const UNDECODABLE_BODY_CODE = /^(Z_|ERR__ERROR_|ZSTD_error_)/;

/**
 * Whether an `ApiUnreachableError` is an answer whose body could not be decoded, rather than no
 * answer at all. The Python SDK's twin is the `ApiUnreachableError` whose cause is httpx's
 * `DecodingError`.
 */
function isUndecodableBody(error: ApiUnreachableError): boolean {
  return error.code !== undefined && UNDECODABLE_BODY_CODE.test(error.code);
}

/** A SHA-256 as the platform names a blob: 64 lowercase hexadecimal digits. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `res`, marked as an answer whose body carries signed links (`RawResponse.carriesLinks`). */
function withLinks(res: RawResponse): RawResponse {
  return { ...res, carriesLinks: true };
}

/** Whether one entry of a `POST /v1/blobs/missing` answer is a blob with its upload target. */
function isMissingBlob(entry: unknown): entry is MissingBlob {
  if (!isPlainObject(entry)) return false;
  const { sha256, size, upload } = entry;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return false;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return false;
  if (!isPlainObject(upload)) return false;
  if (typeof upload.method !== "string" || typeof upload.url !== "string") return false;
  const headers = upload.headers;
  return (
    isPlainObject(headers) && Object.values(headers).every((value) => typeof value === "string")
  );
}

/**
 * Why a saved tree's listing is not one the SDK reads, or `null` when it is: an array of objects,
 * each with a string `path`, `sha256`, `url` and `expires_at` and a non-negative integer `size`.
 */
function savedFilesFault(files: unknown): string | null {
  if (!Array.isArray(files)) return "is not an array";
  for (let index = 0; index < files.length; index += 1) {
    const file: unknown = files[index];
    if (!isPlainObject(file)) return `holds an entry that is not an object, at [${index}]`;
    for (const member of ["path", "sha256", "url", "expires_at"]) {
      if (typeof file[member] !== "string") {
        return `holds an entry whose \`${member}\` is not a string, at [${index}]`;
      }
    }
    if (!SHA256_HEX.test(file.sha256 as string)) {
      return `holds an entry whose \`sha256\` is not 64 lowercase hex digits, at [${index}]`;
    }
    const size = file.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return `holds an entry whose \`size\` is not a non-negative integer, at [${index}]`;
    }
  }
  return null;
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
  const reading = parseJsonBody(body);
  if (!reading.ok) return true;
  const parsed = reading.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  return !("code" in parsed);
}

/**
 * Whether a 2xx answer to `execute` is the completed run the route returns, as far as the SDK reads
 * it: a string `pipeline_run_id`, and a `pipe_output` object whose `working_memory` carries its
 * `root` and `aliases` objects and whose own `pipeline_run_id` is a string, the envelope the Python
 * SDK's model of the answer requires. Anything less is an answer the SDK cannot read, rather than
 * a result that fails with a bare `TypeError` once its output is lifted. The stuffs inside `root`,
 * which the Python model also checks, are left to the read of the main stuff, whose
 * `MissingMainStuffError` names the run.
 */
function isCompletedRunAnswer(answer: object): answer is DictRunResultExecute {
  const { pipeline_run_id: runId, pipe_output: pipeOutput } = answer as {
    pipeline_run_id?: unknown;
    pipe_output?: unknown;
  };
  if (typeof runId !== "string" || !isPlainObject(pipeOutput)) return false;
  const workingMemory = pipeOutput["working_memory"];
  return (
    typeof pipeOutput["pipeline_run_id"] === "string" &&
    isPlainObject(workingMemory) &&
    isPlainObject(workingMemory["root"]) &&
    isPlainObject(workingMemory["aliases"])
  );
}

/** Parse the `Retry-After` header (seconds form, which the platform uses). */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

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

/**
 * A status read with its `degradation` checked by `readRunDegradation`. Only when the read carries
 * the key, so a platform that predates it still leaves it absent; `degraded` is left as sent.
 */
function withCheckedDegradation(run: RunRead): RunRead {
  if (!Object.hasOwn(run, "degradation")) return run;
  return { ...run, degradation: readRunDegradation(run.degradation) };
}

function knownRunStatus(value: unknown): RunStatus | undefined {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value)
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
  details: ProblemDetails;
  document: Record<string, unknown> | undefined;
} {
  const empty = {
    errorType: undefined,
    serverMessage: undefined,
    validationErrors: undefined,
    code: undefined,
    details: {},
    document: undefined,
  };
  if (!body) return empty;
  // Read by the protocol's rules, as every body is: JSON nested deeper than `MAX_BODY_NESTING`, or
  // holding a number past the range of a double, carries no member, as `pipelex-sdk` reads it.
  const reading = parseJsonBody(body);
  if (!reading.ok || !isPlainObject(reading.value)) {
    return empty;
  }
  const root = reading.value;
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
  const details: ProblemDetails = {
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
  return { errorType, serverMessage, validationErrors, code, details, document: root };
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
