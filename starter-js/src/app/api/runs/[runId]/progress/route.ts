import type { ProgressSnapshot } from "@pipelex/mthds-ui/timeline";
import { ApiResponseError, RunLifecycleUnavailableError, type RunProgress } from "@pipelex/sdk";
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
  /** The base URL serves no progress route: a bare runner, or a hosted API older than the route. */
  | { state: "unavailable" };

const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: RunProgressAnswer): Response {
  return Response.json(body, { headers: NO_STORE });
}

/**
 * Any failure but the two above is an error status with no body: the browser
 * keeps the snapshot it holds and reads again, whatever the failure was. It is
 * not logged, following this app's rule against diagnostic console writes; the
 * status poll is where a failing API shows itself.
 */
const READ_FAILED = 502;

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  let progress: RunProgress;
  try {
    progress = await getPipelexClient().getRunProgress(runId);
  } catch (caught) {
    if (caught instanceof RunLifecycleUnavailableError) return answer({ state: "unavailable" });
    if (caught instanceof ApiResponseError && caught.status === 404) {
      return answer({ state: "none" });
    }
    return new Response(null, { status: READ_FAILED, headers: NO_STORE });
  }
  // Outside the `try`: a fault in the mapping is this app's bug, which Next
  // answers with a 500 and reports, never a read that merely failed.
  return answer({ state: "snapshot", snapshot: toProgressSnapshot(progress) });
}
