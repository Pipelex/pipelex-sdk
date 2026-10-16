import type { ProgressSnapshot } from "@pipelex/mthds-ui/timeline";

/*
 * The seam between the run timeline's view and where its snapshots come from.
 *
 * The view (`useRunProgress`, `RunTimelineView` and this file) knows nothing of
 * the hosted API: it imports React and `@pipelex/mthds-ui` only, which ESLint
 * enforces, so another app can lift those files whole and write one reader
 * of its own. This app's reader is `fetchRunProgress`, over its own
 * `GET /api/runs/{runId}/progress` route.
 */

/** What one read of a run's progress gave. */
export type ProgressRead =
  /** The run's progress at one moment. */
  | { kind: "snapshot"; snapshot: ProgressSnapshot }
  /** No progress for this run yet: read again. */
  | { kind: "none" }
  /** This source will not serve this run's progress, and asking again cannot change that: stop asking for this run. */
  | { kind: "unavailable" }
  /** This read failed: keep what is held, and read again. */
  | { kind: "failed" };

/**
 * Reads one run's progress. It never throws: a failure is `failed`. `signal`
 * aborts a read the follower no longer wants, once the run it was for is no
 * longer followed.
 */
export type ProgressReader = (runId: string, signal: AbortSignal) => Promise<ProgressRead>;
