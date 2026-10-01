import type { RunHealth } from "@/hooks/useRun";

interface RunStatusProps {
  /** Durable coarse run status (e.g. `RUNNING`), or null in blocking mode. */
  status: string | null;
  /** Wall-clock elapsed since the run started, in ms. */
  elapsedMs: number;
  /** Why we're in a resilient/retrying poll state, or null when polling cleanly. */
  health: RunHealth | null;
  /** The durable run's id, or null in blocking mode and before `start` answers. */
  runId: string | null;
}

/**
 * Reassuring, cause-specific note for a non-fatal poll state. Both mean the
 * run is still executing server-side and we're still polling — so neither
 * shouts "degraded"; each just names what's briefly off and points forward.
 */
const HEALTH_NOTES: Record<RunHealth, string> = {
  reconnecting: "Reconnecting to the run tracker — your run is still going.",
  retrying: "Network hiccup — retrying. Your run is still going.",
};

/**
 * Friendly labels for the hosted `RunStatus` values. `COMPLETED` maps to
 * "Finalizing" because we only ever show it during the brief mid-write race
 * (status flipped terminal but the result artifacts aren't written yet).
 */
const STATUS_LABELS: Record<string, string> = {
  PENDING: "Queued",
  STARTED: "Starting",
  RUNNING: "Running",
  COMPLETED: "Finalizing",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  TERMINATED: "Terminated",
  TIMED_OUT: "Timed out",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "Running";
}

/**
 * Shared live-status card for both modes. In durable mode `status` is a
 * friendly label ("Queued"/"Running" + elapsed); in blocking mode `status` is
 * null, so it shows just the spinner + elapsed. `role="status"` +
 * `aria-live="polite"` announces progress to assistive tech without stealing
 * focus.
 */
export function RunStatus({ status, elapsedMs, health, runId }: RunStatusProps) {
  const seconds = (elapsedMs / 1000).toFixed(1);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700"
      />
      <div className="space-y-0.5">
        <p className="font-medium">
          {status ? `${statusLabel(status)}… ` : "Running… "}
          {/* aria-hidden: ticks every 250ms — announcing it would drown the live region. */}
          <span aria-hidden="true" className="font-normal text-blue-700">
            {seconds}s
          </span>
        </p>
        {health && <p className="text-xs text-blue-700">{HEALTH_NOTES[health]}</p>}
        {/* The run id, where a person can read and copy it: a run started from
            an inline bundle has no catalog id, so once this page is closed the
            id is the only way back to it — in the back office, through the
            API, or in the server's log, which prints the same line on every
            server and not only in development. `RunDetails` keeps it on screen
            once the run has finished.
            `aria-live="off"` keeps it out of the announcement while leaving it
            in the accessibility tree: inside this polite region it would
            otherwise be read out as a run id's worth of hexadecimal the moment
            it arrives. `select-all` makes one click take the whole id. */}
        {runId && (
          <p aria-live="off" className="text-xs text-blue-700">
            Run <span className="select-all font-mono">{runId}</span>
          </p>
        )}
      </div>
    </div>
  );
}
