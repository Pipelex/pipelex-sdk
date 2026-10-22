/**
 * The `.mthds` post-edit hook's networked stage: the edited file's method tree validated through
 * the SDK (`POST /v1/validate`, `allow_signatures: true`), held to one deadline over the whole
 * stage, so the hook never outlasts its harness's patience whatever the network does.
 */

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
  const gathered = await gatherMethodTree(filePath);
  if (!gathered.ok) {
    return gathered.reason === "secret"
      ? { status: "refused", root: gathered.root, withheld: gathered.withheld }
      : { status: "unavailable" };
  }
  const withheld = gathered.withheld;
  try {
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
      return {
        status: "invalid",
        message: result.message,
        validationErrors: Array.isArray(result.validation_errors) ? result.validation_errors : [],
        renderedMarkdown: result.rendered_markdown,
        withheld,
      };
    }
    return { status: "unavailable" }; // no discriminant — no verdict
  } catch {
    return { status: "unavailable" };
  }
}
