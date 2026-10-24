/**
 * The API-facing pieces the two keyed codegen scripts and the scaffold share.
 *
 * `shared.mts` deliberately touches neither the network nor the SDK client — the
 * offline check has to run in CI with no key — so anything that makes a request
 * lives here instead. What is here is exactly the part the three keyed entry
 * points must agree on: the handshake that decides whether a base URL can
 * resolve a method selector at all, and the lines that explain a failure, each
 * read from the problem the SDK raises it with: its code, its detail and its
 * next step, never its message.
 */
import {
  ApiResponseError,
  formatItem,
  isProblemError,
  readProblemBody,
  type PipelexApiClient,
  type ProblemItem,
  type ValidateMethodSelector,
} from "@pipelex/sdk";

import { describeSelector, selectorKind } from "./shared.mts";

/**
 * Refuse a base URL that does not advertise the selector kinds a run needs.
 *
 * `GET /v1/version` is the SDK's documented handshake, and its `extensions`
 * array is what says whether the hosted origin forwards `method_id` and
 * `method_ref`. Asking it once, before anything is fetched or written, is what
 * turns "403 Forbidden" — which on an env-scoped key says nothing at all about
 * forwarding — into a line naming the base URL and the missing capability.
 *
 * Returns `null` when the run may proceed and the refusal text otherwise. Two
 * cases deliberately proceed rather than refuse, because in both of them the
 * handshake has no verdict to give and the real call's own error is the better
 * message: the handshake itself failing (an unreachable or misconfigured API),
 * and a response whose `extensions` is absent or not an array of strings (an
 * origin that does not advertise capabilities at all).
 */
export async function assertSelectorSupport(
  client: Pick<PipelexApiClient, "version">,
  baseUrl: string,
  kinds: ReadonlySet<"method_ref" | "method_id">,
): Promise<string | null> {
  if (kinds.size === 0) return null;

  let extensions: string[];
  try {
    const info = await client.version();
    const advertised: unknown = info.extensions;
    if (!Array.isArray(advertised) || advertised.some((item) => typeof item !== "string")) {
      return null;
    }
    extensions = advertised as string[];
  } catch {
    return null;
  }

  const missing = [...kinds].filter((kind) => !extensions.includes(kind)).sort();
  if (missing.length === 0) return null;

  return [
    `this base URL does not serve method selectors (${missing.join(", ")}).`,
    `  Base URL: ${baseUrl}`,
    `  It advertises: ${extensions.join(", ") || "(nothing)"}`,
    "  A method named by a manifest is resolved server-side, so the API has to",
    "  forward the selector. The hosted Pipelex API serves this — check",
    "  PIPELEX_BASE_URL in .env.local, or drop it to use the default.",
  ].join("\n");
}

/** The selector kinds a set of methods needs the base URL to forward. */
export function selectorKindsOf(
  selectors: readonly ValidateMethodSelector[],
): Set<"method_ref" | "method_id"> {
  return new Set(selectors.map(selectorKind));
}

/**
 * Whether a failure is the base URL not serving the route at all: the API's
 * own `request.not_found`, or the reading the SDK gives a bare `404` from an
 * edge or an older runner that has no such route.
 */
export function isRouteMissing(error: unknown): boolean {
  return error instanceof ApiResponseError && error.code === "request.not_found";
}

/**
 * Whether a refusal is a bare `403`, one that carried no problem document. A
 * gateway answers a path it does not route with exactly that, as it answers a
 * key it refuses, so the answer cannot say which it was: the SDK reads the
 * status as `auth.invalid_credential`, but a base URL that does not serve the
 * route is just as likely.
 */
export function isBareForbidden(error: unknown): error is ApiResponseError {
  return (
    error instanceof ApiResponseError &&
    error.status === 403 &&
    readProblemBody(error.responseBody) === undefined
  );
}

/**
 * The one line a selector-resolution failure reads as.
 *
 * A method the API cannot find, answered with a problem of its own, means
 * something quite different from a route the base URL does not serve: the
 * route is there and the method is not. The problem's detail is the useful
 * half — for a bad address it names what the repository does contain — so it
 * is printed verbatim under a line naming the selector, with its next step,
 * rather than replaced by a guess about `PIPELEX_BASE_URL`.
 *
 * Returns `null` when the error is not a selector-resolution failure — the
 * route missing, or a failure other than a not-found — leaving the caller's
 * general explanation in charge.
 */
export function explainSelectorFailure(
  error: unknown,
  selector: ValidateMethodSelector,
): string | null {
  if (!(error instanceof ApiResponseError) || isRouteMissing(error)) return null;
  if (error.problem.status !== 404) return null;
  return [
    `the API could not resolve ${describeSelector(selector)}.`,
    `  ${error.problem.detail} (${error.code})`,
    ...nextStepLines(error.problem.next_step?.detail),
  ].join("\n");
}

/**
 * A failed request as the scripts print it, read from its problem: the status
 * and the route, the problem's detail and code, then its next step and the
 * request's id on lines of their own. A failure that got no answer (the API
 * unreachable, a refused argument) is its problem's detail and code alone.
 *
 * A bare `403` ({@link isBareForbidden}) names both of its possible causes,
 * the key and the base URL, rather than the SDK's reading of the status alone,
 * which would send the developer to a key that may well be fine.
 */
export function describeRequestFailure(error: unknown, route: string, baseUrl?: string): string {
  if (isBareForbidden(error)) {
    return [
      `HTTP 403 from ${route}, with no problem document: either the API key was refused, or the base URL does not serve this route, which a gateway answers alike.`,
      "  Check PIPELEX_API_KEY in .env.local, and that PIPELEX_BASE_URL" +
        (baseUrl !== undefined ? ` (${baseUrl})` : "") +
        ` points at a Pipelex API that serves ${route}.`,
      ...(error.requestId !== undefined ? [`  Request id: ${error.requestId}`] : []),
    ].join("\n");
  }
  if (error instanceof ApiResponseError) {
    return [
      `HTTP ${error.status} from ${route} — ${error.problem.detail} (${error.code})`,
      ...nextStepLines(error.problem.next_step?.detail),
      ...(error.requestId !== undefined ? [`  Request id: ${error.requestId}`] : []),
    ].join("\n");
  }
  if (isProblemError(error)) {
    return [
      `${route} failed — ${error.problem.detail} (${error.code})`,
      ...nextStepLines(error.problem.next_step?.detail),
    ].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

/** A verdict's problem items as printed lines: each one's code, what is wrong and where. */
export function describeItems(items: readonly ProblemItem[]): string[] {
  return items.map((item) => `    ${formatItem(item)}`);
}

function nextStepLines(detail: string | undefined): string[] {
  return detail ? [`  Next step: ${detail}`] : [];
}
