// ---------------------------------------------------------------------------
// TEST FIXTURE — progress snapshots of one run of `methods/check-claims`.
//
// Written by hand after the hosted progress contract (`@pipelex/mthds-ui`'s
// `ProgressSnapshot`, the SDK's `RunProgress`): the method's sequence, its
// first step done, and its batch checking the claims, only the first done.
// The paths follow the contract's grammar: the entry pipe's `pipe_ref`, then
// one segment per controller level.
// ---------------------------------------------------------------------------

import type { ProgressInvocation, ProgressSnapshot } from "@pipelex/mthds-ui/timeline";

const ROOT = "check_claims.check_claims";

function invocation(
  path: string,
  pipe_code: string,
  pipe_type: string,
  status: ProgressInvocation["status"],
  started_at: string | null,
  ended_at: string | null,
): ProgressInvocation {
  return {
    path,
    pipe_code,
    pipe_ref: `check_claims.${pipe_code}`,
    pipe_type,
    status,
    started_at,
    ended_at,
  };
}

/** The run halfway: the claims split, the batch checking them. */
export function claimsMidRun(runId = "run-1", version = 7): ProgressSnapshot {
  return {
    pipeline_run_id: runId,
    mode: "live",
    status: "running",
    version,
    assembled_at: "2026-10-16T09:00:12.000Z",
    summary: "Running check_each_claim (step 2 of 4): 1 of 3 items done, 2 running",
    invocations: [
      {
        ...invocation(
          ROOT,
          "check_claims",
          "PipeSequence",
          "running",
          "2026-10-16T09:00:00.000Z",
          null,
        ),
        step_count: 4,
      },
      invocation(
        `${ROOT}/step_1`,
        "split_claims",
        "PipeLLM",
        "succeeded",
        "2026-10-16T09:00:00.100Z",
        "2026-10-16T09:00:04.000Z",
      ),
      {
        ...invocation(
          `${ROOT}/step_2`,
          "check_each_claim",
          "PipeBatch",
          "running",
          "2026-10-16T09:00:04.100Z",
          null,
        ),
        batch: { total: 3, done: 1, running: 2, failed: 0 },
      },
      invocation(
        `${ROOT}/step_2/item_1`,
        "check_claim",
        "PipeLLM",
        "succeeded",
        "2026-10-16T09:00:04.200Z",
        "2026-10-16T09:00:09.000Z",
      ),
      invocation(
        `${ROOT}/step_2/item_2`,
        "check_claim",
        "PipeLLM",
        "running",
        "2026-10-16T09:00:04.200Z",
        null,
      ),
      invocation(
        `${ROOT}/step_2/item_3`,
        "check_claim",
        "PipeLLM",
        "running",
        "2026-10-16T09:00:04.300Z",
        null,
      ),
    ],
  };
}

/** The same run, ended: every invocation done, the condition's outcome taken. */
export function claimsFinished(runId = "run-1", version = 15): ProgressSnapshot {
  const ended = "2026-10-16T09:00:20.000Z";
  return {
    pipeline_run_id: runId,
    mode: "live",
    status: "succeeded",
    version,
    assembled_at: "2026-10-16T09:00:21.000Z",
    summary: "Succeeded",
    invocations: [
      {
        ...invocation(
          ROOT,
          "check_claims",
          "PipeSequence",
          "succeeded",
          "2026-10-16T09:00:00.000Z",
          ended,
        ),
        step_count: 4,
      },
      invocation(
        `${ROOT}/step_1`,
        "split_claims",
        "PipeLLM",
        "succeeded",
        "2026-10-16T09:00:00.100Z",
        "2026-10-16T09:00:04.000Z",
      ),
      {
        ...invocation(
          `${ROOT}/step_2`,
          "check_each_claim",
          "PipeBatch",
          "succeeded",
          "2026-10-16T09:00:04.100Z",
          "2026-10-16T09:00:11.000Z",
        ),
        batch: { total: 3, done: 3, running: 0, failed: 0 },
      },
      {
        ...invocation(
          `${ROOT}/step_3`,
          "word_verdict",
          "PipeCondition",
          "succeeded",
          "2026-10-16T09:00:11.100Z",
          "2026-10-16T09:00:17.000Z",
        ),
        condition: { selected_outcome: "all_hold" },
      },
      invocation(
        `${ROOT}/step_3/outcome_all_hold`,
        "word_reliable_verdict",
        "PipeLLM",
        "succeeded",
        "2026-10-16T09:00:11.200Z",
        "2026-10-16T09:00:16.900Z",
      ),
      invocation(
        `${ROOT}/step_4`,
        "assemble_fact_check",
        "PipeCompose",
        "succeeded",
        "2026-10-16T09:00:17.100Z",
        ended,
      ),
    ],
  };
}

/** The run accepted and not started yet: nothing to draw. */
export function claimsPending(runId = "run-1"): ProgressSnapshot {
  return {
    pipeline_run_id: runId,
    mode: "live",
    status: "pending",
    version: 0,
    assembled_at: "2026-10-16T08:59:59.000Z",
    summary: "Pending",
    invocations: [],
  };
}
