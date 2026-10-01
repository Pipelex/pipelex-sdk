/**
 * App-wide configuration that is safe to read on the client.
 *
 * Pure module — no React, no server-only APIs — so it imports cleanly from
 * either side of the server boundary (the forms read `DEFAULT_EXECUTION_MODE`,
 * the hook and the actions read the `ExecutionMode` type).
 */

/**
 * How a pipeline run is executed:
 * - `blocking` — one synchronous `POST /v1/execute`. Simple, but behind the
 *   hosted gateway it is cut off at ~30s, so long pipelines surface a
 *   `PipelineExecuteTimeoutError`. Use it to *see* that limit.
 * - `durable`  — `POST /v1/start` then poll the run by id. Survives the ~30s
 *   cap and streams coarse live status. Hosted-safe everywhere.
 */
export type ExecutionMode = "blocking" | "durable";

/**
 * Default mode for every example's `<ModeToggle>`. Durable is hosted-safe, so
 * it is the right default; flip an example to blocking to demonstrate the cap.
 * When the configured URL doesn't serve the durable run lifecycle, durable
 * surfaces an explicit `lifecycle_unavailable` error (naming the endpoint URL
 * and steering to `PIPELEX_BASE_URL`) rather than silently downgrading — the
 * developer should know their configured API doesn't provide durable
 * execution.
 *
 * `NEXT_PUBLIC_` env vars are inlined at build time, so this is safe to read on
 * the client. An unrecognized value falls back to `durable`.
 */
export const DEFAULT_EXECUTION_MODE: ExecutionMode =
  process.env.NEXT_PUBLIC_EXECUTION_MODE === "blocking" ? "blocking" : "durable";
