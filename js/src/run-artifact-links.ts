/**
 * Result artifacts handed back by reference — `RunResults.artifact_links`.
 *
 * The platform measures a completed run's results before answering, and when inline they would
 * take the body past the API Gateway's limit it hands its largest artifacts back as links: each
 * such artifact's field reads `null` and `artifact_links` maps its name to `{ url, expires_at }`,
 * a GET of its stored file signed for about fifteen minutes. This module reads those files:
 *
 * - {@link parseRunArtifact} — pure: the text of one such file as the result fields it fills, read
 *   exactly (`parseExactJson`), the usage envelope unpacked. No network, no key, so a browser that
 *   fetched the link itself reads the file with it.
 * - {@link fetchRunArtifact} — one link fetched under `fetchArtifact`'s bounds, then parsed.
 * - {@link followArtifactLinks} — a result with every link (or the named ones) followed into its
 *   fields, the followed entries dropped from `artifact_links`. The result readers call it by
 *   default.
 *
 * The file is the one the runner wrote, so the links inside it are as stored, never re-signed: a
 * produced file's `public_url` inside a followed artifact may have expired, and its
 * `pipelex-storage://` reference is what to resolve (`docs/run-results.md`).
 */

import { ArtifactFetchError, responseUnreadableProblem } from "./errors.js";
import { parseExactJson } from "./exact-json.js";
import { readSignedUrl } from "./artifacts.js";
import type { ArtifactCapableClient, FetchArtifactOptions } from "./artifacts.js";
import { RUN_RESULT_ARTIFACTS, assertArtifactSelection } from "./runs.js";
import type {
  RunArtifactLink,
  RunArtifactLinks,
  RunResultArtifact,
  RunResults,
  TokensUsageRecord,
} from "./runs.js";
import { eitherSignal } from "./signals.js";

/** The reason an `ArtifactFetchError` gives for a referenced file that is not the artifact's JSON. */
export const RUN_ARTIFACT_UNREADABLE = "unreadable";

/** `followArtifactLinks`'s options: the bounds of each fetch, and which links to follow. */
export interface FollowArtifactLinksOptions extends FetchArtifactOptions {
  /**
   * Follow only these artifacts' links; the others stay in `artifact_links`, their fields `null`.
   * Omitted, every link is followed.
   */
  artifacts?: readonly RunResultArtifact[];
}

/** The label that stands for an artifact's link in an error: the signed link itself is never written there. */
function linkLabel(artifact: RunResultArtifact): string {
  return `artifact_links.${artifact}`;
}

function unreadable(artifact: RunResultArtifact, detail: string, status: number, cause?: unknown) {
  return new ArtifactFetchError(
    `The ${artifact} artifact handed back by reference could not be read: ${detail}.`,
    linkLabel(artifact),
    RUN_ARTIFACT_UNREADABLE,
    status,
    { cause, problem: responseUnreadableProblem(status) },
  );
}

/**
 * The result fields one artifact's stored file fills, read from the file's text: `{ graph_spec }`,
 * `{ main_stuff }` and so on, and `{ tokens_usages, usage_assembly_error }` for `tokens_usages`,
 * whose file is the envelope holding both. The text is read with `parseExactJson`, as an inline
 * result is, so an integer past `Number.MAX_SAFE_INTEGER` is a `bigint` holding its exact digits.
 * Pure — no network, no key — for a caller that fetched the link itself, such as a browser handed
 * the link by its server.
 *
 * Throws `RequestArgumentError` for a name outside `RUN_RESULT_ARTIFACTS`, and `ArtifactFetchError`
 * with the reason `unreadable` ({@link RUN_ARTIFACT_UNREADABLE}) for a text that is not JSON, or a
 * usage file that is not the envelope object.
 */
export function parseRunArtifact(artifact: RunResultArtifact, text: string): Partial<RunResults> {
  return parseArtifactText(artifact, text, 200);
}

function parseArtifactText(
  artifact: RunResultArtifact,
  text: string,
  status: number,
): Partial<RunResults> {
  assertArtifactSelection([artifact]);
  let value: unknown;
  try {
    value = parseExactJson(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw unreadable(artifact, "it is not JSON", status, error);
    throw error;
  }
  if (artifact !== "tokens_usages") return { [artifact]: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unreadable(artifact, "it is not the usage envelope object", status);
  }
  const envelope = value as Record<string, unknown>;
  return {
    tokens_usages: (envelope["tokens_usages"] ?? null) as TokensUsageRecord[] | null,
    usage_assembly_error: (envelope["usage_assembly_error"] ?? null) as string | null,
  };
}

/**
 * Fetch one artifact the platform handed back by reference and read it as the result fields it
 * fills ({@link parseRunArtifact}). The link is fetched under `fetchArtifact`'s bounds — redirects
 * refused, no credential of ours sent, `maxBytes` (1 GiB by default) enforced before and while the
 * body arrives, `timeoutMs` (120 s by default) over the whole exchange, a plain `http:` link
 * refused unless it is on the client's own origin or `allowHttp` is set — and decoded as UTF-8.
 *
 * A link lasts about fifteen minutes from the read that handed it back; past that the store
 * refuses it, an `ArtifactFetchError`, and reading the results again hands back a fresh one. Every
 * failure is an `ArtifactFetchError` naming the link as `artifact_links.<name>`, never the signed
 * link itself; the caller's abort is thrown as is.
 */
export async function fetchRunArtifact(
  client: Pick<ArtifactCapableClient, "originUrl">,
  artifact: RunResultArtifact,
  link: RunArtifactLink,
  options: FetchArtifactOptions = {},
): Promise<Partial<RunResults>> {
  assertArtifactSelection([artifact]);
  const { bytes, status } = await readSignedUrl(client, linkLabel(artifact), link.url, options);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw unreadable(artifact, "it is not UTF-8 text", status, error);
  }
  return parseArtifactText(artifact, text, status);
}

/**
 * A result with the artifacts it handed back by reference fetched into their fields — every one,
 * or those `options.artifacts` names — and each followed entry dropped from `artifact_links`, the
 * key itself dropped once none is left, so a followed result reads as one answered inline. The
 * links are fetched at once, and the first that fails stops the others and is thrown
 * ({@link fetchRunArtifact}). The result passed in is never changed: a new one is returned, or the
 * same one when it holds no link to follow.
 *
 * The result readers (`getRunResult`, `waitForResult`, `startAndWaitForResult`) call it by
 * default; a caller that read with `followArtifactLinks: false`, to pass the links on rather than
 * pull the files through itself, calls it where the content is wanted after all.
 */
export async function followArtifactLinks(
  client: Pick<ArtifactCapableClient, "originUrl">,
  results: RunResults,
  options: FollowArtifactLinksOptions = {},
): Promise<RunResults> {
  const { artifacts: only, ...fetchOptions } = options;
  if (only !== undefined) assertArtifactSelection(only);
  const links: RunArtifactLinks = results.artifact_links ?? {};
  // A link under a name this version does not know is left in place, never refused.
  const known: readonly string[] = RUN_RESULT_ARTIFACTS;
  const followed = (Object.keys(links) as RunResultArtifact[]).filter(
    (artifact) =>
      known.includes(artifact) &&
      links[artifact] !== undefined &&
      (only === undefined || only.includes(artifact)),
  );
  if (followed.length === 0) return results;
  // The first failure stops the fetches still in flight, as the caller's own abort does.
  const stop = new AbortController();
  const linked = eitherSignal(stop.signal, fetchOptions.signal);
  let filled: Partial<RunResults>[];
  try {
    filled = await Promise.all(
      followed.map((artifact) =>
        fetchRunArtifact(client, artifact, links[artifact]!, {
          ...fetchOptions,
          signal: linked.signal,
        }).catch((error: unknown) => {
          if (!stop.signal.aborted) stop.abort(error);
          throw error;
        }),
      ),
    );
  } catch (error) {
    // The caller's abort is thrown as is, never the fetch that saw it first.
    if (fetchOptions.signal?.aborted === true) throw fetchOptions.signal.reason;
    throw stop.signal.aborted ? stop.signal.reason : error;
  } finally {
    linked.dispose();
  }
  const remaining: RunArtifactLinks = { ...links };
  for (const artifact of followed) delete remaining[artifact];
  const next: RunResults = { ...results };
  for (const fields of filled) Object.assign(next, fields);
  if (Object.keys(remaining).length === 0) delete next.artifact_links;
  else next.artifact_links = remaining;
  return next;
}

/** Whether `results` holds a link for any of `artifacts`. */
export function holdsArtifactLinks(
  results: Pick<RunResults, "artifact_links">,
  artifacts: readonly RunResultArtifact[],
): boolean {
  return artifacts.some((artifact) => results.artifact_links?.[artifact] !== undefined);
}
