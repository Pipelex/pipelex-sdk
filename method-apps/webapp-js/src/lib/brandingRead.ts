import "server-only";
import { ApiResponseError, type OrganizationBranding } from "@pipelex/sdk";
import { getPipelexClient } from "@/lib/pipelexClient";
import { readClassifyEnv } from "@/lib/serverEnv";

/**
 * The organization's branding, read with the deployment's API key — the
 * server half. `GET /v1/branding` answers the branding of the organization the
 * key belongs to, for any role, so the app wears its team's logo and colours
 * without being told which team that is.
 *
 * **Branding never stops the app.** A read that fails, including one whose
 * client cannot even be built, or that takes longer than `BRANDING_TIMEOUT_MS`
 * answers the last branding a read returned, or `null` when none has yet, which
 * renders the app unbranded. The failure is logged once: a deployment whose
 * API serves no branding (a self-hosted runner) would otherwise log the same
 * line on every page view. With no API key configured nothing is read, since
 * the app cannot run a method either and says so where it matters.
 *
 * **One read serves many page views.** The page renders per request, and a
 * branding changes rarely, so an answer is kept `BRANDING_FRESH_MS` and a
 * failure `BRANDING_RETRY_MS`, per server process, and concurrent page views
 * share the read in flight. A read that outlasts its timeout still lands: the
 * page that gave up on it rendered without it, and the next one wears it. The
 * SDK's read takes no signal, so a read given up on is never cancelled, and
 * only the newest read started may remember what it answers: an older one that
 * settles late never overwrites a newer answer.
 */

/** How long an answer serves before the next page view reads it again. */
export const BRANDING_FRESH_MS = 60_000;

/** How long a failed or timed-out read is kept before the next page view tries again. */
export const BRANDING_RETRY_MS = 15_000;

/** How long a page waits for the read before it renders without it. */
export const BRANDING_TIMEOUT_MS = 3_000;

interface Remembered {
  value: OrganizationBranding | null;
  until: number;
}

let remembered: Remembered | null = null;
/** The last branding a read returned, which a failed read keeps serving. */
let lastRead: OrganizationBranding | null = null;
let pending: Promise<OrganizationBranding | null> | null = null;
/** The number of the newest read started: only that read may remember its answer. */
let newest = 0;
let lastReported: string | null = null;

/**
 * The organization's branding as `getBranding` last answered it, or `null` when
 * no read has succeeded. Never rejects.
 */
export function readOrganizationBranding(): Promise<OrganizationBranding | null> {
  if (!readClassifyEnv().hasApiKey) return Promise.resolve(null);
  if (remembered !== null && Date.now() < remembered.until) {
    return Promise.resolve(remembered.value);
  }
  pending ??= readOnce().finally(() => {
    pending = null;
  });
  return pending;
}

function readOnce(): Promise<OrganizationBranding | null> {
  const generation = ++newest;
  let gaveUp = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve) => {
    timer = setTimeout(() => {
      gaveUp = true;
      if (generation === newest) failed(`no answer within ${BRANDING_TIMEOUT_MS / 1000} s`);
      resolve(lastRead);
    }, BRANDING_TIMEOUT_MS);
    // Building the client is inside the chain: it throws on a misconfigured
    // base URL, and that is a failed read like any other, never a failed page.
    Promise.resolve()
      .then(() => getPipelexClient().getBranding())
      .then(
        (branding) => {
          clearTimeout(timer);
          if (generation === newest) {
            lastRead = branding;
            lastReported = null;
            remember(branding, BRANDING_FRESH_MS);
          }
          resolve(branding);
        },
        (err: unknown) => {
          clearTimeout(timer);
          // A read given up on has had its failure remembered already.
          if (generation === newest && !gaveUp) failed(describeFailure(err));
          resolve(lastRead);
        },
      );
  });
}

/** Keep serving the last branding read, or none, until the failure window ends. */
function failed(reason: string): void {
  report(reason);
  remember(lastRead, BRANDING_RETRY_MS);
}

function remember(value: OrganizationBranding | null, forMs: number): void {
  remembered = { value, until: Date.now() + forMs };
}

/** Log a failure once, until a read succeeds or the failure changes. */
function report(reason: string): void {
  if (reason === lastReported) return;
  lastReported = reason;
  const outcome = lastRead === null ? "rendering unbranded" : "keeping the last branding read";
  // eslint-disable-next-line no-console
  console.warn(`[pipelex] branding not read, ${outcome}: ${reason}`);
}

function describeFailure(err: unknown): string {
  if (err instanceof ApiResponseError) {
    return err.code === "request.not_found"
      ? "the API answered 404 to GET /v1/branding (a deployment that serves no branding)"
      : `the API answered HTTP ${err.status} to GET /v1/branding (${err.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}
