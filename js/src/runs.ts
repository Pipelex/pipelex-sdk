import type { InputForm, OutputForm, PipeIOContracts, Problem } from "mthds/protocol";

import {
  RequestArgumentError,
  RunFailedError,
  argumentInvalidProblem,
  RunLifecycleUnavailableError,
  RunTimeoutError,
} from "./errors.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import { dropUnfit, isPlainObject } from "./records.js";
import type { DictPipeOutput, DictWorkingMemory, PipelexRunResultStart } from "./models.js";

/**
 * Run-lifecycle types + polling for the hosted polling surface (`/v1/runs/*`).
 *
 * Long method runs outlive the hosted gateway's ~30s synchronous cap, so the
 * SDK submits a run (`POST /v1/start`), then polls a self-healing endpoint by
 * bare `pipeline_run_id` until the run reaches a terminal state. All state lives behind
 * the id (DynamoDB + Temporal on the platform), so a caller can drop the poll
 * loop and resume later with just the id.
 *
 * Polling is NOT part of the MTHDS Protocol — it is a hosted-API extension. A
 * bare runner 404s these routes, which the client translates into
 * `RunLifecycleUnavailableError`.
 *
 * Wire contract mirrors the Pipelex Hosted API:
 *   POST /v1/start                           → RunResultStart   (start, 202)
 *   GET  /v1/runs/{pipeline_run_id}/status   → RunRead          (status, self-healing)
 *   GET  /v1/runs/{pipeline_run_id}/progress → RunProgress      (the progress snapshot, self-healing)
 *   GET  /v1/runs/{pipeline_run_id}/results  → 202 / 200 / 409  (results; `?artifacts=` narrows it)
 */

// ── Status ──────────────────────────────────────────────────────────

/**
 * Hosted run lifecycle status. Mirrors `pipelex_shared.schemas.run.RunStatus`
 * — run states are a hosted-implementation concept; the protocol defines none
 * (the hosted store tracks states like `PENDING`). `STARTED` is deprecated
 * server-side but kept here for historical rows.
 */
export type RunStatus =
  | "PENDING"
  | "STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TERMINATED"
  | "TIMED_OUT";

/** Every `RunStatus`, in the platform's declaration order. */
export const RUN_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "STARTED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
];

/**
 * The statuses a run-history filter sends, deduplicated into `RUN_STATUSES` order so the same
 * filter always builds the same query, as the Python twin builds it. `undefined` is no filter,
 * which lists every status. An empty list names no status, and a name that is no `RunStatus`
 * names one the platform refuses with a `422`; each is a `RequestArgumentError`, its problem
 * `client.argument_invalid` naming `status`, before any request, rather than a query that lists every status or fails late. A
 * value that is not an array at all is a `TypeError`, a bug in the calling code.
 */
export function runStatusFilter(
  status: readonly RunStatus[] | undefined,
): readonly RunStatus[] | undefined {
  if (status === undefined) return undefined;
  if (!Array.isArray(status)) {
    throw new TypeError(
      `"status" must be an array naming one or more of ${RUN_STATUSES.join(", ")}.`,
    );
  }
  if (status.length === 0) {
    throw new RequestArgumentError(
      `"status" must name one or more of ${RUN_STATUSES.join(", ")}; omit it to list every status.`,
      { problem: argumentInvalidProblem("status", "empty") },
    );
  }
  const known: readonly string[] = RUN_STATUSES;
  const unknown = status.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new RequestArgumentError(
      `Unknown run status(es) ${unknown.join(", ")}; valid statuses are: ${RUN_STATUSES.join(", ")}.`,
      { problem: argumentInvalidProblem("status", "unknown_value") },
    );
  }
  return RUN_STATUSES.filter((name) => status.includes(name));
}

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
]);

/** A terminal status means the run is done and will not transition again. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Only `COMPLETED` has a result; every other terminal status is a failure. */
export function isSuccessRunStatus(status: RunStatus): boolean {
  return status === "COMPLETED";
}

// ── Responses ───────────────────────────────────────────────────────

/**
 * A run record — the BASE shape of the run-lifecycle read surface.
 *
 * The base fields are declared, and so is `error`, the problem a failed run ended with, which
 * is how a caller learns why a run failed. An implementation may return more (identity,
 * workflow ids, storage URLs, anything else) — those are server-specific response fields,
 * not named in this SDK; the index signature keeps them accessible, mirroring the
 * request-side `extra` passthrough.
 */
export interface RunPublic {
  pipeline_run_id: string;
  pipe_code?: string | null;
  status: RunStatus;
  created_at: string;
  finished_at?: string | null;
  /**
   * Why the run failed: the run's own problem document, as the platform serves it to its caller,
   * under its own code (`run.cancelled`, `run.timed_out`, a model's or a method's code) with its
   * own `domain`, `retry` and `next_step`. `null` on a completed run and on a run that ended
   * without a problem stored; absent on a server that does not serve it. The client keeps it only
   * when it is a problem document (`isProblem` in `mthds/protocol`), and reads anything else as
   * `null`. The results read of the same run nests the same problem as the `run_error` of its
   * `409`, which is where `getRunResult`'s failed arm and `RunFailedError.runError` take it from.
   */
  error?: Problem | null;
  /**
   * Which version of its stored method the run ran: the version number for a run addressed by
   * a bare `method_id` (the latest published version) or by `mt_…@<n>`, `"draft"` for one
   * addressed by `mt_…@draft`, and `null` for a run of an inline source. A hosted extension,
   * absent on a server that does not record it.
   */
  method_version?: number | "draft" | null;
  /**
   * The SHA-256 of the sources the run sent as text (`mthds_contents`, or a `files` map of text
   * entries), 64 lowercase hex characters, which is not a tree digest (`RunDetail.tree_digest`
   * names a run's tree); `null` when the platform never held the sources as text, as on a run of
   * a saved method or a `method_ref` run. A hosted extension, absent on a server that does not
   * record it.
   */
  source_digest?: string | null;
  /** Server-specific response fields (defined by the server you call). */
  [extension: string]: unknown;
}

/**
 * Why a status read is `degraded` — `RunDegradation.reason`:
 *
 * - `status_unavailable`: the platform could not reach the workflow engine, so `status` is the
 *   last one recorded. It says nothing about the run itself, which may be fine; read again after
 *   `retry_after_seconds`.
 * - `workflow_task_failing`: `status` is live, and the run is not making progress. The workflow
 *   task that drives it has failed `failed_attempts` times in a row since `failing_since`; the
 *   workflow engine keeps retrying it, and if it is still failing at `ends_at` the platform ends
 *   the run `FAILED` with a `WorkflowTaskKeptFailingError` report.
 *
 * Read open, as `RunDegradation.reason` types it: a reason a later platform adds arrives as its
 * raw string rather than failing the read, and a consumer that does not know it should not tell
 * the person the run is fine.
 */
export type DegradationReason = "status_unavailable" | "workflow_task_failing";

/**
 * What a `degraded` status read means for this run — `RunRead.degradation`. A progress snapshot
 * carries the same object, whole, as `RunProgress.degradation`, and places a
 * `workflow_task_failing` one on the invocation it concerns as `ProgressInvocation.degradation`.
 *
 * Branch on `reason` (see `DegradationReason`), never on the wording of `message`. Each field is
 * checked by the read: a known field whose value does not have its type is absent, and members
 * this SDK does not name are relayed as sent.
 */
export interface RunDegradation {
  /** Why the read is degraded: a `DegradationReason`, or the raw string of one this SDK does not know. */
  reason: DegradationReason | (string & {});
  /**
   * What the platform says about it, in a sentence. For `workflow_task_failing` it says how many
   * attempts have failed in a row, that the run is not making progress and when the platform will
   * end it. It does not quote the worker's own failure text, which only a platform run locally
   * with `ERROR_DISCLOSURE=verbose` adds. `failed_attempts` and `ends_at` carry the same facts as
   * fields.
   */
  message?: string | null;
  /** How many times in a row the run's workflow task has failed; `null` for `status_unavailable`. */
  failed_attempts?: number | null;
  /**
   * ISO-8601 instant of the first failure in the current run of failures. `null` when the
   * platform could not find the recorded failure in the workflow's history, and always for
   * `status_unavailable`.
   */
  failing_since?: string | null;
  /**
   * ISO-8601 instant at which the platform ends the run `FAILED` if its workflow task is still
   * failing. `null` when the platform could not find the recorded failure: it then does not end
   * the run itself, and the run's own time limit ends it `TIMED_OUT`. Always `null` for
   * `status_unavailable`.
   */
  ends_at?: string | null;
  /** Members a later platform adds. */
  [extension: string]: unknown;
}

/**
 * A run read through the self-healing status path (`RunPublic` + `degraded`, `degradation`,
 * `request_id` and the `Retry-After` hint).
 *
 * `degraded` is true when the read is not a plain fresh reading of a healthy run, and
 * `degradation.reason` says which of two things holds (see `DegradationReason`): the platform
 * could not reach the workflow engine and `status` is the last one recorded
 * (`status_unavailable`, paired with `retry_after_seconds`), or `status` is live and the run is
 * stuck, its workflow task failing until the platform ends it (`workflow_task_failing`). So
 * `degraded` alone no longer means the run is fine. A platform older than the degradation sends
 * `degraded` with no `degradation`; read that as `status_unavailable`, the only meaning `degraded`
 * had then.
 */
export interface RunRead extends RunPublic {
  degraded: boolean;
  /**
   * What `degraded` means for this run; `null` whenever `degraded` is false, and absent on a
   * platform that predates it. Checked field by field, and `null` when it is not an object or its
   * `reason` is not a string (see `RunDegradation`).
   */
  degradation?: RunDegradation | null;
  /**
   * The id of the request that started the run — the one to quote to support. `null` for a run
   * saved before the platform recorded it; absent on a server that does not serve it.
   */
  request_id?: string | null;
  /** The `Retry-After` header's delay, in seconds; set when the platform sent one. */
  retry_after_seconds?: number | null;
}

/**
 * A status read's `degradation`, checked field by field so that it never fails the poll carrying
 * it: a value that is not an object, or whose `reason` is not a string, reads as `null`, since a
 * degradation without a reason cannot be branched on; `message`, `failing_since` and `ends_at` are
 * kept when they are strings and `failed_attempts` when it is an integer, `null` kept for each;
 * members this SDK does not name are relayed as sent.
 *
 * Internal: `getRunStatus` applies it.
 */
export function readRunDegradation(value: unknown): RunDegradation | null {
  if (!isPlainObject(value) || typeof value.reason !== "string") return null;
  const degradation: Record<string, unknown> = { ...value };
  dropUnfit(
    degradation,
    ["message", "failing_since", "ends_at"],
    (field) => typeof field === "string",
  );
  dropUnfit(degradation, ["failed_attempts"], Number.isInteger);
  return degradation as RunDegradation;
}

// ── Progress ────────────────────────────────────────────────────────

/**
 * Where a run stands in its progress snapshot — `RunProgress.status`: accepted and not yet started
 * (`pending`), going (`running`), ended with its result (`succeeded`), ended in failure (`failed`),
 * or stopped before its end (`canceled`). The platform maps its `RunStatus` into these words:
 * `PENDING` is `pending`; `RUNNING` and `STARTED` are `running`; `COMPLETED` is `succeeded`;
 * `FAILED` and `TIMED_OUT` are `failed`; `CANCELLED` and `TERMINATED` are `canceled`.
 */
export type RunProgressStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

/**
 * Where one invocation stands — `ProgressInvocation.status`, the words a run graph uses for its
 * nodes: an item of a batch that has fanned out and not started (`scheduled`), started and not
 * ended (`running`), ended with its output (`succeeded`), ended in failure (`failed`), skipped,
 * which is a successful end with no output of its own (`skipped`), or not ended when the run
 * ended (`canceled`). Each is about the invocation's latest attempt.
 */
export type ProgressInvocationStatus =
  "scheduled" | "running" | "succeeded" | "failed" | "skipped" | "canceled";

/**
 * A batch's items — `ProgressInvocation.batch`, on a `PipeBatch` that has fanned out. `total` is
 * the number it fanned out over; `done` counts the items `succeeded` or `skipped`, `running` those
 * running and `failed` those failed. An item `scheduled` or `canceled` is in none of the three.
 */
export interface ProgressBatch {
  total: number;
  done: number;
  running: number;
  failed: number;
}

/**
 * A resolved condition's outcome — `ProgressInvocation.condition`: the key of the outcome map its
 * value matched, or `null` when it matched none and the condition took its default outcome.
 */
export interface ProgressCondition {
  selected_outcome: string | null;
}

/**
 * The latest failure of an invocation's work — `ProgressInvocation.last_failure`, a health
 * annotation. `message` keeps the disclosure of a run's error report: under the hosted plane's
 * strict disclosure it is the failure's own message only when that message was written for the
 * caller, and `An internal error occurred.` otherwise.
 */
export interface ProgressFailure {
  message: string;
  /** When it failed, an RFC 3339 timestamp in UTC; absent when not recorded. */
  at?: string;
}

/**
 * One attempt of one execution of a run — an entry of `RunProgress.chain`. An execution is a part
 * of a run its engine runs, and may run again, as a whole; `execution` is opaque.
 */
export interface ProgressAttempt {
  execution: string;
  attempt: number;
}

/**
 * One invocation in a progress snapshot: one run of one pipe inside the run, named by its `path`.
 *
 * Timestamps are RFC 3339 in UTC written with `Z`, with fractional seconds when recorded. An
 * optional field is absent when it does not apply, never `null`. The health annotations —
 * `attempts`, `last_failure` and `degradation` — are what the workflow engine reports; an absent
 * one means nothing was observed, never that all is well.
 */
export interface ProgressInvocation {
  /**
   * The invocation's path: the run's entry pipe's `pipe_ref`, then one segment per controller
   * level (`step_<n>`, `branch_<n>`, `item_<n>`, `outcome_<key>`, `default`), joined by `/`, such
   * as `filings.review_filings/step_3/item_2/step_1`. It names one invocation in every view of a
   * run, every attempt of it included, and nests a timeline's rows.
   */
  path: string;
  /** The bare code of the pipe it runs, which a timeline labels its row with. */
  pipe_code: string;
  /** The same pipe's `pipe_ref`, `<domain>.<pipe_code>`. */
  pipe_ref: string;
  /** The pipe's type as the method declares it, such as `PipeSequence` or `PipeLLM`; an open string. */
  pipe_type: string;
  status: ProgressInvocationStatus;
  /** The start of its latest attempt; `null` while `scheduled`, and when no start was recorded. */
  started_at: string | null;
  /** The end of its latest attempt; `null` while `scheduled` or `running`, and when `canceled`. */
  ended_at: string | null;
  /** On a `PipeSequence`, the number of steps its author wrote. */
  step_count?: number;
  /** On a `PipeParallel`, the number of its branches. */
  branch_count?: number;
  /** On a `skipped` invocation, why it was skipped. */
  skip_reason?: string;
  /** On a `PipeBatch` that has fanned out, its items' counts. */
  batch?: ProgressBatch;
  /** On a `PipeCondition` that has resolved, the outcome it took. */
  condition?: ProgressCondition;
  /** Health: how many times its work has been tried, present only when more than once. */
  attempts?: number;
  /** Health: the latest failure of its work. */
  last_failure?: ProgressFailure;
  /**
   * Health: the run is stuck at this invocation — the run status's own `degradation`, with the
   * same members and meanings, placed on the invocation it concerns (the run's root, or the batch
   * item whose execution keeps failing to advance). Its `reason` is `workflow_task_failing`.
   */
  degradation?: RunDegradation;
  /** Members a later platform adds. */
  [extension: string]: unknown;
}

/**
 * A run's progress snapshot — `GET /v1/runs/{pipeline_run_id}/progress`, which `getRunProgress`
 * reads and `waitForResult`'s `onProgress` receives.
 *
 * The state of a run's progress at one moment, projected by the platform at each read from the
 * run's live progress events, its status and what its workflow engine reports of its health.
 * Progress is a hosted-plane extension, part of neither the MTHDS Protocol nor the runner's API,
 * and its names are neutral. Timestamps are RFC 3339 in UTC written with `Z`; an optional field is
 * absent when it does not apply, never `null`. Two reads can answer out of order, so a reader
 * keeps the fresher of the snapshot it holds and the one it reads, by `isFresherRunProgress`.
 * See `docs/run-results.md`.
 */
export interface RunProgress {
  pipeline_run_id: string;
  /** The mode of the events it was projected from; always `live` on the hosted progress route. */
  mode: "live" | "dry";
  status: RunProgressStatus;
  /**
   * The number of distinct progress events the snapshot was projected from, superseded attempts'
   * included, so it never decreases while the run's events are kept. What a reader compares two
   * snapshots by — see `isFresherRunProgress`.
   */
  version: number;
  /** When the snapshot was projected: what a running invocation's elapsed time is measured against. */
  assembled_at: string;
  /**
   * One line of English saying how far the run has got, such as `Running summarize_filing_batch
   * (step 3 of 4): 1 of 3 items done, 2 running`. Show it as it is; never parse it.
   */
  summary: string;
  /** Absent on a snapshot of the whole run, which is every snapshot the hosted plane serves. */
  root_path?: string;
  /** Absent on a snapshot of the whole run, like `root_path`. */
  chain?: ProgressAttempt[];
  /**
   * The run status's `degradation`, whole, present when the run reads degraded: `status_unavailable`
   * when the platform could not read the workflow engine, so `status` is the last one recorded
   * and no invocation carries a health annotation, or `workflow_task_failing` when the run is not
   * making progress.
   */
  degradation?: RunDegradation;
  /** Every invocation the snapshot knows, each before its descendants, children in their order. */
  invocations: ProgressInvocation[];
  /** Members a later platform adds. */
  [extension: string]: unknown;
}

const GOING_PROGRESS_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);
const ENDED_PROGRESS_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "canceled"]);

/**
 * Whether the snapshot just `read` is fresher than the one `held`, and should replace it — the
 * contract's rule, its first clause before the other two:
 *
 * 1. a snapshot of a run still going (`pending` or `running`) never replaces one of the run ended
 *    (`succeeded`, `failed` or `canceled`), whatever their versions and their `assembled_at`, and
 *    one of the run ended always replaces one of the run going, since an ended run does not resume
 *    and a read lagging behind the writes can project it from fewer events;
 * 2. otherwise, of two different versions, the higher is fresher;
 * 3. at the same version, the later `assembled_at` is, compared as instants rather than as text.
 *
 * Nothing held means anything read is fresher. Two snapshots equally fresh, or whose times cannot
 * be compared, keep the one held. Pure: a reader holding snapshots from more than one source, the
 * progress route and a `run_progress_update` frame's re-read, keeps the fresher by it.
 */
export function isFresherRunProgress(read: RunProgress, held: RunProgress | undefined): boolean {
  if (held === undefined) return true;
  if (GOING_PROGRESS_STATUSES.has(read.status) && ENDED_PROGRESS_STATUSES.has(held.status)) {
    return false;
  }
  if (ENDED_PROGRESS_STATUSES.has(read.status) && GOING_PROGRESS_STATUSES.has(held.status)) {
    return true;
  }
  if (read.version !== held.version) return read.version > held.version;
  return instantMicros(read.assembled_at) > instantMicros(held.assembled_at);
}

/**
 * An RFC 3339 timestamp as microseconds since the epoch, so that two of them compare as instants:
 * as text, `06.870Z` sorts after `06.870123Z`, and `Date.parse` alone drops the microseconds the
 * platform writes when it has them. `NaN` for a value that is not such a timestamp.
 */
function instantMicros(timestamp: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(
    timestamp,
  );
  if (match === null) return Number.NaN;
  const [, seconds = "", fraction = "", zone = ""] = match;
  const milliseconds = Date.parse(`${seconds.toUpperCase()}${zone.toUpperCase()}`);
  return milliseconds * 1000 + Number(fraction.padEnd(6, "0").slice(0, 6));
}

const isString = (value: unknown): boolean => typeof value === "string";
const isStringOrNull = (value: unknown): boolean => value === null || typeof value === "string";

/** The members of a snapshot a reader leans on, each with what it must be. */
const RUN_PROGRESS_FIELDS: ReadonlyArray<
  readonly [field: keyof RunProgress & string, expected: string, fits: (value: unknown) => boolean]
> = [
  ["pipeline_run_id", "a string", isString],
  ["mode", "a string", isString],
  ["status", "a string", isString],
  [
    "version",
    "a non-negative integer",
    (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  ],
  ["assembled_at", "a string", isString],
  ["summary", "a string", isString],
  ["invocations", "a list", Array.isArray],
];

/** The members of an invocation a timeline leans on, each with what it must be. */
const PROGRESS_INVOCATION_FIELDS: ReadonlyArray<
  readonly [
    field: keyof ProgressInvocation & string,
    expected: string,
    fits: (value: unknown) => boolean,
  ]
> = [
  ["path", "a string", isString],
  ["pipe_code", "a string", isString],
  ["pipe_ref", "a string", isString],
  ["pipe_type", "a string", isString],
  ["status", "a string", isString],
  ["started_at", "a string or null", isStringOrNull],
  ["ended_at", "a string or null", isStringOrNull],
];

/**
 * What makes a progress answer unreadable, worded to follow `a snapshot whose`, or `undefined`
 * when it can be read: a member the freshness rule or a timeline leans on that is missing or of
 * another type — `version` a non-negative integer, the other required members strings, and each
 * invocation an object whose path, pipe identity and status are strings and whose times are
 * strings or `null`. The other members are relayed as sent.
 *
 * Internal: `getRunProgress` throws the `ApiResponseError` of an unreadable answer with it.
 */
export function runProgressFault(snapshot: Record<string, unknown>): string | undefined {
  for (const [field, expected, fits] of RUN_PROGRESS_FIELDS) {
    if (!fits(snapshot[field])) return `\`${field}\` is not ${expected}`;
  }
  const invocations = snapshot.invocations as unknown[];
  for (const [index, invocation] of invocations.entries()) {
    if (!isPlainObject(invocation)) return `\`invocations[${index}]\` is not an object`;
    for (const [field, expected, fits] of PROGRESS_INVOCATION_FIELDS) {
      if (!fits(invocation[field])) {
        return `\`invocations[${index}].${field}\` is not ${expected}`;
      }
    }
  }
  return undefined;
}

/**
 * A readable snapshot with its degradations checked by `readRunDegradation`, the snapshot's own
 * and each invocation's, so that neither ever fails the read: one that cannot be read, its
 * `reason` not a string, is dropped, since an optional member is absent rather than `null`.
 *
 * Internal: `getRunProgress` applies it to an answer `runProgressFault` passed.
 */
export function withCheckedProgressDegradations(snapshot: RunProgress): RunProgress {
  return {
    ...withCheckedDegradationMember(snapshot),
    invocations: snapshot.invocations.map(withCheckedDegradationMember),
  };
}

function withCheckedDegradationMember<T extends { degradation?: RunDegradation }>(record: T): T {
  if (!Object.hasOwn(record, "degradation")) return record;
  const { degradation, ...rest } = record;
  const checked = readRunDegradation(degradation);
  return (checked === null ? rest : { ...rest, degradation: checked }) as T;
}

/**
 * One inference call's token usage — the client-facing wire record.
 *
 * Mirrors the runtime's `TokensUsageRecord`. Inference accounting is a Pipelex runtime
 * extension — the MTHDS Protocol does not model it — so the hosted API is what pins this
 * wire contract. The same shape rides both surfaces: the durable `tokens_usages.json`
 * artifact that the hosted results route relays, and the blocking execute response's
 * `pipe_output.tokens_usages`.
 *
 * Every field is optional and the index signature is open **on purpose**. A record the
 * current runtime emits always carries the full key set (a field with no value is an
 * explicit `null`, never an omitted key), so callers may read any field directly. But
 * durable artifacts written before the contract shipped are relayed verbatim and never
 * migrated: such a record arrives with no `cost` and no `pipe_code`, and keeps its legacy
 * `job_metadata` / `unit_costs` — reachable through the index signature, never contract
 * fields.
 *
 * The enum-ish fields are open sets on the wire and stay `string` here — never frozen
 * unions — so runtime enum churn is non-breaking for consumers.
 */
export interface TokensUsageRecord {
  /** Kind of inference. Known values: `llm`, `img_gen`, `extract`, `search`. */
  model_type?: string | null;
  /** Human model name (e.g. `gpt-4o`). */
  inference_model_name?: string | null;
  /** Provider/platform model id (e.g. `gpt-4o-2024-11-20`). */
  inference_model_id?: string | null;
  /** The pipe that made the call — what makes per-pipe cost attribution possible. */
  pipe_code?: string | null;
  /** Known values: `llm_job`, `img_gen_job`, `extract_job`, `search_job`, `jinja2_job`, `mock_job`. */
  job_category?: string | null;
  /**
   * Known values: `llm_gen_text`, `llm_gen_object`, `img_gen_text_to_image`,
   * `extract_pages`, `search_sourced_answer`, `search_structured`.
   */
  unit_job_id?: string | null;
  /**
   * Raw provider-reported token counts, keyed by token category (`input`, `input_cached`,
   * `output`, `output_reasoning`, …). `input` is the joined total and `input_cached` a
   * subset of it — the categories are NOT additive, so summing them double-counts.
   */
  nb_tokens_by_category?: Record<string, number> | null;
  /**
   * Computed USD cost of this call. Null when the model has no rate table at all (own-GPU,
   * mock, dry run); `0` means a rate table existed and priced the call at zero. The
   * underlying rate table never crosses the wire and there is no run-level aggregate — sum
   * the records.
   */
  cost?: number | null;
  /** ISO 8601 start of the call. */
  started_at?: string | null;
  /** ISO 8601 end of the call. Duration is derivable from the pair and deliberately not shipped. */
  completed_at?: string | null;
  /** Legacy fields on a pre-contract artifact relayed verbatim (`job_metadata`, `unit_costs`). */
  [extension: string]: unknown;
}

// ── Results artifact selection ───────────────────────────────────

/**
 * The result artifacts a results read can be narrowed to, in the platform's order. Passing some
 * of them as `artifacts` to `getRunResult` (or `waitForResult` / `startAndWaitForResult`) sends
 * `?artifacts=` and the platform reads, re-signs and returns only those. `tokens_usages` brings
 * `usage_assembly_error` with it.
 */
export const RUN_RESULT_ARTIFACTS = [
  "graph_spec",
  "pipe_io_contracts",
  "input_form",
  "output_form",
  "main_stuff",
  "working_memory",
  "tokens_usages",
] as const;

/** One result artifact a results read can be narrowed to — see `RUN_RESULT_ARTIFACTS`. */
export type RunResultArtifact = (typeof RUN_RESULT_ARTIFACTS)[number];

/**
 * Refuse an artifact selection the platform would answer with a 400: an empty one, or one naming
 * an artifact it does not know, each a `RequestArgumentError`, its problem
 * `client.argument_invalid` naming `artifacts`, as the Python twin refuses it. `undefined` is no selection, which reads every artifact; a value that is
 * not an array at all is a `TypeError`, a bug in the calling code that carries no problem.
 */
export function assertArtifactSelection(artifacts: readonly string[] | undefined): void {
  if (artifacts === undefined) return;
  if (!Array.isArray(artifacts)) {
    throw new TypeError(
      `"artifacts" must be an array naming one or more of ${RUN_RESULT_ARTIFACTS.join(", ")}.`,
    );
  }
  if (artifacts.length === 0) {
    throw new RequestArgumentError(
      `"artifacts" must name one or more of ${RUN_RESULT_ARTIFACTS.join(", ")}; omit it to read ` +
        "every artifact.",
      { problem: argumentInvalidProblem("artifacts", "empty") },
    );
  }
  const known: readonly string[] = RUN_RESULT_ARTIFACTS;
  const unknown = artifacts.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new RequestArgumentError(
      `Unknown result artifact(s) ${unknown.join(", ")}; valid artifacts are: ` +
        `${RUN_RESULT_ARTIFACTS.join(", ")}.`,
      { problem: argumentInvalidProblem("artifacts", "unknown_value") },
    );
  }
}

/** Whether a results read with this selection carries `main_stuff` — no selection reads all. */
export function selectionIncludesMainStuff(
  artifacts: readonly RunResultArtifact[] | undefined,
): boolean {
  return artifacts === undefined || artifacts.includes("main_stuff");
}

/** `getRunResult` options. */
export interface GetRunResultOptions {
  /** Abort the read. */
  signal?: AbortSignal;
  /**
   * Read only these artifacts, sent as one comma-separated `?artifacts=` parameter. Omitted, the
   * read returns every artifact. With a selection, an unselected artifact is ABSENT from the
   * result (`undefined`), while a selected one the run never wrote is `null`. An empty selection
   * or an unknown name is a `RequestArgumentError` before any request.
   */
  artifacts?: readonly RunResultArtifact[];
}

/**
 * Result artifacts for a completed run — `GET /v1/runs/{pipeline_run_id}/results`.
 *
 * **Absent versus null.** A read narrowed with `artifacts` carries only the artifacts it named: an
 * unselected artifact is absent (`undefined`), a selected one the run did not write is `null`.
 * Without a selection every artifact field is present on the hosted path. So `undefined` means
 * "not asked for" and `null` means "asked for, not there".
 *
 * `main_stuff` is the resolved main output content and is ALWAYS present for a
 * completed run (the pipelex >= 0.37 main-stuff invariant): on the hosted path it
 * is the `main_stuff.json` S3 artifact relayed verbatim; on the bare-runner blocking
 * path the SDK resolves it from the returned working memory via the run's
 * `main_stuff_name`, so both paths deliver the same content shape. Consumers read
 * `main_stuff` directly — no shape-guessing. A completed run that cannot deliver a
 * main stuff throws `MissingMainStuffError` — when the read asked for it, which a read with no
 * selection does.
 */
export interface RunResults {
  pipeline_run_id: string;
  /**
   * The resolved main output content — always present for a completed run. Typed `unknown`
   * because the content is polymorphic: a structured output is an object of the concept's fields,
   * a multiple output the envelope `{ items: [...] }` the runtime's `ListContent` serialises to,
   * and a native is wrapped too (`{ text }`, `{ number }`). It may be a valid empty value — an
   * empty `items`, an empty `text` — but it is never null. It is absent only from a read whose
   * `artifacts` selection left it out. An integer past `Number.MAX_SAFE_INTEGER` in it, as anywhere
   * in the results, is a `bigint` holding its exact digits (`docs/exact-integers.md`). See
   * `docs/run-results.md`.
   */
  main_stuff?: unknown;
  /**
   * The run's working memory — every named stuff of the run (`{ root, aliases }`), the inputs it
   * was given and the intermediates it produced as well as the main output, each stuff carried as
   * its concept ref and its content. It reads the same on both paths: the hosted path relays the
   * `working_memory.json` artifact verbatim, and on the blocking path the SDK lifts it off
   * `pipe_output`. `main_stuff` is the content of one of its entries, already resolved. Null on the
   * hosted path when the artifact was not yet written. `DictWorkingMemory` mirrors the MTHDS
   * standard's `DictWorkingMemory` field for field. A run delivered by a runtime older than
   * pipelex 0.60.0 carries each `concept` as the concept object instead, and a stored artifact is
   * relayed as written, never migrated: the type stays the standard's `string`, so read `concept`
   * as `unknown` when a run may predate that release. See `docs/run-results.md`.
   */
  working_memory?: DictWorkingMemory | null;
  /**
   * The executed graph — the same document a local run writes as `graphspec.json`: `meta.mode`
   * `"live"`, one node per pipe with its status, its timings and its own usage. It reaches the client on both
   * paths: the hosted path relays the `graphspec.json` artifact verbatim, and on the blocking path
   * the SDK lifts it off `pipe_output`. Null when the runner assembled no graph (see
   * `graph_assembly_error`) or, on the hosted path, when the artifact was not yet written. Typed
   * `unknown` on purpose — the canonical declaration is `GraphSpec` in `@pipelex/mthds-ui`, which
   * carries a React peer dependency this server-side SDK does not take. See `docs/run-results.md`.
   */
  graph_spec?: unknown;
  /**
   * Non-null when the runner's graph assembly failed for the run — the graph's twin of
   * `usage_assembly_error`, and the only thing that separates "the graph broke" from "this run
   * produced no graph". Lifted off `pipe_output` on the blocking path; the hosted results body
   * carries nothing of the kind yet, so on that path the field is absent until the platform writes
   * and relays it.
   */
  graph_assembly_error?: string | null;
  /**
   * Per-pipe input/output contracts for the library the run executed against, keyed by
   * namespaced `pipe_ref` (`domain.code`) — the standard's `PipeIOContracts`, the same artifact
   * `POST /v1/validate` reports and the same one a local run writes beside its graph as
   * `pipe_io_contracts.json`. Imported from `mthds/protocol` rather than restated, under the
   * standing ruling that keeps the standard's artifacts declared once per language
   * (`docs/architecture.md`). It is what says what a `graph_spec` node's data IS: the graph
   * carries the values, this carries their concepts and their schemas.
   *
   * Read it together with `output_form` — `@pipelex/mthds-ui`'s `GraphViewer` takes the pair or
   * neither, and shows a node's structure table instead of its payload when one is missing.
   *
   * Null on the hosted path for a run whose artifacts were not written, and `undefined` until the
   * platform relays the key. See `docs/run-results.md`.
   */
  pipe_io_contracts?: PipeIOContracts | null;
  /**
   * Per-pipe input-form descriptors for that same library — the standard's `InputForm`, keyed
   * over the same `pipe_ref` set as `pipe_io_contracts`, describing each declared input as a
   * typed field rather than a schema. It is what lets a rendered run show its own inputs as
   * values; the renderer treats it as optional even when it has the other two.
   *
   * Null or absent on the same terms as `pipe_io_contracts`.
   */
  input_form?: InputForm | null;
  /**
   * Per-pipe OUTPUT-form descriptors for that same library — the standard's `OutputForm`, the
   * twin of `input_form` on the other side of the pipe, keyed over the same `pipe_ref` set. The
   * descriptor says what the result IS and the contract's `output.json_schema` names the property
   * its payload arrives under, which together are everything a renderer needs to lay a run's
   * result out without inspecting the value.
   *
   * Null or absent on the same terms as `pipe_io_contracts`.
   */
  output_form?: OutputForm | null;
  /**
   * Non-null when the runner's build of the three I/O artifacts failed for the run — their twin
   * of `graph_assembly_error`, and the only thing that separates "describing the data broke" from
   * "this run described none". Lifted off `pipe_output` on the blocking path; the hosted results
   * body carries nothing of the kind yet, so on that path the field is absent until the platform
   * writes and relays it.
   */
  pipe_io_artifacts_error?: string | null;
  /**
   * Bare runner's native pipe output, blocking-execute path only; absent on the hosted path, whose
   * results body carries no such key, so it reads `undefined` there. Supplementary: `main_stuff`,
   * `working_memory`, the graph pair and the usage pair are all lifted out of it onto their own
   * fields, which read the same on both paths. Read `working_memory` for the run's named stuffs;
   * `pipe_output` is the runner's output as it arrived, extension fields included.
   */
  pipe_output?: DictPipeOutput | null;
  /**
   * Per-call usage records — token counts by category, computed `cost` in USD, model id —
   * for LLM and img-gen/extract/search calls alike. On the hosted path this is the
   * `tokens_usages.json` artifact's record list relayed verbatim; on the blocking path it is
   * the execute response's `pipe_output.tokens_usages`. Null whenever assembly produced no
   * list — it was off, it broke (see `usage_assembly_error`), or (hosted) the run was
   * delivered before the artifact existed; `[]` when assembly ran and no inference happened.
   */
  tokens_usages?: TokensUsageRecord[] | null;
  /**
   * Non-null when the runner's usage assembly failed for the run. The ONLY field that
   * separates "usage broke" from "usage was off" / "pre-artifact run" — all three leave
   * `tokens_usages` null, so a caller that cares must branch on this, not on the list.
   */
  usage_assembly_error?: string | null;
}

/**
 * Single-shot result lookup outcome, discriminated on `state`:
 * - `running`  — HTTP 202; poll again after `retry_after_seconds`.
 * - `completed` — HTTP 200; `result` carries the artifacts.
 * - `failed`   — HTTP 409 answering `run.failed`: the run reached a terminal non-`COMPLETED`
 *   status. `problem` is that `run.failed` problem as the platform answered it, `status` the
 *   terminal status its `run_status` parameter names (`FAILED` when it names none the SDK knows),
 *   `message` its `detail`, and `error` the run's own problem, which `run.failed` nests as
 *   `run_error`, or `null` when the run ended without one.
 */
export type RunResultState =
  | { state: "running"; pipeline_run_id: string; retry_after_seconds: number | null }
  | { state: "completed"; pipeline_run_id: string; result: RunResults }
  | {
      state: "failed";
      pipeline_run_id: string;
      status: RunStatus;
      message: string;
      problem: Problem;
      error: Problem | null;
    };

// ── Polling options ─────────────────────────────────────────────────

export interface WaitForResultOptions {
  /**
   * Base poll interval in ms (default 2000). The server's `Retry-After`
   * header overrides this when it asks for a longer wait.
   */
  intervalMs?: number;
  /**
   * Max ms to wait before throwing `RunTimeoutError` (default 1_200_000 — 20 min).
   * `Infinity` waits for as long as the run takes; `NaN` is a `RangeError`.
   */
  timeoutMs?: number;
  /** Abort the poll loop (Ctrl-C / agent walk-away). */
  signal?: AbortSignal;
  /** Invoked before each sleep so callers can drive a spinner / progress line. */
  onPoll?: (info: { attempt: number; elapsedMs: number }) => void;
  /**
   * Called with the run's progress snapshot (`RunProgress`) each time the wait reads one fresher
   * than the last it delivered, by `isFresherRunProgress`, so a caller can show the run advancing.
   * Given, the wait reads `GET /v1/runs/{id}/progress` on each poll that finds the run still
   * running, after the results read and before `onPoll`; omitted, it never reads the progress.
   * A progress read that fails skips that poll's snapshot and never fails the wait, whose truth is
   * the results read; a server answering that it has no progress route is not asked again during
   * the wait. It is not called once the results read finds the run ended, nor on
   * `startAndWaitForResult`'s blocking path, which has no run to read. The callback runs
   * synchronously and its return value is ignored; an exception it throws propagates out of the
   * wait, and the run keeps going on the server.
   */
  onProgress?: (progress: RunProgress) => void;
  /**
   * Read only these result artifacts on each poll — `getRunResult`'s `artifacts`. The 202 a
   * running run answers carries nothing, so the selection only shapes the completed result.
   * `startAndWaitForResult`'s blocking fallback on a bare runner ignores it and returns every
   * artifact the runner sent.
   */
  artifacts?: readonly RunResultArtifact[];
}

/**
 * `startAndWaitForResult`'s second argument: the wait's own options, plus the moment the run
 * comes to exist.
 */
export interface StartAndWaitForResultOptions extends WaitForResultOptions {
  /**
   * Called once with the start acknowledgement, as soon as the durable run exists and before the
   * first poll, so that the caller holds the run's id while it waits: to show it, to log it, or to
   * resume the run by it after an interrupt. It is never called on the blocking path, a bare
   * runner's `POST /v1/execute`, which has no run id to give before it answers. The callback runs
   * synchronously and its return value is ignored; an exception it throws propagates out of
   * `startAndWaitForResult` before anything is polled, and the run it was told about keeps going
   * on the server.
   */
  onStarted?: (ack: PipelexRunResultStart) => void;
  /**
   * Called right before each request that may create a run is sent: the `POST /v1/start`, and the
   * blocking `POST /v1/execute` of a bare runner or of the fallback to it. Until it is called, no
   * run exists and none will, so a caller that stops waiting before then can say no run was
   * started; from then on, a run may exist before the API says so. Once `signal` has aborted it is
   * never called, since no such request is sent. It runs synchronously and its return value is
   * ignored; an exception it throws propagates before the request is sent.
   */
  onStarting?: () => void;
}

// ── Poll loop ───────────────────────────────────────────────────────

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.

/** A single result lookup — the primitive the poll loop drives. */
export type FetchResultOnce = (
  runId: string,
  options?: GetRunResultOptions,
) => Promise<RunResultState>;

/** A single progress read — what the poll loop calls on each poll for `onProgress`. */
export type FetchProgressOnce = (
  runId: string,
  options?: { signal?: AbortSignal },
) => Promise<RunProgress>;

/**
 * Refuse wait options no poll loop can honour. A NaN would reach the sleep's timer as a
 * 1 ms delay and poll in a tight loop. `startAndWaitForResult` calls this before it starts
 * the run, so a bad option never leaves a started run the caller holds no id for.
 */
export function assertWaitOptions(options: WaitForResultOptions = {}): void {
  const { intervalMs, timeoutMs } = options;
  if (Number.isNaN(intervalMs) || Number.isNaN(timeoutMs)) {
    throw new RangeError(
      `"intervalMs" and "timeoutMs" must be numbers, got ${String(intervalMs)} and ` +
        `${String(timeoutMs)}.`,
    );
  }
  assertArtifactSelection(options.artifacts);
}

/**
 * Poll a single-shot result lookup (`fetchOnce`) until the run reaches a
 * terminal state. Returns the artifacts on `COMPLETED`, throws `RunFailedError`
 * on any other terminal status — carrying the run's status and the `run.failed`
 * problem, which nests the run's own — and throws `RunTimeoutError` if `timeoutMs` elapses first (the run
 * keeps executing server-side — re-poll by id later).
 *
 * With `options.onProgress` and a `fetchProgress`, each poll that finds the run still running also
 * reads its progress and hands `onProgress` the snapshot when it is fresher than the last one
 * delivered (`isFresherRunProgress`). A progress read that fails only skips that poll's snapshot;
 * a route-absent `404` (`RunLifecycleUnavailableError`) stops the progress reads for the rest of
 * the wait; the caller's abort still ends the wait.
 *
 * The single owner of the wait/poll/Retry-After/abort logic — `PipelexApiClient.waitForResult`
 * delegates here, so the behavior can never drift.
 */
export async function pollUntilResult(
  fetchOnce: FetchResultOnce,
  runId: string,
  options: WaitForResultOptions = {},
  fetchProgress?: FetchProgressOnce,
): Promise<RunResults> {
  assertWaitOptions(options);
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;
  const { onProgress } = options;
  // No progress request at all unless the caller asked for progress.
  let readsProgress = onProgress !== undefined && fetchProgress !== undefined;
  let delivered: RunProgress | undefined;

  for (;;) {
    throwIfAborted(options.signal);

    // Enforce the deadline BEFORE each lookup, so a poll is never issued past the
    // timeout (the previous wait is clamped to the deadline, so the next loop
    // would otherwise fire one extra fetch right at it).
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new RunTimeoutError(
        `Run ${runId} did not reach a terminal state within ${timeoutMs}ms.`,
        runId,
        timeoutMs,
      );
    }

    const state = await fetchOnce(
      runId,
      options.artifacts === undefined
        ? { signal: options.signal }
        : { signal: options.signal, artifacts: options.artifacts },
    );

    if (state.state === "completed") {
      return state.result;
    }
    if (state.state === "failed") {
      throw new RunFailedError(state.message, runId, state.status, { problem: state.problem });
    }

    if (readsProgress && onProgress !== undefined && fetchProgress !== undefined) {
      let progress: RunProgress | undefined;
      try {
        progress = await fetchProgress(runId, { signal: options.signal });
      } catch (error) {
        // The caller's abort ends the wait. Any other failure skips this poll's snapshot, since
        // the results read, not the progress, is the truth about the run.
        throwIfAborted(options.signal);
        // A server without the route answers every read with the same 404: stop asking.
        if (error instanceof RunLifecycleUnavailableError) readsProgress = false;
      }
      if (progress !== undefined && isFresherRunProgress(progress, delivered)) {
        delivered = progress;
        onProgress(progress);
      }
    }

    attempt += 1;
    options.onPoll?.({ attempt, elapsedMs });

    const retryMs = state.retry_after_seconds != null ? state.retry_after_seconds * 1000 : 0;
    const waitMs = Math.min(Math.max(intervalMs, retryMs), timeoutMs - elapsedMs);
    await sleep(waitMs, options.signal);
  }
}

/** Throw the caller's abort, as the wait does, when `signal` has aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The run poll was aborted.", "AbortError");
}

/** Sleep that resolves after `ms`, or rejects immediately if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    // Clamped, since a longer delay overflows the timer and would fire at once: a sleep
    // past the cap ends at the cap, and the loop simply polls again.
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(ms, MAX_TIMER_DELAY_MS),
    );
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
