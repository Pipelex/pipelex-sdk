/**
 * The artifact stack — the download twin of `prepareInputs`, in layers so each
 * operation is usable without the next:
 *
 * - {@link locateArtifacts} — a pure walk of any JSON value for the strings that
 *   ARE `pipelex-storage://` references, each with every path it sits at.
 *   {@link collectArtifacts} is the same walk's bare references. No network, no key.
 * - {@link resolveArtifacts} — the server's bulk resolve route over a whole
 *   list, chunked at the route's bound, one verdict per reference.
 * - {@link fetchArtifact} — a bounded `Response` for one reference: resolved
 *   fresh, timed out, redirects refused, the byte cap enforced mid-stream, no
 *   credentials forwarded, headers untouched.
 * - {@link downloadArtifacts} — Node-only: a run's produced files saved under a
 *   directory by a bounded pool of workers, as a produced verdict.
 *
 * A produced file is never embedded in a run's results: the content carries its
 * durable `pipelex-storage://` reference beside a signed `public_url` that expires
 * on the provider's schedule. Nothing here reads that embedded link — every link
 * is minted fresh by the server's bulk resolve route (the hosted platform's presigned
 * link, or a self-hosted runner's own signed link), and re-minted when it has expired
 * by the time a worker reaches it. See `docs/artifact-download.md`.
 *
 * `node:fs/promises`, `node:path` and `undici` come from the Node host
 * (`node-host.ts`), which a bundler building for the browser resolves to a module
 * holding none of them, so the module's graph, static and dynamic, stays free of
 * Node builtins: the walk and `resolveArtifacts` run anywhere, `fetchArtifact`
 * runs anywhere the global `fetch` does (the dispatcher is a Node refinement), and
 * only `downloadArtifacts` touches a filesystem.
 */

import type { Dispatcher } from "undici";
import {
  ApiResponseError,
  ArtifactAuthenticationError,
  ArtifactFetchError,
  ArtifactOperationError,
  RunFailedError,
  RunStillRunningError,
  ScopeUnavailableError,
  StoredTextLoadError,
} from "./errors.js";
import { argumentInvalidProblem, responseUnreadableProblem } from "./errors.js";
import { ProblemError, buildProblem } from "mthds/protocol";
import type { Problem } from "mthds/protocol";
import type { GetRunResultOptions, RunResultArtifact, RunResults, RunResultState } from "./runs.js";
import { absenceCause, loadNodeHost } from "./node-host.js";
import { MAX_TIMER_DELAY_MS, isTimerDelay } from "./timers.js";
import { eitherSignal } from "./signals.js";
import type { InputFormItem } from "mthds/protocol";
import {
  STORED_TEXT_REFERENCE_FIELDS,
  STORED_TEXT_VALUE_FIELD,
  childNode,
  describesConcept,
  mainStuffConceptRef,
  mainStuffNode,
  storedTextKindOfNode,
  workingMemoryNode,
} from "./stored-texts.js";
import type { ConceptSource, StoredTextKind } from "./stored-texts.js";
import { parseExactJson } from "./exact-json.js";

// ── Constants ────────────────────────────────────────────────────────

/** The scheme of a durable storage reference. */
export const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";

/**
 * How many references one bulk resolve request takes — the route's bound, fixed
 * by the route's contract, the same on the platform and a self-hosted runner,
 * rather than configured per deployment. A longer list
 * is a `422`, so {@link resolveArtifacts} chunks at this size.
 */
export const BULK_RESOLVE_MAX_URIS = 100;

/**
 * The per-file byte cap. An accident guard against filling a disk from a
 * runaway output, not a judgment about artifact size: a produced file is
 * server-side, so a caller cannot shrink it the way they can shrink an upload.
 */
export const DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

/** The per-file budget for connecting, receiving the headers and reading the body. */
export const DEFAULT_ARTIFACT_TIMEOUT_MS = 120_000;

/** The cap on the bytes one `downloadArtifacts` call writes in total. */
export const DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** How many artifacts one `downloadArtifacts` call has in flight at once. */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

/**
 * A link this close to its `expires_at` is re-resolved rather than fetched: the
 * store checks the signature when the request arrives, and a few seconds of
 * clock skew between the server that signed it and this process must not turn a
 * link the server still considers live into a `403`.
 */
const EXPIRY_MARGIN_MS = 10_000;

/** Longest filename `downloadArtifacts` writes, extension included. */
const MAX_FILENAME_LENGTH = 128;

/**
 * Longest extension taken from a storage key, dot excluded. Anything longer after
 * the key's last dot is read as part of a name rather than as an extension, and
 * the content type's extension is used instead.
 */
const MAX_EXTENSION_LENGTH = 10;

/**
 * Stems Windows reserves for a device, in any case and whatever the extension:
 * `aux.png` there names the auxiliary device, not a file. A stem is a field name
 * the method author chose, so `$.aux.url` would otherwise reach one.
 */
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Ceiling on collision suffixes before the never-overwrite rule gives up. */
const MAX_UNIQUE_ATTEMPTS = 10_000;

/**
 * The extension a saved file takes when its storage key carries none and the
 * resolved content type is one of the artifact types a run produces. Deliberately
 * short: an unknown type simply gets no extension, never a guessed one.
 */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
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

/**
 * The extension a saved stored text takes from the MIME type its reference states, the text types
 * the runtime stores as. A stored text is named by its MIME type, never by its storage key.
 */
const TEXT_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "application/json": ".json",
};

/** The extension a saved stored text takes when its reference states no MIME type the SDK names. */
const TEXT_EXTENSION_BY_KIND: Record<StoredTextKind, string> = {
  text: ".txt",
  html: ".html",
  json: ".json",
};

// ── Types ────────────────────────────────────────────────────────────

/**
 * Why one reference failed — a value, never a thrown error. `code` is the
 * resolve route's own per-reference code (`pipelex.storage.uri_invalid`, `pipelex.org.mismatch`,
 * and a self-hosted runner's `auth.forbidden` whose `requirement` is `read_scope_under_caller` for
 * a reference outside the caller's scope) or one of the fetch boundary's (see `ArtifactFetchError`),
 * plus the download's own `resolve_failed`, `total_limit_exceeded`, `write_failed` and `aborted`.
 * `detail` is the sentence a person reads, and `params` the parameters the route's code declares,
 * when the route sent them.
 */
export interface ArtifactItemError {
  code: string;
  detail: string;
  params?: Record<string, unknown> | null;
}

/** The `requirement` a resolve route's refusal names in its `params`, when it names one. */
function refusalRequirement(error: ArtifactItemError): string | undefined {
  const requirement = error.params?.requirement;
  return typeof requirement === "string" ? requirement : undefined;
}

/**
 * One reference's resolution — the bulk resolve route's item, verbatim. Either
 * the link fields are set and `error` is null, or `error` is set and the three
 * link fields are null. A consumer branches on `error`, never on an HTTP status:
 * the request was a `200` whenever every reference got a verdict.
 */
export type ResolvedArtifact =
  | {
      /** The reference exactly as sent. */
      uri: string;
      /**
       * A short-lived signed link, fetchable now and until `expires_at`, whose lifetime the server
       * sets: the hosted platform's presigned link lasts about fifteen minutes, and a self-hosted
       * runner's link to its own download route lasts its `STORAGE_LINK_TTL_SECONDS`.
       */
      url: string;
      /** UTC expiry of the link, ISO 8601. */
      expires_at: string;
      /** The server's content-type guess from the reference's extension; null when it has none. */
      content_type: string | null;
      error: null;
    }
  | {
      uri: string;
      url: null;
      expires_at: null;
      content_type: null;
      error: ArtifactItemError;
    };

/** The wire request of `POST /v1/resolve-storage-url/bulk` — at most {@link BULK_RESOLVE_MAX_URIS} references. */
export interface BulkResolveStorageUrlsInput {
  uris: string[];
}

/** The wire response of `POST /v1/resolve-storage-url/bulk` — one item per requested reference, in request order. */
export interface BulkResolvedStorageUrls {
  items: ResolvedArtifact[];
}

/** The bounds `fetchArtifact` applies. Every one has a safe default. */
export interface FetchArtifactOptions {
  /** Refuse (before a byte is written) and cut (mid-stream) a body over this many bytes. Default 1 GiB. */
  maxBytes?: number;
  /**
   * Budget for the whole exchange — connect, headers and body. Default 120 s. At most
   * 2147483647, the longest delay a timer honours.
   */
  timeoutMs?: number;
  /**
   * Accept a plain `http:` link on any origin. Off by default: a general-purpose
   * library does not fetch over plain http silently. A plain `http:` link on the
   * origin of the client's configured base URL, which a self-hosted runner hands
   * out, is accepted without it, since the client already sends its API key
   * there. The local compose stack's object store hands out plain `http:` links
   * on another origin, which is the case this opts into.
   */
  allowHttp?: boolean;
  /** Cancels the fetch; a body being read is cancelled too. */
  signal?: AbortSignal;
}

/** Which of a run's artifacts `downloadArtifacts` walks for references. */
export type ArtifactScope = "main_stuff" | "working_memory";

/** The options shared by both forms of a `downloadArtifacts` request. */
export interface DownloadArtifactsOptions extends FetchArtifactOptions {
  /** The directory to save under, created if missing. Files are never overwritten. */
  dir: string;
  /**
   * `main_stuff` (the default) walks the run's main output. `working_memory` is
   * the opt-in that also brings down the echoed inputs and every intermediate.
   */
  scope?: ArtifactScope;
  /** How many artifacts are in flight at once. Default 4. */
  concurrency?: number;
  /**
   * Cap on the bytes written by the whole call. Default 4 GiB. The item that would
   * cross it is an item error, and the items not yet started are skipped with the
   * same reason.
   */
  maxTotalBytes?: number;
}

/**
 * What `downloadArtifacts` takes: the options plus exactly one of `run_id` (the
 * results are re-read, so this works days after the run) or `results` (a
 * `RunResults` already in hand, read as it is). The type pins the other to
 * `never`, so naming both is a compile error.
 */
export type DownloadArtifactsRequest = DownloadArtifactsOptions &
  ({ run_id: string; results?: never } | { results: RunResults; run_id?: never });

/**
 * Where one `pipelex-storage://` reference sits in a walked value — what
 * {@link locateArtifacts} answers per reference. `found_at` lists every path at
 * which the reference occurs, in walk order, and is never empty: `found_at[0]` is
 * where it was first seen, and the path a saved file is named after.
 *
 * A path is `$`-rooted: `$` is the walked value itself, an object key matching
 * `^[A-Za-z_][A-Za-z0-9_]*$` is `.key`, any other key is `["…"]` in JSON string
 * escaping, and an array index is `[n]` — `$.rooms[3].staged_photo.url`,
 * `$.items[0].url`, `$["a key"].url`. It is the exact path of the string, the
 * final `url` of a content object included.
 */
export interface ArtifactLocation {
  /** The reference, exactly as it appears in the walked value. */
  uri: string;
  /** Every `$`-rooted path at which the reference occurs, in walk order. */
  found_at: string[];
}

/**
 * Where one stored text sits in a walked value — a value the runtime holds by its
 * `pipelex-storage://` reference, `{ url, size, mime_type, preview }`, in place of its value field.
 * `found_at` is the path of the reference's `url`, in the notation of {@link ArtifactLocation}, and
 * the other fields are what the reference states, `null` when it states none.
 */
export interface StoredTextLocation extends ArtifactLocation {
  /** What the text holds once loaded: a text, an HTML fragment or a JSON object. */
  kind: StoredTextKind;
  /** The stored value's length in bytes. */
  size: number | null;
  /** The stored value's MIME type, which names its file when it is saved. */
  mime_type: string | null;
  /** The value's first characters. */
  preview: string | null;
}

/**
 * The storage references of a walked value, told apart by concept: the stored files, which
 * {@link locateArtifacts} answers, and the stored texts.
 */
export interface StoredReferences {
  files: ArtifactLocation[];
  texts: StoredTextLocation[];
}

/** What a reference of a download names: a stored file, or a stored text saved as a text file. */
export type DownloadedKind = "file" | "text";

/**
 * One reference's outcome in a download verdict — one shape with nullable fields,
 * like {@link ResolvedArtifact}: either `path` and `size` are set and `error` is
 * null, or `error` is set and both are null. `found_at` says where the reference
 * sits in the walked scope, and `content_type` is the server's guess from the
 * reference's extension, known before the fetch; both are on both arms, so an
 * item that was not saved still says which field it would have filled.
 */
export type DownloadedArtifact =
  | {
      uri: string;
      /** A stored file, or a stored text saved as a text file. */
      kind: DownloadedKind;
      /** Every `$`-rooted path in the walked scope where the reference sits; the first one named the file. */
      found_at: string[];
      /** Absolute path of the written file. */
      path: string;
      content_type: string | null;
      /** Bytes written. */
      size: number;
      error: null;
    }
  | {
      uri: string;
      /** A stored file, or a stored text that would have been saved as a text file. */
      kind: DownloadedKind;
      /** Every `$`-rooted path in the walked scope where the reference sits. */
      found_at: string[];
      path: null;
      content_type: string | null;
      size: null;
      error: ArtifactItemError;
    };

/**
 * The produced verdict of `downloadArtifacts`. `artifacts.length` is the count
 * of references walked, errors included; an empty list over a present scope is
 * a verdict ("this output references no stored file"), not an error.
 */
export interface DownloadArtifactsResult {
  scope: ArtifactScope;
  /** One entry per reference, in discovery order. */
  artifacts: DownloadedArtifact[];
  /** The absolute paths of the files saved, in the same order. */
  saved_paths: string[];
  /** True when every walked reference was saved — vacuously true for an empty walk. */
  all_saved: boolean;
  /** Present, and true, only when the caller's `signal` aborted the call. */
  aborted?: true;
}

/**
 * The client surface the artifact operations need: the raw bulk resolve call, the
 * single-shot result lookup and the origin the client is configured with. Typed as
 * the client's own members so `PipelexApiClient` satisfies it structurally, and so
 * tests inject a fake.
 */
export interface ArtifactCapableClient {
  /**
   * The origin (`scheme://host[:port]`) of the client's configured base URL. A
   * resolved link on it is fetched over plain http without `allowHttp`, since the
   * client already sends its API key there.
   */
  readonly originUrl: string;
  resolveStorageUrls(
    input: BulkResolveStorageUrlsInput,
    options?: { signal?: AbortSignal },
  ): Promise<BulkResolvedStorageUrls>;
  getRunResult(runId: string, options?: GetRunResultOptions): Promise<RunResultState>;
}

// ── locateArtifacts / collectArtifacts ───────────────────────────────

/** One step of a path into a walked value: an object key, or an array index. */
type PathSegment = string | number;

/**
 * A reference as the walk records it: the raw segments of every path it was
 * found at. `downloadArtifacts` names its files from these segments directly, so
 * it never parses a rendered path back; `found_at` is only their rendering.
 */
interface LocatedReference {
  uri: string;
  paths: PathSegment[][];
  /** Set for a stored text's reference, found only when the walk was asked for texts. */
  text?: { kind: StoredTextKind; reference: Record<string, unknown> };
}

/** An object key rendered as `.key` in a path; any other key is rendered as `["…"]`. */
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every `pipelex-storage://` reference inside a JSON-shaped value, each with
 * every path at which it occurs. The references are deduplicated and kept in
 * discovery order (the order of their first sighting), and each one's `found_at`
 * lists its paths in walk order, so `found_at[0]` is where it was first seen.
 *
 * The string test is {@link collectArtifacts}'s: a string counts only when it IS
 * a reference. A path is rooted at `$`, the walked value itself; an object key
 * matching `^[A-Za-z_][A-Za-z0-9_]*$` is written `.key`, any other key `["…"]` in
 * JSON string escaping, and an array index `[n]`. The runtime serializes a
 * produced image or document as content carrying its reference in `url`, so a
 * typical path ends there: `$.rooms[3].staged_photo.url`, `$.items[0].url`, or
 * `$.url` for an output that is one image. Pure — no network, no key.
 *
 * `node` is the descriptor node of the walked value, the standard's output-form node for a run's
 * output ({@link mainStuffNode} finds it in the run's results). Given, the walk follows the
 * concept at each path and skips a stored text — a `Text`, `Markdown`, `Html` or `JSON` value, or
 * one refining them, which the runtime may hold by a `pipelex-storage://` reference too — since
 * a stored text is a value of the run, never a file. Without it, nothing says what a value is, so
 * every reference counts. A result read with its stored texts loaded, the default, holds none.
 */
export function locateArtifacts(value: unknown, node?: InputFormItem | null): ArtifactLocation[] {
  return walkReferences(value, true, node ?? undefined).map(renderLocation);
}

/**
 * Every `pipelex-storage://` reference inside a JSON-shaped value, deduplicated,
 * in discovery order — the references of {@link locateArtifacts}, without their
 * paths. A string counts only when it IS a reference — the whole string, scheme
 * first, with something after the scheme; text that merely contains one does
 * not. The scheme is unambiguous, so this walk is a contract rather than a
 * heuristic: the runtime serializes a produced image or document as content
 * carrying its reference in `url`, beside an expiring `public_url` this walk
 * ignores. Pure — no network, no key — so a consumer can count or list a run's
 * produced files without resolving any of them. `node` skips the stored texts by concept, as on
 * {@link locateArtifacts}.
 */
export function collectArtifacts(value: unknown, node?: InputFormItem | null): string[] {
  return walkReferences(value, false, node ?? undefined).map((located) => located.uri);
}

/**
 * Every `pipelex-storage://` reference inside a JSON-shaped value, told apart by concept: the
 * stored files, exactly as {@link locateArtifacts} answers them, and the stored texts, each with
 * what its reference states. Each list is deduplicated and in discovery order. A stored text is
 * found where `node` describes a stored-text concept ({@link storedTextKindOfNode}) and the value
 * there is its reference, a `pipelex-storage://` `url` with no value field. Without `node` nothing
 * says what a value is, so every reference is a file: a file count one too high, never a file
 * hidden. For a run's output, `node` is {@link mainStuffNode} of its results. Pure — no network.
 */
export function locateStoredReferences(
  value: unknown,
  node?: InputFormItem | null,
): StoredReferences {
  const files: ArtifactLocation[] = [];
  const texts: StoredTextLocation[] = [];
  for (const located of walkReferences(value, true, node ?? undefined, true)) {
    if (located.text === undefined) files.push(renderLocation(located));
    else texts.push(renderTextLocation(located, located.text));
  }
  return { files, texts };
}

/**
 * The walk both public functions share: depth first, keys in `Object.entries`
 * order. With `withPaths` off it records each reference once and no path at
 * all, which is what `collectArtifacts` needs: copying the trail for every
 * occurrence costs memory in proportion to occurrences times depth, where the
 * deduplicated list needs only one entry per unique reference.
 */
function walkReferences(
  value: unknown,
  withPaths = true,
  described?: InputFormItem,
  includeTexts = false,
): LocatedReference[] {
  // A Map keeps insertion order, which is the order of first sighting.
  const byUri = new Map<string, LocatedReference>();
  const trail: PathSegment[] = [];
  const record = (uri: string, path: PathSegment[], text?: LocatedReference["text"]): void => {
    const known = byUri.get(uri);
    if (!withPaths) {
      if (known === undefined) byUri.set(uri, { uri, paths: [], ...(text ? { text } : {}) });
      return;
    }
    if (known === undefined) byUri.set(uri, { uri, paths: [path], ...(text ? { text } : {}) });
    else known.paths.push(path);
  };
  const visit = (node: unknown, nodeDescriptor: InputFormItem | undefined): void => {
    // A stored text is a value of the run, never a file: its reference is recorded as a text when
    // asked for, and never counts as a file.
    const kind = storedTextKindOfNode(nodeDescriptor);
    if (kind !== null) {
      const url = includeTexts ? storedTextReferenceUrl(node, kind) : null;
      if (url !== null && isStorageReference(url)) {
        record(url, [...trail, "url"], { kind, reference: node as Record<string, unknown> });
      }
      return;
    }
    if (typeof node === "string") {
      if (isStorageReference(node)) record(node, [...trail]);
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        trail.push(index);
        visit(node[index], childNode(nodeDescriptor, node, index));
        trail.pop();
      }
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, entry] of Object.entries(node)) {
        trail.push(key);
        visit(entry, childNode(nodeDescriptor, node, key));
        trail.pop();
      }
    }
  };
  visit(value, described);
  return [...byUri.values()];
}

function renderLocation(located: LocatedReference): ArtifactLocation {
  return { uri: located.uri, found_at: located.paths.map(renderPath) };
}

function renderTextLocation(
  located: LocatedReference,
  text: NonNullable<LocatedReference["text"]>,
): StoredTextLocation {
  const { size, mime_type: mimeType, preview } = text.reference;
  return {
    ...renderLocation(located),
    kind: text.kind,
    size: typeof size === "number" ? size : null,
    mime_type: typeof mimeType === "string" ? mimeType : null,
    preview: typeof preview === "string" ? preview : null,
  };
}

/** Segments to the `$`-rooted notation `found_at` carries. */
function renderPath(segments: readonly PathSegment[]): string {
  let path = "$";
  for (const segment of segments) {
    if (typeof segment === "number") path += `[${segment}]`;
    else if (IDENTIFIER_KEY.test(segment)) path += `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}

/**
 * The `$`-rooted notation back to segments, for a location that reaches
 * {@link artifactFilename} from outside the walk. The rendering is lossless, so
 * this is exact for every path the walk produced; anything else is `undefined`.
 */
function parsePath(path: string): PathSegment[] | undefined {
  if (!path.startsWith("$")) return undefined;
  const segments: PathSegment[] = [];
  let at = 1;
  while (at < path.length) {
    const rest = path.slice(at);
    const key = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (key !== null) {
      segments.push(key[1]!);
      at += key[0].length;
      continue;
    }
    const index = /^\[(\d+)\]/.exec(rest);
    if (index !== null) {
      segments.push(Number(index[1]));
      at += index[0].length;
      continue;
    }
    const quoted = /^\[("(?:[^"\\]|\\.)*")\]/s.exec(rest);
    if (quoted === null) return undefined;
    try {
      segments.push(JSON.parse(quoted[1]!) as string);
    } catch {
      return undefined;
    }
    at += quoted[0].length;
  }
  return segments;
}

/** A string that is a storage reference: the scheme, then at least one character. */
export function isStorageReference(value: string): boolean {
  return value.startsWith(PIPELEX_STORAGE_SCHEME) && value.length > PIPELEX_STORAGE_SCHEME.length;
}

/**
 * A `url` a stored text may be loaded from: a `pipelex-storage://` reference, resolved through the
 * server's bulk route to a link it signs, or a `data:` URL, decoded where it is. A stored text at
 * any other URL is never fetched, so a method cannot have the SDK read a host the caller did not
 * choose: the loader refuses it as `unsupported_url`.
 *
 * The file walks ({@link locateStoredReferences}, `downloadArtifacts`) report the first kind
 * only, since a `data:` URL holds its value inline and has nothing to resolve or save.
 */
export function isLoadableStoredTextUrl(url: string): boolean {
  return isStorageReference(url) || url.startsWith("data:");
}

/**
 * The `url` of a stored text's reference, `value` sitting where the concept is a stored text: an
 * object carrying a string `url` and no value field. `null` for anything else, an inline value
 * included. The one recognition the walk and the loader share, each then applying its own rule to
 * the URL.
 */
function storedTextReferenceUrl(value: unknown, kind: StoredTextKind): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  const url = reference["url"];
  if (typeof url !== "string" || reference[STORED_TEXT_VALUE_FIELD[kind]] != null) return null;
  return url;
}

// ── artifactFilename ─────────────────────────────────────────────────

/**
 * The bare filename a reference is saved under, named after the field it fills:
 * the path in `location.found_at[0]`, where the reference was first seen.
 *
 * 1. A final object key `url` is dropped, since the runtime's image and
 *    document contents carry their reference there; a reference under any other
 *    key keeps that key, and a `url` key that is not final is kept.
 * 2. Each key is reduced to `[A-Za-z0-9_]`, every other character (`-` and `.`
 *    included) becoming `_`; an index stays its decimal digits.
 * 3. The segments are joined with `-`. An empty result — the reference is the
 *    walked value itself, or its `url` — becomes the scope's name.
 * 4. Over the filename length cap (`MAX_FILENAME_LENGTH`, extension included),
 *    the tail is kept: whole leading segments are dropped first, since the last
 *    ones are the specific ones, and a single segment still too long is cut to
 *    fit.
 * 5. A stem Windows reserves for a device (`con`, `prn`, `aux`, `nul`,
 *    `com0`–`com9`, `lpt0`–`lpt9`, in any case) gets a trailing `_`, so
 *    `$.aux.url` is saved as `aux_.png`.
 * 6. The extension is the storage key's own, reduced to `[A-Za-z0-9]`, when it
 *    has a short one; otherwise the content type's, for the types a run
 *    produces; otherwise there is none.
 *
 * So `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`, and
 * `$.url` in `main_stuff` as `main_stuff.png`. The stem is ASCII letters, digits,
 * `_` and the `-` joins, never empty and never a device name, so the name can
 * only ever be a regular file directly inside the target directory. A collision on disk is not this
 * function's concern: `downloadArtifacts` suffixes the stem (`name-1.ext`) on
 * exclusive creation, so a file is never overwritten.
 *
 * Throws `ArtifactOperationError` for a location whose `found_at[0]` is not a path
 * in the notation {@link locateArtifacts} writes, or for an unknown scope.
 */
export function artifactFilename(
  location: ArtifactLocation | StoredTextLocation,
  contentType: string | null | undefined,
  scope: ArtifactScope,
): string {
  requireScope(scope);
  // A JavaScript caller can hand anything here — the old signature's bare uri
  // string among them — and every shape must reach the documented refusal
  // rather than a TypeError, or a string's first character.
  const loose = location as { uri?: unknown; found_at?: unknown } | null | undefined;
  const uri: unknown = loose?.uri;
  if (typeof uri !== "string") {
    throw new ArtifactOperationError(
      `artifactFilename needs a location carrying its reference as a string "uri"; got ${String(uri)}.`,
      { problem: argumentInvalidProblem("location", "not_a_location") },
    );
  }
  const foundAt: unknown = loose?.found_at;
  const first: unknown = Array.isArray(foundAt) ? foundAt[0] : undefined;
  const segments = typeof first === "string" ? parsePath(first) : undefined;
  if (segments === undefined) {
    throw new ArtifactOperationError(
      `artifactFilename needs a location whose first "found_at" entry is a path such as ` +
        `"$.items[0].url"; got ${typeof first === "string" ? JSON.stringify(first) : String(first)}.`,
      { problem: argumentInvalidProblem("location", "not_a_path") },
    );
  }
  const text = location as Partial<StoredTextLocation>;
  const extension =
    typeof text.kind === "string" && text.kind in TEXT_EXTENSION_BY_KIND
      ? textExtensionFor(text.kind, text.mime_type ?? contentType)
      : extensionFor(uri, contentType);
  return filenameFor(segments, extension, scope);
}

/** The naming rule of {@link artifactFilename}, over the walk's own segments. */
function filenameFor(
  segments: readonly PathSegment[],
  extension: string,
  scope: ArtifactScope,
): string {
  const named = segments.at(-1) === "url" ? segments.slice(0, -1) : segments;
  const words = named
    .map((segment) =>
      typeof segment === "number" ? String(segment) : segment.replace(/[^A-Za-z0-9_]/gu, "_"),
    )
    // Only the empty key reduces to nothing, and it says nothing about the field.
    .filter((word) => word !== "");
  const stem = fitStem(words.length > 0 ? words : [scope], MAX_FILENAME_LENGTH - extension.length);
  // A device stem is at most four characters, so the `_` cannot overrun the cap.
  return (WINDOWS_DEVICE_STEM.test(stem) ? `${stem}_` : stem) + extension;
}

/** The words joined with `-` within `budget` characters, keeping the tail. */
function fitStem(words: readonly string[], budget: number): string {
  let start = 0;
  let length = words.reduce((sum, word) => sum + word.length, 0) + words.length - 1;
  while (length > budget && start < words.length - 1) {
    length -= words[start]!.length + 1;
    start += 1;
  }
  const stem = words.slice(start).join("-");
  return stem.length > budget ? stem.slice(0, budget) : stem;
}

/** `.ext` for the saved file — the storage key's own, else the content type's — or `""`. */
function extensionFor(uri: string, contentType: string | null | undefined): string {
  const fromKey = storageKeyExtension(uri);
  if (fromKey !== "") return `.${fromKey}`;
  if (contentType == null) return "";
  return EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0]!.trim().toLowerCase()] ?? "";
}

/** `.ext` for a saved stored text — its MIME type's, else its kind's — never its storage key's. */
function textExtensionFor(kind: StoredTextKind, mimeType: string | null | undefined): string {
  const named =
    mimeType == null
      ? undefined
      : TEXT_EXTENSION_BY_MIME_TYPE[mimeType.split(";")[0]!.trim().toLowerCase()];
  return named ?? TEXT_EXTENSION_BY_KIND[kind];
}

/**
 * The extension the storage key's last segment carries, without its dot, reduced
 * to `[A-Za-z0-9]` — or `""` when it has none, or none that short. The segment is
 * what follows the last `/` or `\` once the scheme, query and fragment are gone,
 * percent-decoded when it decodes; a leading dot is not an extension.
 */
function storageKeyExtension(uri: string): string {
  const key = uri.startsWith(PIPELEX_STORAGE_SCHEME)
    ? uri.slice(PIPELEX_STORAGE_SCHEME.length)
    : uri;
  const segment =
    (key.split(/[?#]/)[0] ?? "")
      .split(/[\\/]/)
      .filter((part) => part !== "")
      .pop() ?? "";

  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape sequence is kept as typed; the reduction handles it.
  }

  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return "";
  const extension = decoded.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "");
  return extension.length <= MAX_EXTENSION_LENGTH ? extension : "";
}

/** `path.extname` for a bare filename, without the `node:path` import: `.ext`, or `""` (a leading dot is not an extension). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function requireScope(scope: unknown): asserts scope is ArtifactScope {
  if (scope !== "main_stuff" && scope !== "working_memory") {
    throw new ArtifactOperationError(
      `"scope" must be "main_stuff" or "working_memory", got ${String(scope)}.`,
      { problem: argumentInvalidProblem("scope", "unknown_value") },
    );
  }
}

// ── resolveArtifacts ─────────────────────────────────────────────────

/**
 * Resolve a list of references through the bulk route, chunked at
 * {@link BULK_RESOLVE_MAX_URIS} per request, and answer one
 * {@link ResolvedArtifact} per reference in request order, duplicates included.
 * Per-reference failure is a value on the item; only what is not about a
 * reference throws — the route's whole-request refusals as `ApiResponseError`
 * (a caller with no organization, a malformed request, a signing failure, or a
 * `404` from a deployment that does not serve the route) and an unreachable
 * host as `ApiUnreachableError`. An empty list resolves to an empty list with
 * no request made.
 */
export async function resolveArtifacts(
  client: Pick<ArtifactCapableClient, "resolveStorageUrls">,
  uris: string[],
  options: { signal?: AbortSignal } = {},
): Promise<ResolvedArtifact[]> {
  const items: ResolvedArtifact[] = [];
  for (let start = 0; start < uris.length; start += BULK_RESOLVE_MAX_URIS) {
    const chunk = uris.slice(start, start + BULK_RESOLVE_MAX_URIS);
    const answer = await client.resolveStorageUrls({ uris: chunk }, { signal: options.signal });
    const resolved = answer?.items;
    if (!Array.isArray(resolved) || resolved.length !== chunk.length) {
      throw new ArtifactOperationError(
        `The bulk resolve route answered ${Array.isArray(resolved) ? resolved.length : "no"} ` +
          `item(s) for ${chunk.length} reference(s) — a malformed answer, so no reference can be ` +
          "matched to its verdict.",
        { problem: responseUnreadableProblem(200) },
      );
    }
    items.push(...resolved);
  }
  return items;
}

// ── fetchArtifact ────────────────────────────────────────────────────

/**
 * A bounded `Response` for one reference: the link is minted fresh through the
 * bulk route, then fetched with `redirect: "manual"` (a signed link has no
 * reason to redirect, and one that does is refused rather than followed), no
 * headers of ours (the link carries its own authorization in the query string,
 * and nothing must ride along to the object store), a budget covering the
 * headers and the body, and a byte cap checked against `Content-Length` before
 * a byte is read and again on every chunk. The status, status text and headers
 * are the store's own, except that a `Content-Encoding` the fetch already decoded
 * is dropped with the encoded `Content-Length`: a proxy relaying this response sets its own
 * `Content-Disposition`, `X-Content-Type-Options`, CSP and caching headers,
 * because this function does not.
 *
 * Only a `2xx` is returned. Anything else is thrown as `ArtifactFetchError`
 * with a `code` (a redirect, a refused or vanished object, a store fault, a
 * declared oversize, a timeout, a network fault, an unusable link, or the
 * route's own per-reference refusal); a body that crosses the cap mid-stream
 * errors the returned stream with the same error type (`too_large`). The
 * caller's abort propagates as-is. Whole-request failures of the resolve step
 * propagate unchanged (`ApiResponseError`, `ApiUnreachableError`).
 */
export async function fetchArtifact(
  client: Pick<ArtifactCapableClient, "resolveStorageUrls" | "originUrl">,
  uri: string,
  options: FetchArtifactOptions = {},
): Promise<Response> {
  const bounds = fetchBounds(options, client.originUrl);
  const [resolved] = await resolveArtifacts(client, [uri], { signal: options.signal });
  if (resolved!.error !== null) {
    throw new ArtifactFetchError(resolved!.error.detail, uri, resolved!.error.code, undefined, {
      requirement: refusalRequirement(resolved!.error),
    });
  }
  const dispatcher = await dispatcherFor(bounds.timeoutMs);
  return fetchResolvedUrl(uri, resolved!.url, bounds, dispatcher, () => {
    void dispatcher?.close().catch(() => undefined);
  });
}

/**
 * The whole body of a link the server has already signed, read under `fetchArtifact`'s bounds:
 * the link checked as a resolved one is, redirects refused, the byte cap enforced against the
 * declared length and mid-stream, the budget covering the whole exchange. `label` stands for the
 * link in every error, since a signed link carries its authorization in its query string and is
 * never written into an error. What `followArtifactLinks` reads a result artifact handed back by
 * reference with.
 */
export async function readSignedUrl(
  client: Pick<ArtifactCapableClient, "originUrl">,
  label: string,
  url: string,
  options: FetchArtifactOptions = {},
): Promise<{ bytes: Uint8Array; status: number }> {
  const bounds = fetchBounds(options, client.originUrl);
  const dispatcher = await dispatcherFor(bounds.timeoutMs);
  const response = await fetchResolvedUrl(label, url, bounds, dispatcher, () => {
    void dispatcher?.close().catch(() => undefined);
  });
  if (response.body === null) return { bytes: new Uint8Array(0), status: response.status };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    total += chunk.value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, status: response.status };
}

/** The bounds every fetch runs under, defaults filled in and validated. */
interface FetchBounds {
  maxBytes: number;
  timeoutMs: number;
  allowHttp: boolean;
  /**
   * The origin of the client's configured base URL, on which a plain-http link is
   * fetched without `allowHttp`; null when that base URL has no comparable origin.
   */
  clientOrigin: string | null;
  signal: AbortSignal | undefined;
}

/**
 * The bounds, defaults filled in and validated. `originUrl` is the client's own
 * origin, the one on which a plain-http link is fetched without `allowHttp`.
 */
function fetchBounds(options: FetchArtifactOptions, originUrl: string): FetchBounds {
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS;
  requirePositive("maxBytes", maxBytes);
  // A longer delay overflows the timer, which then fires at once as a false timeout.
  if (!isTimerDelay(timeoutMs)) {
    throw new ArtifactOperationError(
      `"timeoutMs" must be a positive number no larger than ${MAX_TIMER_DELAY_MS}, got ` +
        `${String(timeoutMs)}.`,
      { problem: argumentInvalidProblem("timeoutMs", "not_positive") },
    );
  }
  return {
    maxBytes,
    timeoutMs,
    allowHttp: options.allowHttp ?? false,
    clientOrigin: originOf(originUrl),
    signal: options.signal,
  };
}

/**
 * The origin of an http(s) URL as compared: the WHATWG serialization, which
 * lowercases the scheme and the host, encodes an internationalized name as IDNA,
 * rewrites an IPv4 or IPv6 address in its canonical form (`127.1` is
 * `127.0.0.1`) and drops a default port, so `http://localhost` and
 * `http://LOCALHOST:80/` are one origin. Null for anything else, which then
 * matches nothing. A name is never resolved: `127.0.0.1` and `localhost` are two
 * origins.
 */
function originOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ArtifactOperationError(`"${name}" must be a positive number, got ${String(value)}.`, {
      problem: argumentInvalidProblem(name, "not_positive"),
    });
  }
}

/**
 * The undici dispatcher a fetch runs on, carrying `headersTimeout` and
 * `bodyTimeout` — the per-stall bounds that the overall `AbortSignal` budget
 * does not give: an abort cancels the request, but a socket stalled mid-body
 * is only reclaimed by the dispatcher's own timers. Null outside Node, or when
 * the Node host or `undici` cannot be loaded, in which case the fetch runs on
 * the platform's default dispatcher with only the budget applied.
 */
async function dispatcherFor(timeoutMs: number): Promise<Dispatcher | null> {
  try {
    const { host } = await loadNodeHost();
    if (host === null) return null;
    const Agent = await host.loadAgent();
    return new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  } catch {
    return null;
  }
}

/**
 * The parsed, boundary-approved URL — the object the fetch then uses verbatim. A
 * plain-http link is fetched when the caller opted in with `allowHttp`, or when its
 * origin is `clientOrigin`, the origin of the client's configured base URL: the
 * client already sends its API key there, so a link to it reveals nothing the
 * client does not already trust that server with. That is how a self-hosted runner
 * listening on plain http hands back what it stores.
 */
function checkUrl(
  uri: string,
  downloadUrl: string,
  allowHttp: boolean,
  clientOrigin: string | null,
): URL {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    throw new ArtifactFetchError(
      "The server resolved the reference to a link that is not a valid absolute URL.",
      uri,
      "unsupported_url",
    );
  }
  if (
    url.protocol === "http:" &&
    !allowHttp &&
    (clientOrigin === null || url.origin !== clientOrigin)
  ) {
    throw new ArtifactFetchError(
      "The server resolved the reference to a plain http link on an origin other than the " +
        "client's own, which is refused by default; pass allowHttp: true to accept it (the local " +
        "stack's object store hands out such links).",
      uri,
      "plain_http_refused",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ArtifactFetchError(
      `The server resolved the reference to a "${url.protocol.replace(":", "")}" link, which is not fetched; ` +
        "only http(s) links are.",
      uri,
      "unsupported_url",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ArtifactFetchError(
      "The server resolved the reference to a link carrying credentials, which is not fetched.",
      uri,
      "unsupported_url",
    );
  }
  return url;
}

/**
 * The bounded fetch of an already-resolved link — the half of `fetchArtifact`
 * that `downloadArtifacts` shares, its links coming from one bulk resolve ahead
 * of the workers. `release` runs exactly once, when the exchange is over: the
 * response refused, the body fully read, errored or cancelled.
 */
async function fetchResolvedUrl(
  uri: string,
  downloadUrl: string,
  bounds: FetchBounds,
  dispatcher: Dispatcher | null,
  release: () => void,
): Promise<Response> {
  let url: URL;
  try {
    url = checkUrl(uri, downloadUrl, bounds.allowHttp, bounds.clientOrigin);
  } catch (err) {
    release();
    throw err;
  }

  const controller = new AbortController();
  const userSignal = bounds.signal;
  let timedOut = false;
  let released = false;
  // Runs exactly once, on every way the exchange can end — including the two
  // aborts, so a returned body nobody ever reads still releases its resources.
  // It closes over `timer`, declared below: nothing can call it before that
  // declaration has run, since both aborts fire asynchronously.
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    userSignal?.removeEventListener("abort", onUserAbort);
    release();
  };
  const onUserAbort = (): void => {
    controller.abort(userSignal?.reason);
    releaseOnce();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The artifact fetch timed out.", "TimeoutError"));
    releaseOnce();
  }, bounds.timeoutMs);
  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else userSignal.addEventListener("abort", onUserAbort, { once: true });
  }
  const failure = (err: unknown): unknown => {
    if (timedOut) {
      return new ArtifactFetchError(
        `Fetching the artifact timed out after ${bounds.timeoutMs}ms.`,
        uri,
        "timeout",
        undefined,
        {
          cause: err,
          problem: buildProblem("client.timeout", { seconds: bounds.timeoutMs / 1000 }),
        },
      );
    }
    // The caller's reason, not `err`: a browser rejects the fetch, and errors a body
    // cut short, with a generic AbortError rather than the signal's reason.
    if (userSignal?.aborted) return userSignal.reason;
    if (err instanceof ArtifactFetchError) return err;
    return new ArtifactFetchError(
      `The artifact could not be fetched: ${err instanceof Error ? err.message : String(err)}.`,
      uri,
      "network",
      undefined,
      { cause: err, problem: buildProblem("client.unreachable", { base_url: url.origin }) },
    );
  };

  if (controller.signal.aborted) {
    // Already aborted before the request: the same outcome `fetch` would give,
    // settled here so it does not depend on the platform's fetch checking first.
    releaseOnce();
    throw failure(controller.signal.reason);
  }

  let response: Response;
  try {
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    };
    if (dispatcher !== null) init.dispatcher = dispatcher;
    response = await fetch(url, init);
  } catch (err) {
    releaseOnce();
    throw failure(err);
  }

  const refusal = statusRefusal(uri, response);
  if (refusal !== undefined) {
    await discard(response);
    releaseOnce();
    throw refusal;
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > bounds.maxBytes) {
    await discard(response);
    releaseOnce();
    throw new ArtifactFetchError(
      `The artifact is ${formatMiB(declared)}, over the ${formatMiB(bounds.maxBytes)} cap.`,
      uri,
      "too_large",
      response.status,
      { problem: downloadLimitProblem(bounds.maxBytes) },
    );
  }

  if (response.body === null) {
    releaseOnce();
    return response;
  }

  const upstream = response.body.getReader();
  // The body reader is cancelled on abort explicitly, on top of the request's
  // own abort, so an abandoned stream never waits on the store's next chunk.
  controller.signal.addEventListener(
    "abort",
    () => {
      void upstream.cancel(controller.signal.reason).catch(() => undefined);
    },
    { once: true },
  );
  let total = 0;
  const bounded = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await upstream.read();
      } catch (err) {
        releaseOnce();
        streamController.error(failure(err));
        return;
      }
      if (chunk.done) {
        releaseOnce();
        // Cancelling the upstream reader on abort resolves a pending read as
        // `done`, not as a rejection — so an end-of-stream that arrives while
        // aborted is the abort, never a clean close that would pass a truncated
        // body off as complete.
        if (controller.signal.aborted) {
          streamController.error(failure(controller.signal.reason));
        } else {
          streamController.close();
        }
        return;
      }
      total += chunk.value.byteLength;
      if (total > bounds.maxBytes) {
        await upstream.cancel().catch(() => undefined);
        releaseOnce();
        streamController.error(
          new ArtifactFetchError(
            `The artifact crossed the ${formatMiB(bounds.maxBytes)} cap mid-stream.`,
            uri,
            "too_large",
            response.status,
            { problem: downloadLimitProblem(bounds.maxBytes) },
          ),
        );
        return;
      }
      streamController.enqueue(chunk.value);
    },
    async cancel(reason) {
      releaseOnce();
      await upstream.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: decodedHeaders(response.headers),
  });
}

/**
 * The codings every runtime's `fetch` decodes. `zstd` is left out: whether it is
 * decoded depends on the runtime (Node 22's zlib has none), and a coding fetch
 * did not decode must keep its header, since the bytes are still encoded.
 */
const FETCH_DECODED_CODINGS = new Set(["gzip", "x-gzip", "deflate", "br"]);

/**
 * The store's headers as they describe the body we hand on. When `fetch` has
 * decoded every coding the `Content-Encoding` lists, the stream is the decoded
 * bytes: the encoding and the encoded length are dropped, or a proxy relaying
 * the response would label plain bytes as compressed and give the wrong length.
 * Any other encoding is passed through with the still-encoded body it describes.
 */
function decodedHeaders(headers: Headers): Headers {
  const codings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
  if (codings.length === 0 || !codings.every((coding) => FETCH_DECODED_CODINGS.has(coding))) {
    return headers;
  }
  const decoded = new Headers(headers);
  decoded.delete("content-encoding");
  decoded.delete("content-length");
  return decoded;
}

/** `client.download_limit_exceeded`, naming the cap in bytes. */
function downloadLimitProblem(maxBytes: number): Problem {
  return buildProblem("client.download_limit_exceeded", { limit: maxBytes });
}

function statusRefusal(uri: string, response: Response): ArtifactFetchError | undefined {
  const status = response.status;
  // A browser hands a manual redirect back as an opaque-redirect response, whose
  // status is 0 and says nothing; Node's fetch hands back the 3xx itself.
  if (response.type === "opaqueredirect") {
    return new ArtifactFetchError(
      "The resolved link redirected; redirects are not followed.",
      uri,
      "redirect_refused",
    );
  }
  if (status >= 300 && status < 400) {
    return new ArtifactFetchError(
      `The resolved link redirected (HTTP ${status}); redirects are not followed.`,
      uri,
      "redirect_refused",
      status,
    );
  }
  // The link is minted per call, so a 401/403 is the store refusing a fresh
  // signature (clock skew, a signing misconfiguration) rather than an expired link.
  if (status === 401 || status === 403) {
    return new ArtifactFetchError(
      `The object store refused the resolved link (HTTP ${status}).`,
      uri,
      "store_refused",
      status,
    );
  }
  if (status === 404 || status === 410) {
    return new ArtifactFetchError(
      `The stored file is no longer available (HTTP ${status}).`,
      uri,
      "not_found",
      status,
    );
  }
  if (status < 200 || status >= 300) {
    return new ArtifactFetchError(
      `The object store answered HTTP ${status} for the resolved link.`,
      uri,
      "store_error",
      status,
    );
  }
  return undefined;
}

/** Release a response we are refusing, so its connection is not left dangling. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarding a body we already refused is best-effort; nothing to report.
  }
}

function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

// ── loadStoredTexts ──────────────────────────────────────────────────

/**
 * The cap on one stored text's bytes: the runtime's own cap on what it reads from storage, so a
 * text the runtime could read is never one the SDK refuses.
 */
export const DEFAULT_STORED_TEXT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The cap on the bytes of all the stored texts of one load together. Every loaded value is held
 * until the load ends, as bytes and then as a string that can take twice as many, so the load
 * itself must be bounded, not only each text: 256 MiB leaves room for two texts at the per-text
 * cap while keeping what one load holds to a few hundred MiB of the process's memory.
 */
export const DEFAULT_STORED_TEXT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** How many stored texts one load reads at once. */
export const DEFAULT_STORED_TEXT_CONCURRENCY = 8;

/**
 * The `StoredTextLoadError` reason of a result that cannot say which of its values are stored
 * texts ({@link lacksStoredTextConcepts}); `waitForResult` keeps polling through it for a while.
 */
export const STORED_TEXT_CONCEPTS_MISSING = "concepts_missing";

/** The bounds `loadStoredTexts` applies. Every one has a safe default. */
export interface LoadStoredTextsOptions {
  /**
   * Refuse a stored text over this many bytes: against the size its reference states before
   * anything is sent, then while reading it. Default 100 MiB.
   */
  maxBytes?: number;
  /**
   * Refuse the load once its stored texts together cross this many bytes: against the sizes their
   * references state before anything is sent, then counted as the bytes arrive, every read in
   * flight then stopped. Default 256 MiB ({@link DEFAULT_STORED_TEXT_MAX_TOTAL_BYTES}).
   */
  maxTotalBytes?: number;
  /** Budget for each text's exchange — connect, headers and body. Default 120 s. */
  timeoutMs?: number;
  /**
   * Accept a plain `http:` link on any origin, as the local stack's object store hands out. Off
   * by default; a plain `http:` link on the origin of the client's configured base URL is
   * accepted without it.
   */
  allowHttp?: boolean;
  /** How many texts are read at once. Default 8. */
  concurrency?: number;
  /** Cancels the load; its reason is thrown as is. */
  signal?: AbortSignal;
}

/** One stored text the walk found: where it sits, what it holds, and its reference. */
interface StoredTextSite {
  segments: PathSegment[];
  kind: StoredTextKind;
  url: string;
  reference: Record<string, unknown>;
}

/**
 * A run's result with every stored text in `main_stuff` loaded: each value the runtime holds by
 * reference, `{ url, size, mime_type, preview }`, replaced by its inline form, `{ text }`,
 * `{ inner_html }` (its `css_class` kept) or `{ json_obj }`, which is the shape the generated
 * types parse. The result readers (`getRunResult`, `waitForResult`, `startAndWaitForResult`) call
 * it by default; a caller holding a result read with `loadStoredTexts: false` calls it later.
 *
 * Which values are stored texts is decided by concept, never by URL or MIME type: the concept at
 * each path comes from the run's working memory and output form ({@link mainStuffNode}), so the
 * results must carry them. A result that cannot say (no working memory naming the main stuff, or
 * a concept of the method's own that no form describes) is returned as it is when nothing in
 * `main_stuff` is shaped like a stored text's reference; when something is, it throws
 * `StoredTextLoadError` with the reason `concepts_missing` rather than hand a reference on where a
 * text is promised ({@link lacksStoredTextConcepts}). The runtime writes `output_form` after
 * `main_stuff`, so a read can land in between: `waitForResult` keeps polling through that window
 * for a few polls before it throws.
 *
 * A `pipelex-storage://` reference is resolved through the server's bulk route, at most
 * {@link BULK_RESOLVE_MAX_URIS} per request, and its signed link fetched under the same bounds as
 * `fetchArtifact`; a link within ten seconds of its `expires_at` when its read is about to start,
 * having waited behind the other reads, is resolved again first. A `data:` URL is decoded, its
 * size bounded from its length before it is. A stored text under any other URL
 * ({@link isLoadableStoredTextUrl}) is refused before anything is sent, since fetching it would
 * read a host the method chose rather than the caller; a result read with
 * `loadStoredTexts: false` keeps it as written. The bytes are UTF-8 by the standard's rule, and a
 * JSON value is the object they serialize.
 *
 * Each text is bounded by `maxBytes` (100 MiB by default) and the load as a whole by
 * `maxTotalBytes` (256 MiB by default), both checked first against the sizes the references state,
 * before anything is sent, then as the bytes arrive; the first text that fails stops every other
 * read in flight.
 *
 * The result passed in is never changed: a new one is returned, or the same one when there is
 * nothing to load. Throws `StoredTextLoadError` naming the text that could not be loaded, where it
 * sits and why, a whole-request failure of the resolve route included (`resolve_failed`, the
 * route's error as its `cause`), the load's total over `maxTotalBytes` as
 * `total_limit_exceeded`, and lets the caller's abort through.
 */
export async function loadStoredTexts(
  client: Pick<ArtifactCapableClient, "resolveStorageUrls" | "originUrl">,
  results: RunResults,
  options: LoadStoredTextsOptions = {},
): Promise<RunResults> {
  if (results.main_stuff == null) return results;
  if (lacksStoredTextConcepts(results)) throw conceptsMissingError(results);
  const node = mainStuffNode(results);
  if (node === null) return results;
  const loaded = await loadStoredTextValues(
    client,
    results.main_stuff,
    node,
    options,
    results.pipeline_run_id,
  );
  return loaded === results.main_stuff ? results : { ...results, main_stuff: loaded };
}

/** The result artifacts the concept at each path is read from. */
export const CONCEPT_ARTIFACTS = ["working_memory", "output_form", "input_form"] as const;

/**
 * The concept facts of a run's results: the results themselves when their read carried the
 * working memory and the forms (`selection` undefined reads every artifact), else those three
 * read again by the run's id, beside the results. Nothing is read when nothing is missing, and a
 * second read that finds no completed run leaves the results as they are.
 */
export async function withConceptArtifacts(
  client: Pick<ArtifactCapableClient, "getRunResult">,
  results: RunResults,
  selection: readonly RunResultArtifact[] | undefined,
  signal?: AbortSignal,
): Promise<ConceptSource & { main_stuff?: unknown }> {
  if (selection === undefined) return results;
  const missing = CONCEPT_ARTIFACTS.filter((artifact) => !selection.includes(artifact));
  if (missing.length === 0) return results;
  const state = await client.getRunResult(results.pipeline_run_id, {
    signal,
    artifacts: missing,
    loadStoredTexts: false,
  });
  if (state.state !== "completed") return results;
  const concepts: ConceptSource = {};
  for (const artifact of missing) {
    (concepts as Record<string, unknown>)[artifact] = state.result[artifact];
  }
  return { ...results, ...concepts };
}

/**
 * Whether a value holds anything shaped like a stored text's reference, which is what makes a read
 * that left the concepts out read them again: an object carrying a string `url`, no inline value
 * field, and a `size` or a `preview`, which the runtime sets on every reference it stores and an
 * image or a document content never carries. So an output of images and documents alone answers
 * `false`. A `true` says only that the concepts are worth reading, the concept at each path still
 * deciding; a `false` says no stored text the runtime made can be there.
 */
export function mayHoldStoredTexts(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mayHoldStoredTexts);
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  if (
    typeof fields["url"] === "string" &&
    Object.values(STORED_TEXT_VALUE_FIELD).every((field) => fields[field] == null) &&
    ("size" in fields || "preview" in fields)
  ) {
    return true;
  }
  return Object.values(fields).some(mayHoldStoredTexts);
}

/**
 * Whether a completed result cannot say which values of its `main_stuff` are stored texts while
 * something there is shaped like one's reference ({@link mayHoldStoredTexts}): the working memory
 * names no main stuff, or its concept is the method's own and no `output_form` / `input_form` node
 * describes it, so a text in one of its fields could not be told from any other value. A native
 * concept needs no form: the walk knows its shape. The runtime writes `output_form` after
 * `main_stuff`, so a read can land in between; {@link loadStoredTexts} then throws
 * `StoredTextLoadError` (`concepts_missing`) rather than hand a reference on.
 */
export function lacksStoredTextConcepts(
  results: ConceptSource & { main_stuff?: unknown },
): boolean {
  if (results.main_stuff == null || !mayHoldStoredTexts(results.main_stuff)) return false;
  const conceptRef = mainStuffConceptRef(results);
  if (conceptRef === null) return true;
  return !describesConcept(conceptRef, results);
}

/** The `concepts_missing` failure, naming the first value shaped like a stored text's reference. */
function conceptsMissingError(results: RunResults): StoredTextLoadError {
  const shaped = firstReferenceShape(results.main_stuff);
  const path = renderPath(shaped?.segments ?? []);
  return new StoredTextLoadError(
    `The stored text at ${path} could not be loaded: the result does not say which of its values ` +
      "are stored texts (its working_memory or its output_form is missing), so none is handed on " +
      "as its reference; read the result again in a moment, or with loadStoredTexts: false to see " +
      "it as written.",
    { uri: shaped?.url ?? "", path, reason: STORED_TEXT_CONCEPTS_MISSING },
    { problem: responseUnreadableProblem(200, results.pipeline_run_id) },
  );
}

/** The first value {@link mayHoldStoredTexts} answers for, depth first, with where it sits. */
function firstReferenceShape(
  value: unknown,
  segments: PathSegment[] = [],
): { segments: PathSegment[]; url: string } | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = firstReferenceShape(entry, [...segments, index]);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  const url = fields["url"];
  if (
    typeof url === "string" &&
    Object.values(STORED_TEXT_VALUE_FIELD).every((field) => fields[field] == null) &&
    ("size" in fields || "preview" in fields)
  ) {
    return { segments, url };
  }
  for (const [key, entry] of Object.entries(fields)) {
    const found = firstReferenceShape(entry, [...segments, key]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Whether a results read narrowed to `selection` carried every artifact the concept at each path
 * is read from: the working memory and both forms. `undefined`, a read of every artifact, does.
 */
export function carriesConceptArtifacts(
  selection: readonly RunResultArtifact[] | undefined,
): boolean {
  return (
    selection === undefined || CONCEPT_ARTIFACTS.every((artifact) => selection.includes(artifact))
  );
}

/**
 * Takes `bytes` from the load's budget of `maxTotalBytes`, answering whether the load's texts
 * together are still within it.
 */
type TakeBytes = (bytes: number) => boolean;

/** `value` with its stored texts loaded, walked with `node`; `value` itself when it holds none. */
async function loadStoredTextValues(
  client: Pick<ArtifactCapableClient, "resolveStorageUrls" | "originUrl">,
  value: unknown,
  node: InputFormItem,
  options: LoadStoredTextsOptions,
  runId: string | undefined,
): Promise<unknown> {
  const sites = findStoredTexts(value, node);
  if (sites.length === 0) return value;
  const concurrency = options.concurrency ?? DEFAULT_STORED_TEXT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ArtifactOperationError(
      `"concurrency" must be a positive integer, got ${String(concurrency)}.`,
      { problem: argumentInvalidProblem("concurrency", "not_positive") },
    );
  }
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_STORED_TEXT_MAX_TOTAL_BYTES;
  requirePositive("maxTotalBytes", maxTotalBytes);
  const maxBytes = options.maxBytes ?? DEFAULT_STORED_TEXT_MAX_BYTES;
  requirePositive("maxBytes", maxBytes);

  // One read per distinct URL, named by the first place it was found.
  const firstSite = new Map<string, StoredTextSite>();
  for (const site of sites) if (!firstSite.has(site.url)) firstSite.set(site.url, site);
  const urls = [...firstSite.keys()];

  // Refused before anything is sent: a text whose reference states a size over the cap on one
  // text, and texts whose stated sizes together are over the load's cap.
  let declaredTotal = 0;
  for (const url of urls) {
    const site = firstSite.get(url)!;
    const size = site.reference["size"];
    if (typeof size !== "number" || !(size > 0)) continue;
    if (size > maxBytes) throw overTextCap(site, maxBytes, size);
    declaredTotal += size;
    if (declaredTotal > maxTotalBytes) throw overLoadCap(site, maxTotalBytes);
  }

  // The first failure stops new reads from starting and stops the reads in flight, through one
  // signal linked with the caller's; the load then throws that first failure once every read has
  // settled, or the caller's abort as it is.
  const stop = new AbortController();
  const stopping = eitherSignal(stop.signal, options.signal);
  // Everything after the link is in its disposal scope: a setup that fails, the bulk resolve
  // above all, must not leave a listener on a caller's long-lived signal.
  let dispatcher: Dispatcher | null = null;
  const texts = new Map<string, unknown>();
  let failed = false;
  let firstFailure: unknown;
  try {
    const bounds = fetchBounds(
      {
        maxBytes,
        timeoutMs: options.timeoutMs,
        allowHttp: options.allowHttp,
        signal: stopping.signal,
      },
      client.originUrl,
    );

    const references = urls.filter(isStorageReference);
    const resolved = new Map<string, ResolvedArtifact>();
    const items = await resolveForTexts(client, references, firstSite, options.signal);
    references.forEach((uri, index) => resolved.set(uri, items[index]!));

    // Every byte read counts against the load's budget, whatever the references state.
    let held = 0;
    const take: TakeBytes = (bytes) => {
      held += bytes;
      return held <= maxTotalBytes;
    };

    dispatcher = await dispatcherFor(bounds.timeoutMs);
    const readOne = async (url: string): Promise<void> => {
      const site = firstSite.get(url)!;
      let entry = resolved.get(url);
      // A link resolved before the reads ahead of it is resolved again just before its own read.
      if (entry !== undefined && entry.error === null && isExpired(entry.expires_at)) {
        [entry] = await resolveForTexts(client, [url], firstSite, stopping.signal);
      }
      const bytes = await readStoredBytes(site, entry, bounds, maxTotalBytes, take, dispatcher);
      texts.set(url, decodeStoredValue(site, bytes, runId));
    };
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!failed && next < urls.length) {
        const url = urls[next]!;
        next += 1;
        try {
          await readOne(url);
        } catch (err) {
          if (!failed) {
            failed = true;
            firstFailure = err;
            stop.abort(err);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  } finally {
    stopping.dispose();
    void dispatcher?.close().catch(() => undefined);
  }
  if (failed) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    throw firstFailure;
  }

  let loaded: unknown = structuredClone(value);
  for (const site of sites) {
    loaded = replaceAt(loaded, site.segments, loadedForm(site, texts.get(site.url)));
  }
  return loaded;
}

/**
 * The bulk resolve of stored texts' references, a whole-request failure being the first text's
 * `StoredTextLoadError` (`resolve_failed`); the caller's abort goes through as it is.
 */
async function resolveForTexts(
  client: Pick<ArtifactCapableClient, "resolveStorageUrls">,
  references: string[],
  firstSite: ReadonlyMap<string, StoredTextSite>,
  signal: AbortSignal | undefined,
): Promise<ResolvedArtifact[]> {
  try {
    return await resolveArtifacts(client, references, { signal });
  } catch (err) {
    if (signal?.aborted === true) throw signal.reason;
    // A whole-request failure of the route, a bare runner's 404 among them, is the first text's.
    const site = firstSite.get(references[0]!)!;
    const path = renderPath(site.segments);
    const detail = err instanceof Error ? err.message : String(err);
    throw new StoredTextLoadError(
      `The stored text at ${path} could not be loaded: the bulk resolve route failed: ${detail}`,
      {
        uri: site.url,
        path,
        reason: "resolve_failed",
        status: err instanceof ApiResponseError ? err.status : undefined,
      },
      { cause: err, problem: err instanceof ProblemError ? err.problem : undefined },
    );
  }
}

/** A stored text over the cap on one text; `size` when its reference or its length states it. */
function overTextCap(site: StoredTextSite, maxBytes: number, size?: number): StoredTextLoadError {
  const path = renderPath(site.segments);
  const over = `over the ${formatMiB(maxBytes)} cap.`;
  return new StoredTextLoadError(
    `The stored text at ${path} could not be loaded: it is ` +
      (size === undefined ? over : `${formatMiB(size)}, ${over}`),
    { uri: site.url, path, reason: "too_large" },
    { problem: downloadLimitProblem(maxBytes) },
  );
}

/** A stored text that takes the load's texts together over `maxTotalBytes`. */
function overLoadCap(site: StoredTextSite, maxTotalBytes: number): StoredTextLoadError {
  const path = renderPath(site.segments);
  return new StoredTextLoadError(
    `The stored text at ${path} could not be loaded: with the texts loaded before it, the load ` +
      `is over its ${formatMiB(maxTotalBytes)} total limit (maxTotalBytes).`,
    { uri: site.url, path, reason: "total_limit_exceeded" },
    { problem: downloadLimitProblem(maxTotalBytes) },
  );
}

/**
 * Every stored text's reference in `value`, in walk order, the concept at each path read off
 * `node`. Throws `StoredTextLoadError` (`unsupported_url`) for a stored text whose `url` the
 * loader never reads ({@link isLoadableStoredTextUrl}), before anything is sent.
 */
function findStoredTexts(value: unknown, node: InputFormItem): StoredTextSite[] {
  const sites: StoredTextSite[] = [];
  const trail: PathSegment[] = [];
  const visit = (current: unknown, described: InputFormItem | undefined): void => {
    const kind = storedTextKindOfNode(described);
    if (kind !== null) {
      const url = storedTextReferenceUrl(current, kind);
      if (url === null) return;
      if (!isLoadableStoredTextUrl(url)) {
        const path = renderPath(trail);
        throw new StoredTextLoadError(
          `The stored text at ${path} could not be loaded: its url is neither a pipelex-storage:// ` +
            "reference nor a data: URL, so it is not fetched; read the result with " +
            "loadStoredTexts: false to see it as written.",
          { uri: url, path, reason: "unsupported_url" },
        );
      }
      sites.push({
        segments: [...trail],
        kind,
        url,
        reference: current as Record<string, unknown>,
      });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => {
        trail.push(index);
        visit(entry, childNode(described, current, index));
        trail.pop();
      });
      return;
    }
    if (typeof current === "object" && current !== null) {
      for (const [key, entry] of Object.entries(current)) {
        trail.push(key);
        visit(entry, childNode(described, current, key));
        trail.pop();
      }
    }
  };
  visit(value, node);
  return sites;
}

/**
 * The bytes of one stored text: a reference's signed link fetched, or a `data:` URL decoded.
 * Nothing else is read. Every chunk is taken from the load's budget as it arrives, and the read
 * is cut once the budget is crossed.
 */
async function readStoredBytes(
  site: StoredTextSite,
  resolved: ResolvedArtifact | undefined,
  bounds: FetchBounds,
  maxTotalBytes: number,
  take: TakeBytes,
  dispatcher: Dispatcher | null,
): Promise<Uint8Array> {
  const path = renderPath(site.segments);
  const fail = (
    reason: string,
    detail: string,
    extra?: { cause?: unknown; problem?: Problem; status?: number; requirement?: string },
  ): never => {
    throw new StoredTextLoadError(
      `The stored text at ${path} could not be loaded: ${detail}`,
      { uri: site.url, path, reason, status: extra?.status, requirement: extra?.requirement },
      { cause: extra?.cause, problem: extra?.problem },
    );
  };
  if (site.url.startsWith("data:")) {
    const bytes = decodeDataUrl(site.url, bounds.maxBytes);
    if (bytes === "malformed") return fail("unsupported_url", "its data URL does not decode.");
    if (bytes === "too_large") throw overTextCap(site, bounds.maxBytes);
    if (!take(bytes.byteLength)) throw overLoadCap(site, maxTotalBytes);
    return bytes;
  }
  // Unreachable: the walk admits only a reference or a data: URL, and every reference is resolved first.
  if (resolved === undefined) {
    return fail("unsupported_url", "its url was not resolved by the bulk resolve route.");
  }
  if (resolved.error !== null) {
    return fail(resolved.error.code, resolved.error.detail, {
      requirement: refusalRequirement(resolved.error),
    });
  }
  const link = resolved.url;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchResolvedUrl(site.url, link, bounds, dispatcher, () => undefined);
    if (response.body === null) return new Uint8Array(0);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!take(chunk.value.byteLength)) {
        await reader.cancel().catch(() => undefined);
        throw overLoadCap(site, maxTotalBytes);
      }
      chunks.push(chunk.value);
      total += chunk.value.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (err) {
    if (err instanceof StoredTextLoadError) throw err;
    if (bounds.signal?.aborted === true) throw bounds.signal.reason;
    if (err instanceof ArtifactFetchError) {
      return fail(err.reason, err.message, {
        cause: err,
        problem: err.problem,
        status: err.status,
        requirement: err.requirement,
      });
    }
    return fail("unknown", err instanceof Error ? err.message : String(err), { cause: err });
  }
}

/**
 * The bytes a percent-encoded payload decodes to, counted in one pass that copies nothing: an
 * escape `%XX` is one byte and any other character its UTF-8 length, a surrogate pair four. A `%`
 * not followed by two hex digits makes `decodeURIComponent` refuse the payload anyway. The count
 * stops once it passes `limit`.
 */
function percentDecodedLength(payload: string, limit: number): number {
  let count = 0;
  for (let index = 0; index < payload.length && count <= limit; index += 1) {
    const code = payload.charCodeAt(index);
    if (code === 37) {
      count += 1;
      index += 2;
    } else if (code < 0x80) {
      count += 1;
    } else if (code < 0x800) {
      count += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < payload.length) {
      count += 4;
      index += 1;
    } else {
      count += 3;
    }
  }
  return count;
}

/** The characters of a base64 payload that are not ASCII whitespace, counted in one pass. */
function base64Significant(payload: string): number {
  let count = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    // Tab, line feed, form feed, carriage return and space: what forgiving-base64 drops.
    if (code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 32) count += 1;
  }
  return count;
}

/**
 * A `data:` URL's bytes, base64 or percent-encoded; `"malformed"` when it does not decode, and
 * `"too_large"` when its bytes would be over `maxBytes`, told from the payload's length before
 * anything is decoded.
 *
 * Base64 is read as `atob` reads it (the WHATWG forgiving-base64 decode): ASCII whitespace
 * dropped, at most two `=` of padding when the length is a multiple of four, then a length that is
 * not one past a multiple of four and nothing outside the alphabet. Every test is one linear pass,
 * never a pattern a method's payload could drive into backtracking.
 */
function decodeDataUrl(url: string, maxBytes: number): Uint8Array | "malformed" | "too_large" {
  const comma = url.indexOf(",");
  if (comma < 0) return "malformed";
  const header = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  if (/;base64$/i.test(header)) {
    // Refused from a count that copies nothing before the whitespace is stripped, so a payload
    // over the cap is never copied: at most two of the characters counted are padding.
    if (Math.floor(((base64Significant(payload) - 2) * 3) / 4) > maxBytes) return "too_large";
    let data = payload.replace(/[\t\n\f\r ]+/g, "");
    if (data.length % 4 === 0 && data.endsWith("=")) {
      data = data.slice(0, data.endsWith("==") ? -2 : -1);
    }
    if (data.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(data)) return "malformed";
    if (Math.floor((data.length * 3) / 4) > maxBytes) return "too_large";
    try {
      const binary = atob(data);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      return "malformed";
    }
  }
  // Counted exactly before anything is decoded, so a payload over the cap is never copied.
  if (percentDecodedLength(payload, maxBytes) > maxBytes) return "too_large";
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return "malformed";
  }
  return bytes.byteLength > maxBytes ? "too_large" : bytes;
}

/** The value one stored text holds: its UTF-8 text, or for a JSON value the object that text serializes. */
function decodeStoredValue(
  site: StoredTextSite,
  bytes: Uint8Array,
  runId: string | undefined,
): unknown {
  const path = renderPath(site.segments);
  const unreadable = (reason: string, detail: string, cause?: unknown): never => {
    throw new StoredTextLoadError(
      `The stored text at ${path} could not be loaded: ${detail}`,
      { uri: site.url, path, reason },
      { cause, problem: responseUnreadableProblem(200, runId) },
    );
  };
  let text: string;
  try {
    // The bytes as stored, a byte-order mark included: the value is exactly what was stored.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (err) {
    return unreadable("not_utf8", "its bytes are not UTF-8 text.", err);
  }
  if (site.kind !== "json") return text;
  let parsed: unknown;
  try {
    parsed = parseExactJson(text);
  } catch (err) {
    return unreadable("not_json_object", "its bytes are not JSON.", err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadable("not_json_object", "its JSON is not an object.");
  }
  return parsed;
}

/** The inline form of a loaded stored text: its value field first, its other inline fields kept. */
function loadedForm(site: StoredTextSite, value: unknown): Record<string, unknown> {
  const loaded: Record<string, unknown> = { [STORED_TEXT_VALUE_FIELD[site.kind]]: value };
  const dropped: readonly string[] = STORED_TEXT_REFERENCE_FIELDS;
  for (const [key, entry] of Object.entries(site.reference)) {
    if (!dropped.includes(key)) loaded[key] = entry;
  }
  return loaded;
}

/** `root` with the value at `segments` replaced, in place below the root; the new value itself at `$`. */
function replaceAt(root: unknown, segments: readonly PathSegment[], value: unknown): unknown {
  if (segments.length === 0) return value;
  let parent = root as Record<string | number, unknown>;
  for (const segment of segments.slice(0, -1)) {
    parent = parent[segment] as Record<string | number, unknown>;
  }
  parent[segments.at(-1)!] = value;
  return root;
}

// ── downloadArtifacts ────────────────────────────────────────────────

/** The write side of a streamed download: what {@link writeFully} needs of a `FileHandle`. */
export interface ChunkWriter {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
}

/**
 * Write the whole chunk, looping on short writes. `FileHandle.write()` resolves
 * with the count it managed, which can fall short of the chunk on a filesystem
 * under pressure; taking one call as "written" would report a truncated file
 * as saved.
 */
export async function writeFully(writer: ChunkWriter, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await writer.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new Error(
        `the filesystem accepted no bytes at offset ${offset} of ${chunk.byteLength}`,
      );
    }
    offset += bytesWritten;
  }
}

/** The slice of `node:fs/promises` the download needs, taken from the Node host. */
interface NodeFs {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  open(path: string, flags: string): Promise<NodeFileHandle>;
  unlink(path: string): Promise<void>;
}

interface NodeFileHandle extends ChunkWriter {
  close(): Promise<void>;
}

interface NodePath {
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
}

/**
 * Create `baseName` under `dir` exclusively (`wx`), suffixing the stem
 * (`name-1.ext`, `name-2.ext`, …) until a free name is found. Exclusive creation
 * is what makes "never overwrite" true rather than merely likely: an
 * exists-check followed by a write would race a concurrent worker.
 */
async function openUniqueFile(
  fs: NodeFs,
  path: NodePath,
  dir: string,
  baseName: string,
): Promise<{ handle: NodeFileHandle; path: string }> {
  const ext = extensionOf(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, attempt === 0 ? baseName : `${stem}-${attempt}${ext}`);
    try {
      return { handle: await fs.open(candidate, "wx"), path: candidate };
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free filename for ${baseName} in ${dir}.`);
}

/** A write to the target file failed — tagged so it reports as `write_failed`, not as a transport fault. */
class ArtifactWriteError extends Error {
  readonly inner: unknown;

  constructor(inner: unknown) {
    super(inner instanceof Error ? inner.message : String(inner));
    this.name = "ArtifactWriteError";
    this.inner = inner;
  }
}

/** The download stopped before this item was attempted. */
const SKIPPED_ABORTED = "The download was aborted before this artifact was fetched.";
const SKIPPED_CREDENTIAL =
  "The download stopped on a credential failure before this artifact was fetched.";
const SKIPPED_TOTAL =
  "Skipped: the download's total byte limit was reached by an earlier artifact.";

/** A reference of a download: where it sits, and whether it is a stored file or a stored text. */
type DownloadLocation = ArtifactLocation & { kind: DownloadedKind };

function itemError(
  location: DownloadLocation,
  contentType: string | null,
  code: string,
  detail: string,
  params?: Record<string, unknown> | null,
): DownloadedArtifact {
  return {
    uri: location.uri,
    kind: location.kind,
    found_at: location.found_at,
    path: null,
    content_type: contentType,
    size: null,
    error: params === undefined || params === null ? { code, detail } : { code, detail, params },
  };
}

function isExpired(expiresAt: string): boolean {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at - EXPIRY_MARGIN_MS <= Date.now();
}

function isCredentialRefusal(err: unknown): err is ApiResponseError {
  return err instanceof ApiResponseError && (err.status === 401 || err.status === 403);
}

/**
 * Read a run's results by id, turning a run that has not completed into its typed error. Only the
 * walked scope's artifact is asked for — the scope names are result artifact names — so the
 * platform reads and re-signs nothing the download does not walk.
 */
async function readCompletedResults(
  client: Pick<ArtifactCapableClient, "getRunResult">,
  runId: string,
  scope: ArtifactScope,
  signal: AbortSignal | undefined,
): Promise<RunResults> {
  // Files only: the stored texts are values, which the walk skips by concept rather than loads.
  const state = await client.getRunResult(runId, {
    signal,
    artifacts: [scope],
    loadStoredTexts: false,
  });
  if (state.state === "running") {
    throw new RunStillRunningError(
      `Run ${runId} is still running, so it has no artifacts to download yet` +
        (state.retry_after_seconds != null ? ` — retry in ${state.retry_after_seconds}s.` : "."),
      runId,
      state.retry_after_seconds,
    );
  }
  if (state.state === "failed") {
    throw new RunFailedError(state.message, runId, state.status, { problem: state.problem });
  }
  return state.result;
}

/**
 * Save a run's produced files under `dir` — Node-only, like the path-string arm
 * of `uploadFile`. Takes a `run_id` (the results are re-read, so a run is
 * downloadable days later) or a `RunResults` in hand; walks the requested scope
 * with {@link locateArtifacts}; resolves the whole set through the bulk route
 * ahead of the workers; then a bounded pool of workers each fetch → open with
 * `wx` → write, re-resolving any link that has expired by the time a worker
 * reaches it. The embedded `public_url` is never used. Each file is named after
 * the field it fills, by {@link artifactFilename}'s rule, and never overwritten;
 * a failed or aborted download unlinks its partial file.
 *
 * Returns a produced verdict: one entry per reference, errors as values. It
 * throws only when no verdict can be produced — `RunStillRunningError` or
 * `RunFailedError` for a run that has not completed, `ScopeUnavailableError`
 * when the scope's artifact is null or missing, `ArtifactAuthenticationError`
 * (carrying the verdict so far) when the resolve route refuses the credential,
 * `ArtifactOperationError` outside Node, for an unusable `dir` or for an
 * unknown `scope`, and the
 * transport and lifecycle errors of the reads it makes (`ApiResponseError` for
 * a deployment without the bulk route, `RunLifecycleUnavailableError` for a
 * bare runner asked by id, `ApiUnreachableError`).
 */
export async function downloadArtifacts(
  client: ArtifactCapableClient,
  request: DownloadArtifactsRequest,
): Promise<DownloadArtifactsResult> {
  const loaded = await loadNodeHost();
  if (loaded.host === null) {
    throw new ArtifactOperationError(
      loaded.reason === null
        ? "downloadArtifacts writes to a filesystem and is Node-only. In another runtime, resolve " +
            "with resolveArtifacts or stream with fetchArtifact instead."
        : `downloadArtifacts cannot write to the filesystem: ${loaded.reason}`,
      {
        ...absenceCause(loaded),
        problem: buildProblem("runtime.unsupported", { capability: "writing to the filesystem" }),
      },
    );
  }
  const host = loaded.host;
  const scope = request.scope ?? "main_stuff";
  requireScope(scope);
  const concurrency = request.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY;
  const maxTotalBytes = request.maxTotalBytes ?? DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ArtifactOperationError(
      `"concurrency" must be a positive integer, got ${String(concurrency)}.`,
      { problem: argumentInvalidProblem("concurrency", "not_positive") },
    );
  }
  requirePositive("maxTotalBytes", maxTotalBytes);
  const bounds = fetchBounds(request, client.originUrl);

  const hasRunId = typeof request.run_id === "string" && request.run_id !== "";
  const hasResults = request.results != null;
  if (hasRunId === hasResults) {
    throw new ArtifactOperationError(
      "downloadArtifacts takes exactly one of `run_id` (the results are re-read) or `results` " +
        "(a RunResults in hand).",
      { problem: argumentInvalidProblem("run_id", "not_exactly_one_selector") },
    );
  }
  const results = hasResults
    ? request.results!
    : await readCompletedResults(client, request.run_id!, scope, request.signal);
  const runId = results.pipeline_run_id;

  // `working_memory` is read off the parsed body: the platform relays it whether
  // or not `RunResults` declares the field.
  const walked =
    scope === "main_stuff"
      ? results.main_stuff
      : (results as unknown as Record<string, unknown>)["working_memory"];
  if (walked == null) {
    throw new ScopeUnavailableError(scope, runId);
  }

  // The concept at each path tells a stored text, a value of the run, from a file. A run read by
  // id asked for its scope alone, so its concepts are read beside it when the walk may need them.
  const source: ConceptSource & { main_stuff?: unknown } =
    !hasResults && mayHoldStoredTexts(walked)
      ? await withConceptArtifacts(client, results, [scope], request.signal)
      : results;
  const node =
    scope === "main_stuff"
      ? mainStuffNode({ ...source, main_stuff: walked })
      : workingMemoryNode(source);

  // The walk's own record names the files; `locations` is what the verdict reports. A stored text
  // is saved too, as a text file named by its MIME type.
  const located = walkReferences(walked, true, node ?? undefined, true);
  if (located.length === 0) {
    return { scope, artifacts: [], saved_paths: [], all_saved: true };
  }
  const locations: DownloadLocation[] = located.map((reference) => ({
    ...renderLocation(reference),
    kind: reference.text === undefined ? "file" : "text",
  }));
  const uris = located.map((reference) => reference.uri);
  // A stored text's MIME type is its reference's, the server's guess from the key otherwise.
  const contentTypeOf = (index: number, resolvedType: string | null): string | null => {
    const stated = located[index]!.text?.reference["mime_type"];
    return typeof stated === "string" ? stated : resolvedType;
  };
  const filenameOf = (index: number, contentType: string | null): string => {
    const reference = located[index]!;
    const extension =
      reference.text === undefined
        ? extensionFor(reference.uri, contentType)
        : textExtensionFor(reference.text.kind, contentType);
    return filenameFor(reference.paths[0]!, extension, scope);
  };

  const fs = host.fs as unknown as NodeFs;
  const path: NodePath = host.path;
  const dir = path.resolve(request.dir);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new ArtifactOperationError(
      `The download directory "${dir}" cannot be created or used: ${cause instanceof Error ? cause.message : String(cause)}.`,
      {
        cause,
        problem: buildProblem("client.write_failed", { path: dir, reason: osErrorReason(cause) }),
      },
    );
  }

  // Dense, never sparse: `map` skips the holes of `new Array(n)`, and the verdict
  // must name every reference, reached or not.
  const outcomes: (DownloadedArtifact | undefined)[] = Array.from(
    { length: uris.length },
    () => undefined,
  );
  const verdictSoFar = (): DownloadArtifactsResult => {
    const artifacts = outcomes.map(
      (outcome, index) =>
        outcome ?? itemError(locations[index]!, null, "aborted", SKIPPED_CREDENTIAL),
    );
    return assembleVerdict(scope, artifacts, request.signal?.aborted === true);
  };

  let resolved: ResolvedArtifact[];
  try {
    resolved = await resolveArtifacts(client, uris, { signal: request.signal });
  } catch (err) {
    if (isCredentialRefusal(err)) {
      throw new ArtifactAuthenticationError(
        `The resolve route refused the credential (${err.status}); no artifact was downloaded.`,
        err.status,
        verdictSoFar(),
        { cause: err },
      );
    }
    throw err;
  }

  // One dispatcher for the whole batch, so the workers share connections to the
  // store; closed once every worker has settled.
  const dispatcher = await dispatcherFor(bounds.timeoutMs);
  const signal = request.signal;
  // A call, not a property read: the flag flips across an await, so it must not be narrowed.
  const aborted = (): boolean => signal?.aborted === true;
  const workerBounds: FetchBounds = { ...bounds, signal };
  // A credential refusal on a re-resolve stops the workers taking new items, and
  // nothing else: a fetch already running is on a signed link that does not
  // carry the credential, so it is left to finish and its file is kept.
  let credentialFailure: ApiResponseError | undefined;
  // What the total cap is held against: the bytes of every file saved or being
  // saved, a file in flight counting as the larger of its declared length and
  // what it has written. Reserving the declared length up front is what stops
  // parallel files from each passing the check and then all being cut together;
  // a file that is unlinked gives its share back.
  let committedBytes = 0;
  // The bytes of the files saved so far. The limit is reached for good, and the
  // items not yet started skipped, only when these leave no room: a refusal
  // against another file's reservation is that item's alone, since the file in
  // flight may still fail and give its share back.
  let savedBytes = 0;
  let limitReached = false;
  let next = 0;

  const saveOne = async (
    index: number,
    url: string,
    contentType: string | null,
  ): Promise<DownloadedArtifact> => {
    const location = locations[index]!;
    const uri = location.uri;
    let response: Response;
    try {
      response = await fetchResolvedUrl(uri, url, workerBounds, dispatcher, () => undefined);
    } catch (err) {
      return itemError(location, contentType, ...classifyFailure(err, signal));
    }

    const declaredLength = Number(response.headers.get("content-length"));
    const reserved = Number.isFinite(declaredLength) ? declaredLength : 0;
    if (committedBytes + reserved > maxTotalBytes) {
      if (savedBytes + reserved > maxTotalBytes) limitReached = true;
      await discard(response);
      return itemError(
        location,
        contentType,
        "total_limit_exceeded",
        `Saving this ${formatMiB(reserved)} artifact would take the download past its ` +
          `${formatMiB(maxTotalBytes)} total limit.`,
      );
    }
    committedBytes += reserved;
    let written = 0;
    const share = (): number => Math.max(written, reserved);

    let target: { handle: NodeFileHandle; path: string };
    try {
      const filename = filenameOf(index, contentType);
      target = await openUniqueFile(fs, path, dir, filename);
    } catch (err) {
      committedBytes -= share();
      await discard(response);
      return itemError(
        location,
        contentType,
        "write_failed",
        `The file could not be created: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    const removePartial = async (): Promise<void> => {
      committedBytes -= share();
      await target.handle.close().catch(() => undefined);
      await fs.unlink(target.path).catch(() => undefined);
    };

    if (response.body === null) {
      try {
        await target.handle.close();
      } catch (err) {
        await removePartial();
        return itemError(
          location,
          contentType,
          "write_failed",
          `The file could not be closed: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      committedBytes -= share();
      return {
        uri,
        kind: location.kind,
        found_at: location.found_at,
        path: target.path,
        content_type: contentType,
        size: 0,
        error: null,
      };
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Only the bytes past this file's reservation are new to the total.
        const growth = Math.max(written + value.byteLength, reserved) - share();
        if (committedBytes + growth > maxTotalBytes) {
          if (savedBytes + written + value.byteLength > maxTotalBytes) limitReached = true;
          await reader.cancel().catch(() => undefined);
          await removePartial();
          return itemError(
            location,
            contentType,
            "total_limit_exceeded",
            `This artifact took the download past its ${formatMiB(maxTotalBytes)} total limit.`,
          );
        }
        committedBytes += growth;
        written += value.byteLength;
        try {
          await writeFully(target.handle, value);
        } catch (err) {
          throw new ArtifactWriteError(err);
        }
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      await removePartial();
      if (err instanceof ArtifactWriteError) {
        return itemError(
          location,
          contentType,
          "write_failed",
          `The file could not be written: ${err.message}.`,
        );
      }
      return itemError(location, contentType, ...classifyFailure(err, signal));
    }

    try {
      await target.handle.close();
    } catch (err) {
      await removePartial();
      return itemError(
        location,
        contentType,
        "write_failed",
        `The file could not be closed: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    // A body shorter than it declared gives the unused reservation back.
    committedBytes -= share() - written;
    savedBytes += written;
    return {
      uri,
      kind: location.kind,
      found_at: location.found_at,
      path: target.path,
      content_type: contentType,
      size: written,
      error: null,
    };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= uris.length) return;
      const location = locations[index]!;
      let entry = resolved[index]!;
      if (credentialFailure !== undefined || aborted()) {
        outcomes[index] = itemError(
          location,
          contentTypeOf(index, entry.content_type),
          "aborted",
          credentialFailure ? SKIPPED_CREDENTIAL : SKIPPED_ABORTED,
        );
        continue;
      }
      if (limitReached) {
        outcomes[index] = itemError(
          location,
          contentTypeOf(index, entry.content_type),
          "total_limit_exceeded",
          SKIPPED_TOTAL,
        );
        continue;
      }
      if (entry.error === null && isExpired(entry.expires_at)) {
        try {
          const again = await resolveArtifacts(client, [location.uri], { signal });
          entry = again[0]!;
        } catch (err) {
          if (isCredentialRefusal(err)) {
            credentialFailure = err;
            outcomes[index] = itemError(
              location,
              contentTypeOf(index, entry.content_type),
              "aborted",
              SKIPPED_CREDENTIAL,
            );
            continue;
          }
          if (aborted()) {
            outcomes[index] = itemError(
              location,
              contentTypeOf(index, entry.content_type),
              "aborted",
              SKIPPED_ABORTED,
            );
            continue;
          }
          outcomes[index] = itemError(
            location,
            contentTypeOf(index, entry.content_type),
            "resolve_failed",
            `The expired link could not be re-resolved: ${err instanceof Error ? err.message : String(err)}.`,
          );
          continue;
        }
      }
      if (entry.error !== null) {
        outcomes[index] = itemError(
          location,
          contentTypeOf(index, null),
          entry.error.code,
          entry.error.detail,
          entry.error.params,
        );
        continue;
      }
      outcomes[index] = await saveOne(index, entry.url, contentTypeOf(index, entry.content_type));
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, uris.length) }, worker));
  } finally {
    void dispatcher?.close().catch(() => undefined);
  }

  if (credentialFailure) {
    throw new ArtifactAuthenticationError(
      `The resolve route refused the credential (${credentialFailure.status}) part-way through ` +
        "the download; the verdict so far is on this error.",
      credentialFailure.status,
      verdictSoFar(),
      { cause: credentialFailure },
    );
  }

  return assembleVerdict(
    scope,
    outcomes.map(
      (outcome, index) => outcome ?? itemError(locations[index]!, null, "aborted", SKIPPED_ABORTED),
    ),
    request.signal?.aborted === true,
  );
}

function assembleVerdict(
  scope: ArtifactScope,
  artifacts: DownloadedArtifact[],
  aborted: boolean,
): DownloadArtifactsResult {
  const saved_paths = artifacts.flatMap((artifact) =>
    artifact.error === null ? [artifact.path] : [],
  );
  const verdict: DownloadArtifactsResult = {
    scope,
    artifacts,
    saved_paths,
    all_saved: saved_paths.length === artifacts.length,
  };
  if (aborted) verdict.aborted = true;
  return verdict;
}

/**
 * An item's `[code, detail]` for an error thrown while fetching or reading it: the fetch's own
 * reason for an `ArtifactFetchError`, `aborted` for the caller's abort, and `unknown` for any other
 * error, which is no network failure but a fault the SDK cannot place, such as a defect of its own
 * or of the caller's code, so it is never read as one a retry can pass.
 */
function classifyFailure(err: unknown, signal: AbortSignal | undefined): [string, string] {
  if (err instanceof ArtifactFetchError) return [err.reason, err.message];
  if (signal?.aborted === true)
    return ["aborted", "The download was aborted while this artifact was being fetched."];
  return [
    "unknown",
    `The artifact could not be read: ${err instanceof Error ? err.message : String(err)}.`,
  ];
}

/** Why a directory could not be made, as the operating system's code (`EACCES`), or `unwritable`. */
function osErrorReason(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unwritable";
}
