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

/**
 * Thrown by `parseGeneratedImage` when an image-generation pipeline returns
 * no usable image URL. Distinct from `BadPipelineOutputError` so the error
 * UI can show image-specific guidance (e.g. the model refused the prompt).
 *
 * `nonWebUrl` is set when the pipeline *did* return an image, but at a URL a
 * browser can't load (`file://`, `pipelex-storage://`, …) — typically the
 * Pipelex API using local file storage. `classifyPipelineError` keys on this
 * field to show storage-specific guidance instead of the generic message,
 * without parsing the error string.
 */
export class BadImageOutputError extends Error {
  readonly nonWebUrl?: string;

  constructor(message: string, options?: { nonWebUrl?: string }) {
    super(message);
    this.name = "BadImageOutputError";
    this.nonWebUrl = options?.nonWebUrl;
  }
}
