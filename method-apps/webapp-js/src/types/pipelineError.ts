/**
 * Tagged errors thrown by the `parseXxx()` narrowers in `src/types/`.
 *
 * They mark a system-boundary failure: the pipeline ran, but its output
 * didn't match the shape the app expects (the bundle was edited, or the
 * model produced something unexpected). `classifyPipelineError` in
 * `@/lib/errors` matches on these classes to build a structured
 * `PipelineError` instead of an opaque "unknown" error.
 *
 * They live in their own file (not next to one pipeline's types) because
 * every pipeline's narrower shares them.
 */

/** Thrown by a `parseXxx()` narrower when structured output is malformed. */
export class BadPipelineOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadPipelineOutputError";
  }
}
