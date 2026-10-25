/**
 * The `.mthds` post-edit hook's networked stage: the edited file's method tree validated through
 * the SDK (`POST /v1/validate`, `allow_signatures: true`), held to one deadline over the whole
 * stage, so the hook never outlasts its harness's patience whatever the network does.
 */

import type { ProblemItem, ProblemLocation, SuggestedFix } from "mthds/protocol";
import type { PipelexApiClient } from "../client.js";
import type { ValidateStage } from "./check-core.js";
import { gatherMethodTree } from "./bundle-gather.js";
import { createHookClient } from "./validate-client.js";

/**
 * The deadline over the whole validate stage, well under the hook's overall timeout: the version
 * handshake, the blob route, the uploads of the files the API lacks (a tree up to the gatherer's
 * caps, 12 MiB) and the validation itself all run under it.
 */
export const VALIDATE_TIMEOUT_MS = 10_000;

/** What the stage may be handed instead of what it builds from the environment. */
export interface ValidateStageOptions {
  /** The client to validate through; by default the hook's, given a `PIPELEX_API_KEY`. */
  readonly client?: Pick<PipelexApiClient, "validate">;
  /** The stage's deadline, `VALIDATE_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
}

/**
 * Run the networked validate stage on `filePath`. Every no-verdict condition maps to
 * `unavailable` — no API key, a tree the gatherer cannot list whole, the deadline running out, any
 * failure of the client — so a machine consumer branches on the structured verdict, never on
 * transport, and the lint and format verdicts the hook already applied stand. A bundle or the
 * manifest that looks like a secret is `refused`, with nothing sent, and a verdict names the files
 * of the tree the gatherer kept home as `withheld`.
 */
export async function runValidateStage(
  filePath: string,
  options: ValidateStageOptions = {},
): Promise<ValidateStage> {
  if (options.client === undefined && !process.env.PIPELEX_API_KEY) {
    return { status: "unavailable" };
  }
  // One deadline over the whole stage: the signal reaches every request and upload the
  // validation makes, each stopped in flight once it fires, so nothing keeps running after the
  // hook has given up on it.
  const deadline = AbortSignal.timeout(options.timeoutMs ?? VALIDATE_TIMEOUT_MS);
  try {
    // Inside the try: a gather that throws fails this stage open, as any other no-verdict
    // condition does, rather than rejecting the hook and losing the other files' outcomes.
    const gathered = await gatherMethodTree(filePath);
    if (!gathered.ok) {
      return gathered.reason === "secret"
        ? { status: "refused", root: gathered.root, withheld: gathered.withheld }
        : { status: "unavailable" };
    }
    const withheld = gathered.withheld;
    const client = options.client ?? createHookClient();
    const result = await client.validate({ tree: gathered.tree }, true, { signal: deadline });
    if (result.is_valid === true) {
      return {
        status: "valid",
        pendingSignatures: Array.isArray(result.pending_signatures)
          ? result.pending_signatures
          : [],
        withheld,
      };
    }
    if (result.is_valid === false) {
      // The invalid arm is read from the answer as the server sent it, member by member, so a
      // member of an unexpected shape is left out rather than failing the block it belongs to.
      const answer: Record<string, unknown> = { ...result };
      return {
        status: "invalid",
        message: stringMember(answer.message),
        errors: readProblemItems(answer.errors),
        renderedMarkdown: stringMember(answer.rendered_markdown),
        withheld,
      };
    }
    return { status: "unavailable" }; // no discriminant — no verdict
  } catch {
    return { status: "unavailable" };
  }
}

/** Whether a value is a JSON object: neither `null` nor an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A member the hook shows as text, when it is one. */
function stringMember(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * An invalid verdict's faults, its `errors[]` MTHDS problem items, as the hook names them, read
 * member by member. An entry that names no fault, being no object or lacking a string `code` or
 * `detail`, is skipped. The two members the hook shows besides are kept only when they can be
 * read: the `location`, an object whose members the standard's `formatLocation` reads one by one,
 * and the `suggested_fix`, an object with a string `fix_code` and `description`, which
 * `formatSuggestedFix` words with its safety. A malformed member is left out of its item, so it
 * never costs the agent the fault it belongs to. Any other member of an item is not shown, and
 * not kept.
 */
export function readProblemItems(errors: unknown): ProblemItem[] {
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.flatMap((entry: unknown): ProblemItem[] => {
    if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.detail !== "string") {
      return [];
    }
    const item: ProblemItem = { code: entry.code, detail: entry.detail };
    if (isRecord(entry.location)) {
      item.location = entry.location as ProblemLocation;
    }
    const fix = entry.suggested_fix;
    if (isRecord(fix) && typeof fix.fix_code === "string" && typeof fix.description === "string") {
      // Only `fix_code`, `description` and `safety` are worded; the operations are never read.
      item.suggested_fix = fix as SuggestedFix;
    }
    return [item];
  });
}
