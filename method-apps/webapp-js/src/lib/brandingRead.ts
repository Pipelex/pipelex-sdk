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
 * **Branding never stops the app.** A read that fails or takes longer than
 * `BRANDING_TIMEOUT_MS` answers `null`, which renders the app unbranded, and
 * the failure is logged once: a deployment whose API serves no branding (a
 * self-hosted runner) would otherwise log the same line on every page view.
 * With no API key configured nothing is read, since the app cannot run a
 * method either and says so where it matters.
 *
 * **One read serves many page views.** The page renders per request, and a
 * branding changes rarely, so an answer is kept `BRANDING_FRESH_MS` and a
 * failure `BRANDING_RETRY_MS`, per server process, and concurrent page views
 * share the read in flight. A read that outlasts its timeout still lands: the
 * page that gave up on it rendered unbranded, and the next one wears it.
 */

/** How long an answer serves before the next page view reads it again. */
export const BRANDING_FRESH_MS = 60_000;

/** How long a failed or timed-out read is kept before the next page view tries again. */
export const BRANDING_RETRY_MS = 15_000;

/** How long a page waits for the read before it renders unbranded. */
export const BRANDING_TIMEOUT_MS = 3_000;

interface Remembered {
  value: OrganizationBranding | null;
  until: number;
}

let remembered: Remembered | null = null;
let pending: Promise<OrganizationBranding | null> | null = null;
let lastReported: string | null = null;

/** The organization's branding as `getBranding` answered it, or `null` when it could not be read. */
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

async function readOnce(): Promise<OrganizationBranding | null> {
  const read = getPipelexClient()
    .getBranding()
    .then(
      (branding) => {
        lastReported = null;
        remember(branding, BRANDING_FRESH_MS);
        return branding;
      },
      (err: unknown) => {
        report(describeFailure(err));
        remember(null, BRANDING_RETRY_MS);
        return null;
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      report(`no answer within ${BRANDING_TIMEOUT_MS / 1000} s`);
      remember(null, BRANDING_RETRY_MS);
      resolve(null);
    }, BRANDING_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function remember(value: OrganizationBranding | null, forMs: number): void {
  remembered = { value, until: Date.now() + forMs };
}

/** Log a failure once, until a read succeeds or the failure changes. */
function report(reason: string): void {
  if (reason === lastReported) return;
  lastReported = reason;
  // eslint-disable-next-line no-console
  console.warn(`[pipelex] branding not read, rendering unbranded: ${reason}`);
}

function describeFailure(err: unknown): string {
  if (err instanceof ApiResponseError) {
    return err.status === 404
      ? "the API answered 404 to GET /v1/branding (a deployment that serves no branding, or a missing organization)"
      : `the API answered HTTP ${err.status} to GET /v1/branding`;
  }
  return err instanceof Error ? err.message : String(err);
}
