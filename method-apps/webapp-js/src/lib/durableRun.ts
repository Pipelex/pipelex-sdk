import { getPipelexClient } from "@/lib/pipelexClient";
import { classifyPipelineError, type PipelineError, type PipelineErrorKind } from "@/lib/errors";
import { readClassifyEnv } from "@/lib/serverEnv";
import { buildUsageReport, type UsageReport } from "@/lib/usageReport";
// `PipelexStartOptions` rather than the pure protocol `StartOptions`: it adds
// the run extensions (`method_ref`, `method_id`) a scaffolded action sends in
// place of an inline bundle. See the note in `blockingRun.ts`.
import {
  RunFailedError,
  isTerminalRunStatus,
  type PipelexStartOptions,
  type RunResults,
  type RunStatus,
} from "@pipelex/sdk";

export type StartOutcome = { ok: true; runId: string } | { ok: false; error: PipelineError };

export type PollOutcome<T> =
  | {
      ok: true;
      state: "running";
      status: RunStatus;
      degraded: boolean;
      retryAfterSeconds: number | null;
    }
  | { ok: true; state: "completed"; output: T; usage: UsageReport }
  | { ok: false; error: PipelineError; transient: boolean };

/**
 * A poll tick that failed to *get a verdict* — a gateway 5xx or a network blip
 * (`server_error` / `api_unreachable`) — is transient: the run is still
 * executing server-side, so the client should keep polling rather than abandon
 * it. Everything else is terminal: a classified application failure
 * (`run_failed`, `lifecycle_unavailable`), a narrower's deterministic
 * bad-output, or an auth/request error that retrying can't fix. Mirrors the
 * SDK's own poller, which retries 503 and never fails on a transient hiccup.
 */
function isTransientPollError(kind: PipelineErrorKind): boolean {
  return kind === "server_error" || kind === "api_unreachable";
}

/**
 * Start a pipeline the **durable** way — `POST /v1/start` (202) — and return
 * the run id to poll. Server-only.
 *
 * When the configured URL doesn't serve the run lifecycle, the SDK throws
 * `RunLifecycleUnavailableError` (raw `start()` does NOT auto-fall-back to
 * blocking); it is classified into a `lifecycle_unavailable` error that steers
 * the user to check PIPELEX_BASE_URL.
 */
export async function startDurableRun(
  buildOptions: () => Promise<PipelexStartOptions>,
): Promise<StartOutcome> {
  try {
    const options = await buildOptions();
    const { pipeline_run_id } = await getPipelexClient().start(options);
    // The one line this module writes, and the rule against console writes is
    // about DIAGNOSTICS: a run id is not one. It is the only handle on a run
    // once the page is closed — a run started from an inline bundle has no
    // catalog id, so `listRuns` cannot find it by method — and without it a run
    // a user watched hang cannot be looked up in the back office, with
    // `getRunDetail`, or by the workshop's `mthds_run_status`.
    // eslint-disable-next-line no-console
    console.info(`[pipelex] run started: ${pipeline_run_id}`);
    return { ok: true, runId: pipeline_run_id };
  } catch (err) {
    return { ok: false, error: classifyPipelineError(err, readClassifyEnv()) };
  }
}

/**
 * Poll one tick of a durable run. Server-only — the client calls this on a
 * timer (see `useRun`) and never touches the SDK directly.
 *
 * 1. `getRunStatus` — while non-terminal, report `running` with the coarse
 *    status + degraded flag + the server's `Retry-After` hint.
 * 2. On a terminal status, `getRunResult`:
 *    - `completed` → narrow `result` and report `completed`.
 *    - `failed`    → classify a constructed `RunFailedError` carrying the run's
 *                    stored error report (the result lookup's, else the status
 *                    read's), so the person sees the runtime's reason, next
 *                    step and retry verdict rather than the lookup's sentence.
 *    - `running`   → mid-write race (status flipped terminal but `main_stuff` /
 *                    `graph_spec` aren't written yet) → report `running` so the
 *                    client polls once more.
 * A thrown SDK error — including a narrower throwing `BadPipelineOutputError`,
 * or `RunLifecycleUnavailableError` — is classified, and
 * the failure carries a `transient` flag (see `isTransientPollError`) so the
 * client poll loop can keep polling through a momentary 5xx/network blip
 * instead of abandoning a run that is still completing server-side.
 */
export async function pollDurableRun<T>(
  runId: string,
  parse: (results: RunResults) => T,
): Promise<PollOutcome<T>> {
  const client = getPipelexClient();
  try {
    const read = await client.getRunStatus(runId);
    if (!isTerminalRunStatus(read.status)) {
      return {
        ok: true,
        state: "running",
        status: read.status,
        degraded: read.degraded,
        retryAfterSeconds: read.retry_after_seconds ?? null,
      };
    }

    const res = await client.getRunResult(runId);
    if (res.state === "completed") {
      // `res.result` is a full `RunResults`, so usage rides on it directly (the
      // hosted results route relays the `tokens_usages.json` artifact) — no lift.
      return {
        ok: true,
        state: "completed",
        output: parse(res.result),
        usage: buildUsageReport(res.result),
      };
    }
    if (res.state === "failed") {
      // A genuine run failure is terminal — never retried. Its stored error
      // report says why: the results read carries it on a platform that serves
      // it there, and the status read just made carries it on any hosted
      // platform, even one whose results read does not yet, so the reason
      // reaches the person either way. The status read also says when the run
      // ended, for the support line.
      const report = res.error ?? read.error ?? null;
      return {
        ok: false,
        error: classifyPipelineError(
          new RunFailedError(res.message, runId, res.status, { error: report }),
          readClassifyEnv(),
          { finishedAt: read.finished_at },
        ),
        transient: false,
      };
    }
    // res.state === "running": terminal status but result artifacts mid-write.
    return {
      ok: true,
      state: "running",
      status: read.status,
      degraded: read.degraded,
      retryAfterSeconds: res.retry_after_seconds ?? null,
    };
  } catch (err) {
    const error = classifyPipelineError(err, readClassifyEnv());
    return { ok: false, error, transient: isTransientPollError(error.kind) };
  }
}
