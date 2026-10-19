import {
  INVOCATION_STATUS,
  PROGRESS_MODE,
  RUN_PROGRESS_STATUS,
  type BatchProgress,
  type ConditionProgress,
  type ExecutionAttempt,
  type InvocationFailure,
  type InvocationStatus,
  type ProgressDegradation,
  type ProgressInvocation,
  type ProgressMode,
  type ProgressSnapshot,
  type RunProgressStatus,
} from "@pipelex/mthds-ui/timeline";
import type { ProgressRead, ProgressReader } from "@/lib/progressReader";

/*
 * The browser's progress reader: this app's own `GET /api/runs/{runId}/progress`
 * route (see the route for why it is a Route Handler), its answer turned into
 * a `ProgressRead`.
 *
 * The answer is read member by member, the way the SDK reads the platform's,
 * rather than cast: the snapshot is rebuilt from what checked out, so the
 * compiler holds it to `ProgressSnapshot` and a member the route did not send
 * never reaches the timeline. It is plain code rather than a zod schema because
 * zod is kept out of the browser bundle (`wireOutput.ts` is server-only for
 * that reason). Anything that does not check out is a failed read.
 */

const FAILED: ProgressRead = { kind: "failed" };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

const RUN_STATUSES: ReadonlySet<unknown> = new Set(Object.values(RUN_PROGRESS_STATUS));
const INVOCATION_STATUSES: ReadonlySet<unknown> = new Set(Object.values(INVOCATION_STATUS));
const MODES: ReadonlySet<unknown> = new Set(Object.values(PROGRESS_MODE));

function isRunStatus(value: unknown): value is RunProgressStatus {
  return RUN_STATUSES.has(value);
}

function isInvocationStatus(value: unknown): value is InvocationStatus {
  return INVOCATION_STATUSES.has(value);
}

function isMode(value: unknown): value is ProgressMode {
  return MODES.has(value);
}

/**
 * An optional member: `undefined` when absent, the read value when it checks
 * out, and `null` when it is there and does not, which fails the whole read.
 */
function optional<T>(value: unknown, read: (value: unknown) => T | null): T | undefined | null {
  return value === undefined ? undefined : read(value);
}

function readCount(value: unknown): number | null {
  return isCount(value) ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readDegradation(value: unknown): ProgressDegradation | null {
  if (!isRecord(value)) return null;
  const { reason, message, failed_attempts, failing_since, ends_at } = value;
  if (typeof reason !== "string" || typeof message !== "string") return null;
  if (!(failed_attempts === null || isCount(failed_attempts))) return null;
  if (!isTextOrNull(failing_since) || !isTextOrNull(ends_at)) return null;
  return { reason, message, failed_attempts, failing_since, ends_at };
}

function readBatch(value: unknown): BatchProgress | null {
  if (!isRecord(value)) return null;
  const { total, done, running, failed } = value;
  if (!isCount(total) || !isCount(done) || !isCount(running) || !isCount(failed)) return null;
  return { total, done, running, failed };
}

function readCondition(value: unknown): ConditionProgress | null {
  if (!isRecord(value) || !isTextOrNull(value.selected_outcome)) return null;
  return { selected_outcome: value.selected_outcome };
}

function readFailure(value: unknown): InvocationFailure | null {
  if (!isRecord(value) || typeof value.message !== "string") return null;
  const at = optional(value.at, readText);
  if (at === null) return null;
  return { message: value.message, ...(at !== undefined && { at }) };
}

function readAttempt(value: unknown): ExecutionAttempt | null {
  if (!isRecord(value) || typeof value.execution !== "string" || !isCount(value.attempt)) {
    return null;
  }
  return { execution: value.execution, attempt: value.attempt };
}

/** Every entry read, or `null` when one does not check out. */
function readList<T>(value: unknown, read: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function readInvocation(value: unknown): ProgressInvocation | null {
  if (!isRecord(value)) return null;
  const { path, pipe_code, pipe_ref, pipe_type, status, started_at, ended_at } = value;
  if (typeof path !== "string" || typeof pipe_code !== "string") return null;
  if (typeof pipe_ref !== "string" || typeof pipe_type !== "string") return null;
  if (!isInvocationStatus(status) || !isTextOrNull(started_at) || !isTextOrNull(ended_at)) {
    return null;
  }
  const step_count = optional(value.step_count, readCount);
  const branch_count = optional(value.branch_count, readCount);
  const skip_reason = optional(value.skip_reason, readText);
  const batch = optional(value.batch, readBatch);
  const condition = optional(value.condition, readCondition);
  const attempts = optional(value.attempts, readCount);
  const last_failure = optional(value.last_failure, readFailure);
  const degradation = optional(value.degradation, readDegradation);
  if (
    step_count === null ||
    branch_count === null ||
    skip_reason === null ||
    batch === null ||
    condition === null ||
    attempts === null ||
    last_failure === null ||
    degradation === null
  ) {
    return null;
  }
  return {
    path,
    pipe_code,
    pipe_ref,
    pipe_type,
    status,
    started_at,
    ended_at,
    ...(step_count !== undefined && { step_count }),
    ...(branch_count !== undefined && { branch_count }),
    ...(skip_reason !== undefined && { skip_reason }),
    ...(batch !== undefined && { batch }),
    ...(condition !== undefined && { condition }),
    ...(attempts !== undefined && { attempts }),
    ...(last_failure !== undefined && { last_failure }),
    ...(degradation !== undefined && { degradation }),
  };
}

/** The snapshot the route sent, or `null` when it does not check out. */
export function readProgressSnapshot(value: unknown): ProgressSnapshot | null {
  if (!isRecord(value)) return null;
  const { pipeline_run_id, mode, status, version, assembled_at, summary } = value;
  if (typeof pipeline_run_id !== "string" || !isMode(mode) || !isRunStatus(status)) return null;
  if (!isCount(version) || typeof assembled_at !== "string" || typeof summary !== "string") {
    return null;
  }
  const root_path = optional(value.root_path, readText);
  const chain = optional(value.chain, (entries) => readList(entries, readAttempt));
  const degradation = optional(value.degradation, readDegradation);
  const invocations = readList(value.invocations, readInvocation);
  if (root_path === null || chain === null || degradation === null || invocations === null) {
    return null;
  }
  return {
    pipeline_run_id,
    mode,
    status,
    version,
    assembled_at,
    summary,
    ...(root_path !== undefined && { root_path }),
    ...(chain !== undefined && { chain }),
    ...(degradation !== undefined && { degradation }),
    invocations,
  };
}

/** The route's answer as a read, or `failed` when it is not one the route sends. */
function readAnswer(body: unknown): ProgressRead {
  if (!isRecord(body)) return FAILED;
  switch (body.state) {
    case "snapshot": {
      const snapshot = readProgressSnapshot(body.snapshot);
      return snapshot === null ? FAILED : { kind: "snapshot", snapshot };
    }
    case "none":
      return { kind: "none" };
    case "unavailable":
      return { kind: "unavailable" };
    default:
      return FAILED;
  }
}

/**
 * One run's progress, from this app's progress route. It never throws: a
 * network failure, an abort, an error status and an answer it cannot read are
 * each `failed`, which leaves the snapshot already held in place.
 */
export const fetchRunProgress: ProgressReader = async (runId, signal) => {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/progress`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) return FAILED;
    return readAnswer(await response.json());
  } catch {
    return FAILED;
  }
};
