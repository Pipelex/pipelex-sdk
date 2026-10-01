import type { ClassifyEnv } from "@/lib/errors";

/**
 * Read the env facts `classifyPipelineError` needs. Server-only (reads
 * `process.env`) — shared by the blocking and durable helpers so the two
 * execution paths can never drift on how classification sees the environment.
 */
export function readClassifyEnv(): ClassifyEnv {
  return { apiUrl: process.env.PIPELEX_BASE_URL, hasApiKey: Boolean(process.env.PIPELEX_API_KEY) };
}

/**
 * Whether the assets route may fetch a stored asset over plain `http:`.
 * Server-only (reads `process.env`).
 *
 * The SDK's `fetchArtifact` refuses a cleartext link by default, and the one
 * deployment that hands them out is the local compose stack, whose object
 * store has no TLS. Its API has none either, so the decision follows the base
 * URL: a developer who configured a plain-http API has already accepted
 * cleartext to that stack, and the store link is the same trust. Against the
 * hosted API, a plain-http link stays refused.
 */
export function allowPlainHttpArtifacts(): boolean {
  return /^http:\/\//i.test(process.env.PIPELEX_BASE_URL?.trim() ?? "");
}
