/**
 * The API-facing pieces the two keyed codegen scripts and the scaffold share.
 *
 * `shared.mts` deliberately touches neither the network nor the SDK client — the
 * offline check has to run in CI with no key — so anything that makes a request
 * lives here instead. What is here is exactly the part the three keyed entry
 * points must agree on: the handshake that decides whether a base URL can
 * resolve a method selector at all, and the one line that explains a failure.
 */
import { ApiResponseError, type PipelexApiClient, type ValidateMethodSelector } from "@pipelex/sdk";

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
 * The one line a selector-resolution failure reads as.
 *
 * A 404 from a selector call means something quite different from a 404 on a
 * route: the route is there and the method is not. The server's own message is
 * the useful half — for a bad address it lists the packages the repository does
 * contain — so it is printed verbatim under a line naming the selector, rather
 * than replaced by a guess about `PIPELEX_BASE_URL`.
 *
 * Returns `null` when the error is not a selector-resolution failure, leaving
 * the caller's general explanation in charge.
 */
export function explainSelectorFailure(
  error: unknown,
  selector: ValidateMethodSelector,
): string | null {
  if (!(error instanceof ApiResponseError) || error.status !== 404) return null;
  const detail = error.serverMessage ?? error.message;
  return [`the API could not resolve ${describeSelector(selector)}.`, `  ${detail}`].join("\n");
}
