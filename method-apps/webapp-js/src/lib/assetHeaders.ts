/**
 * Response headers for `/api/assets` — the same-origin stored-asset stream.
 *
 * Serving a run's files from this app's OWN origin is what keeps the presigned
 * link off the page, and it is also the one thing that makes those files
 * dangerous: an SVG or an HTML file fetched from this origin is same-origin, so
 * if a browser ever renders it as a document its scripts run with this origin's
 * cookies and storage. The SDK's `fetchArtifact` is header-neutral on purpose —
 * it hands on the store's headers and says a proxy owns the response hygiene —
 * so three rules live here, and they are why this is a module rather than a
 * few inline `headers.set` calls:
 *
 *   1. `X-Content-Type-Options: nosniff` — the declared type is the only type.
 *      Without it a `.png` full of markup can be sniffed into HTML.
 *   2. Anything that can act as a DOCUMENT (SVG, HTML, XML) gets its own
 *      `Content-Security-Policy: sandbox` response header, which drops it into
 *      an opaque origin: it still renders inside `<img>`, but a direct
 *      navigation to it can no longer touch this origin. Scoped to those types
 *      on purpose — a blanket sandbox would also hit `application/pdf`, and a
 *      sandboxed PDF breaks the browser's built-in viewer the kernel's document
 *      preview relies on.
 *   3. Only the types the kernel previews render inline; everything else is
 *      `Content-Disposition: attachment`, so an unknown blob downloads instead
 *      of being interpreted.
 *
 * Plus private caching: these bytes are authorized by the server's API key, so
 * a shared cache must never hold them, and a browser may keep them briefly.
 *
 * Ported from the webapp's `asset-headers.ts`, minus the range and conditional
 * request relay: `fetchArtifact` forwards no request header to the store, so
 * this route always answers the whole object and advertises nothing else. The
 * store's validators are still handed on — they describe the bytes — but a
 * browser revalidating after `max-age` gets a fresh `200` rather than a `304`,
 * because the conditional header never reaches the store. Relaying it is a
 * change the SDK's fetch seam has to make first.
 *
 * Pure — takes headers, returns headers — so it is tested without a server.
 */

/** Types the kernel's file arms embed directly, beyond `image/*`. */
const INLINE_TYPES = new Set(["application/pdf", "text/plain"]);

/** Types a browser can execute script from when it treats the bytes as a document. */
const DOCUMENT_CAPABLE_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
]);

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** Browser-only cache. Never `public` or `s-maxage`: the bytes are authorized per server, not per link. */
const CACHE_CONTROL = "private, max-age=300, must-revalidate";

/**
 * Framing is same-origin only, and it must be ALLOWED: the kernel's document
 * preview renders a PDF in an `<iframe>`, and that iframe's `src` is now a path
 * on this origin rather than the store's cross-origin link. `frame-ancestors`
 * supersedes `X-Frame-Options` where both are understood, and `next.config.js`
 * deliberately leaves this route out of its global `DENY` for the same reason.
 */
const FRAME_ANCESTORS = "frame-ancestors 'self'";

/** The sandboxing policy a document-capable type is served under. */
const DOCUMENT_SANDBOX_CSP = `default-src 'none'; sandbox; ${FRAME_ANCESTORS}`;

/**
 * The framing and referrer guard EVERY response from this route carries — a
 * refusal as much as a served asset. `next.config.js` leaves `/api/assets/…`
 * out of the app's global `X-Frame-Options`/`Referrer-Policy` rules so that a
 * PDF can be framed same-origin, which makes this route the only thing that
 * answers for its own responses. Shared rather than restated, so the two paths
 * cannot drift: a refusal that skipped them would be the one response in the
 * app carrying no framing policy at all.
 */
export const FRAME_AND_REFERRER_GUARD = {
  "referrer-policy": "no-referrer",
  // For a browser that does not understand `frame-ancestors`.
  "x-frame-options": "SAMEORIGIN",
  "content-security-policy": FRAME_ANCESTORS,
} as const;

/**
 * Upstream headers worth keeping: they describe the bytes handed on.
 *
 * `content-encoding` rides with `content-length` and is not optional: the SDK
 * strips both when `fetch` decoded the body, and keeps both when it did not,
 * so a coding left on the response means the bytes really are still encoded.
 * Copying the length without the coding would label compressed bytes as plain
 * and hand the browser a corrupt file.
 */
const PASSTHROUGH_HEADERS = [
  "content-length",
  "content-encoding",
  "etag",
  "last-modified",
] as const;

/** Strip parameters (`; charset=…`) for type matching, keep them on the wire. */
function baseType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

export function isInlineRenderable(contentType: string): boolean {
  const type = baseType(contentType);
  return type.startsWith("image/") || INLINE_TYPES.has(type);
}

export function isDocumentCapable(contentType: string): boolean {
  return DOCUMENT_CAPABLE_TYPES.has(baseType(contentType));
}

/** The longest filename offered, extension included — the SDK's cap on a saved artifact's name. */
const MAX_FILENAME_LENGTH = 128;

/** An extension longer than this, dot included, is not kept when a name is cut. */
const MAX_EXTENSION_LENGTH = 11;

/**
 * The extension offered for a key that carries none, for the types a run
 * produces — the SDK's own table. Short on purpose: an unknown type gets no
 * extension rather than a guessed one.
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
};

/** `.ext` for a bare filename, or `""` — a leading dot is not an extension. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * The filename offered for one asset: the last segment of its storage key.
 *
 * Not the SDK's `artifactFilename`, which names a file after the field it fills
 * and so needs the location `locateArtifacts` finds in a result. This route
 * serves one object by its reference and never knows which field of which
 * result that object fills, and the kernel's download control already names
 * what it saves after the field. What is named here is the file a browser
 * offers when the asset is opened on its own, and the object's own key is the
 * honest name for that.
 *
 * Reduced to `[A-Za-z0-9._-]` with no leading or trailing `.`, `_` or `-`, so
 * it is never hidden and never `..`; `asset` when nothing survives; given the
 * content type's extension when the key carries none; and cut to the length
 * cap with a short extension kept.
 */
export function assetFilename(uri: string, contentType: string | null): string {
  const segment = uri.slice(uri.lastIndexOf("/") + 1);
  let name = segment.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "asset";
  if (extensionOf(name) === "" && contentType) {
    name += EXTENSION_BY_TYPE[baseType(contentType)] ?? "";
  }
  if (name.length > MAX_FILENAME_LENGTH) {
    const extension = extensionOf(name);
    const kept = extension.length <= MAX_EXTENSION_LENGTH ? extension : "";
    name = name.slice(0, MAX_FILENAME_LENGTH - kept.length) + kept;
  }
  return name;
}

/**
 * `Content-Disposition` for one asset. The filename is `assetFilename`'s,
 * already reduced to `[A-Za-z0-9._-]`, so it can be quoted as it is; the guard
 * is against a caller handing something else.
 */
export function contentDisposition(contentType: string, filename?: string): string {
  const mode = isInlineRenderable(contentType) ? "inline" : "attachment";
  if (!filename) return mode;
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${ascii}"`;
}

export interface AssetHeaderOptions {
  /** The name offered to the browser on download. */
  filename?: string;
}

/**
 * Build the headers for one proxied asset response from the upstream store's
 * response headers, as `fetchArtifact` hands them on.
 */
export function buildAssetHeaders(
  upstream: Headers,
  { filename }: AssetHeaderOptions = {},
): Headers {
  const contentType = upstream.get("content-type") || FALLBACK_CONTENT_TYPE;

  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": contentDisposition(contentType, filename),
    "cache-control": CACHE_CONTROL,
    "x-content-type-options": "nosniff",
    ...FRAME_AND_REFERRER_GUARD,
    // The bytes are this origin's to embed and nobody else's to hotlink.
    "cross-origin-resource-policy": "same-origin",
  });

  headers.set(
    "content-security-policy",
    isDocumentCapable(contentType) ? DOCUMENT_SANDBOX_CSP : FRAME_ANCESTORS,
  );

  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
}
