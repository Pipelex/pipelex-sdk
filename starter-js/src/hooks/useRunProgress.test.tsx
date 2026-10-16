import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressSnapshot } from "@pipelex/mthds-ui/timeline";
import {
  FINAL_PROGRESS_READ_GAP_MS,
  FINAL_PROGRESS_READS,
  PROGRESS_POLL_MS,
  useRunProgress,
  type UseRunProgressOptions,
} from "./useRunProgress";
import type { ProgressRead } from "@/lib/progressReader";
import { claimsFinished, claimsMidRun } from "@/test/fixtures/runProgress";

const RUN = "run-1";

interface WaitingRead {
  runId: string;
  signal: AbortSignal;
  resolve: (answer: ProgressRead) => void;
  reject: (reason: unknown) => void;
}

/** A reader whose reads wait until the test answers them, oldest first. */
function heldReader() {
  const waiting: WaitingRead[] = [];
  const read = vi.fn(
    (runId: string, signal: AbortSignal) =>
      new Promise<ProgressRead>((resolve, reject) => {
        waiting.push({ runId, signal, resolve, reject });
      }),
  );
  async function answer(reply: ProgressRead): Promise<void> {
    const next = waiting.shift();
    if (!next) throw new Error("No read is waiting.");
    await act(async () => {
      next.resolve(reply);
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  async function reject(): Promise<void> {
    const next = waiting.shift();
    if (!next) throw new Error("No read is waiting.");
    await act(async () => {
      next.reject(new Error("a reader that broke its promise never to throw"));
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  return { read, waiting, answer, reject };
}

function snapshot(value: ProgressSnapshot): ProgressRead {
  return { kind: "snapshot", snapshot: value };
}

/** The run ended in failure, projected from as many events as `version` says. */
function failedAt(version: number): ProgressSnapshot {
  return { ...claimsMidRun(RUN, version), status: "failed", summary: "Failed" };
}

function follow(options: Partial<UseRunProgressOptions> & Pick<UseRunProgressOptions, "read">) {
  return renderHook((props: UseRunProgressOptions) => useRunProgress(props), {
    initialProps: { runId: RUN, going: true, ...options },
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("while the run goes", () => {
  it("reads at once, holds what it read, and reads again after each answer", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read });
    expect(reader.read).toHaveBeenCalledExactlyOnceWith(RUN, expect.any(AbortSignal));
    expect(result.current).toBeNull();

    const first = claimsMidRun(RUN, 7);
    await reader.answer(snapshot(first));
    expect(result.current).toBe(first);

    // Never two reads at a time: the next waits for the answer and the pause.
    await advance(PROGRESS_POLL_MS - 1);
    expect(reader.read).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(reader.read).toHaveBeenCalledTimes(2);
    await advance(PROGRESS_POLL_MS * 3);
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it("keeps the fresher snapshot, so a late answer of a lower version changes nothing", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read });
    const newer = claimsMidRun(RUN, 9);
    await reader.answer(snapshot(newer));

    await advance(PROGRESS_POLL_MS);
    await reader.answer(snapshot(claimsMidRun(RUN, 8)));
    expect(result.current).toBe(newer);

    await advance(PROGRESS_POLL_MS);
    const newest = claimsMidRun(RUN, 10);
    await reader.answer(snapshot(newest));
    expect(result.current).toBe(newest);
  });

  it("drops an answer about another run", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read });
    await reader.answer(snapshot(claimsMidRun("run-2", 40)));
    expect(result.current).toBeNull();
  });

  it("reads again at the same pace while the source has no progress for the run yet", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read });
    await reader.answer({ kind: "none" });
    await advance(PROGRESS_POLL_MS);
    expect(reader.read).toHaveBeenCalledTimes(2);
    const read = claimsMidRun();
    await reader.answer(snapshot(read));
    expect(result.current).toBe(read);
  });

  it("keeps the held snapshot, and reads again, when a read fails or its reader rejects", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read });
    const held = claimsMidRun();
    await reader.answer(snapshot(held));

    await advance(PROGRESS_POLL_MS);
    await reader.answer({ kind: "failed" });
    expect(result.current).toBe(held);

    await advance(PROGRESS_POLL_MS);
    await reader.reject();
    expect(result.current).toBe(held);

    await advance(PROGRESS_POLL_MS);
    expect(reader.read).toHaveBeenCalledTimes(4);
  });

  it("stops reading the run once its source says it serves no progress", async () => {
    const reader = heldReader();
    const { rerender } = follow({ read: reader.read });
    await reader.answer({ kind: "unavailable" });
    await advance(PROGRESS_POLL_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(1);

    // Not even the final reads once the run ends.
    rerender({ runId: RUN, going: false, read: reader.read });
    await advance(FINAL_PROGRESS_READ_GAP_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops reading once a snapshot says the run ended, since an ended run does not resume", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read });
    const ended = claimsFinished();
    await reader.answer(snapshot(ended));
    await advance(PROGRESS_POLL_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(ended);
  });

  it("reads nothing without a run", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read, runId: null });
    await advance(PROGRESS_POLL_MS * 5);
    expect(reader.read).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

describe("once the run has ended", () => {
  it("reads past a read lagging behind the end, and takes the snapshot saying the run ended", async () => {
    const reader = heldReader();
    const { result, rerender } = follow({ read: reader.read });
    await reader.answer(snapshot(claimsMidRun(RUN, 7)));

    rerender({ runId: RUN, going: false, read: reader.read });
    expect(reader.read).toHaveBeenCalledTimes(2);
    // A read lagging behind the end the host already saw.
    await reader.answer(snapshot(claimsMidRun(RUN, 8)));
    await advance(FINAL_PROGRESS_READ_GAP_MS - 1);
    expect(reader.read).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(reader.read).toHaveBeenCalledTimes(3);
    const ended = claimsFinished();
    await reader.answer(snapshot(ended));
    expect(result.current).toBe(ended);

    // The last read finds nothing fresher.
    await advance(FINAL_PROGRESS_READ_GAP_MS);
    await reader.answer(snapshot(claimsFinished()));
    expect(result.current).toBe(ended);
    await advance(FINAL_PROGRESS_READ_GAP_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(1 + FINAL_PROGRESS_READS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes a later snapshot of the ended run over a lagging one that said it ended", async () => {
    // The contract lets a read project an ended run from fewer events than an
    // earlier read projected it running from: the reader keeps the ended one,
    // and takes a later snapshot of the ended run by its version.
    const reader = heldReader();
    const { result, rerender } = follow({ read: reader.read });
    await reader.answer(snapshot(claimsMidRun(RUN, 10)));
    await advance(PROGRESS_POLL_MS);
    const lagging = failedAt(8);
    await reader.answer(snapshot(lagging));
    expect(result.current).toBe(lagging);
    // The ended snapshot stops the poll while the host still says the run goes.
    await advance(PROGRESS_POLL_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(2);

    rerender({ runId: RUN, going: false, read: reader.read });
    expect(reader.read).toHaveBeenCalledTimes(3);
    const complete = failedAt(12);
    await reader.answer(snapshot(complete));
    expect(result.current).toBe(complete);

    await advance(FINAL_PROGRESS_READ_GAP_MS);
    await reader.answer(snapshot(failedAt(12)));
    await advance(FINAL_PROGRESS_READ_GAP_MS * 5);
    expect(result.current).toBe(complete);
    expect(reader.read).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the final reads early once an ended snapshot is read twice unchanged", async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read, going: false });
    const ended = claimsFinished();
    await reader.answer(snapshot(ended));
    await advance(FINAL_PROGRESS_READ_GAP_MS);
    await reader.answer(snapshot(claimsFinished()));

    await advance(FINAL_PROGRESS_READ_GAP_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(FINAL_PROGRESS_READS).toBeGreaterThan(2);
    expect(result.current).toBe(ended);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the final reads once the source says it serves no progress", async () => {
    const reader = heldReader();
    follow({ read: reader.read, going: false });
    await reader.answer({ kind: "unavailable" });
    await advance(FINAL_PROGRESS_READ_GAP_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`gives up after ${FINAL_PROGRESS_READS} reads that never say the run ended`, async () => {
    const reader = heldReader();
    const { result } = follow({ read: reader.read, going: false });
    const answers: ProgressRead[] = [
      snapshot(claimsMidRun(RUN, 8)),
      { kind: "none" },
      { kind: "failed" },
    ];
    for (const answer of answers.slice(0, FINAL_PROGRESS_READS)) {
      await reader.answer(answer);
      await advance(FINAL_PROGRESS_READ_GAP_MS);
    }
    await advance(FINAL_PROGRESS_READ_GAP_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(FINAL_PROGRESS_READS);
    expect(result.current?.version).toBe(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("awaits a read the poll left on its way rather than doubling it, and does not count it", async () => {
    const reader = heldReader();
    const { result, rerender } = follow({ read: reader.read });
    // The poll's first read is still on its way when the run ends.
    rerender({ runId: RUN, going: false, read: reader.read });
    await advance(FINAL_PROGRESS_READ_GAP_MS * 2);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.waiting[0]?.signal.aborted).toBe(false);

    await reader.answer(snapshot(claimsMidRun(RUN, 8)));
    // Then the final reads, every one of them its own.
    for (let read = 0; read < FINAL_PROGRESS_READS; read += 1) {
      expect(reader.read).toHaveBeenCalledTimes(2 + read);
      await reader.answer(snapshot(claimsMidRun(RUN, 9 + read)));
      await advance(FINAL_PROGRESS_READ_GAP_MS);
    }
    expect(reader.read).toHaveBeenCalledTimes(1 + FINAL_PROGRESS_READS);
    expect(result.current?.version).toBe(8 + FINAL_PROGRESS_READS);
  });

  it("still makes a final read when the held snapshot says the run ended, and stops when it changes nothing", async () => {
    const reader = heldReader();
    const { result, rerender } = follow({ read: reader.read });
    const ended = claimsFinished();
    await reader.answer(snapshot(ended));
    rerender({ runId: RUN, going: false, read: reader.read });
    expect(reader.read).toHaveBeenCalledTimes(2);
    await reader.answer(snapshot(claimsFinished()));
    await advance(FINAL_PROGRESS_READ_GAP_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(ended);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("when the run is no longer followed", () => {
  it("aborts the read on its way and stops reading on unmount", async () => {
    const reader = heldReader();
    const { unmount } = follow({ read: reader.read });
    const [pending] = reader.waiting;
    unmount();
    expect(pending?.signal.aborted).toBe(true);
    await advance(PROGRESS_POLL_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the previous run's read, drops its late answer and follows the new run", async () => {
    const reader = heldReader();
    const { result, rerender } = follow({ read: reader.read });
    await reader.answer(snapshot(claimsMidRun(RUN, 7)));
    await advance(PROGRESS_POLL_MS);
    const [previous] = reader.waiting;

    rerender({ runId: "run-2", going: true, read: reader.read });
    expect(previous?.signal.aborted).toBe(true);
    expect(result.current).toBeNull();
    expect(reader.waiting.map((read) => read.runId)).toEqual([RUN, "run-2"]);

    // The previous run's reader ignored its signal and answered anyway.
    await reader.answer(snapshot(claimsMidRun(RUN, 8)));
    expect(result.current).toBeNull();
    const next = claimsMidRun("run-2", 3);
    await reader.answer(snapshot(next));
    expect(result.current).toBe(next);
  });

  it("shows nothing once the host follows no run", async () => {
    const reader = heldReader();
    const { result, rerender } = follow({ read: reader.read });
    await reader.answer(snapshot(claimsMidRun()));
    rerender({ runId: null, going: false, read: reader.read });
    expect(result.current).toBeNull();
    await advance(PROGRESS_POLL_MS * 5);
    expect(reader.read).toHaveBeenCalledTimes(1);
  });
});
