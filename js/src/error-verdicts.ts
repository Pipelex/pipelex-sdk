/**
 * The verdict an `ApiResponseError` falls back to when the server sent no usable member.
 *
 * A problem document may carry `retryable` and `error_domain`, and when it does the error takes
 * them (see `ApiResponseError`). When it does not — the platform does not classify its own
 * refusals yet, a gateway answers an HTML page, a bare runner answers Starlette's
 * `{"detail": "Not Found"}` — each missing member is read off this table instead, so a consumer
 * never has to choose its own default. The table reads only the HTTP status, the platform's
 * native `code`, and whether the body names what it refused.
 *
 * It is also the platform's reference: the verdicts the platform will send on its own refusals
 * are decided against this table, so a refusal keeps its verdict when the platform starts
 * sending one. `pipelex-sdk` (Python) applies the same table, and the case file both suites
 * share (`tests/fixtures/error-verdicts.json`) holds them to it.
 */

import type { ErrorVerdict } from "./errors.js";

const INPUT: ErrorVerdict = Object.freeze({ errorDomain: "input", retryable: false });
const CONFIG: ErrorVerdict = Object.freeze({ errorDomain: "config", retryable: false });
const TRANSIENT: ErrorVerdict = Object.freeze({ errorDomain: "runtime", retryable: true });
const FAULT: ErrorVerdict = Object.freeze({ errorDomain: "runtime", retryable: false });

/** The platform code a `409` carries when the organization holds as many API keys as it may. */
const API_KEY_LIMIT_CODE = "pipelex_api_key_limit_reached";

/**
 * The verdict of a refused request whose problem document carried no usable member.
 *
 * - `status` is the HTTP status of the answer.
 * - `code` is the platform's native code, when the body carried one.
 * - `named` says whether the body names what it refused: a platform `code` or a runner
 *   `error_type`. It decides a `404`: a named one is a resource the caller asked for that does not
 *   exist (`input`), a bare one is a route the deployment does not serve (`config`).
 *
 * Every `4xx` the table does not list is the caller's request refused (`input`, not retryable),
 * every `5xx` it does not list is a fault in the service that may pass (`runtime`, retryable),
 * and any other status is one no route answers with, so nothing says a retry helps (`runtime`,
 * not retryable).
 */
export function fallbackVerdict(
  status: number,
  code: string | undefined,
  named: boolean,
): ErrorVerdict {
  switch (status) {
    case 401:
    case 402:
    case 403:
      // The credential, the plan or the access must change.
      return CONFIG;
    case 404:
      return named ? INPUT : CONFIG;
    case 405:
      // The deployment does not serve this method on the route.
      return CONFIG;
    case 408:
    case 429:
      // Refused for its timing, not its content.
      return TRANSIENT;
    case 409:
      // A conflict with the stored state is the caller's, except the key limit, which someone
      // lifts by removing a key.
      return code === API_KEY_LIMIT_CODE ? CONFIG : INPUT;
    case 501:
      // The deployment does not implement it, and asking again will not change that.
      return CONFIG;
  }
  if (status >= 400 && status < 500) return INPUT;
  if (status >= 500 && status < 600) return TRANSIENT;
  return FAULT;
}
