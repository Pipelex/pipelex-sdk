import { describe, expect, it } from "vitest";
import { buildProblem, type ProgressInvocation, type RunProgress } from "@pipelex/sdk";
import { DEGRADATION_TEXT_OTHER, FAILURE_TEXT_SHOWN, toProgressSnapshot } from "./runProgress";

// The provider's raw text and the worker's, which a person must never read.
const PROVIDER_TEXT = "provider said: 412 model global.anthropic.claude-opus-4-8 is not allowed";
const WORKER_TEXT = "The recorded failure is: KeyError at /srv/worker.py:88";

// An invocation's failure as the SDK reads it: a problem whose detail is the provider's raw text.
const PROVIDER_PROBLEM = { ...buildProblem("runtime.unexpected", {}), detail: PROVIDER_TEXT };

// Members the SDK relays as sent, which the mapping must not pass on. Held in
// variables first, so each extra member is a value the SDK's types admit.
const BATCH = { total: 3, done: 1, running: 2, failed: 0, per_item_costs: "never sent on" };
const CONDITION = { selected_outcome: "all_hold", raw_expression: "never sent on" };
const ATTEMPT = { execution: "exec-1", attempt: 2, worker_host: "never sent on" };

const ROOT: ProgressInvocation = {
  path: "check_claims.check_claims",
  pipe_code: "check_claims",
  pipe_ref: "check_claims.check_claims",
  pipe_type: "PipeSequence",
  status: "running",
  started_at: "2026-10-16T09:00:00.000Z",
  ended_at: null,
  step_count: 4,
  internal_note: "never sent on",
};

function progress(overrides: Partial<RunProgress> = {}): RunProgress {
  return {
    pipeline_run_id: "run-1",
    mode: "live",
    status: "running",
    version: 7,
    assembled_at: "2026-10-16T09:00:12.000Z",
    summary: "Running check_each_claim (step 2 of 4)",
    a_member_a_later_platform_adds: "never sent on",
    invocations: [ROOT],
    ...overrides,
  };
}

describe("toProgressSnapshot", () => {
  it("picks the contract's members of the snapshot and of each invocation", () => {
    const snapshot = toProgressSnapshot(progress());
    expect(snapshot).toEqual({
      pipeline_run_id: "run-1",
      mode: "live",
      status: "running",
      version: 7,
      assembled_at: "2026-10-16T09:00:12.000Z",
      summary: "Running check_each_claim (step 2 of 4)",
      invocations: [
        {
          path: "check_claims.check_claims",
          pipe_code: "check_claims",
          pipe_ref: "check_claims.check_claims",
          pipe_type: "PipeSequence",
          status: "running",
          started_at: "2026-10-16T09:00:00.000Z",
          ended_at: null,
          step_count: 4,
        },
      ],
    });
  });

  it("leaves an optional member absent rather than null when the SDK has none", () => {
    const snapshot = toProgressSnapshot(progress());
    for (const member of ["root_path", "chain", "degradation"]) {
      expect(snapshot).not.toHaveProperty(member);
    }
    const [invocation] = snapshot.invocations;
    for (const member of [
      "branch_count",
      "skip_reason",
      "batch",
      "condition",
      "attempts",
      "last_failure",
      "degradation",
    ]) {
      expect(invocation).not.toHaveProperty(member);
    }
  });

  it("picks the members of the nested objects too, never spreading them", () => {
    const snapshot = toProgressSnapshot(
      progress({
        root_path: "check_claims.check_claims/step_2",
        chain: [ATTEMPT],
        invocations: [
          {
            path: "check_claims.check_claims/step_2",
            pipe_code: "check_each_claim",
            pipe_ref: "check_claims.check_each_claim",
            pipe_type: "PipeBatch",
            status: "running",
            started_at: "2026-10-16T09:00:04.000Z",
            ended_at: null,
            batch: BATCH,
          },
          {
            path: "check_claims.check_claims/step_3",
            pipe_code: "word_verdict",
            pipe_ref: "check_claims.word_verdict",
            pipe_type: "PipeCondition",
            status: "succeeded",
            started_at: "2026-10-16T09:00:11.000Z",
            ended_at: "2026-10-16T09:00:17.000Z",
            condition: CONDITION,
            branch_count: 2,
            skip_reason: "not taken",
            attempts: 2,
          },
        ],
      }),
    );
    expect(snapshot.root_path).toBe("check_claims.check_claims/step_2");
    expect(snapshot.chain).toEqual([{ execution: "exec-1", attempt: 2 }]);
    const [batch, condition] = snapshot.invocations;
    expect(batch?.batch).toEqual({ total: 3, done: 1, running: 2, failed: 0 });
    expect(condition?.condition).toEqual({ selected_outcome: "all_hold" });
    expect(condition).toMatchObject({ branch_count: 2, skip_reason: "not taken", attempts: 2 });
    expect(JSON.stringify(snapshot)).not.toContain("never sent on");
  });

  it("replaces each invocation's failure, its problem included, keeping when it failed", () => {
    const snapshot = toProgressSnapshot(
      progress({
        invocations: [
          {
            ...ROOT,
            attempts: 2,
            last_failure: { problem: PROVIDER_PROBLEM, at: "2026-10-16T09:00:09Z" },
          },
          {
            ...ROOT,
            path: "check_claims.check_claims/step_1",
            last_failure: { problem: PROVIDER_PROBLEM },
          },
        ],
      }),
    );
    const [first, second] = snapshot.invocations;
    expect(first?.last_failure).toEqual({
      message: FAILURE_TEXT_SHOWN,
      at: "2026-10-16T09:00:09Z",
    });
    expect(second?.last_failure).toEqual({ message: FAILURE_TEXT_SHOWN });
    expect(JSON.stringify(snapshot)).not.toContain("provider said");
  });

  it("words each degradation from its reason, on the run and on the step, never the platform's", () => {
    const degradation = {
      reason: "workflow_task_failing",
      message: `Workflow task failed 4 times. ${WORKER_TEXT}`,
      failed_attempts: 4,
      failing_since: "2026-10-16T09:00:02Z",
      ends_at: "2026-10-16T09:10:02Z",
    };
    const snapshot = toProgressSnapshot(
      progress({ degradation, invocations: [{ ...ROOT, degradation }] }),
    );
    const shown = {
      reason: "workflow_task_failing",
      message: "This run is not making progress. The platform keeps retrying it.",
      failed_attempts: 4,
      failing_since: "2026-10-16T09:00:02Z",
      ends_at: "2026-10-16T09:10:02Z",
    };
    expect(snapshot.degradation).toEqual(shown);
    expect(snapshot.invocations[0]?.degradation).toEqual(shown);
    expect(JSON.stringify(snapshot)).not.toContain("recorded failure");
  });

  it("gives a degradation every member the timeline types, null where the SDK has none", () => {
    const snapshot = toProgressSnapshot(
      progress({ degradation: { reason: "status_unavailable" } }),
    );
    expect(snapshot.degradation).toEqual({
      reason: "status_unavailable",
      message: "The run tracker can't be reached right now, so this may lag behind the run.",
      failed_attempts: null,
      failing_since: null,
      ends_at: null,
    });
  });

  it("words a reason it does not know without saying the run is fine", () => {
    for (const reason of ["a_reason_a_later_platform_adds", "constructor", "toString"]) {
      const snapshot = toProgressSnapshot(
        progress({ degradation: { reason, message: WORKER_TEXT } }),
      );
      expect(snapshot.degradation?.reason).toBe(reason);
      expect(snapshot.degradation?.message).toBe(DEGRADATION_TEXT_OTHER);
    }
  });
});
