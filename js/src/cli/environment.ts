/**
 * What the command reads from its environment, and the client it builds from it.
 *
 * The key comes from `PIPELEX_API_KEY` and nowhere else: a flag would put it in the shell's history
 * and the process list. The API's address comes from `PIPELEX_BASE_URL`, the hosted API when it
 * is not set. An empty variable counts as unset, except `PIPELEX_BASE_URL`: an empty one, such as
 * an unfilled CI secret, reaches the SDK, which refuses it, rather than send the key to the hosted
 * API by default. No `.env` file is read: a command started through `npx` from wherever the person
 * stands would otherwise pick a credential from whichever file it found there.
 */

import {
  DEFAULT_API_BASE_URL,
  PipelexApiClient,
  RequestArgumentError,
  SDK_VERSION,
} from "../index.js";
import { usageError } from "./io.js";
import type { CommandIO } from "./io.js";

export const API_KEY_VARIABLE = "PIPELEX_API_KEY";
export const BASE_URL_VARIABLE = "PIPELEX_BASE_URL";

/**
 * The poll interval in milliseconds, for tests only: the recorded case table sets it to `0`, so
 * that a run answered "still running" is polled again at once. A person has no reason to set it;
 * unset, the SDK's own interval applies. The Python command reads the same variable.
 */
export const POLL_INTERVAL_VARIABLE = "PIPELEX_SDK_POLL_INTERVAL_MS";

/** The name the command gives itself in the `User-Agent` of every request, before the SDK's own. */
export const CLIENT_APP_NAME = "pipelex-sdk-cli";

function variable(io: CommandIO, name: string): string | undefined {
  const value = io.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The test-only poll interval, or `undefined` for the SDK's own.
 *
 * @throws {CommandError} A usage error when it is set to anything but a whole number.
 */
export function readPollInterval(io: CommandIO): number | undefined {
  const value = variable(io, POLL_INTERVAL_VARIABLE);
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) {
    throw usageError(`${POLL_INTERVAL_VARIABLE} must be a whole number of milliseconds.`);
  }
  return Number(value);
}

/**
 * The client every request goes through, built from the key and the base URL.
 *
 * @throws {CommandError} A usage error when the key is missing or the base URL is refused. The
 *   refusal never quotes the key, and the SDK's refusal of a base URL never quotes the parts of it
 *   that can carry a secret.
 */
export function makeClient(io: CommandIO): PipelexApiClient {
  const apiKey = variable(io, API_KEY_VARIABLE);
  if (apiKey === undefined) {
    throw usageError(`${API_KEY_VARIABLE} is not set.`, [
      `Get a key at https://app.pipelex.com and export it: export ${API_KEY_VARIABLE}=<your key>`,
      "This command reads no .env file; to load one into the shell, run: set -a; . ./.env; set +a",
    ]);
  }
  try {
    return new PipelexApiClient({
      apiKey,
      // Absent, not empty, means the hosted API: the SDK refuses an empty base URL on purpose, so
      // an unfilled CI secret never sends the key to the hosted API by default.
      baseUrl: io.env[BASE_URL_VARIABLE] ?? DEFAULT_API_BASE_URL,
      appInfo: { name: CLIENT_APP_NAME, version: SDK_VERSION },
    });
  } catch (error) {
    if (error instanceof RequestArgumentError) {
      throw usageError(`${BASE_URL_VARIABLE} is refused.`, [`Reason: ${error.message}`]);
    }
    throw error;
  }
}
