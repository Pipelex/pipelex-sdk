import type { ClassifyEnv } from "@/lib/errors";

/**
 * Read the env facts `classifyPipelineError` needs. Server-only (reads
 * `process.env`) — shared by the blocking and durable helpers so the two
 * execution paths can never drift on how classification sees the environment.
 */
export function readClassifyEnv(): ClassifyEnv {
  return { apiUrl: process.env.PIPELEX_BASE_URL, hasApiKey: Boolean(process.env.PIPELEX_API_KEY) };
}
