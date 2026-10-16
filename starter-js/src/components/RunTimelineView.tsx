"use client";

import { Component, lazy, Suspense, type ReactNode } from "react";
import type { ProgressSnapshot } from "@pipelex/mthds-ui/timeline";

/*
 * The run timeline's drawing: `@pipelex/mthds-ui`'s `RunTimeline` over one
 * progress snapshot. With `useRunProgress` and `src/lib/progressReader.ts` it
 * is the view, which knows nothing of where its snapshots come from (ESLint
 * holds these files to React and `@pipelex/mthds-ui`), so another app lifts
 * the view's files whole and writes one reader of its own.
 */

/**
 * Loaded the first time there is a snapshot to draw, so a page that never
 * follows a durable run never downloads it. Its entry imports its own
 * stylesheet, so Tailwind needs no `@source` for it.
 */
const RunTimeline = lazy(() =>
  import("@pipelex/mthds-ui/timeline/react").then((module) => ({ default: module.RunTimeline })),
);

/**
 * The timeline's surface, hairlines, text and type in the gallery's own
 * tokens: the form kernel's, declared by `@pipelex/mthds-form/theme.css` and
 * mapped in `src/app/globals.css`, and Tailwind's default font stacks. The
 * status colours stay the timeline's, because the kernel declares no success
 * or warning colour. The timeline sets its palette inline on its container,
 * which is why a host passes it as a prop rather than in a stylesheet.
 */
const GALLERY_PALETTE: Record<string, string> = {
  "--font-sans": "var(--default-font-family)",
  "--font-mono": "var(--default-mono-font-family)",
  "--surface-panel": "var(--background)",
  "--border-default": "var(--border)",
  "--border-subtle": "var(--border)",
  "--text-primary": "var(--foreground)",
  "--text-default": "var(--foreground)",
  "--text-secondary": "var(--muted-foreground)",
  "--text-muted": "var(--muted-foreground)",
};

/** Whether a snapshot has anything to draw: it has reached at least one invocation. */
function hasProgressToDraw(snapshot: ProgressSnapshot | null): snapshot is ProgressSnapshot {
  return snapshot !== null && snapshot.invocations.length > 0;
}

interface BoundaryProps {
  /** The snapshot drawn: a new one is tried afresh after a failure. */
  resetKey: ProgressSnapshot;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
  resetKey: ProgressSnapshot;
}

/**
 * The timeline's own render boundary, so a snapshot it cannot draw takes down
 * only the timeline, never the form, the result or the error beside it. A new
 * snapshot is tried afresh without remounting a timeline that draws, which
 * would lose the batches the person expanded. A class, because React offers a
 * boundary only as one. React reports what it caught, so nothing is logged
 * here.
 */
class TimelineBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface RunTimelineViewProps {
  /**
   * The run's progress: the fresher of every snapshot read (`useRunProgress`),
   * or each one a source pushes, since the timeline keeps the fresher itself.
   */
  snapshot: ProgressSnapshot | null;
  /**
   * Whether the run is still going, as its host knows it, so running bars keep
   * growing between snapshots. `false` stops them as soon as the host knows the
   * run has ended, before the final snapshot arrives.
   */
  live: boolean;
}

/**
 * A run's progress as a timeline: one row per invocation the run has reached,
 * nested under the controller that ran it, with a bar on a shared time axis.
 * It draws nothing without an invocation, while it loads, or when the timeline
 * cannot draw the snapshot, so its host keeps showing what it shows without
 * it. It adds no live region of its own: the host's status card announces the
 * run, and a timeline announced on every repaint would drown a screen reader.
 * The timeline itself announces only its one-line summary, politely, when it
 * changes.
 */
export function RunTimelineView({ snapshot, live }: RunTimelineViewProps) {
  if (!hasProgressToDraw(snapshot)) return null;
  return (
    <TimelineBoundary resetKey={snapshot}>
      <Suspense fallback={null}>
        <RunTimeline
          snapshot={snapshot}
          theme="light"
          paletteColors={GALLERY_PALETTE}
          live={live}
        />
      </Suspense>
    </TimelineBoundary>
  );
}
