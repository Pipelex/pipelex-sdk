import "server-only";

import type {
  BatchProgress,
  ConditionProgress,
  ExecutionAttempt,
  ProgressDegradation,
  ProgressInvocation,
  ProgressSnapshot,
} from "@pipelex/mthds-ui/timeline";
import type {
  ProgressAttempt,
  ProgressBatch,
  ProgressCondition,
  ProgressInvocation as SdkProgressInvocation,
  RunDegradation,
  RunProgress,
} from "@pipelex/sdk";

/*
 * A run's progress snapshot as it leaves this app's server, for the run
 * timeline: the SDK reads it (`getRunProgress`), the progress route maps it
 * here, and `@pipelex/mthds-ui`'s `RunTimeline` draws it in the browser.
 *
 * What a host shows of a run is the host's choice, so the mapping is this
 * app's policy, applied on the server. It follows the rule a run's failure
 * report already follows here (`docs/errors.md`): the provider's raw text never
 * reaches the person.
 */

/**
 * What the timeline says in place of an invocation's own failure, the problem
 * the SDK reads as `last_failure.problem`. A snapshot carries no flag saying
 * whether that problem's text was written for the caller, and a platform run
 * with verbose disclosure would pass a provider's raw text, so none of it
 * leaves the server. The run's own failure is still shown in full, from its
 * problem, by `<ErrorDisplay>`.
 */
export const FAILURE_TEXT_SHOWN = "An attempt at this step failed.";

/**
 * A degradation's sentence, by its reason. The platform's own `message` is
 * never passed on: under verbose disclosure it appends the worker's raw
 * failure text, and nothing in the snapshot says when it did. A `Map`, so a
 * reason such as `constructor` finds nothing rather than a prototype member.
 */
const DEGRADATION_TEXT: ReadonlyMap<string, string> = new Map([
  ["workflow_task_failing", "This run is not making progress. The platform keeps retrying it."],
  [
    "status_unavailable",
    "The run tracker can't be reached right now, so this may lag behind the run.",
  ],
]);

/** The sentence for a reason this app does not know, which never says the run is fine. */
export const DEGRADATION_TEXT_OTHER = "This run is not making progress as expected.";

/**
 * The SDK types a degradation's members other than `reason` as optional, and
 * the timeline as always present, `null` where they do not apply.
 */
function degradationOf(degradation: RunDegradation): ProgressDegradation {
  return {
    reason: degradation.reason,
    message: DEGRADATION_TEXT.get(degradation.reason) ?? DEGRADATION_TEXT_OTHER,
    failed_attempts: degradation.failed_attempts ?? null,
    failing_since: degradation.failing_since ?? null,
    ends_at: degradation.ends_at ?? null,
  };
}

function batchOf(batch: ProgressBatch): BatchProgress {
  return { total: batch.total, done: batch.done, running: batch.running, failed: batch.failed };
}

function conditionOf(condition: ProgressCondition): ConditionProgress {
  return { selected_outcome: condition.selected_outcome };
}

function attemptOf(attempt: ProgressAttempt): ExecutionAttempt {
  return { execution: attempt.execution, attempt: attempt.attempt };
}

function invocationOf(invocation: SdkProgressInvocation): ProgressInvocation {
  return {
    path: invocation.path,
    pipe_code: invocation.pipe_code,
    pipe_ref: invocation.pipe_ref,
    pipe_type: invocation.pipe_type,
    status: invocation.status,
    started_at: invocation.started_at,
    ended_at: invocation.ended_at,
    ...(invocation.step_count !== undefined && { step_count: invocation.step_count }),
    ...(invocation.branch_count !== undefined && { branch_count: invocation.branch_count }),
    ...(invocation.skip_reason !== undefined && { skip_reason: invocation.skip_reason }),
    ...(invocation.batch !== undefined && { batch: batchOf(invocation.batch) }),
    ...(invocation.condition !== undefined && { condition: conditionOf(invocation.condition) }),
    ...(invocation.attempts !== undefined && { attempts: invocation.attempts }),
    ...(invocation.last_failure !== undefined && {
      last_failure: {
        message: FAILURE_TEXT_SHOWN,
        ...(invocation.last_failure.at !== undefined && { at: invocation.last_failure.at }),
      },
    }),
    ...(invocation.degradation !== undefined && {
      degradation: degradationOf(invocation.degradation),
    }),
  };
}

/**
 * The snapshot the SDK read, as it may leave the server. Every member the
 * contract names is picked, never spread, at every level, so a member a later
 * platform adds does not reach the browser unread; each failure's own text is
 * replaced by `FAILURE_TEXT_SHOWN`; and each degradation gets every member the
 * timeline types, its sentence worded here from its reason.
 */
export function toProgressSnapshot(progress: RunProgress): ProgressSnapshot {
  return {
    pipeline_run_id: progress.pipeline_run_id,
    mode: progress.mode,
    status: progress.status,
    version: progress.version,
    assembled_at: progress.assembled_at,
    summary: progress.summary,
    ...(progress.root_path !== undefined && { root_path: progress.root_path }),
    ...(progress.chain !== undefined && { chain: progress.chain.map(attemptOf) }),
    ...(progress.degradation !== undefined && {
      degradation: degradationOf(progress.degradation),
    }),
    invocations: progress.invocations.map(invocationOf),
  };
}
