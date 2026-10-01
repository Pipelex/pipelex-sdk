/**
 * The largest set of inputs one run sends, in bytes of their JSON.
 *
 * A run's inputs travel as the argument of a Server Action, and Next refuses a
 * Server Action body past `serverActions.bodySizeLimit`, 1 MiB by default, which
 * `next.config.js` keeps. It refuses it before the action runs, so the browser
 * only sees a rejected call, which would read as "Could not reach the server".
 * `useRun` therefore measures the inputs first and refuses them itself, saying
 * how large they are and what the limit is. The margin under 1 MiB is room for
 * the encoding that wraps the inputs on the wire.
 *
 * Files do not count toward it: a dropped file is already in Pipelex storage,
 * and the inputs carry only its reference. What can reach the limit is text or
 * other values typed or pasted into the form.
 */
export const MAX_RUN_INPUT_BYTES = 1_000_000;

/**
 * The inputs' size as a Server Action sends them, near enough: their JSON, in
 * UTF-8 bytes. `null` when they do not serialize as JSON, in which case the
 * check is skipped and the action's own handling stands.
 */
export function runInputBytes(input: unknown): number | null {
  try {
    const json = JSON.stringify(input);
    return json === undefined ? null : new TextEncoder().encode(json).length;
  } catch {
    return null;
  }
}
