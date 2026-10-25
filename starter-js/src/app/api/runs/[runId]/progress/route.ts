import type { ProgressSnapshot } from "@pipelex/mthds-ui/timeline";
import { isProblemError, type RunProgress } from "@pipelex/sdk";
import { getPipelexClient } from "@/lib/pipelexClient";
import { toProgressSnapshot } from "@/lib/runProgress";

/*
 * `GET /api/runs/{runId}/progress`: one run's progress snapshot, for the run
 * timeline (`RunProgressPanel`), read on the server with this app's client so
 * the API key never reaches the browser.
 *
 * A Route Handler rather than a Server Action: Next.js runs a client's Server
 * Actions one at a time, so a progress read would queue behind the status poll
 * and the form's own actions, and they behind it. A GET runs beside them.
 *
 * It reads any run of the key's organization by its id, as each method's
 * `poll<Name>Run` action already does, which is why the servers listen on
 * loopback by default. It spends nothing and sends no CORS headers, so another
 * origin cannot read its answer.
 */

/** Never cached: a working run's progress moves from one read to the next. */
export const dynamic = "force-dynamic";

/** What this route answers about a run's progress: the JSON body of a `200`. */
export type RunProgressAnswer =
  /** The snapshot, as `toProgressSnapshot` made it. */
  | { state: "snapshot"; snapshot: ProgressSnapshot }
  /** No progress for this run yet: the platform's index has not caught up with a run just started. */
  | { state: "none" }
  /**
   * Reading again cannot help, by the failure's own problem: the base URL serves
   * no progress route, or refuses this key the read.
   */
  | { state: "unavailable" };

const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: RunProgressAnswer): Response {
  return Response.json(body, { headers: NO_STORE });
}

/**
 * Whether a failure is a refusal that reading again cannot change: one whose
 * problem says a retry fails the same way (`retry: "no"`) and lays it on
 * someone other than the service (any `domain` but `runtime`). A bare runner
 * without the route is `runtime.unsupported`, in the `operator` domain, and a
 * hosted gateway answers a path it does not route with `403 Forbidden`, as it
 * answers a key it refuses, so the route being absent cannot be told from a
 * refusal there; both are final.
 *
 * A `runtime` problem is never final here, whatever its `retry`: it is a fault
 * in one answer, such as a `200` the SDK could not read (a malformed snapshot,
 * truncated JSON, an empty body), and the next read may well be whole.
 */
function isFinalRefusal(caught: unknown): boolean {
  return isProblemError(caught) && caught.retry === "no" && caught.domain !== "runtime";
}

/**
 * Every other failure is an error status with no body: one whose problem says a
 * retry can pass, a fault in one answer, or a failure that carries no problem. The browser
 * keeps the snapshot it holds and reads again. It is not logged, following this
 * app's rule against diagnostic console writes; the status poll is where a
 * failing API shows itself. A read the browser aborted gets the same answer,
 * which nobody reads.
 */
const READ_FAILED = 502;

function readFailed(): Response {
  return new Response(null, { status: READ_FAILED, headers: NO_STORE });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  let progress: RunProgress;
  try {
    // The request's own signal: a browser that stops reading, because the run it
    // follows changed or its page went, cancels the upstream read too.
    progress = await getPipelexClient().getRunProgress(runId, { signal: request.signal });
  } catch (caught) {
    // The browser has gone, so nobody reads this answer. The SDK rethrows its
    // abort untouched; the failure is not classified at all, so whatever the
    // abort threw is never taken for a final refusal.
    if (request.signal.aborted) return readFailed();
    // The platform's `run.not_found` for a run it does not know: an id just started.
    if (isProblemError(caught) && caught.code === "run.not_found") {
      return answer({ state: "none" });
    }
    // No progress route, or a refused key: not worth reading again for this run.
    if (isFinalRefusal(caught)) return answer({ state: "unavailable" });
    return readFailed();
  }
  // Outside the `try`: a fault in the mapping is this app's bug, which Next
  // answers with a 500 and reports, never a read that merely failed.
  return answer({ state: "snapshot", snapshot: toProgressSnapshot(progress) });
}
