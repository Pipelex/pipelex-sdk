import { createHash } from "node:crypto";
import { ApiResponseError, ApiUnreachableError, ArtifactFetchError } from "@pipelex/sdk";
import { isLogoDigest, organizationLogos, type LogoRecord } from "@/lib/branding";
import { readOrganizationBranding } from "@/lib/brandingRead";
import { buildLogoHeaders, matchesEtag } from "@/lib/logoHeaders";
import { getPipelexClient } from "@/lib/pipelexClient";
import { allowPlainHttpArtifacts } from "@/lib/serverEnv";

/**
 * `GET /api/branding/logo/<sha256>` — the organization's logo, from this
 * app's own origin.
 *
 * The page's header names a logo by the SHA-256 the platform recorded for it
 * (`logoPath` in `src/lib/branding.ts`). This handler looks that digest up
 * among the organization's current logos, reads the bytes with the SDK's
 * `fetchArtifact` — which mints a fresh short-lived link through the API key,
 * then fetches it bounded: timed out, redirects refused, the byte cap enforced,
 * no credential forwarded — checks that they hash to the digest, and serves
 * them under `buildLogoHeaders`. The short-lived link never reaches the
 * browser, and the key never leaves `getPipelexClient()`.
 *
 * **It serves the organization's logos and nothing else.** The only input is
 * a digest, matched against the branding the key reads, so the route cannot
 * be pointed at any other stored object, and a digest that names no current
 * logo — a logo replaced since the page was rendered, or one nobody issued —
 * answers `404`. The logos are what every page of the app shows, so the route
 * needs no authorization beyond the page's own.
 *
 * **The digest is the cache key.** The bytes behind a digest never change, so
 * the browser keeps them under it for a year, and this process keeps the
 * current logos' bytes in memory, read once: a page view costs no request to
 * the API for a logo already served. A replaced logo has a new digest, and the
 * old one's bytes are dropped the next time a logo is read.
 *
 * Errors are HTTP errors, because the consumer is an `<img>` whose error the
 * header turns into its next fallback (the square logo, then the name).
 */

interface RouteContext {
  params: Promise<{ sha256: string }>;
}

/**
 * The platform refuses a logo over 1 MiB, so a larger body is not a logo. The
 * time budget covers the link, the headers and the body of at most that.
 */
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TIMEOUT_MS = 15_000;

/**
 * A logo's bytes, over an `ArrayBuffer` of their own, which is what a response
 * body takes; the response copies them, so the bytes held are never shared.
 */
type LogoBytes = Uint8Array<ArrayBuffer>;

/** The current logos' bytes, by digest. */
const held = new Map<string, LogoBytes>();
/** The reads in flight, by digest, so concurrent page views share one. */
const reading = new Map<string, Promise<LogoBytes>>();

/** The bytes read did not hash to the digest the platform recorded. */
class LogoDigestMismatch extends Error {}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { sha256 } = await context.params;
  if (!isLogoDigest(sha256)) {
    return refusal(400, "invalid_logo_path", "The path does not name a logo by its digest.");
  }

  const logos = organizationLogos(await readOrganizationBranding());
  const logo = logos.find((candidate) => candidate.sha256 === sha256);
  if (logo === undefined) {
    return refusal(404, "logo_not_found", "The organization has no logo with this digest.");
  }

  if (matchesEtag(request.headers.get("if-none-match"), sha256)) {
    return new Response(null, { status: 304, headers: buildLogoHeaders(logo) });
  }

  let bytes: LogoBytes;
  try {
    bytes = await logoBytes(logo, new Set(logos.map((current) => current.sha256)));
  } catch (err) {
    return refusalFor(err);
  }
  return new Response(bytes, {
    status: 200,
    headers: buildLogoHeaders(logo, bytes.byteLength),
  });
}

async function logoBytes(logo: LogoRecord, current: Set<string>): Promise<LogoBytes> {
  const kept = held.get(logo.sha256);
  if (kept !== undefined) return kept;
  let read = reading.get(logo.sha256);
  if (read === undefined) {
    read = readLogo(logo)
      .then((bytes) => {
        // Only the current logos are kept: a replaced one is never asked for again.
        for (const digest of held.keys()) if (!current.has(digest)) held.delete(digest);
        held.set(logo.sha256, bytes);
        return bytes;
      })
      .finally(() => reading.delete(logo.sha256));
    reading.set(logo.sha256, read);
  }
  return read;
}

async function readLogo(logo: LogoRecord): Promise<LogoBytes> {
  // No caller's signal: the read is shared, and one page view closing must not cancel it for another.
  const upstream = await getPipelexClient().fetchArtifact(logo.uri, {
    allowHttp: allowPlainHttpArtifacts(),
    maxBytes: MAX_LOGO_BYTES,
    timeoutMs: LOGO_TIMEOUT_MS,
  });
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== logo.sha256) throw new LogoDigestMismatch();
  return bytes;
}

function refusalFor(err: unknown): Response {
  if (err instanceof LogoDigestMismatch) {
    return refusal(
      502,
      "logo_digest_mismatch",
      "The stored logo's bytes do not match the digest the platform recorded for it.",
    );
  }
  if (err instanceof ArtifactFetchError) {
    return refusal(502, "logo_unavailable", `The logo could not be fetched (${err.code}).`);
  }
  if (err instanceof ApiResponseError) {
    return refusal(
      502,
      "resolve_failed",
      `The Pipelex API refused to resolve the logo (HTTP ${err.status}).`,
    );
  }
  if (err instanceof ApiUnreachableError) {
    return refusal(502, "api_unreachable", "The Pipelex API could not be reached.");
  }
  return refusal(502, "logo_unavailable", "The logo could not be fetched.");
}

function refusal(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
