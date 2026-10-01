/**
 * App-wide configuration that is safe to read on the client.
 *
 * Pure module — no React, no server-only APIs — so it imports cleanly from
 * either side of the server boundary (the forms read `EXECUTION_MODE`, the hook
 * and the actions read the `ExecutionMode` type).
 */

/**
 * How a pipeline run is executed:
 * - `blocking` — one synchronous `POST /v1/execute`. Simple, but behind the
 *   hosted gateway it is cut off at ~30s, so a longer run surfaces an
 *   `execute_timeout` error.
 * - `durable`  — `POST /v1/start` then poll the run by id. Survives the ~30s
 *   cap and streams coarse live status. Hosted-safe everywhere.
 */
export type ExecutionMode = "blocking" | "durable";

/**
 * The mode every method runs in. It is the deployment's choice, not the user's:
 * a person using the app has no reason to know the difference, and a person who
 * picked Blocking would see any method that runs past the gateway's cap fail.
 *
 * Durable is the default because it is hosted-safe. Set
 * `NEXT_PUBLIC_EXECUTION_MODE=blocking` for a deployment that does not serve the
 * durable run lifecycle — a local open-source runner, for instance — which
 * Durable reports as an explicit `lifecycle_unavailable` error (naming the
 * endpoint URL and steering to `PIPELEX_BASE_URL`) rather than silently
 * downgrading.
 *
 * `NEXT_PUBLIC_` env vars are inlined at build time, so this is safe to read on
 * the client. An unrecognized value falls back to `durable`.
 */
export const EXECUTION_MODE: ExecutionMode =
  process.env.NEXT_PUBLIC_EXECUTION_MODE === "blocking" ? "blocking" : "durable";
