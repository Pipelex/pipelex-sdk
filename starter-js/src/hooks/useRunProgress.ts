"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fresherSnapshot, isRunEnded, type ProgressSnapshot } from "@pipelex/mthds-ui/timeline";
import type { ProgressRead, ProgressReader } from "@/lib/progressReader";

/** How long after each answer a going run's progress is read again: the status poll's base interval. */
export const PROGRESS_POLL_MS = 2000;
/** How many reads an ended run's final snapshot gets at most, and how far apart. */
export const FINAL_PROGRESS_READS = 3;
export const FINAL_PROGRESS_READ_GAP_MS = 2000;

const FAILED: ProgressRead = { kind: "failed" };

export interface UseRunProgressOptions {
  /** The run to follow, or `null` for none. */
  runId: string | null;
  /**
   * Whether the run is still going, as its host knows it. While it is, its
   * progress is read on a poll; once it is not, its final snapshot is read, a
   * few times at most.
   */
  going: boolean;
  /** Where the snapshots come from. */
  read: ProgressReader;
}

/** The snapshot held, and the run it is for. */
interface Held {
  runId: string | null;
  snapshot: ProgressSnapshot | null;
}

/** The read on its way: its run, how to abort it, and its answer once it has one. */
interface Reading {
  runId: string;
  controller: AbortController;
  done: Promise<ProgressRead>;
}

/**
 * Follow one run's progress, returning the fresher of every snapshot read for
 * it, or `null` while there is none.
 *
 * - While the run goes, it reads at once, then again `PROGRESS_POLL_MS` after
 *   each answer, never two reads at a time.
 * - It keeps the fresher snapshot by `fresherSnapshot`, the contract's rule,
 *   which `RunTimeline` applies too. An answer about another run is dropped, and
 *   a read on its way is aborted once the run changes or the host unmounts.
 * - While the host says the run goes, a snapshot saying the run ended stops the
 *   poll, since an ended run does not resume; the host's own end then starts
 *   the final reads.
 * - Once the host says the run is no longer going, it makes the final reads,
 *   at most `FINAL_PROGRESS_READS`, `FINAL_PROGRESS_READ_GAP_MS` apart, even
 *   when the snapshot it holds already says the run ended. A read can lag
 *   behind the end the host saw, and the contract lets a read project an ended
 *   run from fewer events than a later read will, so the snapshot held may not
 *   be the last one: a later snapshot of the ended run replaces it by
 *   `fresherSnapshot`. The reads stop early once one answers an ended snapshot
 *   that leaves the held one unchanged, or `unavailable`. A read already on its
 *   way is awaited rather than doubled, and not counted.
 * - `none` reads again at the same pace, `unavailable` stops reading for the
 *   run, and `failed` keeps the held snapshot and reads again.
 *
 * It surfaces no error: the timeline is an addition to the run's status, never
 * a gate on it, and only the host's status poll decides how a run ends. It
 * reads only while the host says the run is going, plus the final reads, so
 * the host's own ceiling bounds it. It does not pause while the page is
 * hidden, because the status poll does not either.
 */
export function useRunProgress({
  runId,
  going,
  read,
}: UseRunProgressOptions): ProgressSnapshot | null {
  const [held, setHeld] = useState<Held>({ runId: null, snapshot: null });
  // Mirrors of what the reading loops need between renders. Each is written in
  // an effect or in a read's callback, never while rendering.
  const heldRef = useRef<Held>(held);
  const readRef = useRef(read);
  const readingRef = useRef<Reading | null>(null);
  /** The run whose source said it serves no progress. */
  const unavailableRef = useRef<string | null>(null);

  useEffect(() => {
    readRef.current = read;
  });

  /** The snapshot held for `id`, or `null` while there is none. */
  const heldFor = useCallback((id: string): ProgressSnapshot | null => {
    const current = heldRef.current;
    return current.runId === id ? current.snapshot : null;
  }, []);

  const hasEnded = useCallback(
    (id: string): boolean => {
      const snapshot = heldFor(id);
      return snapshot !== null && isRunEnded(snapshot.status);
    },
    [heldFor],
  );

  /** Keep the fresher of the held snapshot and one just read for `id`. */
  const apply = useCallback(
    (id: string, incoming: ProgressSnapshot): void => {
      if (incoming.pipeline_run_id !== id) return;
      const current = heldFor(id);
      const kept = fresherSnapshot(current, incoming);
      if (kept === current) return;
      heldRef.current = { runId: id, snapshot: kept };
      setHeld(heldRef.current);
    },
    [heldFor],
  );

  /** The read on its way for `id` when there is one, else a new one. */
  const readOnce = useCallback(
    (id: string): Promise<ProgressRead> => {
      const pending = readingRef.current;
      if (pending?.runId === id) return pending.done;
      const controller = new AbortController();
      const done = readRef
        .current(id, controller.signal)
        .catch(() => FAILED)
        .then((answer) => {
          if (readingRef.current?.controller === controller) readingRef.current = null;
          // A read aborted because its run is no longer followed is dropped.
          if (controller.signal.aborted) return FAILED;
          if (answer.kind === "snapshot") apply(id, answer.snapshot);
          if (answer.kind === "unavailable") unavailableRef.current = id;
          return answer;
        });
      readingRef.current = { runId: id, controller, done };
      return done;
    },
    [apply],
  );

  // A read on its way is aborted once its run is no longer followed: the run
  // changed, or the host unmounted. Not when the run ends, since the final
  // reads await it.
  useEffect(() => {
    return () => {
      const pending = readingRef.current;
      if (pending !== null && pending.runId === runId) {
        pending.controller.abort();
        readingRef.current = null;
      }
    };
  }, [runId]);

  useEffect(() => {
    if (runId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });
    const cut = () => stopped || unavailableRef.current === runId;

    const follow = async () => {
      // An ended snapshot stops the poll; the host's end starts the final reads.
      const done = () => cut() || hasEnded(runId);
      while (!done()) {
        await readOnce(runId);
        if (done()) return;
        await pause(PROGRESS_POLL_MS);
      }
    };

    const finalReads = async () => {
      // A read the poll left on its way answers first, and is not counted.
      if (readingRef.current?.runId === runId) await readingRef.current.done;
      // Made even when the held snapshot says the run ended: a lagging read can
      // project an ended run from fewer events than a later one will.
      for (let reads = 0; reads < FINAL_PROGRESS_READS && !cut(); reads += 1) {
        if (reads > 0) {
          await pause(FINAL_PROGRESS_READ_GAP_MS);
          if (cut()) return;
        }
        const before = heldFor(runId);
        const answer = await readOnce(runId);
        // An ended snapshot that changes nothing: there is nothing fresher to wait for.
        const settled =
          answer.kind === "snapshot" &&
          answer.snapshot.pipeline_run_id === runId &&
          isRunEnded(answer.snapshot.status) &&
          heldFor(runId) === before;
        if (settled) return;
      }
    };

    void (going ? follow() : finalReads());
    return () => {
      stopped = true;
      clearTimeout(timer);
      wake?.();
    };
  }, [runId, going, hasEnded, heldFor, readOnce]);

  return runId !== null && held.runId === runId ? held.snapshot : null;
}
