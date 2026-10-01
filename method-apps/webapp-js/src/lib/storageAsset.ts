/**
 * `pipelex-storage://` reference ⇄ same-origin asset path.
 *
 * A run's files do not come back as web URLs. The content carries the file's
 * durable `pipelex-storage://` reference in `url`, beside a `public_url` the
 * storage provider signed when the run wrote the file — a presigned link that
 * expires in minutes and IS the credential to the object. Painting it would put
 * that credential in the DOM (history, `Referer`, screenshots, error reporters)
 * and leave a tab open long enough with a broken image. So the browser never
 * sees the store: it sees a path on this app's own origin, which
 * `src/app/api/assets/[...path]/route.ts` resolves through the API key on the
 * server and streams. The reference is the object's identity, which does not
 * rot, so the path can be re-signed on every request.
 *
 * `assetPath` is the form kernel's `resolveUrl` — a pure, synchronous rewrite,
 * exactly the shape the kernel's seam asks for (`ResultEnvProvider` in
 * `@pipelex/mthds-form/react` says why it is not a promise) — and
 * `storageUriFromSegments` is the route handler's inverse. This module is
 * deliberately free of server imports: it is the client-safe half of that
 * contract, so a client component can build the URL with no round trip. The
 * SDK barrel is client-safe too (see the note in `errors.ts`), which is what
 * lets the scheme come from it rather than being restated here.
 */
import { PIPELEX_STORAGE_SCHEME } from "@pipelex/sdk";

/** The route that serves a stored asset from this app's own origin. */
export const ASSET_ROUTE_PREFIX = "/api/assets";

// Sanity bounds. The reference is opaque to this app — nothing here reads
// meaning out of a segment — so these only guard against absurd input reaching
// the API, and against traversal in the segments → reference direction.
const MAX_SEGMENTS = 24;
const MAX_URI_LENGTH = 2048;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** A string that IS a storage reference: the scheme, then at least one character. */
export function isStorageUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(PIPELEX_STORAGE_SCHEME) &&
    value.length > PIPELEX_STORAGE_SCHEME.length
  );
}

/** One path segment that round-trips through a URL path without changing meaning. */
function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  // A control character would ride into an outbound URL — never legitimate.
  return !CONTROL_CHARS_RE.test(segment);
}

function safeSegments(segments: readonly string[]): string[] | undefined {
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return undefined;
  return segments.every(isSafeSegment) ? [...segments] : undefined;
}

/**
 * A reference this app will act on: a storage URI within the same bound the
 * display and path halves apply, so every seam that forwards one to the
 * platform stops at the same size.
 */
export function isShareableStorageUri(value: unknown): value is string {
  return isStorageUri(value) && value.length <= MAX_URI_LENGTH;
}

/**
 * The same-origin path for a stored asset, or `undefined` when `uri` is not a
 * well-formed `pipelex-storage://` reference — an `https:` or `data:` URL, for
 * instance, which the kernel paints as it is. `undefined` is the kernel's
 * contract for "this host cannot resolve it", and it then falls back to the
 * payload's own members; the one thing this must never do is return a path that
 * will 404, because a broken image tile says less than a filename.
 *
 * The object's path, and so its file extension, survives the mapping: the
 * route's `Content-Disposition` names the file by it, and the kernel decides
 * previewability from it when the payload states no `mime_type`.
 */
export function assetPath(uri: string): string | undefined {
  if (!isStorageUri(uri) || uri.length > MAX_URI_LENGTH) return undefined;
  const segments = safeSegments(uri.slice(PIPELEX_STORAGE_SCHEME.length).split("/"));
  if (segments === undefined) return undefined;
  return `${ASSET_ROUTE_PREFIX}/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * `assetPath` in the shape the form kernel's input controls ask for: the file
 * field's `env.resolveUrl`, which previews a file the form holds as a stored
 * reference once it no longer holds the dropped `File` itself. The input seam is
 * asynchronous and answers `null` for "cannot resolve"; the rewrite has no round
 * trip to make, so this only adapts the answer.
 */
export async function resolveStoredFile(uri: string): Promise<string | null> {
  return assetPath(uri) ?? null;
}

/**
 * The inverse, for the route handler: rebuild the reference from the decoded
 * catch-all segments Next hands it. `undefined` for anything that is not a
 * plain, traversal-free path, so the route can refuse before it resolves.
 */
export function storageUriFromSegments(
  segments: readonly string[] | undefined,
): string | undefined {
  const safe = safeSegments(segments ?? []);
  if (safe === undefined) return undefined;
  const uri = `${PIPELEX_STORAGE_SCHEME}${safe.join("/")}`;
  return uri.length > MAX_URI_LENGTH ? undefined : uri;
}
