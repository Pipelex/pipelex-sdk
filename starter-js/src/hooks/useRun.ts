"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildClientTimeoutError,
  buildInputsTooLargeError,
  classifyTransportError,
  type PipelineError,
} from "@/lib/errors";
import { MAX_RUN_INPUT_BYTES, runInputBytes } from "@/lib/runRequest";
import type { ExecutionMode } from "@/config";
import type { UsageReport } from "@/lib/usageReport";
import type { BlockingOutcome } from "@/lib/blockingRun";
import type { PollOutcome, StartOutcome } from "@/lib/durableRun";

/**
 * Why the durable poll loop is in a resilient (still-polling, non-fatal) state,
 * or `null` when it's polling cleanly. The two causes are distinct and get
 * distinct copy — neither means the run is in trouble:
 * - `"reconnecting"`: the *server* reported `degraded` — its status endpoint
 *   couldn't reach the workflow orchestrator (Temporal) and returned the
 *   last-known status from its DB. The status shown may briefly lag.
 * - `"retrying"`: a *client-side* poll tick failed to get a verdict (a gateway
 *   5xx or a network blip) and is being retried within the transient budget.
 * In both cases the run keeps executing server-side.
 */
export type RunHealth = "reconnecting" | "retrying";

/**
 * The unified run state machine, identical for both execution modes:
 * `idle → running → (done | error)`. In `running`, `status` is the durable
 * coarse run status (null in blocking — there is no per-tick status),
 * `elapsedMs` is a smooth wall-clock counter, `health` is null while polling
 * cleanly or names why we're in a resilient/retrying state, and `runId` is the
 * durable run's id once it has one. The id rides both terminal states too: the
 * run a user saw finish is the run they quote, and the run they saw fail is the
 * run they need to look up — and once the page is closed, a run started from an
 * inline bundle has no other handle.
 */
export type RunState<T> =
  | { phase: "idle" }
  | {
      phase: "running";
      mode: ExecutionMode;
      status: string | null;
      elapsedMs: number;
      health: RunHealth | null;
      /**
       * The durable run's id, once `start` has returned one — `null` in
       * blocking mode, which has no run to poll, and for the moment between
       * the submit and that answer.
       */
      runId: string | null;
    }
  | {
      phase: "done";
      output: T;
      usage: UsageReport;
      /** The finished run's id — in blocking mode too, where it arrives with the result. */
      runId: string;
    }
  | {
      phase: "error";
      error: PipelineError;
      /** The run this error belongs to, when one had started. */
      runId: string | null;
    };

export interface UseRunConfig<TInput, TOutput> {
  /** Which path to drive. Forms own this as state and pass it in. */
  mode: ExecutionMode;
  /** Blocking Server Action — one synchronous `execute`. */
  blocking: (input: TInput) => Promise<BlockingOutcome<TOutput>>;
  /** Durable Server Action — `start`, returns a run id. */
  start: (input: TInput) => Promise<StartOutcome>;
  /** Durable Server Action — poll one tick of a run by id. */
  poll: (runId: string) => Promise<PollOutcome<TOutput>>;
  /** Base durable poll interval (ms). Honors a larger `Retry-After`. Default 2000. */
  intervalMs?: number;
  /** Durable poll ceiling (ms): stop waiting after this. Default 300_000 (5 min). */
  maxDurationMs?: number;
}

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MAX_DURATION_MS = 300_000;
const TICK_MS = 250;
/**
 * How many *consecutive* transient poll failures (gateway 5xx, network blip, or
 * a rejected Server Action call) to tolerate before giving up. The run keeps
 * executing server-side, so a momentary hiccup must not abandon it — but a
 * sustained outage should still surface the error rather than poll forever.
 * Any verdict-bearing tick resets the streak.
 */
const MAX_TRANSIENT_POLL_FAILURES = 5;

/**
 * Drive a pipeline run in either execution mode behind one state machine, so
 * the forms never branch on `mode`.
 *
 * - **blocking**: a single awaited Server Action; resolve → done, reject →
 *   transport error.
 * - **durable**: `start`, then a self-rescheduling `setTimeout` poll loop (no
 *   overlap) that honors `Retry-After`, enforces a wall-clock ceiling, and
 *   reports live status each tick.
 *
 * Shared concerns: a staleness token invalidates a superseded or unmounted
 * run's late results; an elapsed ticker drives a smooth counter; every awaited
 * boundary is wrapped so a rejected promise becomes a classified transport
 * error rather than escaping to React's error boundary.
 */
export function useRun<TInput, TOutput>(
  cfg: UseRunConfig<TInput, TOutput>,
): { state: RunState<TOutput>; run: (input: TInput) => void; reset: () => void } {
  const [state, setState] = useState<RunState<TOutput>>({ phase: "idle" });

  const tokenRef = useRef(0);
  const startedAtRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest-config ref: forms build the cfg object fresh each render (mode is
  // their state), so read the live callbacks/mode at submit time while keeping
  // `run` a stable identity. Updated in an effect (not during render) so the
  // ref rule stays satisfied — `run` only reads it from event handlers/timers,
  // which fire after commit.
  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  });

  const clearTimers = useCallback(() => {
    if (tickerRef.current !== null) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startTicker = useCallback(() => {
    if (tickerRef.current !== null) return;
    tickerRef.current = setInterval(() => {
      setState((prev) =>
        prev.phase === "running" ? { ...prev, elapsedMs: Date.now() - startedAtRef.current } : prev,
      );
    }, TICK_MS);
  }, []);

  const reset = useCallback(() => {
    tokenRef.current += 1; // invalidate any in-flight async work
    clearTimers();
    setState({ phase: "idle" });
  }, [clearTimers]);

  const run = useCallback(
    (input: TInput) => {
      const token = ++tokenRef.current;
      const isCurrent = () => tokenRef.current === token;
      clearTimers();
      startedAtRef.current = Date.now();

      const { mode, blocking, start, poll } = cfgRef.current;
      const intervalMs = cfgRef.current.intervalMs ?? DEFAULT_INTERVAL_MS;
      const maxDurationMs = cfgRef.current.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

      setState({ phase: "running", mode, status: null, elapsedMs: 0, health: null, runId: null });
      startTicker();

      // Held outside the state so a failure carries it however the run ended:
      // `fail` is called from timers and rejected promises, where the previous
      // state is not in hand.
      let runId: string | null = null;

      const fail = (error: PipelineError) => {
        if (!isCurrent()) return;
        clearTimers();
        setState({ phase: "error", error, runId });
      };
      const succeed = (output: TOutput, usage: UsageReport, finishedRunId: string) => {
        if (!isCurrent()) return;
        clearTimers();
        setState({ phase: "done", output, usage, runId: finishedRunId });
      };

      // Past what one Server Action body may carry, Next refuses the call
      // before the action runs, and the rejection would read as "Could not
      // reach the server". Refuse it here instead, saying why.
      const inputBytes = runInputBytes(input);
      if (inputBytes !== null && inputBytes > MAX_RUN_INPUT_BYTES) {
        fail(buildInputsTooLargeError(inputBytes, MAX_RUN_INPUT_BYTES));
        return;
      }

      if (mode === "blocking") {
        blocking(input)
          .then((outcome) => {
            if (outcome.ok) {
              succeed(outcome.output, outcome.usage, outcome.runId);
              return;
            }
            // A run that finished but could not be read still has an id, and
            // it is the one a user needs to quote.
            runId = outcome.runId ?? null;
            fail(outcome.error);
          })
          .catch((err) => fail(classifyTransportError(err)));
        return;
      }

      // Durable: start, then poll until terminal. A momentary 5xx/network blip
      // on one tick must not abandon a run that is still completing
      // server-side, so transient poll failures are retried within a bounded
      // budget; only a terminal failure (or a sustained outage) ends the run.
      let transientFailures = 0;

      const pollOnce = async (runId: string) => {
        if (!isCurrent()) return;
        // Ceiling: stop polling after maxDurationMs (the run continues server-side).
        const elapsed = Date.now() - startedAtRef.current;
        if (elapsed >= maxDurationMs) {
          fail(buildClientTimeoutError(elapsed));
          return;
        }

        // Schedule the next tick, capped to the time remaining before the
        // ceiling — a large Retry-After must not leave the UI "running" past
        // maxDurationMs; the capped tick lands on the ceiling check above.
        const scheduleNext = (baseDelayMs: number) => {
          const remainingMs = Math.max(0, maxDurationMs - (Date.now() - startedAtRef.current));
          pollTimerRef.current = setTimeout(
            () => void pollOnce(runId),
            Math.min(baseDelayMs, remainingMs),
          );
        };

        // A tick that failed to get a verdict: keep polling unless the streak
        // exceeds the budget. Surface `retrying` so the UI shows we hit a blip
        // but are still trying — the run keeps executing server-side.
        const onTransient = (error: PipelineError) => {
          transientFailures += 1;
          if (transientFailures > MAX_TRANSIENT_POLL_FAILURES) {
            fail(error);
            return;
          }
          setState((prev) => (prev.phase === "running" ? { ...prev, health: "retrying" } : prev));
          scheduleNext(intervalMs);
        };

        let outcome: PollOutcome<TOutput>;
        try {
          outcome = await poll(runId);
        } catch (err) {
          // The awaited Server Action call itself rejected (network drop, dev
          // server crash, stale Server Action id). Treat as a transient blip.
          if (!isCurrent()) return;
          onTransient(classifyTransportError(err));
          return;
        }
        if (!isCurrent()) return;

        if (!outcome.ok) {
          if (outcome.transient) onTransient(outcome.error);
          else fail(outcome.error);
          return;
        }

        transientFailures = 0; // a verdict-bearing tick clears the streak
        if (outcome.state === "completed") {
          succeed(outcome.output, outcome.usage, runId);
          return;
        }

        // running: refresh the live status (the ticker keeps elapsedMs
        // current). A verdict-bearing tick cleared the transient streak above,
        // so `health` now reflects only the server's own signal:
        // `reconnecting` when it served a last-known status, else clean.
        setState((prev) =>
          prev.phase === "running"
            ? {
                ...prev,
                status: outcome.status,
                health: outcome.degraded ? "reconnecting" : null,
              }
            : prev,
        );
        scheduleNext(Math.max(intervalMs, (outcome.retryAfterSeconds ?? 0) * 1000));
      };

      start(input)
        .then((outcome) => {
          if (!isCurrent()) return;
          if (!outcome.ok) {
            // Includes `lifecycle_unavailable` (the configured URL doesn't
            // serve the durable run lifecycle): surface it as an explicit
            // error — never silently downgrade durable to blocking. The
            // classified error names the endpoint URL and steers the user to
            // check PIPELEX_BASE_URL.
            fail(outcome.error);
            return;
          }
          runId = outcome.runId;
          setState((prev) => (prev.phase === "running" ? { ...prev, runId } : prev));
          void pollOnce(outcome.runId); // first tick immediately
        })
        .catch((err) => fail(classifyTransportError(err)));
    },
    [clearTimers, startTicker],
  );

  // Unmount: invalidate in-flight work and stop timers so a late result can't
  // setState on an unmounted component and the poll loop ends.
  useEffect(() => {
    return () => {
      tokenRef.current += 1;
      clearTimers();
    };
  }, [clearTimers]);

  return { state, run, reset };
}
