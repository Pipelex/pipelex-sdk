/**
 * Combining abort signals by hand. This module imports nothing, so any module of the SDK can use it
 * without an import cycle.
 */

/**
 * A signal that aborts when either does, with the reason of the first to abort, and `dispose`,
 * which detaches it from both once it is no longer needed, so a long-lived signal does not keep
 * a listener per call. `second` absent gives `first` itself. Built by hand rather than with
 * `AbortSignal.any`, which older browsers lack.
 */
export function eitherSignal(
  first: AbortSignal,
  second: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  if (second === undefined || first.aborted) return { signal: first, dispose: () => undefined };
  if (second.aborted) return { signal: second, dispose: () => undefined };
  const controller = new AbortController();
  const dispose = (): void => {
    first.removeEventListener("abort", onFirst);
    second.removeEventListener("abort", onSecond);
  };
  const onFirst = (): void => {
    dispose();
    controller.abort(first.reason);
  };
  const onSecond = (): void => {
    dispose();
    controller.abort(second.reason);
  };
  first.addEventListener("abort", onFirst, { once: true });
  second.addEventListener("abort", onSecond, { once: true });
  return { signal: controller.signal, dispose };
}
