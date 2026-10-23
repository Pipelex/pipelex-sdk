import { isDocumentCapable } from "@/lib/assetHeaders";
import type { LogoRecord } from "@/lib/branding";

/**
 * Response headers for `/api/branding/logo/<sha256>` — the organization's
 * logo, served from this app's own origin.
 *
 * The URL carries the logo's SHA-256, and the bytes behind a digest never
 * change, so the browser keeps them for a year without asking again, under
 * the digest as their entity tag: a replaced logo has a new digest, so the
 * page asks for a new URL and nothing stale lingers. The rest is the hygiene
 * `assetHeaders.ts` explains for a run's files, applied to an image:
 *
 *   - the type is the one the platform read from the logo's own bytes, never
 *     the store's, and `nosniff` makes it the only one;
 *   - an SVG gets a sandboxing policy of its own, so opening it directly
 *     cannot run anything with this origin's rights, while inside an `<img>`
 *     it renders as any picture does;
 *   - caching is private, because the bytes are read with the deployment's
 *     key: a shared cache never holds them;
 *   - the bytes are this origin's to embed and nobody else's to hotlink.
 *
 * The app's global framing and referrer rules in `next.config.js` cover this
 * route, so they are not restated here. Pure, so it is tested without a server.
 */

/** A year, the longest a cache is asked to keep anything; the digest makes it safe. */
const CACHE_CONTROL = "private, max-age=31536000, immutable";

/** The policy an SVG logo is served under: no subresource, no script, an opaque origin. */
const SVG_SANDBOX_CSP = "default-src 'none'; sandbox";

/** The logo's entity tag: its digest, which names its bytes exactly. */
export function logoEtag(sha256: string): string {
  return `"${sha256}"`;
}

/** Whether a request's `If-None-Match` names this logo, so a `304` answers it. */
export function matchesEtag(ifNoneMatch: string | null, sha256: string): boolean {
  if (ifNoneMatch === null) return false;
  const etag = logoEtag(sha256);
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === etag);
}

/** The headers of a served logo, or of the `304` that confirms the browser's copy. */
export function buildLogoHeaders(
  logo: Pick<LogoRecord, "sha256" | "contentType">,
  contentLength?: number,
): Headers {
  const headers = new Headers({
    "content-type": logo.contentType,
    "content-disposition": "inline",
    "cache-control": CACHE_CONTROL,
    etag: logoEtag(logo.sha256),
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
  if (isDocumentCapable(logo.contentType)) {
    headers.set("content-security-policy", SVG_SANDBOX_CSP);
  }
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return headers;
}
