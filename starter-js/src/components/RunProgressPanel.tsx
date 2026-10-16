"use client";

import { useState } from "react";
import type { RunState } from "@/hooks/useRun";
import { useRunProgress } from "@/hooks/useRunProgress";
import { fetchRunProgress } from "@/lib/fetchRunProgress";
import { RunTimelineView } from "./RunTimelineView";

/**
 * The run to follow, given the form's run state and the run followed so far:
 * one seen running with an id, which is a durable run once `start` answered,
 * kept through the end of that same run. A blocking run has no id until it
 * has ended, so it is never followed, and a new submit starts afresh.
 */
function runToFollow(state: RunState<unknown>, followed: string | null): string | null {
  switch (state.phase) {
    case "running":
      return state.runId;
    case "done":
    case "error":
      return state.runId === followed ? followed : null;
    case "idle":
      return null;
  }
}

/**
 * The gallery's glue between a form's run and the run timeline: it follows a
 * durable run while it goes, through this app's progress route, and keeps the
 * run's last snapshot once it is done or has failed, so a finished run keeps
 * its timeline and a failed one shows where it stopped.
 *
 * It renders the timeline alone, with no wrapper of its own, so the timeline's
 * own "Run progress" region is the one landmark, and nothing stays in the page
 * while it draws nothing: until the run has reached an invocation, while the
 * timeline loads, and always on a base URL that serves no progress. The form
 * then shows exactly what it shows without it, with no empty region and no
 * stray gap in its column. Each form renders it last in its column, in every
 * phase, so the timeline never jumps between the status card and the result.
 */
export function RunProgressPanel({ state }: { state: RunState<unknown> }) {
  // What the previous render followed, adjusted while rendering rather than in
  // an effect, so the timeline never draws a run the form has moved on from.
  const [followed, setFollowed] = useState<string | null>(null);
  const runId = runToFollow(state, followed);
  if (runId !== followed) setFollowed(runId);

  const going = state.phase === "running";
  const snapshot = useRunProgress({ runId, going, read: fetchRunProgress });
  return <RunTimelineView snapshot={snapshot} live={going} />;
}
