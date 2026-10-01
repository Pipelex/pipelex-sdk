import { ApiResponseError, ApiUnreachableError, ArtifactFetchError } from "@pipelex/sdk";
import { assetFilename, buildAssetHeaders, FRAME_AND_REFERRER_GUARD } from "@/lib/assetHeaders";
import { getPipelexClient } from "@/lib/pipelexClient";
import { allowPlainHttpArtifacts } from "@/lib/serverEnv";
import { storageUriFromSegments } from "@/lib/storageAsset";

/**
 * `GET /api/assets/{...storage path}` — stream a stored asset from this app's
 * own origin.
 *
 * The browser addresses an object by its `pipelex-storage://` path, built by
 * `assetPath` (`src/lib/storageAsset.ts`), and this handler turns it back into
 * the reference, hands it to the SDK's `fetchArtifact` — which mints a fresh
 * presigned link through the API key and returns the store's response as a
 * bounded stream: timed out, redirects refused, the byte cap enforced
 * mid-stream, no credential forwarded — and pipes the bytes back under the
 * headers `buildAssetHeaders` owns. The presigned link is never what the
 * browser fetches, and the key never leaves `getPipelexClient()`.
 *
 * Deliberately NOT a redirect to the store: a 3xx would put the presigned link
 * back in the browser, which is the problem the route exists to remove.
 *
 * Deliberately NOT an arbitrary-URL proxy: the only input is a storage path, so
 * the route can never be pointed at a host of the caller's choosing — the
 * classic open-proxy shape of an "image proxy" endpoint.
 *
 * The body is streamed, never buffered: a run's outputs include multi-megabyte
 * PDFs and images.
 *
 * Errors are HTTP errors, because the consumer is an `<img>` or an `<object>`
 * that needs a non-2xx to fall back: a malformed path is `400`, a reference the
 * key cannot see or that names nothing is `404` for both — the route must not
 * be usable to probe for objects — and everything that failed on this side of
 * the store or inside it is `502`. The JSON body names the reason for whoever
 * opens the path by hand.
 */

/**
 * **The authorization seam — this template ships it open, and a real
 * deployment must close it.**
 *
 * This route resolves any well-formed reference with the deployment's single
 * API key, so as it stands anyone who can reach the app can read any object
 * in the organization's storage whose path they hold — another person's run
 * output, another person's uploaded input. That is the right default for a
 * single-tenant demo where the app is the only reader, and the wrong one the
 * moment the app serves more than one person.
 *
 * So put the check here: read the session, decide whether this caller may read
 * this reference, and answer `false` if not — the caller then gets the same
 * `404` as a reference that names nothing, which is what keeps the route from
 * telling anyone what exists. The same question is asked of
 * `resolveShareUrl` in `src/actions/shareUrl.ts`, which hands out a link that
 * works outside the app entirely, and both have to answer it.
 *
 * Refusing to enumerate is not the same as refusing to serve: the `404` on a
 * forbidden reference below hides WHICH objects exist, and this is what
 * decides WHO may read one.
 */
async function mayRead(_request: Request, _uri: string): Promise<boolean> {
  return true;
}

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return serveAsset(request, context, "GET");
}

/**
 * `<object data>` PDF viewers and media elements probe with HEAD before they
 * fetch, and a 405 makes them fall back to their error state.
 */
export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  return serveAsset(request, context, "HEAD");
}

/**
 * This proxy's own bounds on one fetch, because the SDK's defaults are sized
 * for `downloadArtifacts` writing to a disk — 1 GiB, and 120 s covering the
 * connect, the headers AND the body read — and neither fits a browser proxy.
 *
 * The byte cap matters because `mayRead` ships open: until a deployment closes
 * it, this is the only thing bounding what one unauthenticated request can
 * make the server stream. 64 MiB is well above any file a method produces for
 * a browser to paint or preview.
 *
 * The time budget matters because it is spent by the CLIENT's own pull: the
 * response is streamed, so back-pressure from a slow reader counts against the
 * same timer. At 120 s a legitimate large asset on a slow connection is
 * aborted mid-stream, after the response has already advertised the store's
 * full `content-length` — a failed transfer the browser reports as a length
 * mismatch. 300 s for at most 64 MiB is a floor of roughly 1.8 Mbit/s.
 */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const ASSET_TIMEOUT_MS = 300_000;

async function serveAsset(
  request: Request,
  context: RouteContext,
  method: "GET" | "HEAD",
): Promise<Response> {
  const { path } = await context.params;
  const uri = storageUriFromSegments(path);
  if (uri === undefined) {
    return refusal(400, "invalid_asset_path", "The path is not a stored asset's path.");
  }

  if (!(await mayRead(request, uri))) {
    return refusal(404, "asset_not_found", "No stored asset at this path.");
  }

  let upstream: Response;
  try {
    upstream = await getPipelexClient().fetchArtifact(uri, {
      signal: request.signal,
      allowHttp: allowPlainHttpArtifacts(),
      maxBytes: MAX_ASSET_BYTES,
      timeoutMs: ASSET_TIMEOUT_MS,
    });
  } catch (err) {
    return refusalFor(err);
  }

  const headers = buildAssetHeaders(upstream.headers, {
    filename: assetFilename(uri, upstream.headers.get("content-type")),
  });

  if (method === "HEAD") {
    // A stream already errored or locked rejects on cancel, and this is the
    // probe `<object data>` viewers make before every fetch: letting the
    // rejection out would answer a generic 500 instead of these headers.
    try {
      await upstream.body?.cancel();
    } catch {
      // The bytes are not wanted either way.
    }
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * The reference's own refusals — the resolve route's per-reference verdicts
 * (`invalid_storage_uri`, `forbidden`) and a store that has no such object —
 * all answer `404`, so a `403` cannot be told from a `404` from outside.
 * Everything else the fetch boundary reports is this side's failure to reach
 * the bytes, `store_refused` included: that is the store rejecting a signature
 * this route has just minted, which means a clock, a signing key or a bucket
 * policy — an outage to report as one, not an asset to call missing.
 */
const NOT_FOUND_CODES = new Set(["invalid_storage_uri", "forbidden", "not_found"]);

function refusalFor(err: unknown): Response {
  if (err instanceof ArtifactFetchError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return refusal(404, "asset_not_found", "No stored asset at this path.");
    }
    return refusal(
      502,
      "asset_unavailable",
      `The stored asset could not be fetched (${err.code}).`,
    );
  }
  if (err instanceof ApiResponseError) {
    // The resolve route refused the whole request: the key, the route's
    // absence on this deployment, or a malformed request — a server-side
    // configuration problem, never the caller's. A 404 is the one worth
    // naming: `fetchArtifact` mints its link through the platform's bulk
    // resolve route, and a deployment that does not serve it cannot serve
    // this route either, whatever the single-reference route says.
    return refusal(
      502,
      "resolve_failed",
      err.status === 404
        ? "The configured Pipelex API does not serve POST /v1/resolve-storage-url/bulk, which the assets route needs to resolve a stored asset."
        : `The Pipelex API refused to resolve the asset (HTTP ${err.status}).`,
    );
  }
  if (err instanceof ApiUnreachableError) {
    return refusal(502, "api_unreachable", "The Pipelex API could not be reached.");
  }
  return refusal(502, "asset_unavailable", "The stored asset could not be fetched.");
}

function refusal(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // The app's global framing and referrer rules leave this route out, so
        // the route answers for every response it sends — this one included.
        ...FRAME_AND_REFERRER_GUARD,
      },
    },
  );
}
