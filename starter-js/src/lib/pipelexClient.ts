import { PipelexApiClient } from "@pipelex/sdk";

let cached: PipelexApiClient | null = null;

/**
 * Returns a process-wide PipelexApiClient.
 *
 * The client natively reads the starter's Pipelex-branded env vars —
 * PIPELEX_API_KEY for the bearer token and PIPELEX_BASE_URL for the host — and
 * falls back to the hosted API (https://api.pipelex.com) when PIPELEX_BASE_URL
 * is unset. Those are the exact vars `.env.example`, the README, and every
 * error message reference, so no bridging is needed: construct it bare.
 */
export function getPipelexClient(): PipelexApiClient {
  if (!cached) {
    cached = new PipelexApiClient();
  }
  return cached;
}
